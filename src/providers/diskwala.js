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

async function callApiKeyProxy(shareUrl, timeoutMs) {
  const proxyUrl = String(process.env.DISKWALA_PROXY_URL || '').trim();
  const apiKey = String(process.env.DISKWALA_API_KEY || '').trim();
  if (!proxyUrl || !apiKey) return null;

  const resp = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ url: shareUrl }),
    signal: AbortSignal.timeout(Math.max(timeoutMs, 60_000)),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`API-key resolver HTTP ${resp.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`);

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

  // Preferred SESSION-free route: an API-key resolver supplied by the owner.
  // Secrets stay in deployment environment variables and are never committed.
  if (process.env.DISKWALA_PROXY_URL && process.env.DISKWALA_API_KEY) {
    try {
      const result = await callApiKeyProxy(shareUrl, ctx.timeoutMs);
      if (result) return result;
    } catch (err) {
      failures.push(`api-key resolver: ${err.message}`);
      console.warn('[diskwala] API-key resolver failed; trying public fallback:', err.message);
    }
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
