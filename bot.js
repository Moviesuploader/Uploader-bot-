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
import * as adminConfig from './src/admin-config.js';
import * as mongo from './src/mongo.js';

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

// --- Owner/admin configuration ---
// The panel is intentionally a single editable message: buttons never create
// navigation clutter, and every credential/value message is deleted after capture.
const ownerFile = path.resolve('data/owner.json');
const legacyOwnerIds = new Set(
  (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

try {
  for (const id of JSON.parse(fs.readFileSync(ownerFile, 'utf8'))) legacyOwnerIds.add(String(id));
} catch {}

const configuredAdmin = adminConfig.getConfig();
if (configuredAdmin.ownerId) legacyOwnerIds.add(configuredAdmin.ownerId);

function currentOwnerId() {
  return adminConfig.getConfig().ownerId || String(process.env.OWNER_ID || '').trim() || [...legacyOwnerIds][0] || '';
}

function isAdmin(chatId) {
  const owner = currentOwnerId();
  return owner ? String(chatId) === owner : legacyOwnerIds.has(String(chatId));
}

function claimOwner(chatId) {
  const id = String(chatId);
  adminConfig.save({ ownerId: id });
  legacyOwnerIds.clear();
  legacyOwnerIds.add(id);
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  fs.writeFileSync(ownerFile, JSON.stringify([id]));
  console.log(`[access] owner claimed: ${id}`);
}

const adminSetup = new Map();

function adminPanelText(note = '') {
  const a = adminConfig.getConfig();
  const mt = mtproto.status();
  const mg = mongo.status();
  const owner = a.ownerId || currentOwnerId();

  return `🛠️ <b>Uploader Bot — Admin Panel</b>\n\n` +
    `👑 Owner ID: <code>${esc(owner || 'Not set')}</code>\n` +
    `🍃 MongoDB: <b>${mg.configured ? (mg.connected ? 'Connected' : 'Configured') : 'Not set'}</b>\n` +
    `📢 Logs Channel: <code>${esc(a.logsChannelId || 'Not set')}</code>\n` +
    `📦 Dump Channel: <code>${esc(a.dumpChannelId || 'Not set')}</code>\n\n` +
    `📱 MTProto API ID: <code>${mt.apiId || 'Not set'}</code>\n` +
    `🔐 API Hash: <b>${mt.hasApiHash ? 'Configured' : 'Not set'}</b>\n` +
    `🪪 Session: <b>${mt.hasSession ? 'Configured' : 'Not set'}</b>\n` +
    `📤 Large upload: <b>${mt.enabled ? 'Ready' : 'Not ready'}</b>` +
    (note ? `\n\n<blockquote>${esc(note)}</blockquote>` : '');
}

function adminPanelMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '👑 Owner ID', callback_data: 'adm:owner' },
        { text: '🍃 Mongo URI', callback_data: 'adm:mongo' },
      ],
      [
        { text: '📢 Logs Channel', callback_data: 'adm:logs' },
        { text: '📦 Dump Channel', callback_data: 'adm:dump' },
      ],
      [
        { text: '🆔 API ID', callback_data: 'adm:apiid' },
        { text: '🔐 API Hash', callback_data: 'adm:apihash' },
      ],
      [
        { text: '📱 Session', callback_data: 'adm:session' },
        { text: '🧪 Test MTProto', callback_data: 'adm:testmt' },
      ],
      [
        { text: '🧪 Test Mongo', callback_data: 'adm:testmongo' },
        { text: '🧪 Test Dump', callback_data: 'adm:testdump' },
      ],
      [
        { text: '🗑 Clear Mongo', callback_data: 'adm:clearmongo' },
        { text: '🗑 Clear Logs', callback_data: 'adm:clearlogs' },
      ],
      [
        { text: '🗑 Clear Dump', callback_data: 'adm:cleardump' },
      ],
      [
        { text: '🔄 Refresh', callback_data: 'adm:refresh' },
        { text: '✖️ Close', callback_data: 'adm:close' },
      ],
    ],
  };
}

