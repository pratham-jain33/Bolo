'use strict';

// The user's own folders, searched for real.
//
// No index, no watcher, no daemon. An index is a thing that goes stale, needs
// rebuilding, watches the disk and costs memory on a laptop — and the questions
// this answers ("find the deck I was working on") are rare enough that a bounded
// walk is cheaper than keeping one honest. So every call is a fresh walk with a
// hard ceiling on depth, entries visited and how long it holds the event loop.
//
// Everything here returns { ok, ... } and never throws.
//
// The one action with a side effect is open(), which hands a path to the OS
// default handler. It is behind validTarget(): absolute, inside one of the folders
// this integration searches, and existing — checked in that order, because
// containment is the security question and "not found" is only the convenience
// one. A path that arrives from a transcript therefore cannot make the machine
// open something the user did not ask for.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const settings = require('./settings');

// Optional override, so the searched set can be changed without touching this
// file. Absent is the normal case — the three folders below are the default.
const ROOTS_KEY = 'localFilesRoots';

const MAX_DEPTH = 10;        // folders deep, a root = 0
const MAX_ENTRIES = 20000;   // entries visited per walk, of any kind
const MAX_RESULTS = 100;
const DEFAULT_LIMIT = 25;
const YIELD_EVERY = 300;     // entries between two yields to the event loop

// Skipped by name, case-insensitively. `node_modules` is the one directory on a
// normal machine that is both huge and never what the user meant; dot-directories
// (`.git`, `.cache`, `.venv`) are skipped wholesale for the same reason as in a
// vault — nothing the user wrote lives in one.
const SKIP_DIRS = new Set(['node_modules']);

// The three folders a file finder may look in, and nothing else.
//
// Home itself is deliberately not one of them: it holds AppData, .ssh, and every
// other application's state, so a search over it is a search over the machine
// rather than over the user's work. The fallback names are only reached when
// Electron is not the host (see electron() below) — under the app, getPath knows
// the real ones, including on a system whose folders are not named in English.
const DEFAULT_DIRS = [
  ['documents', 'Documents'],
  ['desktop', 'Desktop'],
  ['downloads', 'Downloads']
];

/* ---------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------ */

// The Electron module, if it is really there.
//
// Under plain `node`, require('electron') resolves to the *path of the electron
// binary* — a string, with no `app` and no `shell`. Asking what the object
// actually has is what keeps this module usable outside the app: the app injects
// nothing special, and tools/files-check.js runs the same code either way.
function electron() {
  try {
    const e = require('electron');
    return e && typeof e === 'object' ? e : null;
  } catch (_) {
    return null;
  }
}

function appPath(name) {
  const e = electron();
  if (e && e.app && typeof e.app.getPath === 'function') {
    try {
      const p = e.app.getPath(name);
      if (p) return p;
    } catch (_) {
      // getPath('documents') throws before the app is ready. Falling back is
      // right: a search that starts a moment later beats one that crashes.
    }
  }
  return null;
}

function fail(error, reason, extra) {
  return { ok: false, integration: 'localFiles', error, reason: reason || error, ...(extra || {}) };
}

