'use strict';

// Maps — real map actions with no API key anywhere.
//
// There is nothing to authenticate and nothing to call: Google's documented
// universal links (the `?api=1` form) do everything this needs once they are
// opened in a browser. So this is a URL builder plus the OS default browser,
// which is also why it works with no account, no key and no network code of our
// own.
//
// The one rule that carries weight here is openUrl(). Every URL the agent can be
// *talked into* producing passes through it, so it accepts only an https URL on
// Google's or Apple's own map hosts. An agent that has just been told "open
// http://evil.example/steal" gets a refusal, not a browser window. Nothing else
// in this file opens anything.
//
// Everything returns { ok, ... } and never throws. status(), setPlace() and
// place() are synchronous on purpose — they touch nothing outside the process,
// and a caller that awaits a plain object is fine while one that does not is
// still correct.

const MODES = ['driving', 'walking', 'bicycling', 'transit'];
const DEFAULT_MODE = 'driving';
const PLACES = ['home', 'work'];
const MAX_QUERY = 300;

const SEARCH_BASE = 'https://www.google.com/maps/search/?api=1&query=';
const DIRECTIONS_BASE = 'https://www.google.com/maps/dir/?api=1';

// What a spoken query is shortened to. A spoken address is fine; a spoken
// paragraph is not, and the URL keeps the whole thing either way.
const SPOKEN = 60;

function fail(error, reason, extra) {
  return { ok: false, integration: 'maps', error, reason: reason || error, ...(extra || {}) };
}

// One line, trimmed, capped. A newline in a URL parameter is a broken link at
// best and a header-shaped surprise at worst, and there is no reason to accept
// one from a transcript.
function clip(v, limit) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  return limit ? s.slice(0, limit) : s;
}

function spoken(v) {
  const s = clip(v);
  return s.length > SPOKEN ? s.slice(0, SPOKEN).trim() + '…' : s;
}

/* ---------------------------------------------------------------------------
   The saved places

   Home and work live in the app's settings store (bolo-settings.json), beside
   every other preference, rather than in a file of their own: they are two short
   strings, and a second file would be a second thing to keep in step.

   Read through this one function so a check can redirect it — the alternative is
   a test that writes `mapsHome` into the user's real settings.
   ------------------------------------------------------------------------ */

let storeImpl = null;

function store() {
  if (storeImpl) return storeImpl;
  const settings = require('./settings');
  return { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) };
}

// mapsHome / mapsWork, which is what setPlace writes and what the Settings pane
// reads back.
function placeKey(name) {
  return 'maps' + name.charAt(0).toUpperCase() + name.slice(1);
}

function savedPlace(name) {
  return clip(store().get(placeKey(name)), MAX_QUERY) || null;
}

// "take me home" arrives as the word "home", not as an address, so a bare
// home/work is looked up in settings. Anything else — an address, a business, a
// town — is passed through untouched, because Maps is much better at finding it
// than this file is.
function resolvePlace(value) {
  const v = clip(value, MAX_QUERY);
  if (!v) return { ok: false, error: 'empty', reason: 'No place was given.' };

  const name = v.toLowerCase();
  if (!PLACES.includes(name)) return { ok: true, place: v, saved: false };

  const saved = savedPlace(name);
  if (!saved) {
    return {
      ok: false, error: 'no-place', place: name,
      reason: 'There is no ' + name + ' saved yet. Set it in Integrations first.'
    };
  }
  return { ok: true, place: saved, saved: true, key: placeKey(name) };
}

/* ---------------------------------------------------------------------------
   The URL builders — pure, and the part worth checking
   ------------------------------------------------------------------------ */

function normalizeMode(mode) {
  const m = clip(mode).toLowerCase();
  if (!m) return DEFAULT_MODE;
  // The words a person actually says, onto the four the API takes. Anything
  // unrecognised becomes driving rather than being passed through: a junk
  // travelmode is a link Google refuses, and "driving" is the sane default.
  const alias = {
    drive: 'driving', driving: 'driving', car: 'driving',
    walk: 'walking', walking: 'walking', onfoot: 'walking', 'on foot': 'walking',
    bike: 'bicycling', bicycle: 'bicycling', cycling: 'bicycling', bicycling: 'bicycling',
    transit: 'transit', train: 'transit', bus: 'transit', subway: 'transit'
  };
  const mapped = alias[m] || m;
  return MODES.includes(mapped) ? mapped : DEFAULT_MODE;
}

function buildSearchUrl(query) {
  const q = clip(query, MAX_QUERY);
  if (!q) return null;
  return SEARCH_BASE + encodeURIComponent(q);
}

function buildDirectionsUrl({ from, to, mode } = {}) {
  const dest = clip(to, MAX_QUERY);
  if (!dest) return null;

  const parts = [];
  const origin = clip(from, MAX_QUERY);
  // No origin is not an error: Google Maps starts from the current location,
  // which is what someone saying "directions to the airport" means.
  if (origin) parts.push('origin=' + encodeURIComponent(origin));
  parts.push('destination=' + encodeURIComponent(dest));
  parts.push('travelmode=' + normalizeMode(mode));
  return DIRECTIONS_BASE + '&' + parts.join('&');
}

