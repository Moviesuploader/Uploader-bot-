import { openAsBlob } from 'node:fs';
import { config } from './config.js';

const base = () => `${config.apiRoot}/bot${config.botToken}`;

// JSON POST to the Bot API. Throws on Telegram-side errors.
export async function call(method, params = {}, timeoutMs = 60_000) {
  const resp = await fetch(`${base()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!data.ok) throw new Error(data.description || `Telegram API error on ${method}`);
  return data.result;
}

// Long polling. The HTTP timeout must exceed the poll timeout.
export function getUpdates(offset) {
  return call(
    'getUpdates',
    { offset, timeout: config.pollTimeoutSec, allowed_updates: ['message', 'callback_query'] },
    (config.pollTimeoutSec + 15) * 1000,
  );
}

export const getMe = () => call('getMe');

export const sendMessage = (chatId, text, extra = {}) =>
  call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });

// Editing/deleting can legitimately fail (message unchanged, already gone) —
// those failures are safe to ignore.
export const editMessageText = (chatId, messageId, text, extra = {}) =>
  call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  }).catch(() => null);

export const deleteMessage = (chatId, messageId) =>
  call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);

export const answerCallbackQuery = (id, text = '', showAlert = false) =>
  call('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert }).catch(
    () => null,
  );

export const sendChatAction = (chatId, action) =>
  call('sendChatAction', { chat_id: chatId, action }).catch(() => null);

const MIME_BY_EXT = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  m4v: 'video/x-m4v', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav',
  ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/opus', wma: 'audio/x-ms-wma',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive',
};

// Upload a file from disk using multipart/form-data. kind: video | audio | document.
// A real File with an explicit name + MIME type keeps the filename/extension
// intact end-to-end (bare Blobs can lose it in some multipart stacks).
export async function sendFile({ chatId, filePath, filename, caption, kind = 'document', thumbPath = null }) {
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1024));
    form.append('parse_mode', 'HTML');
  }
  const method = kind === 'video' ? 'sendVideo' : kind === 'audio' ? 'sendAudio' : 'sendDocument';
  const field = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'document';
  if (kind === 'video') form.append('supports_streaming', 'true');
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(filename || '') || [])[1]?.toLowerCase() || '';
  const file = new File([blob], filename, { type: MIME_BY_EXT[ext] || 'application/octet-stream' });
  form.append(field, file, filename);
  if (kind === 'audio') form.append('title', filename.replace(/\.[^.]+$/, ''));
  if (thumbPath && (kind === 'video' || kind === 'audio')) {
    try {
      const thumbBlob = await openAsBlob(thumbPath);
      form.append('thumbnail', new File([thumbBlob], 'thumb.jpg', { type: 'image/jpeg' }), 'thumb.jpg');
    } catch {}
  }

  const resp = await fetch(`${base()}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15 * 60 * 1000), // uploads can take a while
  });
  const data = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!data.ok) throw new Error(data.description || `Telegram upload failed`);
  return data.result;
}
