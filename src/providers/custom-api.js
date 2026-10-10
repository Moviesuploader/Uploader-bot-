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
       root?.file_data || root?.videos || root?.sources
      ? (root.files || root.list || root.items || root.children || root.contents || root.videos || root.sources || [root.file_data])
      : [root]);

  return (Array.isArray(candidates) ? candidates : [candidates]).map((f) => {
    if (!f || typeof f !== 'object') return null;

    // Some APIs return a video's quality variants as data.sources[].url.
    const dlink = firstString(
      f.download_url, f.downloadUrl, f.direct_link, f.direct_url, f.dlink,
      f.download, f.video_url, f.videoUrl, f.url, f.link,
      f.links?.download, f.links?.direct, f.source?.url
    );
    if (!dlink) return null;

    const sizeBytes = Number(f.size_bytes || f.sizeBytes || f.bytes || f.filesize || f.size || 0) || 0;
    const rawName = f.file_name || f.filename || f.server_filename || f.name || f.title || 'media-file';
    const quality = f.quality || f.resolution || '';
    const label = quality ? ` [${String(quality)}]` : '';
    return {
      name: String(rawName) + label,
      size: typeof f.size === 'string' && /[a-z]/i.test(f.size) ? f.size : formatSize(sizeBytes),
      size_bytes: sizeBytes,
      thumbnail: firstString(f.thumbnail, f.thumb, f.image, f.poster),
      dlink,
      is_dir: Boolean(f.isdir || f.is_dir || f.type === 'folder' || f.type === 'directory'),
      path: f.path || '',
      fs_id: String(f.id || f.fs_id || ''),
    };
  }).filter(Boolean);
}

async function fetchJson(url, timeoutMs) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'UploaderBot/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(Number(timeoutMs) || 30_000, 60_000)),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`API returned HTTP ${resp.status}`);
  try { return JSON.parse(body); } catch { throw new Error('API returned invalid JSON'); }
}

function itemMatchesUrl(item, shareUrl) {
  const candidates = [item?.url, item?.link, item?.album_url, item?.source, item?.video_url];
  const normalize = (value) => {
    try {
      const u = new URL(value);
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch { return ''; }
  };
  const target = normalize(shareUrl);
  return Boolean(target && candidates.some((candidate) => normalize(candidate) === target));
}

async function resolveNestedDetails(json, shareUrl, api, timeoutMs) {
  const root = json?.data || json?.result || json?.response || json;
  const items = Array.isArray(root) ? root : Array.isArray(root?.items) ? root.items : Array.isArray(root?.videos) ? root.videos : Array.isArray(root?.albums) ? root.albums : Array.isArray(root?.data) ? root.data : [];
  const matched = items.find((item) => itemMatchesUrl(item, shareUrl));
  const detailUrl = firstString(matched?.details_api, matched?.detailsApi);
  if (!detailUrl) return json;

  // Follow API-provided detail links only when they point to the same API host.
  // This avoids turning arbitrary response URLs into server-side requests.
  const detail = new URL(detailUrl);
  if (!['http:', 'https:'].includes(detail.protocol) || detail.hostname !== new URL(api.endpoint).hostname) {
    throw new Error(`${api.name} returned a details_api on an unexpected host`);
  }
  return fetchJson(detail.toString(), timeoutMs);
}

export async function resolveInfo(shareUrl, ctx = {}) {
  const api = findApiForUrl(shareUrl);
  if (!api) throw new Error('No enabled API endpoint matches this link. Open /admin → API Manager.');

  const endpoint = resolveEndpoint(api.endpoint, shareUrl);
  let json = await fetchJson(endpoint, ctx.timeoutMs);
  if (json?.success === false || json?.status === false || json?.ok === false) {
    throw new Error(json.message || json.error || json.err || `${api.name} reported failure`);
  }

  let files = collectFiles(json);
  if (!files.length) {
    json = await resolveNestedDetails(json, shareUrl, api, ctx.timeoutMs);
    if (json?.success === false || json?.status === false || json?.ok === false) {
      throw new Error(json.message || json.error || json.err || `${api.name} reported failure`);
    }
    files = collectFiles(json);
  }
  if (!files.length) {
    throw new Error(`${api.name} returned metadata but no direct media URL. Configure its details endpoint using <URL>, or check whether its detail response contains sources[].url / videos[].video_url.`);
  }

  const root = json?.data || json?.result || json?.response || json;
  const first = files[0];
  return {
    provider: api.id === 'mega' || /mega/i.test(api.name) ? 'mega' : 'custom_api',
    provider_label: api.name,
    share_url: shareUrl,
    final_url: shareUrl,
    title: root?.name || root?.title || json?.name || first.name,
    files,
  };
}

export function downloadHeaders() {
  return { Accept: '*/*', 'User-Agent': 'Mozilla/5.0' };
}
