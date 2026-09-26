export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} bytes`;
}

export function findBetween(str, start, end) {
  const startIndex = str.indexOf(start);
  if (startIndex === -1) return '';
  const endIndex = str.indexOf(end, startIndex + start.length);
  if (endIndex === -1) return '';
  return str.slice(startIndex + start.length, endIndex);
}

// Emoji that matches the file type, for prettier messages.
export function fileEmoji(name) {
  const e = (String(name).split('.').pop() || '').toLowerCase();
  if (['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'mpg', 'mpeg'].includes(e)) return '🎬';
  if (['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac', 'opus', 'wma'].includes(e)) return '🎵';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return '🖼️';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '🗜️';
  if (e === 'apk') return '🤖';
  if (e === 'pdf') return '📕';
  if (['doc', 'docx', 'txt', 'md'].includes(e)) return '📄';
  return '📦';
}
