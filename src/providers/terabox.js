import { formatSize } from '../utils.js';

export const name = 'terabox';

export const hosts = new Set([
  'terabox.com','www.terabox.com','terabox.app','www.terabox.app',
  'teraboxapp.com','www.teraboxapp.com','1024terabox.com','www.1024terabox.com',
  '1024tera.com','www.1024tera.com','1024tera.co','www.1024tera.co',
  'teraboxlink.com','www.teraboxlink.com','terasharelink.com','www.terasharelink.com',
  'terafileshare.com','www.terafileshare.com','nephobox.com','www.nephobox.com',
  'freeterabox.com','www.freeterabox.com','4funbox.com','www.4funbox.com',
  'mirrobox.com','www.mirrobox.com','momerybox.com','www.momerybox.com',
  'tibibox.com','www.tibibox.com','dubox.com','www.dubox.com',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const SAMRA_API =
  process.env.TERABOX_SAMRA_API ||
  'https://samratbdownload.krishnalucky193.workers.dev/';

function extractSurl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (m) return m[1].startsWith('1') ? m[1].slice(1) : m[1];
  } catch {}
  return '';
}

function normalizeSamra(data, shareUrl) {
  const root = data?.data || data?.result || data;
  if (!root || typeof root !== 'object') return null;

  const rawFiles =
    root.files ||
    root.list ||
    root.file ||
    (Array.isArray(root) ? root : [root]);

  const arr = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

  const files = arr
    .map((f) => {
      if (!f || typeof f !== 'object') return null;

      const dlink =
        f.download_url ||
        f.downloadUrl ||
        f.direct_link ||
        f.direct_url ||
        f.dlink ||
        '';

      const stream =
        f.stream_url ||
        f.streamUrl ||
        f.m3u8 ||
        f.hls ||
        f.play_url ||
        '';

      const link = dlink || stream;
      if (!/^https?:\/\//i.test(String(link))) return null;

      const sizeBytes =
        Number(f.size_bytes || f.sizeBytes || f.bytes || 0) ||
        (typeof f.size === 'number' ? f.size : 0) ||
        0;

      const displaySize =
        (typeof f.size_formatted === 'string' && f.size_formatted) ||
        (typeof f.formatted_size === 'string' && f.formatted_size) ||
        (typeof f.size === 'string' && /[a-z]/i.test(f.size) ? f.size : '') ||
        formatSize(sizeBytes);

      const name =
        f.file_name ||
        f.filename ||
        f.server_filename ||
        f.name ||
        f.title ||
        'terabox.mp4';

      return {
        name: String(name),
        size: displaySize,
        size_bytes: sizeBytes,
        quality: f.quality || f.resolution || '',
        extension: f.extension || '',
        thumbnail: f.thumbnail || f.thumb || f.image || '',
        dlink: String(dlink || stream),
        stream_url: stream ? String(stream) : '',
        is_dir: Boolean(f.isdir || f.is_dir),
        path: f.path || '',
        fs_id: f.fs_id ? String(f.fs_id) : '',
      };
    })
    .filter(Boolean);

  if (!files.length) return null;

  return {
    provider: name,
    share_url: shareUrl,
    final_url: shareUrl,
    surl: extractSurl(shareUrl),
    title: root.name || root.title || files[0].name,
    files,
  };
}

async function resolveWithSamra(shareUrl, ctx) {
  const u = new URL(SAMRA_API);
  u.searchParams.set('url', shareUrl);

  const resp = await fetch(u, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(ctx.timeoutMs, 60_000)),
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`SAMRA API HTTP ${resp.status}`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('SAMRA API returned invalid JSON');
  }

  if (data?.success === false) {
    throw new Error(data?.message || data?.error || 'SAMRA API reported failure');
  }

  const result = normalizeSamra(data, shareUrl);
  if (!result) throw new Error('SAMRA API returned no downloadable file');
  return result;
}

export function downloadHeaders() {
  return { 'User-Agent': UA, Accept: '*/*' };
}

export async function resolveInfo(shareUrl, ctx) {
  // Single authoritative TeraBox resolver. Old cookie/internal-API engines
  // were removed because they were unreliable and complicated troubleshooting.
  return resolveWithSamra(shareUrl, ctx);
}
