import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './src/config.js';
import { cookiePool } from './src/cookies.js';
import * as tg from './src/telegram.js';
import { extractMediaLinks } from './src/detect.js';
import { buildInfoPayload, esc } from './src/format.js';
import { formatSize, fileEmoji } from './src/utils.js';
import { Cache } from './src/cache.js';
import * as mtproto from './src/mtproto.js';

if (!config.botToken) {
  console.error('BOT_TOKEN is missing — set it in .env and restart.');
  process.exit(1);
}

const downloadDir = path.resolve(config.downloadDir);
fs.mkdirSync(downloadDir, { recursive: true });

const execFileAsync = promisify(execFile);
const cache = new Cache();
const botApiMaxBytes = config.maxFileMb * 1024 * 1024;
const downloadMaxBytes = config.downloadMaxMb > 0 ? config.downloadMaxMb * 1024 * 1024 : Infinity;

// Hosting health endpoint. Koyeb/Render-style web services require a listening
// port even though Telegram itself is handled through long polling.
const healthPort = Number(process.env.PORT || 8000);
const healthServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'uploader-bot', uptime: Math.round(process.uptime()) }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});
healthServer.listen(healthPort, '0.0.0.0', () => {
  console.log(`Health server listening on 0.0.0.0:${healthPort}`);
});

// --- Access control (private bot) ---
// Owner ids come from ALLOWED_USERS (comma-separated) and/or data/owner.json.
// When neither exists, the first /start claims ownership (persisted to disk).
const ownerFile = path.resolve('data/owner.json');
const ownerIds = new Set(
  (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
try {
  for (const id of JSON.parse(fs.readFileSync(ownerFile, 'utf8'))) ownerIds.add(String(id));
} catch {}
function claimOwner(chatId) {
  ownerIds.add(String(chatId));
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  fs.writeFileSync(ownerFile, JSON.stringify([...ownerIds]));
  console.log(`[access] owner claimed: ${chatId}`);
}


const mtprotoSetup = new Map();

function isAdmin(chatId) {
  return ownerIds.has(String(chatId));
}

function mtprotoPanelText() {
  const st = mtproto.status();
  return `⚙️ <b>MTProto Admin Setup</b>\n\n🆔 API ID: <code>${st.apiId || 'Not set'}</code>\n🔐 API Hash: <code>${st.hasApiHash ? 'Configured' : 'Not set'}</code>\n📱 Session: <code>${st.hasSession ? 'Configured' : 'Not set'}</code>\n\nStatus: ${st.enabled ? '✅ Ready for large uploads' : '⚠️ Not configured'}\n\nSensitive values are never echoed back in chat.`;
}

function mtprotoPanelMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '🆔 Set API ID', callback_data: 'mt:apiid' },
        { text: '🔐 Set API Hash', callback_data: 'mt:apihash' },
      ],
      [{ text: '📱 Set Session', callback_data: 'mt:session' }],
      [
        { text: '🧪 Test Connection', callback_data: 'mt:test' },
        { text: '🗑 Clear Config', callback_data: 'mt:clear' },
      ],
      [{ text: '🔄 Refresh', callback_data: 'mt:refresh' }],
    ],
  };
}

async function showMtprotoPanel(chatId, messageId = null) {
  const text = mtprotoPanelText();
  if (messageId) {
    await tg.editMessageText(chatId, messageId, text, { reply_markup: mtprotoPanelMarkup() });
  } else {
    await tg.sendMessage(chatId, text, { reply_markup: mtprotoPanelMarkup() });
  }
}

