const Store = require('electron-store');

// seed-keys.js holds live credentials and is gitignored, so it may legitimately
// be absent on a fresh clone. A missing seed file means "no bundled keys", not a
// crash on boot — the app still runs and keys can be pasted into Settings.
let seed = { groq: [], deepgram: [] };
try {
  seed = require('./seed-keys');
} catch (_) { /* not shipped / not cloned: run keyless until one is added */ }

// Original secure-ish local key store for bolo.
//
// Two providers now, not one: Groq does both the speech-to-text and the model
// work, and Deepgram does the speaking. They rotate independently — a Groq key
// hitting a rate limit must not put a Deepgram key into cooldown, and the two
// services have unrelated key shapes.
//
// The store is therefore shaped { providers: { groq: {keys,index}, deepgram: {...} } }
// rather than the flat { keys, index } it used to be. `migrateLegacy` carries an
// install that predates the split across, so nobody loses the key they already
// pasted in. Keys live in the `bolo-keys` store file and are never logged in
// full, and never handed to a renderer — `listMasked` is the only reader a
// renderer is allowed to have.

const PROVIDERS = ['groq', 'deepgram'];
const DEFAULT_PROVIDER = 'groq';

// Bumped when the bundled keys in seed-keys.js change and should be re-offered
// to an install that never added any of its own. v2 is the google provider: an
// install already at v1 has to see the new provider, and the per-provider guard
// in applySeed still protects any key the user pasted themselves. Spotify is one
// provider later and deliberately does NOT bump this — see seedSpotifyClient,
// which has to stay reachable after the gate has closed.
const SEED_VERSION = 2;

let store = null;

function init() {
  store = new Store({
    name: 'bolo-keys',
    // No `keys`/`index` default here on purpose: a default would make a legacy
    // store read as "already migrated" and the migrate below would never fire.
    defaults: { providers: {}, seeded: 0 }
  });
  migrateLegacy();
  applySeed();
  seedSpotifyClient();
  return store;
}

function ensure() {
  if (!store) init();
  return store;
}

function mask(k) {
  if (!k || k.length < 8) return '••••';
  return k.slice(0, 3) + '…' + k.slice(-4);
}

function normalizeProvider(provider) {
  const p = String(provider || DEFAULT_PROVIDER).toLowerCase();
  return PROVIDERS.includes(p) ? p : DEFAULT_PROVIDER;
}

/* ---------------------------------------------------------------------------
   Store shape
   ------------------------------------------------------------------------ */

// Returns { keys, index } for one provider, tolerating a store that has never
// held that provider at all.
function providerState(provider) {
  ensure();
  const all = store.get('providers') || {};
  const p = all[provider];
  if (p && Array.isArray(p.keys)) {
    return { keys: p.keys, index: Number(p.index) || 0 };
  }
  return { keys: [], index: 0 };
}

// Writes one provider back without disturbing its siblings — the two providers
// rotate at their own pace and must not clobber each other's index. Extra fields
// on the record (google's `secret`) are carried through rather than dropped.
function writeProvider(provider, next) {
  ensure();
  const all = store.get('providers') || {};
  const keys = Array.isArray(next.keys) ? next.keys : [];
  const index = keys.length ? (Number(next.index) || 0) % keys.length : 0;
  const record = { ...(all[provider] || {}), ...next, keys, index };
  store.set('providers', { ...all, [provider]: record });
}

// An install from before the provider split has a flat `keys` array. Move it to
// groq, which is the only provider that existed then, and drop the old fields so
// the migration cannot run twice. Deliberately not version-gated: it is
// idempotent (it deletes what it reads) and must keep working for a pre-v1 store.
function migrateLegacy() {
  const legacy = store.get('keys');
  if (!Array.isArray(legacy)) return;

  if (legacy.length) {
    const groq = providerState('groq');
    if (!groq.keys.length) {
      writeProvider('groq', { keys: legacy, index: store.get('index') || 0 });
    }
  }
  store.delete('keys');
  store.delete('index');
  store.delete('provider');
}

// The keys the user handed over, applied once. Two guards, both load-bearing:
//
//   - only into a provider that has no keys at all, so a key the user pasted
//     themselves is never overwritten by a bundled one; and
//   - only while `seeded` is below SEED_VERSION, so Settings -> Clear keys
//     stays cleared instead of being re-seeded on the next launch.
function applySeed() {
  const done = Number(store.get('seeded')) || 0;
  if (done >= SEED_VERSION) return;

  for (const provider of PROVIDERS) {
    const list = (seed[provider] || [])
      .map((k) => String(k || '').trim())
      .filter(Boolean);
    if (!list.length) continue;
    if (providerState(provider).keys.length) continue;

    const unique = [];
    for (const k of list) if (!unique.includes(k)) unique.push(k);
    writeProvider(provider, { keys: unique, index: 0 });
  }

  store.set('seeded', SEED_VERSION);
}

