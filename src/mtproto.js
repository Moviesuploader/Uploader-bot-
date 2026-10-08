import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

let clientPromise = null;

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

export function isEnabled() {
  const apiId = Number(env('TELEGRAM_API_ID', env('API_ID')));
  const apiHash = env('TELEGRAM_API_HASH', env('API_HASH'));
  const session = env('TELEGRAM_SESSION_STRING', env('USER_SESSION_STRING'));
  return Boolean(apiId > 0 && apiHash && session);
}

async function getClient() {
  if (!isEnabled()) return null;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const apiId = Number(env('TELEGRAM_API_ID', env('API_ID')));
    const apiHash = env('TELEGRAM_API_HASH', env('API_HASH'));
    const sessionValue = env('TELEGRAM_SESSION_STRING', env('USER_SESSION_STRING'));

    const client = new TelegramClient(
      new StringSession(sessionValue),
      apiId,
      apiHash,
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

export async function sendLargeFile({ chatId, filePath, caption, onProgress }) {
  const client = await getClient();
  if (!client) throw new Error('MTProto session is not configured');

  const workers = Math.max(1, Math.min(Number(process.env.MT_PROTO_WORKERS || 8), 16));

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
