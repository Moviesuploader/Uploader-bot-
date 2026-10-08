import fs from 'node:fs';
import process from 'node:process';

// Minimal zero-dependency .env loader (does not override real env vars).
function loadDotenv(path = '.env') {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv();

export const config = {
  // Telegram
  botToken: process.env.BOT_TOKEN || '',
  // Point this at a local telegram-bot-api server (e.g. http://localhost:8081)
  // to raise the upload limit from ~50MB to 2GB.
  apiRoot: process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org',
  pollTimeoutSec: Number(process.env.POLL_TIMEOUT_SEC || 30),

  // Public Bot API multipart upload ceiling is ~50MB. Larger files are
  // routed to MTProto when a user session is configured.
  maxFileMb: Number(process.env.MAX_FILE_MB || 48),

  // 0 means no application-level download cap. Telegram transport limits are
  // handled separately at upload time.
  downloadMaxMb: Number(process.env.DOWNLOAD_MAX_MB || 0),

  downloadDir: process.env.DOWNLOAD_DIR || './downloads',
  // Parallel range downloader settings. Sources without HTTP Range support
  // automatically fall back to a single connection.
  downloadConnections: Math.max(1, Math.min(Number(process.env.DOWNLOAD_CONNECTIONS || 8), 16)),
  downloadChunkMb: Math.max(8, Number(process.env.DOWNLOAD_CHUNK_MB || 32)),

  // Resolver
  cookies: (process.env.TERABOX_COOKIES || process.env.TERABOX_COOKIE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 25000),
  extraHosts: (process.env.EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};