/* ---------------------------------------------------------------------------
   Reads
   ------------------------------------------------------------------------ */

function listMasked(provider) {
  const p = normalizeProvider(provider);
  const { keys, index } = providerState(p);
  return keys.map((k, i) => ({ index: i, masked: mask(k), active: i === index % (keys.length || 1) }));
}

function count(provider) {
  return providerState(normalizeProvider(provider)).keys.length;
}

function has(provider) {
  return count(provider) > 0;
}

// Full key, for main-process use only. Never send this to a renderer.
function getActiveKey(provider) {
  const p = normalizeProvider(provider);
  const { keys, index } = providerState(p);
  if (!keys.length) return null;
  return keys[index % keys.length];
}

/* ---------------------------------------------------------------------------
   Writes
   ------------------------------------------------------------------------ */

function add(key, provider) {
  const p = normalizeProvider(provider);
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'empty-key' };
  if (k.length < 10) return { ok: false, error: 'key-too-short' };

  const { keys, index } = providerState(p);
  if (keys.includes(k)) return { ok: false, error: 'duplicate-key', count: keys.length, provider: p };
  const next = keys.concat([k]);
  writeProvider(p, { keys: next, index });
  return { ok: true, provider: p, count: next.length, keys: listMasked(p) };
}

function removeAt(index, provider) {
  const p = normalizeProvider(provider);
  const { keys, index: current } = providerState(p);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= keys.length) return { ok: false, error: 'bad-index' };
  const next = keys.slice();
  next.splice(i, 1);
  // Cooldowns are positional, so removing a key invalidates every one of them.
  clearCooldowns(p);
  writeProvider(p, { keys: next, index: current >= next.length ? 0 : current });
  return { ok: true, provider: p, count: next.length, keys: listMasked(p) };
}

function clear(provider) {
  const p = normalizeProvider(provider);
  clearCooldowns(p);
  writeProvider(p, { keys: [], index: 0 });
  return { ok: true, provider: p, count: 0, keys: [] };
}

function rotate(provider) {
  const p = normalizeProvider(provider);
  const { keys, index } = providerState(p);
  if (!keys.length) return { ok: false, error: 'no-keys' };
  const next = (index + 1) % keys.length;
  writeProvider(p, { keys, index: next });
  return { ok: true, provider: p, index: next, keys: listMasked(p) };
}

/* ---------------------------------------------------------------------------
   Round-robin
   ------------------------------------------------------------------------ */

// A key that just failed is skipped while it cools down, so a rate-limited key
// costs one wasted call rather than one on every request. If every key is
// cooling down the cooldown is ignored: being rate-limited is a reason to try a
// different key, never a reason to refuse to call the API at all.
const COOLDOWN_MS = 15000;
const failedAt = new Map();

function clearCooldowns(provider) {
  for (const k of Array.from(failedAt.keys())) {
    if (k.startsWith(provider + ':')) failedAt.delete(k);
  }
}

// Round-robin: use the current key, then advance. Every call moves the index on,
// so two consecutive requests use two different keys rather than pinning one
// until it fails. Starts at index 0, not 1 — advancing before reading would
// silently skip the first key on a fresh install.
function nextKey(provider) {
  const p = normalizeProvider(provider);
  const { keys, index } = providerState(p);
  if (!keys.length) return null;

  const start = index % keys.length;
  const now = Date.now();
  let chosen = start;
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length;
    chosen = idx; // all cooling down: keep the last candidate rather than none
    const at = failedAt.get(p + ':' + idx) || 0;
    if (now - at >= COOLDOWN_MS) break;
  }

  writeProvider(p, { keys, index: (chosen + 1) % keys.length });
  return keys[chosen];
}

// On 429/auth failure, put this key in cooldown so nextKey() steps over it. The
// index already advanced past the key that was just used.
function markFailure(provider) {
  const p = normalizeProvider(provider);
  const { keys, index } = providerState(p);
  if (!keys.length) return { ok: false, error: 'no-keys' };
  const failed = (index - 1 + keys.length) % keys.length;
  failedAt.set(p + ':' + failed, Date.now());
  return { ok: true, provider: p, index: failed, cooldownMs: COOLDOWN_MS, keys: listMasked(p) };
}

// A key that succeeds is healthy again, so clear any stale cooldown.
function markSuccess(provider) {
  const p = normalizeProvider(provider);
  const { keys, index } = providerState(p);
  if (!keys.length) return;
  failedAt.delete(p + ':' + ((index - 1 + keys.length) % keys.length));
}

module.exports = {
  init, mask, listMasked, count, has, add, removeAt, clear,
  getActiveKey, nextKey, rotate, markFailure, markSuccess,
  PROVIDERS, DEFAULT_PROVIDER, SEED_VERSION, COOLDOWN_MS
};