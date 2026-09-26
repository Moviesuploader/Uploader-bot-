import { formatSize } from '../utils.js';

export const name = 'diskwala';

export const hosts = new Set([
  'diskwala.com', 'www.diskwala.com',
  'diskwala.net', 'www.diskwala.net',
  'diskwala.app', 'www.diskwala.app',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const DEFAULT_RESOLVER = 'https://diskwala-dl-six.vercel.app/api/scrap';

function resolverList() {
  // Keep the original working engine as the default. A replacement/fallback can
  // be supplied without changing code: comma-separate DISKWALA_RESOLVER_URLS.
  const configured = String(
    process.env.DISKWALA_RESOLVER_URLS || process.env.DISKWALA_RESOLVER_URL || '',
  )
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set([...configured, DEFAULT_RESOLVER])];
}

export function downloadHeaders() {
  return { 'User-Agent': UA, Accept: '*/*' };
}

function findPublicUrl(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') {
    const v = value.replaceAll('\\u0026', '&');
    if (/^https?:\/\//i.test(v) && !/diskwala\.com\/app\//i.test(v) &&
        !/\.(?:png|jpe?g|svg|css|js|ico)(?:\?|$)/i.test(v)) return v;
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) { const hit = findPublicUrl(item, depth + 1); if (hit) return hit; }
    return '';
  }
  if (typeof value === 'object') {
    const preferred = ['downloadUrl','download_url','streamUrl','stream_url','url','file','path','link'];
    for (const key of preferred) {
      if (key in value) { const hit = findPublicUrl(value[key], depth + 1); if (hit) return hit; }
    }
    for (const item of Object.values(value)) { const hit = findPublicUrl(item, depth + 1); if (hit) return hit; }
  }
  return '';
}

async function callPublicDiskwala(shareUrl, timeoutMs) {
  const id = /\/(?:app|file|e)\/([a-zA-Z0-9]+)/.exec(shareUrl)?.[1];
  if (!id) throw new Error('invalid DiskWala share URL');
  const headers = { 'User-Agent': UA, Accept: 'application/json,text/html,*/*', Referer: shareUrl };

  // Public endpoints used by several open-source DiskWala clients. No user
  // session, Telegram session, API key, or private credential is sent.
  for (const endpoint of [
    `https://www.diskwala.com/api/file/${id}`,
    `https://www.diskwala.com/api/stream/${id}`,
  ]) {
    try {
      const resp = await fetch(endpoint, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const normalized = normalize(data, shareUrl);
      if (normalized) return normalized;
      const hit = findPublicUrl(data);
      if (hit) return normalize({ fileInfo: { name: data?.name || 'diskwala.mp4', url: hit } }, shareUrl);
    } catch {}
  }

  // Next.js pages may expose public file metadata in __NEXT_DATA__.
  const page = await fetch(shareUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (page.ok) {
    const html = await page.text();
    const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const hit = findPublicUrl(data);
        if (hit) return normalize({ fileInfo: { name: 'diskwala.mp4', url: hit } }, shareUrl);
      } catch {}
    }
  }
  throw new Error('public DiskWala metadata did not expose a downloadable URL');
}

async function callApiKeyProxy(shareUrl, timeoutMs) {
  const proxyUrl = String(process.env.DISKWALA_API_URL || process.env.DISKWALA_PROXY_URL || '').trim();
  const apiKey = String(process.env.DISKWALA_API_KEY || '').trim();
  if (!proxyUrl || !apiKey) return null;

  const authMode = String(process.env.DISKWALA_API_AUTH || 'bearer').trim().toLowerCase();
  const authHeaders = authMode === 'x-api-key'
    ? { 'X-API-Key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };

  const resp = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({ url: shareUrl }),
    signal: AbortSignal.timeout(Math.max(timeoutMs, 60_000)),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`API resolver HTTP ${resp.status}${raw ? `: ${raw.slice(0, 180)}` : ''}`);

  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('API-key resolver returned invalid JSON'); }

  const normalized = normalize(data, shareUrl);
  if (!normalized) throw new Error('API-key resolver returned no downloadable URL');
  return normalized;
}

function normalize(data, shareUrl) {
  const file = data?.data?.file || data?.file || data?.fileInfo || data?.result?.file;
  const dlink =
    file?.downloadUrl || file?.download_url || file?.url ||
    data?.downloadUrl || data?.download_url || data?.url;
  if (!dlink || !/^https?:\/\//i.test(String(dlink))) return null;

  const ext =
    String(file?.extension || '').toLowerCase().replace(/[^a-z0-9]/g, '') ||
    (() => {
      try {
        const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(String(dlink)).pathname);
        return m ? m[1].toLowerCase() : 'mp4';
      } catch { return 'mp4'; }
    })();
  let fileName = String(file?.name || data?.title || 'diskwala').trim() || 'diskwala';
  if (!fileName.toLowerCase().endsWith(`.${ext}`)) fileName = `${fileName}.${ext}`;
  const size = Number(file?.size || file?.size_bytes || data?.size || 0) || 0;
  return {
    provider: name,
    share_url: shareUrl,
    final_url: shareUrl,
    surl: '',
    title: fileName,
    files: [{
      name: fileName,
      size: formatSize(size),
      size_bytes: size,
      thumbnail: file?.thumb || file?.thumbnail || data?.thumbnail || '',
      dlink: String(dlink),
      is_dir: false,
      path: '',
      fs_id: '',
    }],
  };
}


