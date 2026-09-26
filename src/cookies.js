import { config } from './config.js';

// Simple round-robin pool. The providers call next() per attempt, so a dead
// cookie is automatically skipped on the next retry.
class CookiePool {
  constructor(cookies) {
    this.cookies = cookies;
    this.i = 0;
  }

  get size() {
    return this.cookies.length;
  }

  next() {
    if (!this.cookies.length) return null;
    const cookie = this.cookies[this.i % this.cookies.length];
    this.i += 1;
    return cookie;
  }
}

export const cookiePool = new CookiePool(config.cookies);
