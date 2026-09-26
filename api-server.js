// Zero-config media download API.
// Terabox-family links work with no user-supplied cookie/login — cookies come
// from a self-refreshing shared pool. Diskwala links return an honest error
// (their API requires browser-signed requests + a logged-in session).

import http from 'node:http';
import { Readable } from 'node:stream';
import { config } from './src/config.js';
import { sharedCookiePool } from './src/sharedcookies.js';
import { pickProvider, getProvider, supportedHosts } from './src/providers/index.js';

const PORT = Number(process.env.API_PORT || 3400);
const API_KEY = process.env.API_KEY || ''; // when set, require ?key= or X-API-Key

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj, null, 2));
}

function authorized(req, u) {
  if (!API_KEY) return true;
  return u.searchParams.get('key') === API_KEY || req.headers['x-api-key'] === API_KEY;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function resolveShare(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error('Invalid URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Only http/https URLs are supported'), { status: 400 });
  }
  const provider = pickProvider(parsed.hostname);
  if (!provider) {
    throw Object.assign(new Error(`Unsupported host: ${parsed.hostname}`), {
      status: 400,
      extra: { supported_hosts: supportedHosts },
    });
  }
  await sharedCookiePool.refresh();
  const result = await provider.resolveInfo(parsed.toString(), {
    cookies: sharedCookiePool,
    timeoutMs: config.requestTimeoutMs,
  });
  return { provider, result };
}

async function handleInfo(req, res, u) {
  const url = u.searchParams.get('url');
  if (!url) {
    return sendJson(res, 400, {
      success: false,
      error: "Missing 'url' parameter",
      example: '/api/info?url=https://terabox.com/s/xxxx',
    });
  }
  try {
    const { provider, result } = await resolveShare(url);
    const files = result.files.map((f, i) => ({
      index: i,
      name: f.name,
      size: f.size,
      size_bytes: f.size_bytes,
      thumbnail: f.thumbnail,
      is_dir: Boolean(f.is_dir),
      dlink: f.dlink,
      download_url: f.dlink
        ? `${baseUrl(req)}/api/download?url=${encodeURIComponent(url)}&index=${i}`
        : null,
    }));
    return sendJson(res, 200, {
      success: true,
      provider: provider.name,
      share_url: url,
      file_count: files.length,
      files,
      ...(result.qualities ? { title: result.title, author: result.author, qualities: result.qualities } : {}),
    });
  } catch (err) {
    return sendJson(res, err.status || 502, {
      success: false,
      error: err.message,
      ...(err.extra || {}),
    });
  }
}

async function streamDownload(req, res, dlink, name, providerName) {
  const provider = (providerName && getProvider(providerName)) || getProvider('terabox');
  const headers = provider.downloadHeaders(sharedCookiePool.next() || '');
  if (req.headers.range) headers.Range = req.headers.range;

  // Abort only if headers take too long — never mid-stream.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('Upstream timeout')), config.requestTimeoutMs);
  let upstream;
  try {
    upstream = await fetch(dlink, { headers, redirect: 'follow', signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    return sendJson(res, 502, { success: false, error: `Upstream fetch failed: ${e.message}` });
  }
  clearTimeout(timer);

  if (!upstream.ok && upstream.status !== 206) {
    upstream.body?.cancel().catch(() => {});
    return sendJson(res, 502, { success: false, error: `Upstream returned HTTP ${upstream.status}` });
  }

  const safeName = String(name || 'download').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200) || 'download';
  const ascii = safeName.replace(/[^\x20-\x7E]/g, '_');
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    ...(upstream.headers.get('content-length')
      ? { 'Content-Length': upstream.headers.get('content-length') }
      : {}),
    ...(upstream.headers.get('content-range')
      ? { 'Content-Range': upstream.headers.get('content-range') }
      : {}),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Access-Control-Allow-Origin': '*',
  });
  req.on('close', () => {
    upstream.body?.cancel().catch(() => {});
  });
  Readable.fromWeb(upstream.body).pipe(res);
}

async function handleDownload(req, res, u) {
  const url = u.searchParams.get('url');
  const redirect = ['1', 'true', 'yes'].includes((u.searchParams.get('redirect') || '').toLowerCase());
  if (!url) return sendJson(res, 400, { success: false, error: "Missing 'url' parameter" });

  let resolved;
  try {
    resolved = await resolveShare(url);
  } catch (err) {
    return sendJson(res, err.status || 502, { success: false, error: err.message });
  }

  // Quality pick (YouTube): /api/download?url=...&format=720&type=mp4
  const qFormat = u.searchParams.get('format');
  const qType = u.searchParams.get('type');
  if ((qFormat || qType) && resolved.provider.resolveQuality) {
    try {
      const f = await resolved.provider.resolveQuality(url, qFormat || '360', qType || 'mp4', {
        cookies: sharedCookiePool,
        timeoutMs: config.requestTimeoutMs,
      });
      if (redirect) {
        res.writeHead(302, { Location: f.dlink, 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      return streamDownload(req, res, f.dlink, f.name, resolved.provider.name);
    } catch (err) {
      return sendJson(res, 502, { success: false, error: err.message });
    }
  }

  const files = resolved.result.files.filter((f) => !f.is_dir && f.dlink);
  const index = Math.max(0, Number.parseInt(u.searchParams.get('index') || '0', 10) || 0);
  const file = files[index];
  if (!file) {
    return sendJson(res, 404, {
      success: false,
      error: `No downloadable file at index ${index} (${files.length} available)`,
    });
  }
  if (redirect) {
    res.writeHead(302, { Location: file.dlink, 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  return streamDownload(req, res, file.dlink, file.name, resolved.provider.name);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Range,X-API-Key',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    });
    return res.end();
  }

  try {
    if (path === '/') {
      return sendJson(res, 200, {
        name: 'media-dl-api',
        version: '1.2.0',
        description:
          'Zero-config downloader API. Diskwala links resolve fully (free public resolver). Terabox links resolve via an external download API (cookie pool fallback for metadata).',
        endpoints: {
          'GET /api/info?url=<share-link>': 'file metadata + direct download links',
          'GET /api/download?url=<share-link>[&index=N]': 'download the file (add &redirect=1 for a 302 to the raw link)',
          'GET /api/health': 'service status',
        },
        auth: API_KEY ? 'pass ?key=<API_KEY> or X-API-Key header' : 'open',
      });
    }
    if (path === '/api/health') {
      return sendJson(res, 200, {
        success: true,
        status: 'ok',
        shared_cookies: sharedCookiePool.size,
        uptime_seconds: Math.round(process.uptime()),
        terabox: process.env.TERABOX_API_KEY
          ? 'operational (external resolver API + cookie pool fallback)'
          : 'metadata only (shared cookie pool)',
        diskwala: 'operational (public resolver)',
      });
    }
    if (!authorized(req, u)) {
      return sendJson(res, 401, { success: false, error: 'Invalid or missing API key' });
    }
    if (path === '/api/info' && req.method === 'GET') return await handleInfo(req, res, u);
    if (path === '/api/download' && req.method === 'GET') return await handleDownload(req, res, u);
    return sendJson(res, 404, { success: false, error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { success: false, error: `Internal error: ${err.message}` });
  }
});

sharedCookiePool.refresh(true).finally(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`media-dl-api listening on http://0.0.0.0:${PORT}`);
    console.log(`cookie pool size: ${sharedCookiePool.size}`);
    console.log(`api key required: ${API_KEY ? 'yes' : 'no'}`);
  });
});