async function handleMtprotoCallback(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || !isAdmin(chatId)) {
    await tg.answerCallbackQuery(cq.id, '🔒 Admin only', true);
    return;
  }

  const action = String(cq.data || '').split(':')[1] || '';

  if (action === 'refresh') {
    await tg.answerCallbackQuery(cq.id, 'Refreshed');
    await showMtprotoPanel(chatId, cq.message.message_id);
    return;
  }

  if (action === 'clear') {
    mtproto.clearConfig();
    await tg.answerCallbackQuery(cq.id, 'Config cleared');
    await showMtprotoPanel(chatId, cq.message.message_id);
    return;
  }

  if (action === 'test') {
    await tg.answerCallbackQuery(cq.id, 'Testing MTProto…');
    try {
      const result = await mtproto.testConnection();
      await tg.editMessageText(chatId, cq.message.message_id,
        `🧪 <b>MTProto connection OK</b> ✅\n\n👤 Account: <code>@${esc(result.username || 'private')}</code>\n🆔 ID: <code>${esc(result.id)}</code>\n⭐ Premium: <b>${result.premium ? 'Yes' : 'No'}</b>`,
        { reply_markup: mtprotoPanelMarkup() });
    } catch (err) {
      await tg.editMessageText(chatId, cq.message.message_id,
        `❌ <b>MTProto connection failed</b>\n<blockquote>${esc(err.message)}</blockquote>`,
        { reply_markup: mtprotoPanelMarkup() });
    }
    return;
  }

  const stepMap = { apiid: 'apiId', apihash: 'apiHash', session: 'session' };
  const step = stepMap[action];
  if (!step) return;

  mtprotoSetup.set(String(chatId), { step, values: {} });
  const prompts = {
    apiId: '🆔 <b>Send API ID</b>\n\nOnly the numeric API ID.\n/cancel to abort.',
    apiHash: '🔐 <b>Send API Hash</b>\n\nIt will not be echoed back.\n/cancel to abort.',
    session: '📱 <b>Send Session String</b>\n\nIt will not be echoed back.\n/cancel to abort.',
  };
  await tg.answerCallbackQuery(cq.id);
  await tg.sendMessage(chatId, prompts[step]);
}

async function handleMtprotoSetupMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId || !isAdmin(chatId)) return false;

  const state = mtprotoSetup.get(String(chatId));
  if (!state) return false;

  const text = String(msg.text || '').trim();
  if (!text) return true;

  if (text === '/cancel') {
    mtprotoSetup.delete(String(chatId));
    await tg.sendMessage(chatId, '❌ MTProto setup cancelled.');
    return true;
  }

  if (state.step === 'apiId') {
    if (!/^\d+$/.test(text) || Number(text) <= 0) {
      await tg.sendMessage(chatId, '❌ API ID must be a positive number. Try again or /cancel.');
      return true;
    }
    state.values.apiId = Number(text);
    state.step = 'apiHash';
    await tg.sendMessage(chatId, '🔐 <b>Now send the API Hash.</b>\n\nIt will not be echoed back.');
    return true;
  }

  if (state.step === 'apiHash') {
    if (text.length < 10) {
      await tg.sendMessage(chatId, '❌ API Hash looks too short. Try again or /cancel.');
      return true;
    }
    state.values.apiHash = text;
    state.step = 'session';
    await tg.sendMessage(chatId, '📱 <b>Now send the Session String.</b>\n\nIt will not be echoed back.');
    return true;
  }

  if (state.step === 'session') {
    if (text.length < 20) {
      await tg.sendMessage(chatId, '❌ Session String looks too short. Try again or /cancel.');
      return true;
    }

    try {
      mtproto.saveConfig({ apiId: state.values.apiId, apiHash: state.values.apiHash, session: text });
      mtprotoSetup.delete(String(chatId));
      await tg.sendMessage(chatId, '💾 <b>MTProto config saved.</b>\n\n🧪 Testing connection now…');
      const result = await mtproto.testConnection();
      await tg.sendMessage(chatId,
        `✅ <b>MTProto is ready!</b>\n\n👤 Account: <code>@${esc(result.username || 'private')}</code>\n🆔 ID: <code>${esc(result.id)}</code>\n⭐ Premium: <b>${result.premium ? 'Yes' : 'No'}</b>\n\nLarge TeraBox uploads can now use this session.`);
    } catch (err) {
      await tg.sendMessage(chatId,
        `⚠️ <b>Config saved, but connection test failed.</b>\n<blockquote>${esc(err.message)}</blockquote>\n\nOpen /mtproto to retry.`);
    }
    return true;
  }

  return true;
}

const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'mpg', 'mpeg']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac', 'opus', 'wma']);
const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
};
const mediaKind = (name) => {
  const e = extOf(name);
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'document';
};