async function showAdminPanel(chatId, messageId = null, note = '') {
  const text = adminPanelText(note);
  const extra = { reply_markup: adminPanelMarkup() };
  if (messageId) {
    await tg.editMessageText(chatId, messageId, text, extra);
    return messageId;
  }
  const sent = await tg.sendMessage(chatId, text, extra);
  return sent?.message_id || null;
}

function startAdminInput(chatId, panelMessageId, step) {
  adminSetup.set(String(chatId), { step, panelMessageId, values: {} });
}

async function handleAdminCallback(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || !isAdmin(chatId)) {
    await tg.answerCallbackQuery(cq.id, '🔒 Owner only', true);
    return;
  }

  const data = String(cq.data || '');
  const action = data.split(':')[1] || '';
  const panelId = cq.message.message_id;

  if (action === 'refresh') {
    await tg.answerCallbackQuery(cq.id, 'Refreshed');
    await showAdminPanel(chatId, panelId);
    return;
  }

  if (action === 'close') {
    adminSetup.delete(String(chatId));
    await tg.answerCallbackQuery(cq.id, 'Closed');
    await tg.editMessageText(chatId, panelId, '✅ <b>Admin panel closed.</b>');
    return;
  }

  if (action === 'testdump') {
    await tg.answerCallbackQuery(cq.id, 'Testing dump channel…');
    const dumpId = adminConfig.getConfig().dumpChannelId;
    if (!dumpId) {
      await showAdminPanel(chatId, panelId, 'Dump channel is not configured.');
      return;
    }
    try {
      const test = await tg.sendMessage(dumpId, '🧪 <b>Dump channel test</b>\n\nThis message will be deleted automatically.');
      await tg.deleteMessage(dumpId, test.message_id);
      await showAdminPanel(chatId, panelId, 'Dump channel is reachable and bot can post there ✅');
    } catch (err) {
      await showAdminPanel(chatId, panelId, `Dump channel test failed: ${err.message}`);
    }
    return;
  }

  if (action === 'cleardump') {
    adminConfig.clear('dumpChannelId');
    await tg.answerCallbackQuery(cq.id, 'Dump channel cleared');
    await showAdminPanel(chatId, panelId);
    return;
  }
  if (action === 'testmongo') {
    await tg.answerCallbackQuery(cq.id, 'Testing MongoDB…');
    try {
      await mongo.testConnection();
      await showAdminPanel(chatId, panelId, 'MongoDB connection is working ✅');
    } catch (err) {
      await showAdminPanel(chatId, panelId, `MongoDB test failed: ${err.message}`);
    }
    return;
  }

  if (action === 'testmt') {
    await tg.answerCallbackQuery(cq.id, 'Testing MTProto…');
    try {
      const result = await mtproto.testConnection();
      await showAdminPanel(
        chatId,
        panelId,
        `MTProto OK • @${result.username || 'private'} • Premium: ${result.premium ? 'Yes' : 'No'}`,
      );
    } catch (err) {
      await showAdminPanel(chatId, panelId, `MTProto test failed: ${err.message}`);
    }
    return;
  }

  if (action === 'clearmongo') {
    adminConfig.clear('mongoUri');
    await mongo.close();
    await tg.answerCallbackQuery(cq.id, 'Mongo URI cleared');
    await showAdminPanel(chatId, panelId);
    return;
  }

  if (action === 'clearlogs') {
    adminConfig.clear('logsChannelId');
    await tg.answerCallbackQuery(cq.id, 'Logs channel cleared');
    await showAdminPanel(chatId, panelId);
    return;
  }

  const steps = {
    owner: {
      prompt: '👑 <b>Send the new Owner ID</b>\n\nOnly the numeric Telegram user ID.\n/cancel to return.',
      next: 'owner',
    },
    mongo: {
      prompt: '🍃 <b>Send MongoDB URI</b>\n\nIt will be saved securely and never echoed back.\n/cancel to return.',
      next: 'mongo',
    },
    logs: {
      prompt: '📢 <b>Send Logs Channel ID</b>\n\nExample: <code>-1001234567890</code>\nMake sure the bot is allowed to post there.\n/cancel to return.',
      next: 'logs',
    },
    dump: {
      prompt: '📦 <b>Send Dump Channel ID</b>\n\nDownloaded files will be stored here first, then copied to the user.\nExample: <code>-1001234567890</code>\nMake sure the bot is allowed to post there.\n/cancel to return.',
      next: 'dump',
    },
    apiid: {
      prompt: '🆔 <b>Send MTProto API ID</b>\n\nOnly the numeric API ID.\n/cancel to return.',
      next: 'apiId',
    },
    apihash: {
      prompt: '🔐 <b>Send MTProto API Hash</b>\n\nThe message will be deleted immediately after capture.\n/cancel to return.',
      next: 'apiHash',
    },
    session: {
      prompt: '📱 <b>Send MTProto Session String</b>\n\nThe message will be deleted immediately after capture.\n/cancel to return.',
      next: 'session',
    },
  };

  const item = steps[action];
  if (!item) return;

  await tg.answerCallbackQuery(cq.id);
  startAdminInput(chatId, panelId, item.next);

  if (action === 'apiid' || action === 'apihash' || action === 'session') {
    const existing = mtproto.getConfig();
    adminSetup.get(String(chatId)).values = { ...existing };
  }

  await tg.editMessageText(chatId, panelId, item.prompt, {
    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm:cancel' }]] },
  });
}

