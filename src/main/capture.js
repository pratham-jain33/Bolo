const { BrowserWindow } = require('electron');
const path = require('path');
const audio = require('./audio');
const trace = require('./trace');

// Devices whose name says they are not really a microphone. Windows offers
// several of these (VB-Audio's CABLE Output, Stereo Mix, virtual meeting
// cameras) and one of them is frequently the system default. Opening one is
// indistinguishable from success — the stream is live, the meter moves — while
// the words never arrive, so it is worth naming out loud when it happens.
const VIRTUAL_MIC = /cable|vb-audio|voicemeeter|virtual|loopback|stereo mix|sound mapper|what u hear/i;

// The hidden window that owns the microphone.
//
// It is deliberately not owned by shell.js: this is not chrome, it has no
// appearance and it is never shown. What it does have is a lifetime problem the
// other windows do not — it must stay alive while the dashboard is closed to the
// tray, or the wake word and the pill's meter die with the window. So it is
// created once at boot, recreated on demand if it ever goes away, and never
// takes part in `window-all-closed` reasoning.
//
// Two webPreferences are load-bearing:
//
//   - backgroundThrottling: false — Chromium throttles timers in a hidden window
//     to roughly one tick per second. With that on, the level stream would arrive
//     at 1Hz and the meter and wake gate would both look broken.
//   - autoplayPolicy: 'no-user-gesture-required' — this window is never clicked,
//     so its AudioContext would be born suspended and every level would read as
//     flat silence.

let win = null;
let paths = null;

// The capture window's webContents id, so the permission handlers below can
// grant the microphone to this one window and to nothing else. Set in create(),
// so a recreated window is re-scoped rather than inheriting a stale id.
let captureWcId = null;

// Commands sent before the page has finished loading are queued rather than
// dropped. Without this, a dictation started in the first second after launch
// would send `bolo:capture-start` into a webContents with no listener yet, and
// the only symptom would be the 6s start timeout in audio.js.
let ready = false;
let queue = [];
const QUEUE_MAX = 8;

// Whether the first successful microphone open has been logged. Once is enough
// to prove the device opened; every dictation after that would be noise.
let loggedFirstStart = false;

function flushQueue() {
  const w = getWindow();
  if (!w) { queue = []; return; }
  const pending = queue;
  queue = [];
  for (const [channel, payload] of pending) {
    try { w.webContents.send(channel, payload); } catch (_) { /* window went away mid-flush */ }
  }
}

function create(preloadPath, rendererDir) {
  if (preloadPath) paths = { preloadPath, rendererDir };
  if (win && !win.isDestroyed()) return win;
  if (!paths) return null;

  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    frame: false,
    // Off the taskbar and out of the alt-tab order: this is not a window the
    // user should ever be able to find.
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: paths.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.loadFile(path.join(paths.rendererDir, 'capture.html'));

  ready = false;
  captureWcId = win.webContents.id;
  win.webContents.on('did-finish-load', () => {
    ready = true;
    flushQueue();
  });

  win.on('closed', () => {
    win = null;
    ready = false;
    captureWcId = null;
    queue = [];
    // Any dictation in flight is lost with the window; settling it here is what
    // stops the voice machine sitting in 'routing' until a timeout fires.
    audio.abort('the capture window closed');
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[bolo capture] renderer gone:', details && details.reason);
    audio.abort('the capture renderer crashed');
  });

  return win;
}

function getWindow() {
  return win && !win.isDestroyed() ? win : null;
}

// Recreate the window if it has gone away. Called on every send, so a crashed
// capture renderer heals itself on the next dictation rather than leaving the
// app permanently mute.
function ensure() {
  return getWindow() || create();
}

function send(channel, payload) {
  const w = ensure();
  if (!w) return false;
  if (!ready) {
    // Still loading. Hold it rather than losing it — see `queue` above.
    if (queue.length >= QUEUE_MAX) queue.shift();
    queue.push([channel, payload]);
    return true;
  }
  try {
    w.webContents.send(channel, payload);
    return true;
  } catch (e) {
    console.warn('[bolo capture] send failed:', channel, e.message);
    return false;
  }
}

