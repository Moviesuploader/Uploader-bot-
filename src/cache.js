// Tiny in-memory cache for resolved links, keyed by a short random id so it
// fits in Telegram's 64-byte callback_data. Entries expire after `ttlMs`.
export class Cache {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.map = new Map();
    this.ttl = ttlMs;
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.map) {
        if (now - v.ts > this.ttl) this.map.delete(k);
      }
    }, 60_000);
    sweep.unref();
  }

  put(value) {
    const id = Math.random().toString(36).slice(2, 10);
    this.map.set(id, { value, ts: Date.now() });
    return id;
  }

  get(id) {
    const entry = this.map.get(id);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttl) {
      this.map.delete(id);
      return null;
    }
    return entry.value;
  }
}
