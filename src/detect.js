import { pickProvider } from './providers/index.js';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

// Pull every supported Diskwala/Terabox link out of a message.
// Returns at most `limit` links so one message can't flood the resolver.
export function extractMediaLinks(text, limit = 3) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(URL_RE)) {
    let u;
    try {
      u = new URL(m[0]);
    } catch {
      continue;
    }
    const provider = pickProvider(u.hostname);
    if (!provider) continue;
    const normalized = u.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ url: normalized, provider });
    if (out.length >= limit) break;
  }
  return out;
}