async function statOf(p) {
  try {
    return await fsp.stat(p);
  } catch (_) {
    return null;
  }
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// An extension list, from whatever the caller had: 'png', '.png', 'png, jpg',
// ['PNG', '.jpg']. Returns dotted lower-case names, or null for "no filter" —
// and an unparseable list is treated as no filter rather than as a filter that
// silently matches nothing.
function normalizeExt(ext) {
  if (ext == null || ext === '') return null;
  const list = (Array.isArray(ext) ? ext : String(ext).split(/[,\s]+/))
    .map((e) => String(e).trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return list.length ? list.map((e) => '.' + e) : null;
}

// Case-insensitive substring on the name. An empty query matches everything,
// which is the useful reading of "list what is in Downloads".
function matchName(name, query) {
  if (!query) return true;
  return String(name).toLowerCase().includes(query);
}

// Is `abs` inside one of the roots?
//
// path.relative is the whole test: anything that climbs out comes back as a path
// starting with '..', and anything on another drive comes back absolute. The root
// itself counts as inside — "open my documents" is a reasonable thing to say —
// and its parent does not, which is the case that matters: Documents\.. is the
// home folder, and the home folder is not a place this integration may open.
function insideRoot(abs, dirs) {
  for (const root of dirs || []) {
    const rel = path.relative(root, abs);
    if (rel === '') return { ok: true, root, relative: '' };
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { ok: true, root, relative: rel };
  }
  return fail('outside-roots', 'That path is not inside a folder bolo searches.');
}

/* ---------------------------------------------------------------------------
   Roots
   ------------------------------------------------------------------------ */

// The folders that actually exist, recomputed every call.
//
// Nothing is cached: the set changes without warning — a Downloads folder comes
// and goes, a user repoints an override, an external drive is unplugged — and a
// stale root is a search that reports "no results" for a file the user can see in
// Explorer.
async function roots() {
  const override = settings.get(ROOTS_KEY);
  const wanted = Array.isArray(override) && override.length
    ? override.filter((p) => typeof p === 'string' && p.trim())
    : DEFAULT_DIRS.map(([key, fallback]) => appPath(key) || path.join(os.homedir(), fallback));

  const out = [];
  const seen = new Set();
  for (const p of wanted) {
    const abs = path.resolve(String(p));
    // Windows paths are case-insensitive; a list containing both spellings of one
    // folder would otherwise be searched twice.
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    const st = await statOf(abs);
    if (st && st.isDirectory()) out.push(abs);
  }
  return out;
}

async function status() {
  const dirs = await roots();
  return {
    ok: true, integration: 'localFiles', roots: dirs, available: true,
    // The reason the list can be short or empty, said once, here, rather than
    // leaving the pane to report "no folders" with no explanation.
    reason: dirs.length
      ? null
      : 'No searchable folders were found. bolo looks in Documents, Desktop and Downloads.'
  };
}

/* ---------------------------------------------------------------------------
   The walk

   One bounded walk, used by every reader. All three ceilings are here on purpose:

     * depth, because a node_modules chain is arbitrarily deep;
     * entries visited, because the roots can be huge;
     * a yield to the event loop every few hundred entries, because this runs in
       the main process — the same one that owns the notch, the microphone and
       every IPC reply. A tight readdir loop would freeze the whole app for the
       length of a search, and the user would read that as bolo having crashed.

   Symlinks are skipped rather than followed: to a Dirent a link is neither a file
   nor a directory, so a link pointing back up the tree cannot make this loop
   forever. `visit` returns false to stop the walk early — that is how a limit is
   a hard stop rather than a post-filter.
   ------------------------------------------------------------------------ */

async function walk(root, state, visit, opts = {}) {
  const maxDepth = opts.maxDepth || MAX_DEPTH;
  const maxEntries = opts.maxEntries || MAX_ENTRIES;

  const stack = [{ dir: root, depth: 0 }];
  let since = 0;

  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur.dir, { withFileTypes: true });
    } catch (_) {
      continue; // unreadable is skipped, never fatal: a permissions error in one
                // folder must not fail the whole search
    }

    for (const e of entries) {
      if (++state.entries > maxEntries) {
        state.truncated = true;
        return;
      }
      if (++since >= YIELD_EVERY) {
        since = 0;
        await new Promise(setImmediate);
      }

      const full = path.join(cur.dir, e.name);

      if (e.isDirectory()) {
        if (cur.depth + 1 > maxDepth) continue;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        stack.push({ dir: full, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;

      const st = await statOf(full);
      if (!st) continue;

      const more = await visit({
        path: full,
        name: e.name,
        dir: cur.dir,
        size: st.size,
        mtime: st.mtimeMs, // ms since epoch: every consumer sorts or formats
        // Bare, no dot: it is a label shown next to a filename, not a path.
        ext: path.extname(e.name).slice(1).toLowerCase()
      });
      if (more === false) return;
    }
  }
}

/* ---------------------------------------------------------------------------
   Search
   ------------------------------------------------------------------------ */

async function search({ query, limit, ext } = {}) {
  const q = String(query == null ? '' : query).trim();
  const needle = q.toLowerCase();
  const max = clampInt(limit, 1, MAX_RESULTS, DEFAULT_LIMIT);
  const exts = normalizeExt(ext);
  const dirs = await roots();

  const state = { entries: 0, truncated: false };
  const files = [];

  for (const root of dirs) {
    await walk(root, state, (file) => {
      if (!matchName(file.name, needle)) return true;
      if (exts && !exts.includes('.' + file.ext)) return true;
      files.push(file);
      return files.length < max; // false ends the walk at the limit
    });
    if (files.length >= max || state.truncated) break;
  }

  return {
    ok: true, integration: 'localFiles',
    query: q, count: files.length, roots: dirs, files,
    truncated: state.truncated
  };
}

// The most recently modified files anywhere under the roots — for "open the thing
// I was just working on", which is the question a file finder is asked most.
async function recent({ limit } = {}) {
  const max = clampInt(limit, 1, MAX_RESULTS, DEFAULT_LIMIT);
  const dirs = await roots();

  const state = { entries: 0, truncated: false };
  const files = [];

  // No early stop here: "newest" cannot be answered from a prefix of the walk, so
  // this one pays the full budget and sorts what it found.
  for (const root of dirs) {
    await walk(root, state, (file) => {
      files.push(file);
      return true;
    });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return {
    ok: true, integration: 'localFiles',
    count: Math.min(files.length, max), roots: dirs, files: files.slice(0, max),
    truncated: state.truncated
  };
}

/* ---------------------------------------------------------------------------
   Opening
   ------------------------------------------------------------------------ */

async function validTarget(raw) {
  const p = String(raw == null ? '' : raw).trim();
  if (!p) return fail('bad-path', 'No path was given.');
  if (p.includes('\0')) return fail('bad-path', 'That is not a usable path.');
  if (!path.isAbsolute(p)) {
    return fail('not-absolute', 'A full path is needed to open something: ' + p);
  }

  const abs = path.resolve(p);
  const dirs = await roots();
  const inside = insideRoot(abs, dirs);
  if (!inside.ok) return inside;

  const st = await statOf(abs);
  if (!st) return fail('not-found', 'There is nothing at that path any more.');

  return { ok: true, abs, isDir: st.isDirectory(), root: inside.root };
}

async function open({ path: p } = {}) {
  const v = await validTarget(p);
  if (!v.ok) return v;

  const e = electron();
  if (!e || !e.shell || typeof e.shell.openPath !== 'function') {
    return fail('no-shell', 'The system file handler is not available here.');
  }

  const err = await e.shell.openPath(v.abs);
  // openPath resolves to '' on success and to the failure message otherwise. It
  // does not reject, so this is the only signal there is.
  if (err) return fail('open-failed', String(err));

  return {
    ok: true, integration: 'localFiles', action: 'open',
    path: v.abs, name: path.basename(v.abs), kind: v.isDir ? 'folder' : 'file'
  };
}

async function reveal({ path: p } = {}) {
  const v = await validTarget(p);
  if (!v.ok) return v;

  const e = electron();
  if (!e || !e.shell || typeof e.shell.showItemInFolder !== 'function') {
    return fail('no-shell', 'The system file handler is not available here.');
  }

  try {
    e.shell.showItemInFolder(v.abs);
  } catch (err) {
    return fail('reveal-failed', String((err && err.message) || err));
  }

  return {
    ok: true, integration: 'localFiles', action: 'reveal',
    path: v.abs, name: path.basename(v.abs)
  };
}

module.exports = {
  ROOTS_KEY,
  roots,
  status,
  search,
  open,
  reveal,
  recent,
  _internals: {
    walk,
    insideRoot,
    normalizeExt,
    matchName,
    validTarget,
    electron,
    LIMITS: { MAX_DEPTH, MAX_ENTRIES, MAX_RESULTS, DEFAULT_LIMIT, YIELD_EVERY }
  }
};