async function handleAdminInput(msg) {
  const chatId = msg.chat?.id;
  if (!chatId || !isAdmin(chatId)) return false;

  const state = adminSetup.get(String(chatId));
  if (!state) return false;

  const text = String(msg.text || '').trim();
  if (!text) return true;

  // Delete the admin's value message immediately. Telegram supports bots deleting
  // incoming private-chat messages; failures are safely ignored by telegram.js.
  await tg.deleteMessage(chatId, msg.message_id);

  if (text === '/cancel') {
    adminSetup.delete(String(chatId));
    await showAdminPanel(chatId, state.panelMessageId);
    return true;
  }

  const finish = async (note = '') => {
    adminSetup.delete(String(chatId));
    await showAdminPanel(chatId, state.panelMessageId, note);
  };

  try {
    if (state.step === 'owner') {
      if (!/^\d+$/.test(text) || Number(text) <= 0) {
        await showAdminPanel(chatId, state.panelMessageId, 'Owner ID must be a positive numeric Telegram user ID.');
        return true;
      }
      adminConfig.save({ ownerId: text });
      legacyOwnerIds.clear();
      legacyOwnerIds.add(text);
      fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
      fs.writeFileSync(ownerFile, JSON.stringify([text]));
      await finish('Owner ID saved. Admin access is now assigned to the new owner.');
      return true;
    }

    if (state.step === 'mongo') {
      if (!/^(mongodb(?:\+srv)?:\/\/)/i.test(text)) {
        await showAdminPanel(chatId, state.panelMessageId, 'That does not look like a MongoDB URI.');
        return true;
      }
      adminConfig.save({ mongoUri: text });
      await mongo.close();
      await mongo.testConnection();
      await finish('MongoDB URI saved and connection verified ✅');
      return true;
    }

    if (state.step === 'logs') {
      if (!/^-?\d+$/.test(text) && !/^@?[A-Za-z0-9_]{4,}$/.test(text)) {
        await showAdminPanel(chatId, state.panelMessageId, 'Enter a valid channel/chat ID such as -1001234567890 or a channel username.');
        return true;
      }
      adminConfig.save({ logsChannelId: text });
      await finish('Logs channel saved. New download activity will be sent there 📢');
      return true;
    }
    if (state.step === 'dump') {
      if (!/^-?\d+$/.test(text) && !/^@?[A-Za-z0-9_]{4,}$/.test(text)) {
        await showAdminPanel(chatId, state.panelMessageId, 'Enter a valid channel/chat ID such as -1001234567890 or a channel username.');
        return true;
      }
      try {
        adminConfig.save({ dumpChannelId: text });
        const test = await tg.sendMessage(text, '🧪 <b>Dump channel configured successfully.</b>\n\nThis test message will be deleted.');
        await tg.deleteMessage(text, test.message_id);
      } catch (err) {
        adminConfig.clear('dumpChannelId');
        await showAdminPanel(chatId, state.panelMessageId, `Could not post to that channel: ${err.message}`);
        return true;
      }
      await finish('Dump channel saved and verified ✅\nDownloaded files will be stored there first, then copied to the user.');
      return true;
    }

    if (state.step === 'apiId') {
      if (!/^\d+$/.test(text) || Number(text) <= 0) {
        await showAdminPanel(chatId, state.panelMessageId, 'API ID must be a positive number.');
        return true;
      }
      state.values.apiId = Number(text);
    } else if (state.step === 'apiHash') {
      if (text.length < 10) {
        await showAdminPanel(chatId, state.panelMessageId, 'API Hash looks too short.');
        return true;
      }
      state.values.apiHash = text;
    } else if (state.step === 'session') {
      if (text.length < 20) {
        await showAdminPanel(chatId, state.panelMessageId, 'Session String looks too short.');
        return true;
      }
      state.values.session = text;
    } else {
      await finish('Unknown setup step.');
      return true;
    }

    const mtState = state.step === 'apiId' ? 'apiHash' : state.step === 'apiHash' ? 'session' : null;
    if (mtState) {
      const prompt = mtState === 'apiHash'
        ? '🔐 <b>Now send the MTProto API Hash</b>\n\nYour message will be deleted immediately.'
        : '📱 <b>Now send the MTProto Session String</b>\n\nYour message will be deleted immediately.';
      state.step = mtState;
      await tg.editMessageText(chatId, state.panelMessageId, prompt, {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm:cancel' }]] },
      });
      return true;
    }

    mtproto.saveConfig(state.values);
    const result = await mtproto.testConnection();
    await finish(`MTProto saved and verified ✅ • @${result.username || 'private'} • Premium: ${result.premium ? 'Yes' : 'No'}`);
  } catch (err) {
    await showAdminPanel(chatId, state.panelMessageId, `Save/test failed: ${err.message}`);
  }
  return true;
}