// The allowlist. Deliberately narrow: two Google hosts with a /maps path, the
// legacy maps host, and Apple's. Anything else — a different scheme, a different
// host, a host that merely *contains* google.com, a URL carrying credentials —
// is refused, because the agent is the thing producing these and the agent can
// be persuaded.
function allowedMapUrl(raw) {
  let u;
  try {
    u = new URL(String(raw == null ? '' : raw));
  } catch (_) {
    return null;   // not a URL at all, which includes every javascript: payload
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;

  const host = u.hostname.toLowerCase();
  if (host === 'maps.apple.com') return u;
  if (host === 'maps.google.com') return u;
  if ((host === 'google.com' || host === 'www.google.com') && /^\/maps(\/|$)/.test(u.pathname)) return u;
  return null;
}

/* ---------------------------------------------------------------------------
   Opening
   ------------------------------------------------------------------------ */

// Overridable so a check can prove directions() builds the right link without a
// browser opening on somebody's desktop.
let opener = null;

function openExternal(url) {
  if (opener) return Promise.resolve(opener(url));
  const { shell } = require('electron');
  return Promise.resolve(shell.openExternal(url));
}

// The only place a browser is opened.
async function open(url) {
  try {
    await openExternal(url);
    return { ok: true };
  } catch (e) {
    return fail('open-failed', 'The browser could not be opened: ' + ((e && e.message) || e));
  }
}

/* ---------------------------------------------------------------------------
   The API surface
   ------------------------------------------------------------------------ */

function status() {
  return {
    ok: true,
    integration: 'maps',
    mode: 'url-opener',
    home: savedPlace('home'),
    work: savedPlace('work')
  };
}

// An empty value clears the place, which is the only way to unsay one.
function setPlace({ key, value } = {}) {
  const name = clip(key).toLowerCase();
  if (!PLACES.includes(name)) {
    return fail('bad-place', 'Only "home" and "work" can be saved.', { speech: 'I can only save home and work.' });
  }
  const v = clip(value, MAX_QUERY);
  store().set(placeKey(name), v);
  return {
    ok: true,
    integration: 'maps',
    key: name,
    value: v || null,
    speech: v ? 'Saved ' + name + '.' : 'Cleared ' + name + '.'
  };
}

async function search({ query } = {}) {
  const q = clip(query, MAX_QUERY);
  if (!q) return fail('empty-query', 'There is nothing to look up.', { speech: 'What should I look up?' });

  const url = buildSearchUrl(q);
  const r = await open(url);
  if (!r.ok) return { ...r, url };
  return {
    ok: true,
    integration: 'maps',
    action: 'search',
    query: q,
    url,
    speech: 'Opening the map for ' + spoken(q) + '.'
  };
}

async function directions({ from, to, mode } = {}) {
  const dest = resolvePlace(to);
  if (!dest.ok) return { ...fail(dest.error, dest.reason), speech: dest.error === 'empty' ? 'Where to?' : dest.reason };

  // No `from`: start from home when one is saved, since leaving from home is the
  // common case. Otherwise leave the origin out and Maps uses where the user is.
  let origin = '';
  if (from) {
    const src = resolvePlace(from);
    if (!src.ok) return { ...fail(src.error, src.reason), speech: src.reason };
    origin = src.place;
  } else {
    origin = savedPlace('home') || '';
  }

  const travel = normalizeMode(mode);
  const url = buildDirectionsUrl({ from: origin, to: dest.place, mode: travel });
  const r = await open(url);
  if (!r.ok) return { ...r, url };

  return {
    ok: true,
    integration: 'maps',
    action: 'directions',
    from: origin || null,
    to: dest.place,
    mode: travel,
    url,
    speech: 'Opening directions to ' + spoken(dest.place) + (origin ? ' from ' + spoken(origin) : '') + '.'
  };
}

// The lookup that does not open anything: a URL for the app to show, or for
// something later to open through openUrl().
function place({ query } = {}) {
  const q = clip(query, MAX_QUERY);
  if (!q) return fail('empty-query', 'There is nothing to look up.', { speech: 'What should I look up?' });

  return {
    ok: true,
    integration: 'maps',
    action: 'place',
    query: q,
    url: buildSearchUrl(q),
    speech: 'Here is the map link for ' + spoken(q) + '.'
  };
}

async function openUrl({ url } = {}) {
  const safe = allowedMapUrl(url);
  if (!safe) {
    return fail('blocked-url', 'That is not a Google or Apple Maps link, so bolo will not open it.', {
      speech: 'I will not open that link.'
    });
  }
  const href = safe.toString();
  const r = await open(href);
  if (!r.ok) return { ...r, url: href };
  return {
    ok: true,
    integration: 'maps',
    action: 'open',
    url: href,
    speech: 'Opening that map link.'
  };
}

module.exports = {
  status, setPlace, search, directions, place, openUrl,
  _internals: {
    // Test seams. `setStore` keeps the check away from the user's real settings;
    // `setOpener` keeps it away from their browser.
    setStore: (s) => { storeImpl = s || null; },
    setOpener: (fn) => { opener = typeof fn === 'function' ? fn : null; },
    buildSearchUrl, buildDirectionsUrl, allowedMapUrl, resolvePlace, normalizeMode,
    savedPlace, placeKey,
    MODES, DEFAULT_MODE, MAX_QUERY
  }
};