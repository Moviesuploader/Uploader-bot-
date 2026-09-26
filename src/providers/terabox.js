import { formatSize, findBetween } from '../utils.js';

export const name = 'terabox';

// Terabox and its known mirror/alias domains. Share links on any of these
// resolve through the same backend.
export const hosts = new Set([
  'terabox.com',
  'www.terabox.com',
  'terabox.app',
  'www.terabox.app',
  'teraboxapp.com',
  'www.teraboxapp.com',
  '1024terabox.com',
  'www.1024terabox.com',
  '1024tera.com',
  'www.1024tera.com',
  '1024tera.co',
  'www.1024tera.co',
  'teraboxlink.com',
  'www.teraboxlink.com',
  'terasharelink.com',
  'www.terasharelink.com',
  'terafileshare.com',
  'www.terafileshare.com',
  'nephobox.com',
  'www.nephobox.com',
  'freeterabox.com',
  'www.freeterabox.com',
  '4funbox.com',
  'www.4funbox.com',
  'mirrobox.com',
  'www.mirrobox.com',
  'momerybox.com',
  'www.momerybox.com',
  'tibibox.com',
  'www.tibibox.com',
  'dubox.com',
  'www.dubox.com',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0';

// Browser-like headers. Do NOT set Host / Connection / Accept-Encoding —
// undici manages those itself and rejects some of them.
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  DNT: '1',
  'sec-ch-ua': '"Microsoft Edge";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const LIST_ENDPOINT = 'https://www.terabox.com/share/list';

function headersWithCookie(cookie) {
  return cookie ? { ...BROWSER_HEADERS, Cookie: cookie } : { ...BROWSER_HEADERS };
}

// Headers used when streaming the actual file bytes from the dlink/CDN.
export function downloadHeaders(cookie) {
  const h = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.terabox.com/',
    DNT: '1',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function extractSurl(finalUrl) {
  try {
    const u = new URL(finalUrl);
    const fromQuery = u.searchParams.get('surl');
    if (fromQuery) return fromQuery;
    // /s/1AbCd style links: the surl is the path segment minus the leading "1".
    const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (m) return m[1].startsWith('1') ? m[1].slice(1) : m[1];
  } catch {
    /* fall through */
  }
  return null;
}

function extractTokens(html) {
  const jsToken =
    findBetween(html, 'fn%28%22', '%22%29') ||
    (html.match(/jsToken\s*[:=]\s*"([^"]+)"/) || [])[1] ||
    '';
  const logid =
    findBetween(html, 'dp-logid=', '&') ||
    (html.match(/dp-logid=([A-Za-z0-9%]+)/) || [])[1] ||
    '';
  const bdstoken =
    findBetween(html, 'bdstoken":"', '"') ||
    (html.match(/bdstoken\\?"\s*:\s*\\?"([^"\\]+)/) || [])[1] ||
    '';
  return { jsToken, logid, bdstoken };
}

async function resolveWithCookie(shareUrl, cookie, ctx) {
  const timeout = AbortSignal.timeout(ctx.timeoutMs);

  // 1. Follow the share link to the canonical share page (gives us ?surl=).
  let resp = await fetch(shareUrl, {
    headers: headersWithCookie(cookie),
    redirect: 'follow',
    signal: timeout,
  });
  if (!resp.ok) throw new Error(`Share link fetch failed (HTTP ${resp.status})`);
  const finalUrl = resp.url;
  const surl = extractSurl(finalUrl);
  if (!surl) {
    throw new Error('Invalid share link (no surl found). Check the link or your cookie.');
  }

  // 2. Load the share page HTML and pull the tokens the internal API requires.
  resp = await fetch(finalUrl, {
    headers: headersWithCookie(cookie),
    redirect: 'follow',
    signal: timeout,
  });
  if (!resp.ok) throw new Error(`Share page fetch failed (HTTP ${resp.status})`);
  const html = await resp.text();
  const { jsToken, logid } = extractTokens(html);
  if (!jsToken || !logid) {
    throw new Error('Failed to extract tokens from share page (cookie may be expired)');
  }

  // 3. Call the internal share/list API for file metadata + dlink.
  const params = new URLSearchParams({
    app_id: '250528',
    web: '1',
    channel: 'dubox',
    clienttype: '0',
    jsToken,
    'dp-logid': logid,
    page: '1',
    num: '100',
    by: 'name',
    order: 'asc',
    site_referer: finalUrl,
    shorturl: surl,
    root: '1,',
  });
  resp = await fetch(`${LIST_ENDPOINT}?${params.toString()}`, {
    headers: headersWithCookie(cookie),
    signal: timeout,
  });
  if (!resp.ok) throw new Error(`File list fetch failed (HTTP ${resp.status})`);
  const data = await resp.json();
  if (data.errno) {
    throw new Error(`Terabox API error ${data.errno}${data.errmsg ? `: ${data.errmsg}` : ''}`);
  }
  if (!Array.isArray(data.list) || data.list.length === 0) {
    throw new Error('No files found for this share link');
  }

  const files = data.list.map((f) => ({
    name: f.server_filename || 'file',
    size: formatSize(Number.parseInt(f.size, 10) || 0),
    size_bytes: Number.parseInt(f.size, 10) || 0,
    thumbnail: (f.thumbs && (f.thumbs.url3 || f.thumbs.url2 || f.thumbs.url1)) || '',
    dlink: f.dlink || '',
    is_dir: f.isdir === 1 || f.isdir === '1',
    path: f.path || '',
    fs_id: f.fs_id ? String(f.fs_id) : '',
  }));

  return {
    provider: name,
    share_url: shareUrl,
    final_url: finalUrl,
    surl,
    title: data.title || '',
    files,
  };
}

export async function resolveInfo(shareUrl, ctx) {
  const attempts = Math.max(1, Math.min(ctx.cookies.size || 1, 3));
  let lastError = 'Resolution failed';
  for (let i = 0; i < attempts; i += 1) {
    const cookie = ctx.cookies.next() || '';
    try {
      return await resolveWithCookie(shareUrl, cookie, ctx);
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(lastError);
}
