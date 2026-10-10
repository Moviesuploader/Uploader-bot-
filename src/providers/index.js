import * as terabox from './terabox.js';
import * as diskwala from './diskwala.js';
import * as youtube from './youtube.js';
import * as customApi from './custom-api.js';
import { config } from '../config.js';

const providers = [terabox, diskwala, youtube];

export function getProvider(providerName) {
  return providers.find((p) => p.name === providerName) || null;
}

export function pickProvider(hostname) {
  const h = String(hostname || '').toLowerCase();
  for (const p of providers) {
    if (p.hosts.has(h)) return p;
  }
  // Custom API endpoints are owner-configurable and matched by their host list.
  try {
    const api = customApi.findApiForUrl(`https://${h}/`);
    if (api) return customApi;
  } catch {}
  // Unknown extra mirrors are treated as Terabox-family (their usual case).
  if (config.extraHosts.includes(h)) return terabox;
  return null;
}

export const supportedHosts = [...providers.flatMap((p) => [...p.hosts]), ...customApi.getConfiguredApis().flatMap((a) => a.hosts || [])];