function findMediaUrl(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && (/\.(mp4|m4v|webm|mkv)(?:[?#]|$)/i.test(value) || /amazonaws|cloudfront|cdn/i.test(value))) return value;
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMediaUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const preferred = ['downloadUrl','download_url','signed_url','stream_url','file_url','url'];
    for (const key of preferred) {
      if (key in value) {
        const found = findMediaUrl(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = findMediaUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

async function callBrowserResolver(shareUrl, timeoutMs) {
  if (String(process.env.DISKWALA_BROWSER_RESOLVER || '1') === '0') return null;

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return null;
  }

  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let captured = null;
  let metadata = null;
  try {
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const done = new Promise((resolve) => {
      page.on('response', async (response) => {
        try {
          const url = response.url();
          if (!url.includes('diskwala.com') || response.status() !== 200) return;
          if (!/\/file\/(sign|temp_info)/.test(url)) return;
          const body = await response.json();
          if (url.includes('/file/temp_info')) metadata = body;
          const media = findMediaUrl(body);
          if (media && !captured) {
            captured = { body, media };
            resolve();
          }
        } catch {}
      });
    });

    await page.goto(shareUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(20_000, Math.min(timeoutMs, 45_000)),
    });

    // Some versions request the signed URL only after Play/Download is clicked.
    for (const selector of ['button:has-text("Download")', 'button:has-text("Play")', 'video', '[class*="play" i]']) {
      try {
        await page.locator(selector).first().click({ timeout: 1200 });
        break;
      } catch {}
    }

    await Promise.race([
      done,
      new Promise((resolve) => setTimeout(resolve, Math.max(8_000, Math.min(timeoutMs, 20_000)))),
    ]);

    if (!captured?.media) throw new Error('official page produced no public signed media URL');

    const metaFile = metadata?.fileInfo || metadata?.data?.fileInfo || metadata?.data?.file || metadata?.file || {};
    return normalize({
      fileInfo: {
        ...metaFile,
        name: metaFile.name || 'diskwala.mp4',
        url: captured.media,
      },
    }, shareUrl);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function callResolver(base, shareUrl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const encoded = encodeURIComponent(shareUrl);

  // Existing resolver contract: GET ?q=<share-url>.
  // Custom resolvers can use {url} in DISKWALA_RESOLVER_URLS to place the URL
  // explicitly, otherwise the legacy ?q= contract is retained.
  const apiUrl = base.includes('{url}')
    ? base.replaceAll('{url}', encoded)
    : `${base}${base.includes('?') ? '&' : '?'}q=${encoded}`;

  const resp = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal,
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`);
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('invalid JSON response'); }
  const normalized = normalize(data, shareUrl);
  if (!normalized) throw new Error('response contained no downloadable URL');
  return normalized;
}

export async function resolveInfo(shareUrl, ctx) {
  const failures = [];

  // First try the public share flow. It needs no Telegram user session and
  // never exposes an API key to an unknown third-party service.
  try {
    return await callPublicDiskwala(shareUrl, ctx.timeoutMs);
  } catch (err) {
    failures.push(`public flow: ${err.message}`);
  }

  // Preferred SESSION-free route: an API-key resolver supplied by the owner.
  // Secrets stay in deployment environment variables and are never committed.
  if ((process.env.DISKWALA_API_URL || process.env.DISKWALA_PROXY_URL) && process.env.DISKWALA_API_KEY) {
    try {
      const result = await callApiKeyProxy(shareUrl, ctx.timeoutMs);
      if (result) return result;
    } catch (err) {
      failures.push(`api-key resolver: ${err.message}`);
      console.warn('[diskwala] API-key resolver failed; trying public fallback:', err.message);
    }
  }

  // SESSION-free fallback: run DiskWala's own public web client in Chromium.
  // The page creates its own first-party signed request; we only observe the
  // resulting public media URL. No Telegram user session or Mini-App token.
  try {
    const result = await callBrowserResolver(shareUrl, ctx.timeoutMs);
    if (result) return result;
  } catch (err) {
    failures.push(`browser resolver: ${err.message}`);
    console.warn('[diskwala] browser resolver failed; trying legacy resolver:', err.message);
  }

  for (const resolver of resolverList()) {
    // One transient 5xx should not instantly fail a user request.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callResolver(resolver, shareUrl, ctx.timeoutMs);
      } catch (err) {
        failures.push(`${new URL(resolver.replace('{url}', '') || DEFAULT_RESOLVER).host}: ${err.message}`);
        if (!/HTTP 5\d\d|fetch failed|timeout|aborted/i.test(String(err.message)) || attempt === 2) break;
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }
  console.error('[diskwala] all resolvers failed:', failures.join(' | '));
  throw new Error(
    'Diskwala resolver is temporarily unavailable. The bot retried the upstream service but it is still failing.',
  );
}
