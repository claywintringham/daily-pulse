// ── Upstash Redis client (pure fetch, no npm package required) ──────────────
// Uses the Upstash REST API directly so this works in any serverless runtime.

const BASE  = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function cmd(...args) {
  if (!BASE || !TOKEN) throw new Error('Upstash env vars not set');
  const res = await fetch(BASE, {
    method:  'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Redis: ${json.error}`);
  return json.result;
}

export const redis = {
  /** Get a value (auto JSON-parsed). Returns null if missing. */
  async get(key) {
    const raw = await cmd('GET', key);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },

  /** Set a value (auto JSON-serialised). Optional TTL in seconds. */
  async set(key, value, ttlSeconds) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) return cmd('SET', key, s, 'EX', ttlSeconds);
    return cmd('SET', key, s);
  },

  /** Delete a key. */
  async del(key) { return cmd('DEL', key); },

  /** Check existence. Returns 1 or 0. */
  async exists(key) { return cmd('EXISTS', key); },

  /** Increment a counter and set TTL only on first creation. */
  async incr(key) { return cmd('INCR', key); },

  /** Set TTL on an existing key. */
  async expire(key, ttlSeconds) { return cmd('EXPIRE', key, ttlSeconds); },
};

// Named exports so callers can do either:
//   import { redis } from './redis.js'          → redis.get(key)
//   import { get, set } from './redis.js'       → get(key)
export const get    = (...a) => redis.get(...a);
export const set    = (...a) => redis.set(...a);
export const del    = (...a) => redis.del(...a);
export const exists = (...a) => redis.exists(...a);
export const incr   = (...a) => redis.incr(...a);
export const expire = (...a) => redis.expire(...a);
