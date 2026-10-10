import { formatSize } from '../utils.js';
import * as adminConfig from '../admin-config.js';

export const name = 'custom_api';

const DEFAULT_MEGA = {
  id: 'mega',
  name: 'Mega API',
  endpoint: 'https://samra-mega-api.onrender.com/api/info?url=<MEGA_URL>',
  hosts: ['mega.nz', 'www.mega.nz', 'mega.co.nz', 'www.mega.co.nz'],
  enabled: true,
};

export function getConfiguredApis() {
  const saved = adminConfig.getConfig().apiEndpoints || [];
  const mega = saved.find((x) => x.id === 'mega');
  return mega ? saved : [DEFAULT_MEGA, ...saved.filter((x) => x.id !== 'mega')];
}

export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

function hostMatches(url, hosts) {
  let host;
  try { host = normalizeHost(new URL(url).hostname); } catch { return false; }
  return (hosts || []).some((h) => {
    const normalized = normalizeHost(h);
    return normalized && (host === normalized || host.endsWith('.' + normalized));
  });
}

export function findApiForUrl(url) {
  const apis = getConfiguredApis().filter((a) => a.enabled !== false);
  return apis.find((a) => hostMatches(url, a.hosts || [])) || null;
}

function resolveEndpoint(template, shareUrl) {
  const encoded = encodeURIComponent(shareUrl);
  const token = /<\s*(?:MEGA_URL|URL|SHARE_URL)\s*>/i;
  if (token.test(template)) return template.replace(token, encoded);
  const endpoint = new URL(template);
  endpoint.searchParams.set('url', shareUrl);
  return endpoint.toString();
}

function firstString(...values) {
  return values.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)) || '';
}

function collectFiles(payload) {
  const root = payload?.data || payload?.result || payload?.response || payload;
  const candidates = Array.isArray(root)
    ? root
    : (root?.files || root?.list || root?.items || root?.children || root?.contents ||
       root?.file_data ? (root.files || root.list || root.items || root.children || root.contents || [root.file_data]) : [root]);
  return (Array.isArray(candidates) ? candidates : [candidates]).map((f) => {
    if (!f || typeof f !== 'object') return null;
    const dlink = firstString(f.download_url, f.downloadUrl, f.direct_link, f.direct_url, f.dlink, f.download, f.url, f.links?.download, f.links?.direct);
    if (!dlink) return null;
    const sizeBytes = Number(f.size_bytes || f.sizeBytes || f.bytes || f.filesize || f.size || 0) || 0;
    const rawName = f.file_name || f.filename || f.server_filename || f.name || f.title || 'mega-file';
    return {
      name: String(rawName),
      size: typeof f.size === 'string' && /[a-z]/i.test(f.size) ? f.size : formatSize(sizeBytes),
      size_bytes: sizeBytes,
      thumbnail: firstString(f.thumbnail, f.thumb, f.image),
      dlink,
      is_dir: Boolean(f.isdir || f.is_dir || f.type === 'folder' || f.type === 'directory'),
      path: f.path || '',
      fs_id: String(f.id || f.fs_id || ''),
    };
  }).filter(Boolean);
}

export async function resolveInfo(shareUrl, ctx = {}) {
  const api = findApiForUrl(shareUrl);
  if (!api) throw new Error('No enabled API endpoint matches this link. Open /admin → API Manager.');
  const endpoint = resolveEndpoint(api.endpoint, shareUrl);
  const resp = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'UploaderBot/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(Number(ctx.timeoutMs) || 30_000, 60_000)),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`${api.name} returned HTTP ${resp.status}`);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`${api.name} returned invalid JSON`); }
  if (json?.success === false || json?.status === false || json?.ok === false) {
    throw new Error(json.message || json.error || json.err || `${api.name} reported failure`);
  }
  const files = collectFiles(json);
  if (!files.length) throw new Error(`${api.name} returned no direct downloadable files; API response format may need a provider adapter`);
  return {
    provider: api.id === 'mega' || /mega/i.test(api.name) ? 'mega' : 'custom_api',
    provider_label: api.name,
    share_url: shareUrl,
    final_url: shareUrl,
    title: json?.data?.name || json?.data?.title || json?.name || files[0].name,
    files,
  };
}

export function downloadHeaders() {
  return { Accept: '*/*', 'User-Agent': 'Mozilla/5.0' };
}