// Messages from the capture window. Levels arrive ~16x/second, so they use
// `send` rather than `invoke` — a round trip per frame would be pure overhead on
// a channel nobody ever reads a reply from.
function installIpc(ipcMain) {
  ipcMain.on('bolo:capture-level', (_e, level) => audio.feedLevel(level));
  ipcMain.on('bolo:capture-state', (_e, payload) => {
    const p = payload || {};
    if (p.ok) {
      // Logged exactly once. "The key works but nothing gets typed" is the one
      // report this feature cannot be diagnosed from without evidence, so the
      // first successful open states the codec and the track state out loud
      // rather than leaving it to be assumed.
      if (!loggedFirstStart) {
        loggedFirstStart = true;
        console.log('[bolo capture] microphone open — ' + (p.mime || 'audio/webm') +
          ', recording=' + !!p.recording);
      }
      // Which microphone, every time. An id is opaque, and the device that most
      // often explains an empty transcript is a virtual cable that carries
      // silence — a stream opened on one of those is "working" by every other
      // measure and produces no words at all.
      if (p.deviceLabel) {
        trace.log('mic', 'open on ' + p.deviceLabel, { recording: !!p.recording });
        if (VIRTUAL_MIC.test(p.deviceLabel)) {
          trace.log('mic', 'this is a virtual/loopback device — it usually records silence, not your voice');
        }
      }
      // Only when it happens: the saved microphone was gone and the system
      // default was used instead. See `fellBackFrom` in the capture renderer.
      if (p.fellBackFrom) {
        console.warn('[bolo capture] saved microphone is unavailable — used the system default instead');
        trace.log('mic', 'saved microphone unavailable, used the system default');
      }
    } else {
      console.warn('[bolo capture]', p.stage || 'start', 'failed:', p.error || p.nameless || 'unknown');
      trace.log('mic', 'open failed', { stage: p.stage || 'start', error: p.error || p.nameless || 'unknown' });
    }
    audio.feedState(p);
  });
  ipcMain.on('bolo:capture-done', (_e, payload) => audio.feedDone(payload || {}));
  // A clip the wake-word recogniser asked for. Paired to its request by nonce.
  ipcMain.on('bolo:capture-clip-result', (_e, payload) => audio.feedClip(payload || {}));
  ipcMain.on('bolo:capture-devices-result', (_e, payload) => settleDevices(payload));
}

/* ---------------------------------------------------------------------------
   The device list

   Enumeration has to happen in the capture window — see the note in
   src/renderer/capture.js — so this is a request/response across a channel that
   is otherwise one-way. The nonce is what pairs an answer with its question: two
   panes asking at once must not be handed each other's list.
   ------------------------------------------------------------------------ */

let deviceSeq = 0;
const deviceWaiters = new Map();
const DEVICE_TIMEOUT_MS = 8000;

// Never rejects. A capture window that has crashed, or a renderer that never
// answers, resolves as an empty list rather than leaving the Settings pane
// spinning on a promise that will not settle.
function listDevices(timeoutMs) {
  if (!ensure()) return Promise.resolve({ ok: false, error: 'no-capture-window', devices: [] });

  const nonce = ++deviceSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      deviceWaiters.delete(nonce);
      resolve({ ok: false, error: 'timeout', devices: [] });
    }, timeoutMs || DEVICE_TIMEOUT_MS);

    deviceWaiters.set(nonce, (payload) => {
      clearTimeout(timer);
      deviceWaiters.delete(nonce);
      resolve(payload);
    });

    if (!send('bolo:capture-devices', { nonce })) {
      clearTimeout(timer);
      deviceWaiters.delete(nonce);
      resolve({ ok: false, error: 'send-failed', devices: [] });
    }
  });
}

function settleDevices(payload) {
  const p = payload || {};
  const waiter = deviceWaiters.get(p.nonce);
  if (waiter) waiter(p);
  else if (deviceWaiters.size) console.warn('[bolo capture] device list arrived with no request waiting');
}

module.exports = { create, ensure, getWindow, send, listDevices, installIpc, installPermissions };

/* ---------------------------------------------------------------------------
   Permissions
   ------------------------------------------------------------------------ */

// getUserMedia is refused outright unless the session says yes, and Electron's
// default is to ask a handler that does not exist — so without this the
// microphone fails with NotAllowedError before the OS is ever consulted.
//
// Scoped deliberately: only the capture window may hold the microphone. A
// dashboard or notch renderer that asked for it would be refused, so a bug (or a
// compromise) in one of those cannot turn into a hot microphone.
//
// Everything that is not `media` is allowed through. Setting a handler at all
// replaces Electron's permissive default, so returning false for the rest would
// start denying fullscreen and clipboard checks that used to pass.
function installPermissions(session) {
  try {
    session.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission !== 'media') return callback(true);
      const id = wc ? wc.id : null;
      const ok = id !== null && id === captureWcId;
      // A refusal here is the difference between "the app is broken" and "the
      // app said no", so it is never silent.
      if (!ok) console.warn('[bolo capture] refusing microphone for webContents ' + id);
      callback(ok);
    });
    // The check handler is consulted before the request handler, so denying here
    // would fail the mic with no request ever being made. It only refuses when it
    // positively knows the caller is a different window — a null webContents, or
    // one arriving before create() has run, is allowed rather than guessed at.
    session.setPermissionCheckHandler((wc, permission) => {
      if (permission !== 'media') return true;
      if (!wc || captureWcId === null) return true;
      return wc.id === captureWcId;
    });
  } catch (e) {
    console.warn('[bolo capture] could not install permission handlers:', e.message);
  }
}