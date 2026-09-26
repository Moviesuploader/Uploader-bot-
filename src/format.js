import { config } from './config.js';
import { fileEmoji } from './utils.js';

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const trunc = (s, n = 40) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

const MAX_BUTTONS = 10; // Telegram allows up to 100, but keep messages tidy.
const MAX_SONG_RESULTS = 4; // keep the /song card under Telegram's 4096-char cap

const PROVIDER_STYLE = {
  diskwala: { icon: '🎬', label: 'DISKWALA' },
  terabox: { icon: '🌐', label: 'TERABOX' },
  youtube: { icon: '📺', label: 'YOUTUBE' },
};

const SONG_SECTIONS = {
  apple: { icon: '🍎', label: 'APPLE MUSIC' },
  spotify: { icon: '🟢', label: 'SPOTIFY' },
  whatmusic: { icon: '🎧', label: 'WHATMUSIC' },
};

const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// /song search results card — sections in the fixed order they were fetched.
export function buildSongPayload(query, sections) {
  const lines = [
    `🎵 <b><u>SONG SEARCH</u></b>`,
    '',
    `<code>▎🔎 ${esc(trunc(query, 32))}</code>`,
    '',
  ];
  let total = 0;
  for (const sec of sections) {
    const style = SONG_SECTIONS[sec.id] || { icon: '🎵', label: sec.id.toUpperCase() };
    lines.push(DIVIDER);
    lines.push(`${style.icon} <b><u>${style.label}</u></b>`);
    if (sec.error) {
      lines.push(`<blockquote>⚠️ <i>${esc(sec.error)}</i></blockquote>`);
    } else if (!sec.results.length) {
      lines.push('<blockquote>😶 <i>no results found</i></blockquote>');
    } else {
      total += sec.results.length;
      sec.results.slice(0, MAX_SONG_RESULTS).forEach((r, i) => {
        const open = r.url ? `  •  <a href="${esc(r.url)}">▶️ open</a>` : '';
        lines.push(
          `${i + 1}. <b>${esc(trunc(r.title, 38))}</b>${r.artist ? `\n    🎤 ${esc(trunc(r.artist, 38))}` : ''}${open}`,
        );
      });
      if (sec.results.length > MAX_SONG_RESULTS) {
        lines.push(`<i>…and ${sec.results.length - MAX_SONG_RESULTS} more</i>`);
      }
    }
    lines.push('');
  }
  lines.push(DIVIDER);
  lines.push(`<i>🏁 ${total} result${total === 1 ? '' : 's'} across ${sections.length} services</i>`);
  return { text: lines.join('\n') };
}

// Quality-picker card (YouTube): the actual download links resolve lazily
// when a quality button is tapped. Callback data: q:<cacheId>:<format>:<type>
// for downloads, k:<cacheId>:<format>:<type> for the direct link.
function buildQualityPayload(result, cacheId) {
  const style = PROVIDER_STYLE[result.provider] || {
    icon: '📦',
    label: result.provider.toUpperCase(),
  };
  const lines = [
    `${style.icon} <b><u>${style.label} — LINK READY</u></b>`,
    '',
    '<code>▎✅ Video found</code>',
    '',
    DIVIDER,
    `🎬 ${esc(result.title || 'YouTube video')}`,
  ];
  if (result.author) lines.push(`📺 ${esc(result.author)}`);
  lines.push(
    DIVIDER,
    '',
    '<b>👇 Pick a quality:</b>',
    '',
    '<blockquote>📺 <b>MP4</b> — video (360p / 720p)\n🎵 <b>MP3</b> — audio only</blockquote>',
  );

  const keyboard = [
    [
      { text: '📺 360p MP4', callback_data: `q:${cacheId}:360:mp4` },
      { text: '📺 720p MP4', callback_data: `q:${cacheId}:720:mp4` },
    ],
    [
      { text: '🎵 MP3 Audio', callback_data: `q:${cacheId}:best:mp3` },
      { text: '🔗 360p link', callback_data: `k:${cacheId}:360:mp4` },
    ],
  ];

  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: keyboard },
    fileCount: 1,
  };
}

// Build the info message + inline keyboard for a resolved share link.
// Button callback_data format: "dl:<cacheId>:<fileIndex>" / "ln:<cacheId>:<fileIndex>"
// (Telegram caps callback_data at 64 bytes — hence the short cache id.)
export function buildInfoPayload(result, cacheId) {
  if (Array.isArray(result.qualities) && result.qualities.length) {
    return buildQualityPayload(result, cacheId);
  }

  const files = result.files.filter((f) => !f.is_dir);
  const shown = files.slice(0, MAX_BUTTONS);
  const maxBytes = config.maxFileMb * 1024 * 1024;
  const style = PROVIDER_STYLE[result.provider] || {
    icon: '📦',
    label: result.provider.toUpperCase(),
  };

  const lines = [
    `${style.icon} <b><u>${style.label} — LINK READY</u></b>`,
    '',
    files.length
      ? `<code>▎✅ ${files.length} file${files.length === 1 ? '' : 's'} resolved</code>`
      : '<code>▎📭 Empty share</code>',
    '',
    DIVIDER,
  ];

  shown.forEach((f, i) => {
    const tooBig = f.size_bytes > maxBytes;
    lines.push(`${fileEmoji(f.name)} ${esc(f.name)}`);
    lines.push(
      `💾 ${esc(f.size)}` + (tooBig ? '  •  ⚠️ <i>over chat limit — link only</i>' : ''),
    );
    if (i < shown.length - 1) lines.push('');
  });

  if (files.length > shown.length) {
    lines.push(
      '',
      `➕ <i>${files.length - shown.length} more file(s) — only the first ${MAX_BUTTONS} get buttons.</i>`,
    );
  }
  if (!files.length) {
    lines.push('Only folders found in this share — nothing to download directly.');
  }

  lines.push(
    DIVIDER,
    '',
    '<b>👇 Pick an action:</b>',
    '',
    '<blockquote>⬇️ <b>Download</b> — file lands right here in chat\n🔗 <b>Direct link</b> — raw URL, tap to copy</blockquote>',
  );

  const keyboard = shown.map((f, i) => [
    {
      text: files.length > 1 ? `⬇️ Download #${i + 1}` : '⬇️ Download',
      callback_data: `dl:${cacheId}:${i}`,
    },
    {
      text: files.length > 1 ? `🔗 #${i + 1}` : '🔗 Direct Link',
      callback_data: `ln:${cacheId}:${i}`,
    },
  ]);

  return {
    text: lines.join('\n'),
    reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
    fileCount: files.length,
  };
}