// Build a clean Telegram filename that ALWAYS keeps its extension. Telegram
// clients can't open files whose names get truncated past the extension.
function safeFileName(name, dlink) {
  let base = String(name || '').trim().replace(/[\\/:*?"<>|\r\n]+/g, '_');
  if (/^https?:/i.test(base)) base = '';
  let ext = extOf(base);
  if (!ext && dlink) {
    try {
      ext = extOf(decodeURIComponent(new URL(dlink).pathname));
    } catch {
      ext = '';
    }
  }
  let core = base;
  if (ext && core.toLowerCase().endsWith('.' + ext)) core = core.slice(0, -(ext.length + 1));
  core = core.replace(/\.+$/, '').trim() || 'file';
  if (core.length > 60) core = core.slice(0, 60).trimEnd();
  return ext ? `${core}.${ext}` : core;
}

// Download a dlink to a temp file, enforcing the size cap both from the
// content-length header and while streaming.
async function downloadToDisk(dlink, headers, ext = '', onProgress = null) {
  const resp = await fetch(dlink, { headers, redirect: 'follow' });
  if (!resp.ok && resp.status !== 206) {
    resp.body?.cancel().catch(() => {});
    throw new Error(`download failed (HTTP ${resp.status})`);
  }
  const len = Number(resp.headers.get('content-length') || 0);
  if (len > downloadMaxBytes) {
    resp.body?.cancel().catch(() => {});
    const e = new Error('too_big');
    e.tooBig = true;
    throw e;
  }
  const tmp = path.join(
    downloadDir,
    `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext ? `.${ext}` : ''}`,
  );
  let received = 0;
  const guard = new Transform({
    transform(chunk, enc, cb) {
      received += chunk.length;
      if (onProgress) {
        try {
          onProgress(received, len);
        } catch {}
      }
      if (received > downloadMaxBytes) {
        const e = new Error('too_big');
        e.tooBig = true;
        cb(e);
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(resp.body), guard, fs.createWriteStream(tmp));
  } catch (err) {
    fs.unlink(tmp, () => {});
    throw err;
  }
  return tmp;
}

async function convertToTelegramVideo(inputPath, filename) {
  const ext = extOf(filename);
  if (ext === 'mp4') return { path: inputPath, filename };

  const base = filename.replace(/\.[^.]+$/, '') || 'video';
  const outputPath = path.join(
    downloadDir,
    `tg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`,
  );
  const timeout = Number(process.env.FFMPEG_TIMEOUT_MS || 2 * 60 * 60 * 1000);

  // For multi-GB sources, try a lossless container remux first. Only
  // re-encode when the source codecs cannot be placed in MP4.
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], { timeout });
  } catch {
    fs.unlink(outputPath, () => {});
    try {
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-preset', process.env.FFMPEG_PRESET || 'veryfast',
        '-crf', process.env.FFMPEG_CRF || '23',
        '-c:a', 'aac',
        '-b:a', process.env.FFMPEG_AUDIO_BITRATE || '128k',
        '-movflags', '+faststart',
        outputPath,
      ], { timeout });
    } catch (err) {
      fs.unlink(outputPath, () => {});
      throw new Error(`video conversion failed: ${err.message}`);
    }
  }

  const stat = fs.statSync(outputPath);
  if (stat.size > downloadMaxBytes) {
    fs.unlink(outputPath, () => {});
    const e = new Error('too_big');
    e.tooBig = true;
    throw e;
  }
  return { path: outputPath, filename: `${base}.mp4` };
}
async function handleMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const text = msg.text || msg.caption || '';

  // Private bot: first /start claims ownership; everyone else is rejected.
  if (!ownerIds.size) {
    if (!text.startsWith('/start')) {
      await tg.sendMessage(
        chatId,
        "🔒 <b>Private bot</b>\n\nIt isn't claimed yet — send /start to become its owner. 👑",
      );
      return;
    }
    claimOwner(chatId);
    await tg.sendMessage(
      chatId,
      `✅ <b>Ownership claimed!</b> 👑\n\n<blockquote>Only your account can use this bot from now on.</blockquote>\n🆔 <code>${chatId}</code>`,
    );
  } else if (!ownerIds.has(String(chatId))) {
    console.log(`[access] blocked unauthorized chat ${chatId}`);
    await tg.sendMessage(chatId, '🔒 <b>Private bot</b>\n<blockquote>Access denied.</blockquote>');
    return;
  }

  if (await handleMtprotoSetupMessage(msg)) return;

  if (text.startsWith('/mtproto') || text.startsWith('/admin')) {
    await showMtprotoPanel(chatId);
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    await tg.sendMessage(
      chatId,
      `👋 <b>Welcome to the Diskwala & Terabox Downloader!</b>\n\n` +
        `<blockquote>🔗 Send me a share link and I'll fetch the file info instantly.</blockquote>\n\n` +
        `<b>What I can do:</b>\n` +
        `🎬 Diskwala links → info + downloads\n` +
        `🌐 Terabox links → info + downloads\n` +
        `▶️ YouTube links → video downloads\n` +
        `📦 Small files use Bot API; large files use MTProto when configured\n` +
        `🎬 Video output is normalized to MP4 for playback\n\n` +
        `<i>Just paste a link to start ⚡</i>`,
    );
    return;
  }

  const links = extractMediaLinks(text);
  if (!links.length) {
    if (text.startsWith('/')) return; // ignore unknown commands silently
    await tg.sendMessage(
      chatId,
      '🤔 <b>No link found there.</b>\n\nSend me a Diskwala, Terabox, or YouTube link, e.g.\n<code>https://youtu.be/xxxx</code>',
    );
    return;
  }

  for (const { url, provider } of links) {
    const status = await tg.sendMessage(chatId, '🔍 <i>Resolving your link…</i> ⏳');
    try {
      const result = await provider.resolveInfo(url, {
        cookies: cookiePool,
        timeoutMs: config.requestTimeoutMs,
      });
      const id = cache.put({ result, provider });
      const payload = buildInfoPayload(result, id);
      await tg.deleteMessage(chatId, status.message_id);
      await tg.sendMessage(chatId, payload.text, {
        reply_markup: payload.reply_markup,
        reply_to_message_id: msg.message_id,
      });
    } catch (err) {
      await tg.editMessageText(
        chatId,
        status.message_id,
        `❌ <b>Failed to resolve</b>\n<blockquote>${esc(err.message)}</blockquote>`,
      );
    }
  }
}

