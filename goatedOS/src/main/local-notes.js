'use strict';

// Local notes — a real notes store with no account behind it.
//
// This is the one integration in the catalogue that needs nothing configured: no
// OAuth, no API key, no path to point at. What it needs instead is somewhere to
// put the notes, and that is the app's own userData directory, beside
// bolo-settings.json and bolo-history.json, so there is one place to look and
// one place to clear.
//
// Two things here are load-bearing and neither is obvious from outside:
//
//   * every write replaces the whole file, through a temp file and a rename in
//     the same directory. A crash part way through a plain write leaves a store
//     that cannot be parsed, and that costs every note rather than the last one.
//     The rename is atomic, so a reader sees the old file or the new one.
//   * writes are serialised. `add` is a read-modify-write of the whole store, so
//     two at once — a held voice key and a wake word, say — would have the second
//     quietly overwrite the first's note.
//
// A store that cannot be read is never written over. The file that failed to
// parse may still hold every note the user has, so a read failure puts the
// module into a read-only state that refuses mutations and says why, rather than
// trading the notes for a working feature.
//
// A note is DATA. Nothing stored here is an instruction, and nothing in this app
// acts on what a note says.
//
// Everything returns { ok, ... } and never throws.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Beside electron-store's own files, which is where the rest of the app's state
// lives. electron-store would do this for us, but the notes want an atomic
// rewrite it does not offer, and one extra file is cheaper than one extra
// dependency.
const FILE = 'bolo-notes.json';

const MAX_NOTES = 5000;   // the store is bounded; see add() for what happens at the top
const MAX_TEXT = 20000;   // a long dictated note, with room to spare
const MAX_TITLE = 120;
const MAX_TAGS = 12;
const MAX_TAG = 40;
const TITLE_WORDS = 6;    // how much of a note becomes its title when none was given
const PREVIEW = 200;
const EXCERPT_PAD = 60;
const DEFAULT_LIMIT = 50;
const LIST_CAP = 500;

/* ---------------------------------------------------------------------------
   Where the store lives
   ------------------------------------------------------------------------ */

// Overridable so a check can point at a temp directory instead of the user's
// real notes. Resolved lazily: this module is required on paths that run before
// the app is ready, and `app.getPath` only means anything in the main process.
let overridePath = null;

function storePath() {
  return overridePath || defaultPath();
}

function defaultPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const dir = app.getPath('userData');
      if (dir) return path.join(dir, FILE);
    }
  } catch (_) {
    // Not in an Electron main process — a plain `node` run. Fall through to the
    // same pairing electron-store resolves: APPDATA on Windows, XDG elsewhere.
  }
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'bolo', FILE);
}

/* ---------------------------------------------------------------------------
   Shape of a note
   ------------------------------------------------------------------------ */

function blank() {
  return { version: 1, notes: [] };
}