async function sendDownloadLog({ chatId, actor, provider, sourceUrl, file, status, uploadMethod = '', error = '' }) {
  const a = adminConfig.getConfig();
  const actorName = actor?.username ? `@${actor.username}` : actor?.first_name || String(actor?.id || chatId);
  const payload = {
    chatId: String(chatId),
    userId: actor?.id ? String(actor.id) : String(chatId),
    username: actor?.username || '',
    userName: actorName,
    provider: provider?.name || provider?.constructor?.name || 'unknown',
    sourceUrl: sourceUrl || '',
    fileName: file?.name || '',
    size: file?.size || '',
    sizeBytes: Number(file?.size_bytes || 0),
    downloadUrl: file?.dlink || '',
    status,
    uploadMethod,
    error: error || '',
  };

  await Promise.allSettled([
    a.logsChannelId
      ? tg.sendMessage(
          a.logsChannelId,
          `📥 <b>Download Log</b>\n\n👤 <b>User:</b> ${esc(actorName)} (<code>${esc(payload.userId)}</code>)\n🏷 <b>Provider:</b> <code>${esc(payload.provider)}</code>\n📄 <b>File:</b> <code>${esc(payload.fileName)}</code>\n💾 <b>Size:</b> <code>${esc(payload.size || 'Unknown')}</code>\n📊 <b>Status:</b> <b>${esc(status)}</b>${uploadMethod ? `\n📤 <b>Upload:</b> <code>${esc(uploadMethod)}</code>` : ''}${sourceUrl ? `\n🔗 <b>Source:</b> <pre>${esc(sourceUrl)}</pre>` : ''}${error ? `\n❌ <b>Error:</b> <pre>${esc(error)}</pre>` : ''}`,
          { protect_content: true },
        )
      : Promise.resolve(),
    mongo.status().configured ? mongo.logDownload(payload).catch(() => {}) : Promise.resolve(),
  ]);
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
  // Some file hosts advertise byte-range support but aggressively rate-limit
  // bursts of parallel range requests. A large 16-way burst can therefore turn
  // a perfectly valid download into HTTP 429. Start conservatively and fall
  // back to one stream when the host asks us to slow down.
  const connections = Math.max(1, Math.min(Number(process.env.DOWNLOAD_CONNECTIONS || 4), 16));
  const chunkBytes = Math.max(
    8 * 1024 * 1024,
    Number(process.env.DOWNLOAD_CHUNK_MB || 32) * 1024 * 1024,
  );
  const cleanHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(([k]) => String(k).toLowerCase() !== 'range'),
  );
  cleanHeaders['Accept-Encoding'] = 'identity';

  const tmp = path.join(
    downloadDir,
    'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + (ext ? '.' + ext : ''),
  );

  const retryAfterMs = (resp) => {
    const value = resp?.headers?.get?.('retry-after');
    if (!value) return 1500;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.max(1000, seconds * 1000));
    const when = Date.parse(value);
    if (Number.isFinite(when)) return Math.min(60_000, Math.max(1000, when - Date.now()));
    return 1500;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const singleStream = async (knownLength = 0) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const resp = await fetch(dlink, { headers: cleanHeaders, redirect: 'follow' });
        if (resp.status === 429) {
          const wait = retryAfterMs(resp);
          resp.body?.cancel().catch(() => {});
          lastError = new Error('download rate limited (HTTP 429)');
          if (attempt < 4) {
            console.warn('[download] source rate-limited; retrying after ' + Math.ceil(wait / 1000) + 's');
            await sleep(wait);
            continue;
          }
          throw lastError;
        }
        if (resp.status >= 500 && resp.status <= 599) {
          resp.body?.cancel().catch(() => {});
          lastError = new Error('download failed (HTTP ' + resp.status + ')');
          if (attempt < 4) {
            await sleep(Math.min(10_000, 1000 * attempt));
            continue;
          }
          throw lastError;
        }
        if (!resp.ok && resp.status !== 206) {
          resp.body?.cancel().catch(() => {});
          throw new Error('download failed (HTTP ' + resp.status + ')');
        }

        const len = knownLength || Number(resp.headers.get('content-length') || 0);
        if (len > downloadMaxBytes) {
          resp.body?.cancel().catch(() => {});
          const e = new Error('too_big');
          e.tooBig = true;
          throw e;
        }

        let received = 0;
        const guard = new Transform({
          transform(chunk, enc, cb) {
            received += chunk.length;
            try { onProgress?.(received, len); } catch {}
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
          await pipeline(
            Readable.fromWeb(resp.body),
            guard,
            fs.createWriteStream(tmp, { highWaterMark: 4 * 1024 * 1024 }),
          );
        } catch (err) {
          fs.unlink(tmp, () => {});
          throw err;
        }
        return tmp;
      } catch (err) {
        lastError = err;
        if (err?.tooBig || attempt >= 4) throw err;
      }
    }
    throw lastError || new Error('download failed');
  };

  let probe = null;
  try {
    // Probe once to discover the total size. If the probe itself is rate-limited,
    // do not immediately fire more range requests; wait and use a normal stream.
    probe = await fetch(dlink, {
      headers: { ...cleanHeaders, Range: 'bytes=0-0' },
      redirect: 'follow',
    });

    if (probe.status === 429) {
      const wait = retryAfterMs(probe);
      probe.body?.cancel().catch(() => {});
      console.warn('[download] range probe rate-limited; waiting ' + Math.ceil(wait / 1000) + 's and switching to single stream');
      await sleep(wait);
      return singleStream();
    }

    const rangeHeader = probe.headers.get('content-range') || '';
    const match = /^bytes\\s+0-0\\/(\\d+)$/.exec(rangeHeader);
    const total = match ? Number(match[1]) : 0;

    if (probe.status !== 206 || !total) {
      probe.body?.cancel().catch(() => {});
      return singleStream();
    }
    if (total > downloadMaxBytes) {
      probe.body?.cancel().catch(() => {});
      const e = new Error('too_big');
      e.tooBig = true;
      throw e;
    }
    if (connections === 1 || total <= chunkBytes) {
      probe.body?.cancel().catch(() => {});
      return singleStream(total);
    }
    probe.body?.cancel().catch(() => {});

    await fs.promises.writeFile(tmp, Buffer.alloc(0));
    await fs.promises.truncate(tmp, total);

    const ranges = [];
    for (let start = 0; start < total; start += chunkBytes) {
      ranges.push([start, Math.min(total - 1, start + chunkBytes - 1)]);
    }

    let received = 0;
    let nextRange = 0;
    let rateLimitedWait = 0;
    const abort = new AbortController();

    const downloadRange = async ([rangeStart, rangeEnd]) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const resp = await fetch(dlink, {
            headers: { ...cleanHeaders, Range: 'bytes=' + rangeStart + '-' + rangeEnd },
            redirect: 'follow',
            signal: abort.signal,
          });

          if (resp.status === 429) {
            rateLimitedWait = Math.max(rateLimitedWait, retryAfterMs(resp));
            resp.body?.cancel().catch(() => {});
            abort.abort();
            const e = new Error('range download rate limited (HTTP 429)');
            e.rateLimited = true;
            throw e;
          }

          if (resp.status !== 206) {
            resp.body?.cancel().catch(() => {});
            const e = new Error(
              resp.status === 200
                ? 'range_not_supported'
                : 'range download failed (HTTP ' + resp.status + ')',
            );
            e.rangeUnsupported = resp.status === 200;
            throw e;
          }

          const expected = rangeEnd - rangeStart + 1;
          const contentLength = Number(resp.headers.get('content-length') || 0);
          if (contentLength && contentLength !== expected) {
            resp.body?.cancel().catch(() => {});
            throw new Error('range size mismatch (expected ' + expected + ', got ' + contentLength + ')');
          }

          const writer = fs.createWriteStream(tmp, {
            flags: 'r+',
            start: rangeStart,
            highWaterMark: 4 * 1024 * 1024,
          });
          let written = 0;
          const guard = new Transform({
            transform(chunk, enc, cb) {
              written += chunk.length;
              received += chunk.length;
              try { onProgress?.(received, total); } catch {}
              cb(null, chunk);
            },
          });

          await pipeline(Readable.fromWeb(resp.body), guard, writer);
          if (written !== expected) {
            throw new Error('range incomplete (expected ' + expected + ', got ' + written + ')');
          }
          return;
        } catch (err) {
          if (err?.rateLimited || abort.signal.aborted) throw err;
          if (attempt >= 3) throw err;
          await sleep(400 * attempt);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(connections, ranges.length) },
      async () => {
        while (!abort.signal.aborted) {
          const index = nextRange++;
          if (index >= ranges.length) return;
          try {
            await downloadRange(ranges[index]);
          } catch (err) {
            abort.abort();
            throw err;
          }
        }
      },
    );

    try {
      await Promise.all(workers);
    } catch (err) {
      fs.unlink(tmp, () => {});
      if (rateLimitedWait > 0) {
        console.warn('[download] range requests were rate-limited; retrying as a single stream');
        await sleep(rateLimitedWait);
        return singleStream(total);
      }
      if (err.rangeUnsupported) return singleStream(total);
      throw err;
    }

    const stat = fs.statSync(tmp);
    if (stat.size !== total) {
      fs.unlink(tmp, () => {});
      throw new Error('parallel download size mismatch (expected ' + total + ', got ' + stat.size + ')');
    }

    console.log('[download] parallel: ' + ranges.length + ' ranges / ' + Math.min(connections, ranges.length) + ' connections');
    return tmp;
  } catch (err) {
    probe?.body?.cancel().catch(() => {});
    fs.unlink(tmp, () => {});
    throw err;
  }
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

  // Private bot: first /start claims ownership when no owner is configured.
  if (!currentOwnerId()) {
    if (!text.startsWith('/start')) {
      await tg.sendMessage(chatId, '🔒 <b>Private bot</b>\n\nSend /start to claim ownership. 👑');
      return;
    }
    claimOwner(chatId);
    await tg.sendMessage(
      chatId,
      `✅ <b>Ownership claimed!</b> 👑\n\nOnly your account can use this bot.\n🆔 <code>${chatId}</code>`,
    );
  } else if (!isAdmin(chatId)) {
    console.log(`[access] blocked unauthorized chat ${chatId}`);
    await tg.sendMessage(chatId, '🔒 <b>Private bot</b>\n<blockquote>Access denied.</blockquote>');
    return;
  }

  if (await handleAdminInput(msg)) return;

  if (text.startsWith('/mtproto') || text.startsWith('/admin')) {
    await showAdminPanel(chatId);
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
async function deliverFile(chatId, file, provider, status = null, sourceUrl = '', actor = null) {
  const statusMsg =
    status ||
    (await tg.sendMessage(
      chatId,
      `⏬ <b>Preparing download…</b>\n${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n💾 <code>${esc(file.size)}</code>`,
    ));
  const statusId = statusMsg.message_id;
  let tmp = null;
  let uploadMethod = '';
  let stage = 'download';
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

    stage = 'media-preparation';
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

    stage = 'upload';
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

    const dumpChannelId = adminConfig.getConfig().dumpChannelId;
    if (dumpChannelId) {
      stage = 'dump-upload';
      // Store the file once in the dump channel, then copy that Telegram
      // message to the user. This avoids a second physical upload.
      if (needsMtproto) {
        uploadMethod = 'MTProto → Dump → Copy';
        if (!mtproto.isEnabled()) {
          throw new Error(
            `large upload requires MTProto session (file is ${formatSize(actualSize)}; Bot API limit is ${config.maxFileMb} MB)`,
          );
        }
        let uploadLastEdit = 0;
        const uploadStartedAt = Date.now();
        const dumped = await mtproto.sendLargeFile({
          chatId: dumpChannelId,
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
              `📦 <b>Saving to dump…</b>\n${fileEmoji(uploadName)} <b>${esc(uploadName)}</b>\n💾 <code>${esc(formatSize(uploaded))}${total ? ` / ${esc(formatSize(total))}` : ''}</code>  ⚡ <code>${esc(speed)}</code>${bar ? `\n${bar}` : ''}`,
            );
          },
        });
        const dumpMessageId = dumped?.id || dumped?.message_id;
        if (!dumpMessageId) throw new Error('Dump upload succeeded but no Telegram message ID was returned');
        await tg.copyMessage(chatId, dumpChannelId, Number(dumpMessageId));
      } else {
        uploadMethod = 'Bot API → Dump → Copy';
        let dumped;
        try {
          dumped = await tg.sendFile({
            chatId: dumpChannelId,
            filePath: uploadPath,
            filename: uploadName,
            caption,
            kind: kind === 'video' ? 'video' : kind,
            thumbPath,
          });
        } catch (e1) {
          if (kind === 'document') throw e1;
          console.error(`${kind} dump upload failed (${e1.message}) — retrying as document`);
          dumped = await tg.sendFile({
            chatId: dumpChannelId,
            filePath: uploadPath,
            filename: uploadName,
            caption,
            kind: 'document',
          });
        }
        if (!dumped?.message_id) throw new Error('Dump upload succeeded but no Telegram message ID was returned');
        await tg.copyMessage(chatId, dumpChannelId, dumped.message_id);
      }
    } else if (needsMtproto) {
      stage = 'mtproto-upload';
      uploadMethod = 'MTProto';
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
      stage = 'bot-api-upload';
      uploadMethod = 'Bot API';
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
    await sendDownloadLog({
      chatId,
      actor,
      provider,
      sourceUrl,
      file,
      status: 'SUCCESS',
      uploadMethod,
    });
    await tg.deleteMessage(chatId, statusId);
  } catch (err) {
    const reason = err.tooBig
      ? 'the file exceeded the configured download-size cap'
      : esc(`${stage}: ${err.message || 'unknown error'}`);
    await sendDownloadLog({
      chatId,
      actor,
      provider,
      sourceUrl,
      file,
      status: 'FAILED',
      uploadMethod,
      error: err.message,
    });
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
  if (String(cq.data || '').startsWith('adm:')) {
    if (String(cq.data || '') === 'adm:cancel') {
      const chatId = cq.message?.chat?.id;
      if (chatId && isAdmin(chatId)) {
        const state = adminSetup.get(String(chatId));
        adminSetup.delete(String(chatId));
        await tg.answerCallbackQuery(cq.id, 'Cancelled');
        await showAdminPanel(chatId, state?.panelMessageId || cq.message.message_id);
      } else {
        await tg.answerCallbackQuery(cq.id, '🔒 Owner only', true);
      }
      return;
    }
    await handleAdminCallback(cq);
    return;
  }

  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (currentOwnerId() && !isAdmin(chatId)) {
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
    await deliverFile(chatId, file, entry.provider, status, entry.result.share_url || '', cq.from);
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
  const knownSize = Number(file.size_bytes || 0);
  if (knownSize > botApiMaxBytes && !mtproto.isEnabled()) {
    await tg.answerCallbackQuery(cq.id, '⚠️ MTProto required for this file', true);
    await tg.sendMessage(
      chatId,
      `⚠️ <b>Large upload session is not configured</b>\n\n` +
        `${fileEmoji(file.name)} <b>${esc(file.name)}</b>\n` +
        `💾 <code>${esc(file.size)}</code> — over the ${config.maxFileMb} MB Bot API limit.\n\n` +
        `The file was <b>not downloaded</b>, so no time/bandwidth is wasted.\n\n` +
        `🔗 <b>Direct link:</b>\n<pre>${esc(file.dlink)}</pre>\n\n` +
        `<i>Configure MTProto from /admin → 📱 Session to enable large downloads.</i>`,
    );
    return;
  }
  await tg.answerCallbackQuery(cq.id, '⏬ Download started…');
  await deliverFile(chatId, file, entry.provider, null, entry.result.share_url || '', cq.from);
}

async function main() {
  try {
    await mtproto.initialize();
  } catch (err) {
    console.warn(`[mtproto] initialization warning: ${err.message}`);
  }

  try {
    const me = await tg.getMe();
    console.log(`Logged in as @${me.username} (id ${me.id})`);
  } catch (err) {
    console.warn(`getMe failed (${err.message}) — will keep retrying via the poll loop.`);
  }
  console.log(`Bot API upload cap: ${config.maxFileMb} MB | download cap: ${config.downloadMaxMb || 'unlimited'} MB | API root: ${config.apiRoot}`);
  if (mtproto.isEnabled()) {
    try {
      const mt = await mtproto.testConnection();
      console.log(`MTProto large upload: enabled (@${mt.username || 'private'} | Premium: ${mt.premium ? 'yes' : 'no'})`);
    } catch (err) {
      console.warn(`MTProto large upload: configured but unusable — ${err.message}`);
    }
  } else {
    console.log('MTProto large upload: disabled');
  }
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
