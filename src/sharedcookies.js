// Shared, self-refreshing Terabox cookie pool.
// Fetches working ndus cookies from a public pool so the API needs zero
// user-supplied cookies or logins. Any cookies in TERABOX_COOKIES are kept
// as a priority fallback.

import { config } from './config.js';

const POOL_URL = process.env.TERABOX_COOKIE_POOL_URL || 'https://tera.backend.live/cookies-list';
const REFRESH_MS = 30 * 60 * 1000;

class SharedCookiePool {
  constructor(staticCookies) {
    this.staticCookies = staticCookies;
    this.remote = [];
    this.i = 0;
    this.lastFetch = 0;
    this.refreshing = null;
  }

  get size() {
    return this.remote.length + this.staticCookies.length;
  }

  // Safe to call before every resolve — no-ops when the pool is fresh.
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing;
    if (!force && this.remote.length && Date.now() - this.lastFetch < REFRESH_MS) return;
    this.refreshing = (async () => {
      try {
        const resp = await fetch(POOL_URL, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`pool HTTP ${resp.status}`);
        const list = await resp.json();
        if (Array.isArray(list) && list.length) {
          this.remote = list.map((s) => String(s).trim()).filter((s) => s.startsWith('ndus='));
          this.lastFetch = Date.now();
          console.log(`[cookies] shared pool refreshed: ${this.remote.length} cookies`);
        }
      } catch (e) {
        console.warn(`[cookies] pool refresh failed: ${e.message}`);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // Synchronous next() — same interface the providers already use.
  next() {
    const all = [...this.staticCookies, ...this.remote];
    if (!all.length) return null;
    const c = all[this.i % all.length];
    this.i += 1;
    return c;
  }
}

export const sharedCookiePool = new SharedCookiePool(config.cookies);