function nextId() {
  // Timestamp plus a random tail: unique even when two notes land in the same
  // millisecond, which is exactly what a held key plus a wake word produces, and
  // ordered by eye in the file. The tail is padded because toString(36) of a
  // random number is sometimes shorter than the eight characters asked for.
  const tail = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return Date.now().toString(36) + '-' + tail;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function fail(error, reason, extra) {
  return { ok: false, integration: 'localNotes', error, reason: reason || error, ...(extra || {}) };
}

// Trim and normalise line endings, keep everything else. A note's own blank
// lines are its shape, so collapsing runs of whitespace here would be editing
// what the user dictated.
function cleanText(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
}

// A title made from the note itself, for when the user did not give one.
function deriveTitle(text, words = TITLE_WORDS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const parts = flat.split(' ');
  const head = parts.slice(0, words).join(' ');
  return (parts.length > words ? head + '…' : head).slice(0, MAX_TITLE);
}

// One tag list out of either an array or the comma-separated string a router
// tends to produce, deduped case-insensitively because "Work" and "work" are one
// tag to a person.
function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim().slice(0, MAX_TAG);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function isNote(n) {
  return !!n && typeof n === 'object' && typeof n.id === 'string' && n.id && typeof n.text === 'string';
}

function normalizeStored(n) {
  return {
    id: n.id,
    title: String(n.title || '').slice(0, MAX_TITLE) || deriveTitle(n.text),
    text: String(n.text).slice(0, MAX_TEXT),
    tags: cleanTags(n.tags),
    createdAt: typeof n.createdAt === 'string' && n.createdAt ? n.createdAt : new Date().toISOString()
  };
}

function summary(n) {
  return {
    id: n.id,
    title: n.title,
    tags: n.tags,
    createdAt: n.createdAt,
    chars: n.text.length,
    // The list is for picking a note, not for reading one — read() is what hands
    // back the whole thing. A list of 500 full notes would be megabytes of IPC.
    preview: excerpt(n.text, '', PREVIEW)
  };
}

// A slice of the note around the match, marked with ellipses, flattened to one
// line so it can be shown in a list or spoken. The stored text keeps its own
// newlines; only the excerpt is flattened.
function excerpt(text, query, pad = EXCERPT_PAD) {
  const src = String(text || '');
  const q = String(query || '');
  const at = q ? src.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (!src) return '';
  let cut;
  if (at < 0) cut = src.slice(0, pad * 2) + (src.length > pad * 2 ? '…' : '');
  else {
    const from = Math.max(0, at - pad);
    const to = Math.min(src.length, at + q.length + pad);
    cut = (from ? '…' : '') + src.slice(from, to) + (to < src.length ? '…' : '');
  }
  return cut.replace(/\s+/g, ' ').trim();
}

// Which field a query hit in. `null` means it hit nothing.
function foundIn(note, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return { title: false, text: false, tags: false };
  const hit = {
    title: note.title.toLowerCase().includes(q),
    text: note.text.toLowerCase().includes(q),
    tags: note.tags.some((t) => t.toLowerCase().includes(q))
  };
  return hit.title || hit.text || hit.tags ? hit : null;
}

/* ---------------------------------------------------------------------------
   The file
   ------------------------------------------------------------------------ */

let cache = null;    // { version, notes: [...] } once loaded
let broken = null;   // why the file could not be read; latched, see below
let queue = Promise.resolve();

// The shipped bound, overridable only so the check can exercise the full-store
// path without writing five thousand notes first.
let maxNotes = MAX_NOTES;

async function load() {
  if (cache) return cache;
  // Latched on purpose: a broken file is reported once and the app stops
  // re-reading it on every keystroke. Fixing the file means a restart, which is
  // a fair price for never writing over it.
  if (broken) return null;

  let raw;
  try {
    raw = await fs.readFile(storePath(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      cache = blank();   // first run: no file is not a failure
      return cache;
    }
    broken = 'the notes file could not be read (' + ((e && e.message) || e) + ')';
    return null;
  }

  try {
    const parsed = JSON.parse(stripBom(raw));
    const notes = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.notes) ? parsed.notes : []);
    cache = { version: 1, notes: notes.filter(isNote).map(normalizeStored) };
  } catch (e) {
    broken = 'the notes file could not be parsed (' + ((e && e.message) || e) + ')';
    return null;
  }
  return cache;
}