// Download + upload pipeline shared by direct downloads and quality picks.
// Reuses an existing status message when one is passed (quality flow).
async function deliverFile(chatId, file, provider, status = null) {
  const statusMsg =
    status ||
    (await tg.sendMessage(
      chatId,
      `⏬ <b>Preparing download…</b>\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n💾 <code>${esc(file.size)}</code>`,
    ));
  const statusId = statusMsg.message_id;
  let tmp = null;
  let thumbPath = null;
  try {
    const fname = safeFileName(file.name, file.dlink);
    const kind = mediaKind(fname);
    const headers = provider.downloadHeaders(cookiePool.next() || '');
    let lastEdit = 0;
    const startedAt = Date.now();
    const onProgress = (received, total) => {
      const now = Date.now();
      if (now - lastEdit < 4000) return; // stay under Telegram's edit rate limit
      lastEdit = now;
      const pct = total ? Math.floor((received / total) * 100) : null;
      const bar =
        pct == null
          ? ''
          : `${'▰'.repeat(Math.floor(pct / 10))}${'▱'.repeat(10 - Math.floor(pct / 10))} ${pct}%`;
      const secs = Math.max(1, (now - startedAt) / 1000);
      const speed = `${formatSize(Math.round(received / secs))}/s`;
      tg.editMessageText(
        chatId,
        statusId,
        `⏬ <b>Downloading…</b>\n${fileEmoji(fname)} <b>${esc(fname)}</b>\n💾 <code>${esc(formatSize(received))}${total ? ` / ${esc(formatSize(total))}` : ''}</code>  ⚡ <code>${esc(speed)}</code>${bar ? `\n${bar}` : ''}`,
      );
    };
    tmp = await downloadToDisk(file.dlink, headers, extOf(fname), onProgress);

    // Telegram's sendVideo expects a playable video container; normalize
    // non-MP4 video sources to MP4 instead of silently sending them as files.
    let uploadPath = tmp;
    let uploadName = fname;
    if (kind === 'video' && extOf(fname) !== 'mp4') {
      const converted = await convertToTelegramVideo(tmp, fname);
      uploadPath = converted.path;
      uploadName = converted.filename;
      fs.unlink(tmp, () => {});
      tmp = uploadPath;
    }

    // Attach the provider thumbnail to playable media when available.
    if (file.thumbnail && (kind === 'video' || kind === 'audio')) {
      try {
        const t = await fetch(file.thumbnail, { signal: AbortSignal.timeout(15_000) });
        if (t.ok) {
          thumbPath = `${tmp}.jpg`;
          fs.writeFileSync(thumbPath, Buffer.from(await t.arrayBuffer()));
        }
      } catch {}
    }

    await tg.editMessageText(
      chatId,
      statusId,
      `📤 <b>Uploading to Telegram…</b>\n${fileEmoji(fname)} <b>${esc(fname)}</b>\n💾 <code>${esc(file.size)}</code>\n<blockquote>☕ Big files can take a while — hang tight.</blockquote>`,
    );
    await tg.sendChatAction(
      chatId,
      kind === 'video' ? 'upload_video' : kind === 'audio' ? 'upload_audio' : 'upload_document',
    );
    const caption = `✅ <b>${esc(uploadName)}</b>\n💾 ${esc(file.size)}`;
    const actualSize = fs.statSync(uploadPath).size;
    const needsMtproto = actualSize > botApiMaxBytes;

    if (needsMtproto) {
      if (!mtproto.isEnabled()) {
        throw new Error(
          `large upload requires MTProto session (file is ${formatSize(actualSize)}; Bot API limit is ${config.maxFileMb} MB)`,
        );
      }

      let uploadLastEdit = 0;
      const uploadStartedAt = Date.now();
      await mtproto.sendLargeFile({
        chatId,
        filePath: uploadPath,
        caption,
        onProgress: (uploaded, total) => {
          const now = Date.now();
          if (now - uploadLastEdit < 4000) return;
          uploadLastEdit = now;
          const pct = total ? Math.floor((uploaded / total) * 100) : null;
          const bar = pct == null
            ? ''
            : `${'▰'.repeat(Math.floor(pct / 10))}${'▱'.repeat(10 - Math.floor(pct / 10))} ${pct}%`;
          const secs = Math.max(1, (now - uploadStartedAt) / 1000);
          const speed = `${formatSize(Math.round(uploaded / secs))}/s`;
          tg.editMessageText(
            chatId,
            statusId,
            `📤 <b>Uploading via MTProto…</b>\n${fileEmoji(uploadName)} <b>${esc(uploadName)}</b>\n💾 <code>${esc(formatSize(uploaded))}${total ? ` / ${esc(formatSize(total))}` : ''}</code>  ⚡ <code>${esc(speed)}</code>${bar ? `\n${bar}` : ''}`,
          );
        },
      });
    } else {
      await tg.sendChatAction(
        chatId,
        kind === 'video' ? 'upload_video' : kind === 'audio' ? 'upload_audio' : 'upload_document',
      );
      try {
        await tg.sendFile({
          chatId,
          filePath: uploadPath,
          filename: uploadName,
          caption,
          kind: kind === 'video' ? 'video' : kind,
          thumbPath,
        });
      } catch (e1) {
        if (kind === 'document') throw e1;
        console.error(`${kind} upload failed (${e1.message}) — retrying as document`);
        await tg.sendFile({
          chatId,
          filePath: uploadPath,
          filename: uploadName,
          caption,
          kind: 'document',
        });
      }
    }
    await tg.deleteMessage(chatId, statusId);
  } catch (err) {
    const reason = err.tooBig
      ? 'the file exceeded the configured download-size cap'
      : esc(err.message);
    await tg.editMessageText(
      chatId,
      statusId,
      `❌ <b>Download failed</b>\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n<blockquote>${reason}</blockquote>\n🔗 <b>Direct link:</b>\n<pre>${esc(file.dlink)}</pre>`,
    );
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
    if (thumbPath) fs.unlink(thumbPath, () => {});
  }
}

