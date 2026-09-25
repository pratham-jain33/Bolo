// Hold-to-talk.
//
// Electron's globalShortcut is press-only — it fires one callback on the key
// down and never sees the release — so on its own the voice key can only be a
// toggle: press to start, press to stop. Real hold-to-talk (hold to record,
// release to send) needs the key-UP event, and the only way to get that
// system-wide is a native input hook. That is uiohook-napi, which watches the
// OS keyboard and reports keydown AND keyup for every key.
//
// This module is that watcher, and nothing more: it matches the bound
// accelerators against live key events and calls onPress(mode) / onRelease(mode).
// main.js decides what those mean (start / stop a listening session). It is used
// only in "hold" activation mode; in "toggle" mode main.js keeps the plain
// globalShortcut path and this module stays stopped.
//
// It degrades rather than dies: if the native module will not load (an install
// that could not fetch its prebuilt binary), available() is false and main.js
// falls back to the toggle path. A window that cannot hold-to-talk still toggles.
//
// One honest caveat: a listener is not a filter. uiohook sees the key but does
// not consume it, so the activation chord also reaches the focused app. For the
// default Ctrl+Shift+D / +E / +A that is harmless; a binding that collides with
// something the foreground app cares about would fire both. globalShortcut, by
// contrast, swallows its accelerator — which is the price of toggle vs hold.

let uIOhook = null;
let UiohookKey = null;
try {
  const mod = require('uiohook-napi');
  uIOhook = mod.uIOhook;
  UiohookKey = mod.UiohookKey;
} catch (_) {
  uIOhook = null; // no native hook here; main.js will use the toggle path
}

let running = false;
let bindings = [];        // [{ mode, mods:{ctrl,shift,alt,meta}, keycode }]
let onPressCb = null;
let onReleaseCb = null;
// Only one hold at a time: the mode whose key is currently held, and its keycode
// so the matching keyup can be recognised even after modifiers have been let go.
let activeMode = null;
let activeKeycode = null;
// Every keycode currently held, by scancode. The native modifier *flags* on a
// key event have proven flaky in the wild (a Ctrl held through the chord
// sometimes arrives as ctrlKey:false while the keycodes themselves are always
// right), so matching consults this tracked set as well as the flags. Without
// it a tap the hook plainly saw reads as "the key does nothing".
let held = new Set();

// Modifier scancodes, left and right, resolved off the native table when it is
// there and off well-known constants when it is not (the table only matters
// while the hook is running, which implies it loaded).
function modCodes() {
  const K = UiohookKey || {};
  const num = (v, fb) => (typeof v === 'number' ? v : fb);
  return {
    ctrl: [num(K.Ctrl, 0x001D), num(K.CtrlRight, 0x0E1D)],
    shift: [num(K.Shift, 0x002A), num(K.ShiftRight, 0x0036)],
    alt: [num(K.Alt, 0x0038), num(K.AltRight, 0x0E38)],
    meta: [num(K.Meta, 0x0E5B), num(K.MetaRight, 0x0E5C)]
  };
}

function available() {
  return !!(uIOhook && UiohookKey && typeof uIOhook.start === 'function');
}

// Map the final token of an Electron accelerator ("D", "F1", "5", "Space") to a
// uiohook keycode. Letters and digits cover the defaults; a handful of named keys
// are added for anything the user rebinds to. Returns undefined when there is no
// mapping, which drops that binding from hold mode (it still works as a toggle).
function keycodeFor(token) {
  if (!UiohookKey || !token) return undefined;
  const t = String(token).trim();
  const up = t.toUpperCase();
  // Single letter or digit — the UiohookKey table keys them by the character.
  if (/^[A-Z0-9]$/.test(up) && UiohookKey[up] != null) return UiohookKey[up];
  const NAMED = {
    SPACE: 'Space', ENTER: 'Enter', RETURN: 'Enter', TAB: 'Tab',
    ESC: 'Escape', ESCAPE: 'Escape', BACKSPACE: 'Backspace',
    UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
    HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown',
    INSERT: 'Insert', DELETE: 'Delete'
  };
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(up) && UiohookKey[up] != null) return UiohookKey[up];
  const named = NAMED[up];
  if (named && UiohookKey[named] != null) return UiohookKey[named];
  return undefined;
}

