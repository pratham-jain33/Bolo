const { globalShortcut } = require('electron');

// A named-accelerator registry rather than a single hotkey. bolo binds one
// shortcut per dictation mode plus a repeat-last-transcript key, and they have
// to be registered, re-registered and released independently — registering one
// mode must never silently drop another.
//
// `id` is a stable key ('dictation', 'ask', 'edit', 'agent', 'pasteLast').
// Nothing here validates the accelerator grammar; that's Electron's job and it
// reports failure by returning false from register().

const bound = new Map(); // id -> accelerator currently held
const handlers = new Map(); // id -> fn

function setHandler(id, fn) {
  handlers.set(id, fn);
}

// Returns { id, ok, accelerator, error }.
function register(id, accelerator) {
  unregister(id);

  if (!accelerator) {
    return { id, ok: false, accelerator, error: 'no-accelerator' };
  }

  // Two ids on one accelerator: the second register() would fail anyway, but
  // naming the conflict is far more useful than "register-failed".
  for (const [otherId, otherAcc] of bound) {
    if (otherId !== id && sameAccelerator(otherAcc, accelerator)) {
      return { id, ok: false, accelerator, error: 'already-bound-to-' + otherId };
    }
  }

  try {
    const ok = globalShortcut.register(accelerator, () => {
      const fn = handlers.get(id);
      if (typeof fn === 'function') fn();
    });
    if (!ok) {
      return { id, ok: false, accelerator, error: 'register-failed (in use or invalid)' };
    }
    bound.set(id, accelerator);
    return { id, ok: true, accelerator };
  } catch (e) {
    return { id, ok: false, accelerator, error: e.message };
  }
}

// The requested accelerator is not always one the platform can bind: "Fn" is not
// a Windows key at all (the embedded controller swallows it and no key event ever
// reaches an application), and a combination another app already owns cannot be
// taken. The user's choice is what Settings displays; this is what actually gets
// registered, so a binding the platform refuses degrades to a working key instead
// of to a dead action.
// Fallbacks are only reached when the requested key is refused (another app
// already owns it). Each is a distinct working chord, different from the
// defaults in settings.js, so a conflict degrades to a live key rather than a
// dead one. `voice` is the dictation binding under its registry id.
const FALLBACKS = {
  voice: ['Control+Alt+D', 'CommandOrControl+Shift+Period'],
  dictation: ['Control+Alt+D', 'CommandOrControl+Shift+Period'],
  edit: ['Control+Alt+E', 'CommandOrControl+Shift+U'],
  agent: ['Control+Alt+G', 'CommandOrControl+Shift+J'],
  pasteLast: ['CommandOrControl+Shift+V']
};

// Returns register()'s shape, plus `requested` and `substituted` so a caller can
// tell the user what it actually got.
function registerTolerant(id, accelerator) {
  const chain = [accelerator].concat(FALLBACKS[id] || []).filter(Boolean);
  let last = null;
  for (const acc of chain) {
    const r = register(id, acc);
    if (r.ok) {
      return Object.assign(r, { requested: accelerator, substituted: acc !== accelerator });
    }
    last = r;
  }
  return Object.assign(last || { id, ok: false, accelerator, error: 'no-accelerator' }, {
    requested: accelerator,
    substituted: false
  });
}

// Electron is case-insensitive on modifier names but not on key names, so
// normalise both sides before comparing.
function sameAccelerator(a, b) {
  const norm = (s) =>
    String(s || '')
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join('+');
  return norm(a) === norm(b);
}

function unregister(id) {
  const acc = bound.get(id);
  if (acc) {
    try { globalShortcut.unregister(acc); } catch (_) {}
    bound.delete(id);
  }
}

function unregisterAll() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  bound.clear();
}

function getBindings() {
  return Object.fromEntries(bound);
}

function getBinding(id) {
  return bound.get(id) || null;
}

// ---------------------------------------------------------------------------
// Compatibility shim for the original single-hotkey call sites. `register`
// above is the real API; these keep main.js's existing dictation wiring
// working while the mode registry moves over.
// ---------------------------------------------------------------------------
const LEGACY_ID = 'dictation';

function setTrigger(fn) {
  setHandler(LEGACY_ID, fn);
}

function registerLegacy(accelerator) {
  return register(LEGACY_ID, accelerator);
}

module.exports = {
  setHandler,
  register,
  // The one main.js uses for every activation key: the default is what the user
  // asked for, and this is what the platform will actually give them.
  registerTolerant,
  FALLBACKS,
  unregister,
  unregisterAll,
  getBindings,
  getBinding,
  sameAccelerator,
  // legacy surface
  setTrigger,
  registerLegacy,
  getCurrent: () => getBinding(LEGACY_ID)
};