async function handleCallback(cq) {
  if (String(cq.data || '').startsWith('mt:')) {
    await handleMtprotoCallback(cq);
    return;
  }

  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (ownerIds.size && !ownerIds.has(String(chatId))) {
    await tg.answerCallbackQuery(cq.id, '🔒 Private bot', true);
    return;
  }
  const [action, id, a, b] = String(cq.data || '').split(':');
  const entry = cache.get(id);
  if (!chatId || !entry || !['dl', 'ln', 'q', 'k'].includes(action)) {
    await tg.answerCallbackQuery(cq.id, '⚠️ This button expired — send the link again', true);
    return;
  }

  // --- Quality pick (YouTube): "q" downloads, "k" sends the direct link ---
  if (action === 'q' || action === 'k') {
    const format = a;
    const type = b;
    const qualityLabel = type === 'mp3' ? 'MP3 audio' : `${format}p`;
    if (!entry.provider.resolveQuality) {
      await tg.answerCallbackQuery(cq.id, 'Quality choice is not supported for this link', true);
      return;
    }
    await tg.answerCallbackQuery(cq.id, `⏬ Preparing ${qualityLabel}…`);
    const status = await tg.sendMessage(
      chatId,
      `🔍 <i>Resolving ${esc(qualityLabel)}…</i> ⏳\n<blockquote>☕ The YouTube API can take ~1 minute.</blockquote>`,
    );
    let file;
    try {
      file = await entry.provider.resolveQuality(entry.result.share_url, format, type, {
        cookies: cookiePool,
        timeoutMs: config.requestTimeoutMs,
      });
    } catch (err) {
      await tg.editMessageText(
        chatId,
        status.message_id,
        `❌ <b>Failed to resolve ${esc(qualityLabel)}</b>\n<blockquote>${esc(err.message)}</blockquote>`,
      );
      return;
    }
    if (action === 'k') {
      await tg.editMessageText(
        chatId,
        status.message_id,
        `🔗 <b>Direct link</b>\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n💾 <code>${esc(file.size)}</code>\n\n<pre>${esc(file.dlink)}</pre>\n⏳ <i>Expires soon — use it now.</i>`,
      );
      return;
    }
    if (file.size_bytes > botApiMaxBytes && !mtproto.isEnabled()) {
      await tg.editMessageText(
        chatId,
        status.message_id,
        `⚠️ <b>Large upload session not configured</b>\n\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n💾 <code>${esc(file.size)}</code> — over the ${config.maxFileMb} MB Bot API limit.\n\n🔗 <b>Direct link:</b>\n<pre>${esc(file.dlink)}</pre>\n\n<i>Add the MTProto session variables to enable large uploads.</i>`,
      );
      return;
    }
    await deliverFile(chatId, file, entry.provider, status);
    return;
  }

  const files = entry.result.files.filter((f) => !f.is_dir);
  const file = files[Number.parseInt(a, 10)];
  if (!file || !file.dlink) {
    await tg.answerCallbackQuery(cq.id, 'File not found', true);
    return;
  }

  // "🔗" button — just send the direct link.
  if (action === 'ln') {
    await tg.answerCallbackQuery(cq.id, '🔗 Direct link sent below');
    await tg.sendMessage(
      chatId,
      `🔗 <b>Direct link</b>\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n💾 <code>${esc(file.size)}</code>\n\n<pre>${esc(file.dlink)}</pre>\n⏳ <i>Expires soon — use it now.</i>`,
    );
    return;
  }

  // "⬇️" button — deliver the file into the chat.
  if (file.size_bytes > botApiMaxBytes && !mtproto.isEnabled()) {
    await tg.answerCallbackQuery(cq.id, `⚠️ ${file.size} needs MTProto — link only`, true);
    await tg.sendMessage(
      chatId,
      `⚠️ <b>Large upload session not configured</b>\n\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n💾 <code>${esc(file.size)}</code> — over the ${config.maxFileMb} MB Bot API limit.\n\n🔗 <b>Direct link:</b>\n<pre>${esc(file.dlink)}</pre>\n\n<i>Add the MTProto session variables to enable large uploads.</i>`,
    );
    return;
  }
  await tg.answerCallbackQuery(cq.id, '⏬ Download started…');
  await deliverFile(chatId, file, entry.provider);
}

async function main() {
  try {
    const me = await tg.getMe();
    console.log(`Logged in as @${me.username} (id ${me.id})`);
  } catch (err) {
    console.warn(`getMe failed (${err.message}) — will keep retrying via the poll loop.`);
  }
  console.log(`Bot API upload cap: ${config.maxFileMb} MB | download cap: ${config.downloadMaxMb || 'unlimited'} MB | API root: ${config.apiRoot}`);
  console.log(`MTProto large upload: ${mtproto.isEnabled() ? 'enabled' : 'disabled'}`);
  console.log(`Terabox cookies configured: ${cookiePool.size}`);
  console.log('Listening for messages…');

  let offset = 0;
  let failures = 0;
  for (;;) {
    try {
      const updates = await tg.getUpdates(offset);
      failures = 0;
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          handleMessage(u.message).catch((e) => console.error('message handler error:', e.message));
        } else if (u.callback_query) {
          handleCallback(u.callback_query).catch((e) =>
            console.error('callback handler error:', e.message),
          );
        }
      }
    } catch (err) {
      failures += 1;
      const waitMs = Math.min(15_000, 1_000 * failures);
      console.error(`Polling error: ${err.message} — retrying in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

main();