// Electron accelerator string -> { mods, keycode }, or null if the key part has
// no uiohook mapping. Modifier-only accelerators (no main key) return null: hold
// mode needs a key whose release it can watch.
function parseAccel(accel) {
  const parts = String(accel || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = { ctrl: false, shift: false, alt: false, meta: false };
  let key = null;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'control' || l === 'ctrl' || l === 'commandorcontrol' || l === 'cmdorctrl') mods.ctrl = true;
    else if (l === 'shift') mods.shift = true;
    else if (l === 'alt' || l === 'option') mods.alt = true;
    else if (l === 'super' || l === 'meta' || l === 'command' || l === 'cmd') mods.meta = true;
    else key = p;
  }
  if (!key) return null;
  const keycode = keycodeFor(key);
  if (keycode == null) return null;
  return { mods, keycode };
}

function modsMatch(e, mods) {
  return !!e.ctrlKey === mods.ctrl &&
    !!e.shiftKey === mods.shift &&
    !!e.altKey === mods.alt &&
    !!e.metaKey === mods.meta;
}

// Same question as modsMatch, answered from the tracked held-key set instead
// of the event flags. Normalises to modifier classes and requires exactness,
// so holding an extra modifier still does not match — just like the flags.
function trackedMatch(mods) {
  const codes = modCodes();
  const has = (list) => list.some((c) => held.has(c));
  return has(codes.ctrl) === mods.ctrl &&
    has(codes.shift) === mods.shift &&
    has(codes.alt) === mods.alt &&
    has(codes.meta) === mods.meta;
}

// list: [{ mode, accelerator }]. Unmappable bindings are dropped (logged by the
// caller through the return value).
function setBindings(list) {
  const next = [];
  const dropped = [];
  for (const item of list || []) {
    const parsed = parseAccel(item && item.accelerator);
    if (parsed) next.push({ mode: item.mode, mods: parsed.mods, keycode: parsed.keycode });
    else dropped.push(item && item.mode);
  }
  bindings = next;
  // A rebind mid-hold would otherwise strand activeMode; reset it.
  activeMode = null;
  activeKeycode = null;
  return { bound: next.map((b) => b.mode), dropped };
}

function onPress(cb) { onPressCb = cb; }
function onRelease(cb) { onReleaseCb = cb; }

function handleDown(e) {
  // Track first: the chord's own keydown is what completes the set, so the
  // main key has to be in `held` before matching runs.
  if (e && typeof e.keycode === 'number') held.add(e.keycode);
  // Auto-repeat sends repeated keydowns while a key is held; the activeMode guard
  // makes only the first one start a session.
  if (activeMode) return;
  for (const b of bindings) {
    if (e.keycode === b.keycode && (modsMatch(e, b.mods) || trackedMatch(b.mods))) {
      activeMode = b.mode;
      activeKeycode = b.keycode;
      if (onPressCb) { try { onPressCb(b.mode); } catch (_) {} }
      return;
    }
  }
}

function handleUp(e) {
  if (e && typeof e.keycode === 'number') held.delete(e.keycode);
  // Stop when the main key is released, whatever happened to the modifiers in the
  // meantime — "hold D, let go of D" is the gesture, and releasing Shift first
  // must not either stop it early or strand it.
  if (activeMode && e.keycode === activeKeycode) {
    const m = activeMode;
    activeMode = null;
    activeKeycode = null;
    if (onReleaseCb) { try { onReleaseCb(m); } catch (_) {} }
  }
}

function start() {
  if (!available() || running) return running;
  held.clear();
  try {
    uIOhook.on('keydown', handleDown);
    uIOhook.on('keyup', handleUp);
    uIOhook.start();
    running = true;
  } catch (_) {
    running = false;
  }
  return running;
}

function stop() {
  if (!uIOhook || !running) return;
  try {
    if (typeof uIOhook.removeListener === 'function') {
      uIOhook.removeListener('keydown', handleDown);
      uIOhook.removeListener('keyup', handleUp);
    }
    uIOhook.stop();
  } catch (_) {}
  running = false;
  activeMode = null;
  activeKeycode = null;
  held.clear();
}

module.exports = {
  available,
  setBindings,
  onPress,
  onRelease,
  start,
  stop,
  isRunning: () => running,
  parseAccel
};