// Write the whole store to a temp file in the same directory, then rename it
// over the real one. Same volume, so the rename is atomic and a reader sees the
// old file or the new one — never a half-written one.
async function persist() {
  const file = storePath();
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    // A temp file left behind is litter, not damage, but there is no reason to
    // keep it either.
    try { await fs.rm(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

// One mutation at a time, in order. The previous result is deliberately ignored:
// a failed write must not block the next one.
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

// The one place a mutation happens. `fn` gets the current notes and returns
// `{ ok, notes, ... }` — the new array under `notes` rather than an in-place
// edit, so a failed write can put the old one back and memory never claims more
// than the disk has. That array is stripped before the caller sees it: it is how
// the write is staged, not something any of these actions return.
async function mutate(fn) {
  return serial(async () => {
    const st = await load();
    if (!st) {
      return fail('store-unreadable', 'The notes file could not be read, so nothing was changed. ' + broken);
    }

    let out;
    let next;
    try {
      const r = await fn(st.notes);
      if (!r || !r.ok) return r || fail('failed', 'That did not work.');
      next = r.notes;
      out = { ...r };
      delete out.notes;
    } catch (e) {
      return fail('failed', (e && e.message) || String(e));
    }

    const prev = st.notes;
    st.notes = next;
    try {
      await persist();
    } catch (e) {
      st.notes = prev;
      return fail('write-failed', 'The note could not be written to disk: ' + ((e && e.message) || e));
    }
    return out;
  });
}

/* ---------------------------------------------------------------------------
   The API surface
   ------------------------------------------------------------------------ */

async function status() {
  const st = await load();
  if (!st) {
    return fail('store-unreadable', broken, { integration: 'localNotes', count: 0, path: storePath() });
  }
  return {
    ok: true,
    integration: 'localNotes',
    count: st.notes.length,
    path: storePath()
  };
}

async function add({ text, title, tags } = {}) {
  const body = cleanText(text);
  if (!body) return fail('empty', 'There was nothing to note.', { speech: 'There was nothing to note.' });

  const capped = body.length > MAX_TEXT;
  const givenTitle = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

  return mutate((notes) => {
    if (notes.length >= maxNotes) {
      // Refused, not evicted. Dropping the oldest note to make room would delete
      // something the user wrote without being asked, which is a worse failure
      // than a store that stops accepting notes and says so.
      return fail('store-full', 'The notes store is full at ' + maxNotes + ' notes. Delete some to add more.', {
        count: notes.length,
        limit: maxNotes,
        speech: 'Your notes store is full. Delete a few before adding more.'
      });
    }

    const note = {
      id: nextId(),
      title: givenTitle || deriveTitle(body),
      text: capped ? body.slice(0, MAX_TEXT) : body,
      tags: cleanTags(tags),
      createdAt: new Date().toISOString()
    };

    return {
      ok: true,
      integration: 'localNotes',
      note,
      truncated: capped,
      count: notes.length + 1,
      notes: [note, ...notes],
      // The spoken line says what was saved when the user named it, and stays
      // short when they did not — "Noted." is the whole point of a voice note.
      speech: givenTitle ? 'Saved "' + givenTitle + '".' : 'Noted.'
    };
  });
}

async function list({ limit, tag, query } = {}) {
  const st = await load();
  if (!st) return fail('store-unreadable', broken);

  const n = Math.max(1, Math.min(LIST_CAP, Number(limit) || DEFAULT_LIMIT));
  const wantTag = String(tag == null ? '' : tag).trim().toLowerCase();
  const q = String(query == null ? '' : query).trim();

  // Newest first, so the note just dictated is the one at the top.
  const sorted = st.notes.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const hit = sorted
    .filter((x) => !wantTag || x.tags.some((t) => t.toLowerCase() === wantTag))
    .filter((x) => !q || foundIn(x, q));

  return {
    ok: true,
    integration: 'localNotes',
    count: hit.length,
    returned: Math.min(n, hit.length),
    notes: hit.slice(0, n).map(summary)
  };
}

async function read({ id } = {}) {
  const st = await load();
  if (!st) return fail('store-unreadable', broken);

  const want = String(id == null ? '' : id).trim();
  if (!want) return fail('bad-id', 'No note id was given.');
  const note = st.notes.find((x) => x.id === want);
  if (!note) return fail('not-found', 'There is no note with that id.', { id: want, speech: 'I could not find that note.' });

  return {
    ok: true,
    integration: 'localNotes',
    note: { ...note },
    speech: note.title ? 'Reading "' + note.title + '".' : 'Reading that note.'
  };
}

async function remove({ id } = {}) {
  const st = await load();
  if (!st) return fail('store-unreadable', broken);

  const want = String(id == null ? '' : id).trim();
  if (!want) return fail('bad-id', 'No note id was given.');

  return mutate((notes) => {
    const at = notes.findIndex((x) => x.id === want);
    if (at < 0) return fail('not-found', 'There is no note with that id.', { id: want, speech: 'I could not find that note.' });
    const gone = notes[at];
    const next = notes.slice();
    next.splice(at, 1);
    return {
      ok: true,
      integration: 'localNotes',
      id: want,
      removed: gone.title,
      count: next.length,
      notes: next,
      speech: 'Deleted "' + (gone.title || 'that note') + '".'
    };
  });
}

async function search({ query, limit } = {}) {
  const st = await load();
  if (!st) return fail('store-unreadable', broken);

  const q = String(query == null ? '' : query).trim();
  if (!q) return fail('bad-query', 'Nothing to search for.', { speech: 'What should I search your notes for?' });

  const n = Math.max(1, Math.min(LIST_CAP, Number(limit) || DEFAULT_LIMIT));
  const hits = [];
  for (const note of st.notes) {
    // Title and text only: a tag match is what list()'s `tag` filter is for, and
    // counting one here would put a note in the results with no excerpt to show.
    const hit = foundIn(note, q);
    if (!hit || (!hit.title && !hit.text)) continue;
    hits.push({ note, hit });
  }

  hits.sort((a, b) => (a.note.createdAt < b.note.createdAt ? 1 : a.note.createdAt > b.note.createdAt ? -1 : 0));

  return {
    ok: true,
    integration: 'localNotes',
    query: q,
    count: hits.length,
    returned: Math.min(n, hits.length),
    notes: hits.slice(0, n).map(({ note, hit }) => ({
      ...summary(note),
      titleMatch: hit.title,
      textMatch: hit.text,
      excerpt: excerpt(note.text, q)
    }))
  };
}

module.exports = {
  status, add, list, read, remove, search,
  _internals: {
    // Test seams. `setStorePath` is the important one: without it a check would
    // write into the user's real notes.
    setStorePath: (p) => { overridePath = p ? String(p) : null; cache = null; broken = null; },
    setMaxNotes: (n) => { maxNotes = Math.max(1, Number(n) || MAX_NOTES); },
    storePath, defaultPath,
    deriveTitle, excerpt, cleanTags, cleanText,
    MAX_NOTES, MAX_TEXT, MAX_TITLE, TITLE_WORDS
  }
};