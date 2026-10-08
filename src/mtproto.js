import fs from 'node:fs';
import path from 'node:path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import * as mongo from './mongo.js';

const storeFile = path.resolve('data/mtproto.json');
let clientPromise = null;
let mongoLoaded = false;

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(storeFile, 0o600); } catch {}
}

export function getConfig() {
  const saved = readStore();
  return {
    apiId: Number(saved.apiId || env('TELEGRAM_API_ID', env('API_ID')) || 0),
    apiHash: String(saved.apiHash || env('TELEGRAM_API_HASH', env('API_HASH')) || '').trim(),
    session: String(saved.session || env('TELEGRAM_SESSION_STRING', env('USER_SESSION_STRING')) || '').trim(),
  };
}

export async function initialize() {
  if (mongoLoaded) return getConfig();
  mongoLoaded = true;

  const local = getConfig();
  if (local.apiId > 0 && local.apiHash && local.session) return local;

  try {
    const remote = await mongo.getMtprotoConfig();
    if (remote?.apiId && remote?.apiHash && remote?.session) {
      writeStore({
        apiId: Number(remote.apiId),
        apiHash: String(remote.apiHash),
        session: String(remote.session),
      });
      clientPromise = null;
      console.log('[mtproto] configuration restored from MongoDB');
    }
  } catch (err) {
    console.warn(`[mtproto] MongoDB restore skipped: ${err.message}`);
  }

  return getConfig();
}

export function isEnabled() {
  const c = getConfig();
  return Boolean(c.apiId > 0 && c.apiHash && c.session);
}

export function saveConfig({ apiId, apiHash, session }) {
  const current = getConfig();
  const next = {
    apiId: Number(apiId || current.apiId || 0),
    apiHash: String(apiHash || current.apiHash || '').trim(),
    session: String(session || current.session || '').trim(),
  };
  if (!next.apiId || !next.apiHash || !next.session) {
    throw new Error('API ID, API Hash and Session String are all required');
  }
  writeStore(next);
  clientPromise = null;

  // Keep a local copy for immediate use and persist the same configuration
  // in MongoDB so Koyeb/Heroku redeploys can restore it.
  mongo.saveMtprotoConfig(next).catch((err) => {
    console.warn(`[mtproto] MongoDB persistence failed: ${err.message}`);
  });

  return { apiId: next.apiId, configured: true };
}

export function clearConfig() {
  writeStore({});
  clientPromise = null;
  mongo.clearMtprotoConfig().catch((err) => {
    console.warn(`[mtproto] MongoDB clear failed: ${err.message}`);
  });
}

export function status() {
  const c = getConfig();
  return {
    apiId: c.apiId,
    hasApiHash: Boolean(c.apiHash),
    hasSession: Boolean(c.session),
    enabled: Boolean(c.apiId > 0 && c.apiHash && c.session),
  };
}

async function getClient() {
  if (!isEnabled()) return null;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const c = getConfig();

    const client = new TelegramClient(
      new StringSession(c.session),
      c.apiId,
      c.apiHash,
      {
        connectionRetries: 5,
        autoReconnect: true,
        floodSleepThreshold: 60,
      },
    );

    await client.connect();
    await client.getMe();
    console.log('[mtproto] large-file session connected');
    return client;
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });

  return clientPromise;
}

export async function testConnection() {
  const client = await getClient();
  if (!client) throw new Error('MTProto is not configured');
  const me = await client.getMe();
  return {
    id: String(me?.id || ''),
    username: me?.username ? String(me.username) : '',
    premium: Boolean(me?.premium),
  };
}

export async function sendLargeFile({ chatId, filePath, caption, onProgress }) {
  const client = await getClient();
  if (!client) throw new Error('MTProto session is not configured');

  const workers = Math.max(1, Math.min(Number(process.env.MT_PROTO_WORKERS || 16), 32));

  return client.sendFile(chatId, {
    file: filePath,
    caption,
    forceDocument: false,
    supportsStreaming: true,
    workers,
    progressCallback: (uploaded, total) => {
      try {
        onProgress?.(Number(uploaded) || 0, Number(total) || 0);
      } catch {}
    },
  });
}
