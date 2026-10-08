import fs from 'node:fs';
import path from 'node:path';

const storeFile = path.resolve('data/admin-config.json');

function env(name) {
  return String(process.env[name] || '').trim();
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
    ownerId: String(saved.ownerId || env('OWNER_ID') || '').trim(),
    mongoUri: String(saved.mongoUri || env('MONGO_URI') || env('MONGODB_URI') || '').trim(),
    logsChannelId: String(saved.logsChannelId || env('LOGS_CHANNEL_ID') || '').trim(),
    dumpChannelId: String(saved.dumpChannelId || env('DUMP_CHANNEL_ID') || '').trim(),
  };
}

export function save(patch = {}) {
  const current = getConfig();
  const next = {
    ownerId: patch.ownerId !== undefined ? String(patch.ownerId || '').trim() : current.ownerId,
    mongoUri: patch.mongoUri !== undefined ? String(patch.mongoUri || '').trim() : current.mongoUri,
    logsChannelId: patch.logsChannelId !== undefined ? String(patch.logsChannelId || '').trim() : current.logsChannelId,
    dumpChannelId: patch.dumpChannelId !== undefined ? String(patch.dumpChannelId || '').trim() : current.dumpChannelId,
  };
  writeStore(next);
  return next;
}

export function clear(key) {
  const current = getConfig();
  if (key === 'ownerId') current.ownerId = '';
  if (key === 'mongoUri') current.mongoUri = '';
  if (key === 'logsChannelId') current.logsChannelId = '';
  if (key === 'dumpChannelId') current.dumpChannelId = '';
  writeStore(current);
  return current;
}
