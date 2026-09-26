import { formatSize } from '../utils.js';

export const name = 'diskwala';

export const hosts = new Set([
  'diskwala.com',
  'www.diskwala.com',
  'diskwala.net',
  'www.diskwala.net',
  'diskwala.app',
  'www.diskwala.app',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

// Free public Diskwala resolver — no cookies or login required on our side.
// Override with DISKWALA_RESOLVER_URL if the upstream ever moves.
const RESOLVER = process.env.DISKWALA_RESOLVER_URL || 'https://diskwala-dl-six.vercel.app/api/scrap';

export function downloadHeaders() {
  return {
    'User-Agent': UA,
    Accept: '*/*',
  };
}

export async function resolveInfo(shareUrl, ctx) {
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const apiUrl = `${RESOLVER}?q=${encodeURIComponent(shareUrl)}`;
  const resp = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: timeout,
  });
  if (!resp.ok) throw new Error(`Diskwala resolver failed (HTTP ${resp.status})`);

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error('Diskwala resolver returned an invalid response');
  }

  const file = data?.data?.file;
  if (!data?.success || !file?.downloadUrl) {
    throw new Error(
      'Could not resolve this Diskwala link — it may be private, deleted, or a playlist (only direct file links are supported right now).',
    );
  }

  const ext = String(file.extension || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  let fileName = String(file.name || 'diskwala').trim() || 'diskwala';
  // The resolver sometimes returns a name WITHOUT the extension (the extension
  // only lives in a separate field) — append it when missing.
  if (!fileName.toLowerCase().endsWith(`.${ext}`)) fileName = `${fileName}.${ext}`;
  return {
    provider: name,
    share_url: shareUrl,
    final_url: shareUrl,
    surl: '',
    title: fileName,
    files: [
      {
        name: fileName,
        size: formatSize(file.size || 0),
        size_bytes: file.size || 0,
        thumbnail: file.thumb || '',
        dlink: file.downloadUrl,
        is_dir: false,
        path: '',
        fs_id: '',
      },
    ],
  };
}
