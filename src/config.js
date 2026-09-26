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

  // Files larger than this are NOT uploaded to Telegram — the bot sends the
  // direct link instead. Official Bot API limit is 50MB, so default is 48.
  maxFileMb: Number(process.env.MAX_FILE_MB || 48),

  downloadDir: process.env.DOWNLOAD_DIR || './downloads',

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
