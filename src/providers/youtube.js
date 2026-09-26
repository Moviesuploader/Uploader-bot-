import { formatSize } from '../utils.js';

export const name = 'youtube';

export const hosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

// URL bases stay as plain constants (no template interpolation inside a URL
// literal) so this file transports cleanly through any tooling.
const OEMBED_BASE = 'https://www.youtube.com/oembed';
const YT_IMG_BASE = 'https://i.ytimg.com/vi';

// YouTube downloads go through the same hosted resolver account as Terabox.
// Several endpoints offer the same conversion — we RACE them and always use
// the fastest healthy one (the last winner is tried first next time).
const YT_API_BASE =
  process.env.YTDL_API_BASE || process.env.TERABOX_API_BASE || 'https://api-dark-shan-yt.koyeb.app';
const YT_API_KEY = process.env.YTDL_API_KEY || process.env.TERABOX_API_KEY || '';
const YT_MP3_FORMAT = process.env.YTDL_MP3_FORMAT || '320';

export const QUALITIES = [
  { id: '360', type: 'mp4', label: '360p MP4' },
  { id: '720', type: 'mp4', label: '720p MP4' },
  { id: 'best', type: 'mp3', label: 'MP3 Audio' },
];

export function downloadHeaders() {
  return { 'User-Agent': UA, Accept: '*/*' };
}

function ytId(u) {
  try {
    const url = new URL(u);
    if (url.hostname.includes('youtu.be')) return url.pathname.split('/')[1] || '';
    return url.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function ytThumb(id) {
  return id ? `${YT_IMG_BASE}/${id}/hqdefault.jpg` : '';
}

// Fast, keyless metadata for the info card (YouTube oEmbed). The card shows
// quality buttons; actual download links resolve only when one is picked.
export async function resolveInfo(shareUrl, ctx) {
  const id = ytId(shareUrl);
  let title = 'YouTube video';
  let author = '';
  try {
    const r = await fetch(`${OEMBED_BASE}?url=${encodeURIComponent(shareUrl)}&format=json`, {
      signal: AbortSignal.timeout(Math.min(ctx.timeoutMs || 15000, 15000)),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.title) title = j.title;
      if (j.author_name) author = j.author_name;
    }
  } catch {}
  return {
    provider: name,
    share_url: shareUrl,
    final_url: shareUrl,
    surl: '',
    title,
    author,
    thumbnail: ytThumb(id),
    qualities: QUALITIES,
    files: [], // no direct links until a quality is picked
  };
}

// --- endpoint racing -------------------------------------------------------

function endpointsFor(shareUrl, format, type) {
  const q = encodeURIComponent(shareUrl);
  const key = encodeURIComponent(YT_API_KEY);
  if (type === 'mp3') {
    return [
      { tag: 'ytmp3', url: `${YT_API_BASE}/download/ytmp3?url=${q}&apikey=${key}` },
      { tag: 'ytmp3-v2', url: `${YT_API_BASE}/download/ytmp3-v2?url=${q}&apikey=${key}` },
      {
        tag: 'ytdl',
        url: `${YT_API_BASE}/download/ytdl?url=${q}&format=${encodeURIComponent(YT_MP3_FORMAT)}&type=mp3&apikey=${key}`,
      },
    ];
  }
  return [
    {
      tag: 'ytmp4',
      url: `${YT_API_BASE}/download/ytmp4?url=${q}&quality=${encodeURIComponent(format)}&apikey=${key}`,
    },
    {
      tag: 'ytdl',
      url: `${YT_API_BASE}/download/ytdl?url=${q}&format=${encodeURIComponent(format)}&type=mp4&apikey=${key}`,
    },
  ];
}

async function fetchEndpoint(ep, signal) {
  const resp = await fetch(ep.url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => null);
  if (!data || data.status !== true || !data.data?.download) {
    throw new Error(data?.err || data?.error || data?.message || 'no download link');
  }
  return data.data;
}

let lastWinner = null; // tag of the endpoint that won the previous race

async function raceFastest(shareUrl, format, type, timeoutMs) {
  let eps = endpointsFor(shareUrl, format, type);
  if (lastWinner) {
    // Sticky winner: last race's fastest endpoint goes first next time.
    eps = [...eps].sort((a, b) => (a.tag === lastWinner ? -1 : b.tag === lastWinner ? 1 : 0));
  }
  const ac = new AbortController();
  const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(Math.max(timeoutMs || 0, 90_000))]);
  const started = Date.now();
  const errors = [];
  try {
    return await new Promise((resolve, reject) => {
      let pending = eps.length;
      let done = false;
      for (const ep of eps) {
        fetchEndpoint(ep, signal)
          .then((d) => {
            if (done) return; // a slower leg finished after the winner — ignore it
            done = true;
            lastWinner = ep.tag;
            console.log(`[youtube] endpoint "${ep.tag}" won the race in ${Date.now() - started}ms`);
            ac.abort(); // cancel the losers
            resolve(d);
          })
          .catch((e) => {
            errors.push(`${ep.tag}: ${e.message}`);
            if (--pending === 0 && !done) reject(new Error(errors.join(' | ')));
          });
      }
    });
  } finally {
    ac.abort();
  }
}

// Resolve one quality into a downloadable file entry (races the endpoints).
export async function resolveQuality(shareUrl, format = '360', type = 'mp4', ctx = {}) {
  if (!YT_API_KEY) throw new Error('YouTube resolver API key is not configured');
  const d = await raceFastest(shareUrl, format, type, ctx.timeoutMs);

  const title = String(d.title || 'youtube-video').trim() || 'youtube-video';
  const ext = type === 'mp3' ? 'mp3' : 'mp4';

  // Learn the real file size with one HEAD request (non-fatal if it fails).
  let sizeBytes = 0;
  try {
    const head = await fetch(d.download, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
    const len = Number(head.headers.get('content-length') || 0);
    if (len > 0) sizeBytes = len;
  } catch {}

  const durationSec = Number(d.duration) || 0;
  const durationTxt = durationSec
    ? `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, '0')} min`
    : '';

  const id = ytId(shareUrl);
  const safeTitle = title.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80) || 'youtube-video';
  const qualityLabel =
    type === 'mp3' ? `MP3 ${String(d.quality || '').trim()}`.trim() : `${format}p`;
  const thumb =
    typeof d.thumbnail === 'string' && /^https?:\/\//.test(d.thumbnail)
      ? d.thumbnail
      : ytThumb(id);

  return {
    name: `${safeTitle} [${qualityLabel}].${ext}`,
    size: sizeBytes ? formatSize(sizeBytes) : durationTxt || 'unknown size',
    size_bytes: sizeBytes,
    thumbnail: thumb,
    dlink: d.download,
    is_dir: false,
    path: '',
    fs_id: '',
  };
}
