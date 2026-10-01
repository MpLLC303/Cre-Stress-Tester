// Runtime configuration, resolved once from the environment.
//
// Secrets (Etsy keys, image API key) live only in this object inside the sidecar; callers must
// never copy them into events or HTTP responses.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const OUTPOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = ['anthropic', 'scripted'];

function intInRange(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}, got ${JSON.stringify(value)}`);
  return n;
}

/** An optional positive integer id (Etsy ids are int64 but small enough to be safe integers). */
function optionalId(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(value)}`);
  return n;
}

/**
 * Build the runtime config from environment variables.
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{dataDir:string, host:string, port:number, stationPath:string, provider:'anthropic'|'scripted',
 *   modelOverride:string|null, image:{provider:string|null, model:string|null, apiKey:string|null},
 *   etsy:{apiKey:string|null, sharedSecret:string|null, accessToken:string|null, refreshToken:string|null,
 *     shopId:string|null, taxonomyId:number|null, shippingProfileId:number|null},
 *   allowHosts:string[], tickMs:number}}
 * @throws {Error} on a malformed PORT, OUTPOST_TICK_MS, ETSY_TAXONOMY_ID or ETSY_SHIPPING_PROFILE_ID
 */
export function loadConfig(env = process.env) {
  const hasClaudeCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const provider = env.OUTPOST_PROVIDER || (hasClaudeCredentials ? 'anthropic' : 'scripted');
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`OUTPOST_PROVIDER must be one of ${PROVIDERS.join(', ')}, got ${JSON.stringify(provider)}`);
  }
  return {
    dataDir: resolve(env.OUTPOST_DATA || join(OUTPOST_ROOT, 'data')),
    host: env.HOST || '127.0.0.1',
    port: intInRange(env.PORT || 8787, 'PORT', 0, 65535),
    stationPath: resolve(env.OUTPOST_STATION || join(OUTPOST_ROOT, 'config', 'station.json')),
    provider,
    modelOverride: env.OUTPOST_MODEL || null,
    image: {
      provider: env.OUTPOST_IMAGE_PROVIDER || null,
      model: env.OUTPOST_IMAGE_MODEL || null,
      apiKey: env.OPENAI_API_KEY || null,
    },
    etsy: {
      apiKey: env.ETSY_API_KEY || null,
      sharedSecret: env.ETSY_SHARED_SECRET || null,
      accessToken: env.ETSY_ACCESS_TOKEN || null,
      // Access tokens last ~1 h; with a refresh token the connector renews them and persists the
      // rotated pair to <dataDir>/secrets/etsy-token.json (which then wins over these two).
      refreshToken: env.ETSY_REFRESH_TOKEN || null,
      shopId: env.ETSY_SHOP_ID || null,
      taxonomyId: optionalId(env.ETSY_TAXONOMY_ID, 'ETSY_TAXONOMY_ID'), // seller taxonomy id every Etsy listing needs
      shippingProfileId: optionalId(env.ETSY_SHIPPING_PROFILE_ID, 'ETSY_SHIPPING_PROFILE_ID'), // sent with drafts when set
    },
    allowHosts: (env.OUTPOST_ALLOW_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    tickMs: intInRange(env.OUTPOST_TICK_MS || 500, 'OUTPOST_TICK_MS', 10, 60_000),
  };
}
