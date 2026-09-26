// Music search across the hosted search API — Apple Music, Spotify, WhatMusic.
// All three are fetched in parallel for speed and displayed in the fixed
// order the user asked for: Apple Music → Spotify → WhatMusic.

const SEARCH_API_BASE =
  process.env.SEARCH_API_BASE ||
  process.env.TERABOX_API_BASE ||
  'https://api-dark-shan-yt.koyeb.app';
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || process.env.TERABOX_API_KEY || '';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

async function searchOne(path, query, timeoutMs) {
  const url = `${SEARCH_API_BASE}${path}?q=${encodeURIComponent(query)}&apikey=${encodeURIComponent(SEARCH_API_KEY)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(Math.max(timeoutMs || 0, 30_000)),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const firstString = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

function normalizeApple(json) {
  const items = Array.isArray(json?.data) ? json.data : [];
  return items
    .map((it) => ({
      title: firstString(it, ['title', 'name']),
      artist: it.artist?.name || firstString(it, ['artist', 'artistName']),
      url: firstString(it, ['song', 'url', 'link']),
      image: typeof it.image === 'string' ? it.image : '',
    }))
    .filter((x) => x.title);
}

function normalizeSpotify(json) {
  if (json && json.success === false) throw new Error(json.message || 'Spotify search failed');
  const items = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.results)
      ? json.results
      : [];
  return items
    .map((it) => ({
      title: firstString(it, ['title', 'name', 'song_name']),
      artist: Array.isArray(it.artists)
        ? it.artists.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(', ')
        : firstString(it, ['artist', 'artist_name']),
      url: firstString(it, ['url', 'link', 'spotify_url']) || it.external_urls?.spotify || '',
      image:
        (typeof it.image === 'string' && it.image) ||
        (typeof it.thumbnail === 'string' && it.thumbnail) ||
        it.album?.images?.[0]?.url ||
        '',
    }))
    .filter((x) => x.title);
}

function normalizeWhatmusic(json) {
  const d = json?.data;
  let items = [];
  if (Array.isArray(d)) items = d;
  else if (d && Array.isArray(d.results)) items = d.results;
  else if (d && typeof d === 'object' && Object.keys(d).length) items = [d];
  return items
    .map((it) => ({
      title: firstString(it, ['title', 'name', 'song', 'track']),
      artist: firstString(it, ['artist', 'subtitle', 'author']),
      url: firstString(it, ['url', 'link', 'song_link', 'share_url']),
      image: (typeof it.image === 'string' && it.image) || (typeof it.cover === 'string' && it.cover) || '',
    }))
    .filter((x) => x.title);
}

// Returns three sections in the fixed order: apple → spotify → whatmusic.
// Each section is { id, results } or { id, error }.
export async function searchMusic(query, timeoutMs = 30_000) {
  if (!SEARCH_API_KEY) throw new Error('Search API key is not configured');
  const settled = await Promise.allSettled([
    searchOne('/search/apple-music', query, timeoutMs),
    searchOne('/search/spotify-v2', query, timeoutMs),
    searchOne('/search/whatmusic', query, timeoutMs),
  ]);
  const normalizers = [normalizeApple, normalizeSpotify, normalizeWhatmusic];
  const ids = ['apple', 'spotify', 'whatmusic'];
  return settled.map((s, i) => {
    if (s.status === 'rejected') return { id: ids[i], error: s.reason?.message || 'failed' };
    try {
      return { id: ids[i], results: normalizers[i](s.value) };
    } catch (e) {
      return { id: ids[i], error: e.message };
    }
  });
}
