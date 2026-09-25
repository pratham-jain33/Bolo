const settings = require('./settings');

// Audio, main-process side.
//
// This used to be a stub that emitted `Math.random()` on a timer — the pill's
// meter, the notch's waveform and the wake-word gate were all animating noise.
// It is now a facade over the hidden capture window (src/renderer/capture.js),
// which owns the real microphone and reports real RMS levels back.
//
// The API the rest of the app already used is deliberately unchanged
// (`setLevelListener` / `getLevelListener` / `start` / `stop` / `isListening`),
// with one honest difference: start and stop are async now, because opening a
// microphone and finalising a MediaRecorder are both genuinely asynchronous.
// Callers that used to ignore the return value still work; voice.js awaits it.
//
// The window is injected rather than required, so there is no cycle between
// main.js, shell.js and this file.

const START_TIMEOUT_MS = 6000;
const STOP_TIMEOUT_MS = 8000;
// A clip is a fixed few hundred milliseconds of audio plus one encode, so it is
// bounded far tighter than a dictation.
const CLIP_TIMEOUT_MS = 5000;

let sender = null;        // (channel, payload) => void, injected by main.js
let onLevel = null;
let listening = false;
let monitoring = false;
let pendingStart = null;
let inflightStart = null;
let pendingStop = null;
let pendingClip = null;
let clipSeq = 0;
let lastError = null;
let lastState = { ok: null, hasStream: false };

// The level stream has more than one consumer (waveform, pill, wake-word gate),
// so expose the current listener — callers that need to add themselves without
// displacing the others can chain onto it.
function setLevelListener(fn) {
  onLevel = fn;
}

function getLevelListener() {
  return onLevel;
}

// main.js hands in the way to reach the capture window. Until it does, every
// call below degrades to "no microphone" instead of throwing.
function attach(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

function send(channel, payload) {
  if (!sender) return false;
  try { return sender(channel, payload) !== false; } catch (_) { return false; }
}

function settleStart(result) {
  const p = pendingStart;
  inflightStart = null;
  if (!p) return;
  pendingStart = null;
  clearTimeout(p.timer);
  p.resolve(result);
}

function settleStop(result) {
  const p = pendingStop;
  if (!p) return;
  pendingStop = null;
  clearTimeout(p.timer);
  p.resolve(result);
}

/* ---------------------------------------------------------------------------
   Called by main.js with whatever the capture window reported
   ------------------------------------------------------------------------ */

function feedLevel(level) {
  const n = Number(level);
  if (typeof onLevel === 'function') onLevel(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
}

// The capture window tells us whether the microphone actually opened. A refusal
// (no device, permission denied) has to surface here, because the alternative is
// a session that reports "listening", shows a moving meter, and then transcribes
// nothing — which reads as a broken app rather than as a missing microphone.
function feedState(payload) {
  const p = payload || {};
  lastState = { ok: !!p.ok, hasStream: !!p.recording, mime: p.mime || null, error: p.error || null, nameless: p.nameless || null };
  if (p.ok) {
    listening = true;
    lastError = null;
    settleStart({ ok: true, listening: true, mime: p.mime || null });
    return;
  }
  listening = false;
  lastError = { stage: p.stage || 'start', message: p.error || 'capture failed', name: p.nameless || null };
  settleStart({ ok: false, listening: false, error: lastError.message, stage: lastError.stage, name: lastError.name });
}

// The capture window's answer to a clip request. Paired by nonce, because the
// request is fire-and-forget on a one-way channel.
function feedClip(payload) {
  const p = payload || {};
  const wait = pendingClip;
  if (!wait || (p.nonce != null && p.nonce !== wait.nonce)) return;
  pendingClip = null;
  clearTimeout(wait.timer);
  if (!p.ok) return wait.resolve({ ok: false, error: p.error || 'clip-failed', bytes: 0 });
  wait.resolve({
    ok: true,
    buffer: p.buffer || null,
    mime: p.mime || 'audio/webm',
    ms: p.ms || 0,
    bytes: p.bytes || (p.buffer ? p.buffer.byteLength : 0)
  });
}

function feedDone(payload) {
  const p = payload || {};
  listening = false;
  if (!p.ok) {
    lastError = { stage: 'record', message: p.error || 'recording failed' };
    settleStop({ ok: false, error: lastError.message, bytes: 0 });
    return;
  }
  settleStop({
    ok: true,
    buffer: p.buffer || null,
    mime: p.mime || 'audio/webm',
    ms: p.ms || 0,
    bytes: p.bytes || (p.buffer ? p.buffer.byteLength : 0)
  });
}

// The window died with a dictation in flight. Without this both promises would
// sit until their timeouts, and the voice machine would look stuck.
function abort(reason) {
  listening = false;
  monitoring = false;
  settleStart({ ok: false, listening: false, error: reason || 'capture window gone', stage: 'window' });
  settleStop({ ok: false, error: reason || 'capture window gone', bytes: 0 });
  if (pendingClip) {
    const wait = pendingClip;
    pendingClip = null;
    clearTimeout(wait.timer);
    wait.resolve({ ok: false, error: reason || 'capture window gone', bytes: 0, stage: 'window' });
  }
}

/* ---------------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------------ */

// idle -> listening. Resolves once the microphone is genuinely open and the
// recorder is running.
async function start() {
  if (listening) return { ok: true, listening: true, already: true };

  if (!sender) {
    lastError = { stage: 'window', message: 'capture window is not available' };
    return { ok: false, listening: false, error: lastError.message };
  }

  if (pendingStart) settleStart({ ok: false, listening: false, error: 'superseded' });

  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingStart) pendingStart = null;
      inflightStart = null;
      lastError = { stage: 'timeout', message: 'the microphone did not open in time' };
      resolve({ ok: false, listening: false, error: lastError.message, stage: 'timeout' });
    }, START_TIMEOUT_MS);
    pendingStart = { resolve, timer };
  });
  inflightStart = result;

  send('bolo:capture-start', { deviceId: settings.get('micDeviceId') || '' });
  return result;
}

// listening -> stopped. Resolves with the recorded bytes.
async function stop() {
  if (!sender) return { ok: false, error: 'capture window is not available', bytes: 0 };

  // A stop can land while the microphone is still opening — the key is
  // press-to-start / press-to-stop and the device takes a moment to spin up. Wait
  // for that start to settle rather than reporting "not listening" for a session
  // the user can see is running.
  if (inflightStart && !listening) {
    const s = await inflightStart;
    if (!s.ok) return { ok: false, error: s.error || 'not-listening', bytes: 0 };
  }

  if (pendingStop) settleStop({ ok: false, error: 'superseded', bytes: 0 });

  // Nothing is recording. Answer immediately rather than waiting out the
  // timeout for a capture window that has nothing to hand back.
  if (!listening) return { ok: false, error: 'not-listening', bytes: 0 };

  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingStop) pendingStop = null;
      resolve({ ok: false, error: 'the recorder did not finish in time', bytes: 0 });
    }, STOP_TIMEOUT_MS);
    pendingStop = { resolve, timer };
  });

  send('bolo:capture-stop', {});
  return result;
}

// A short clip off the already-open stream, for a caller that wants to know what
// was said rather than how loud it was. Used by the wake word, which cannot
// recognise a phrase from a level.
//
// It reuses the monitor stream rather than opening a second one: the microphone
// is already hot when this is called, so this costs an encoder and nothing else.
// A dictation in flight is refused by the capture window ('busy') rather than
// interleaved — see recordClip() there.
async function clip(ms) {
  if (!sender) return { ok: false, error: 'capture window is not available', bytes: 0 };
  if (pendingClip) return { ok: false, error: 'clip-in-flight', bytes: 0 };

  const nonce = ++clipSeq;
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingClip && pendingClip.nonce === nonce) pendingClip = null;
      resolve({ ok: false, error: 'the clip did not arrive in time', bytes: 0, stage: 'timeout' });
    }, CLIP_TIMEOUT_MS);
    pendingClip = { nonce, resolve, timer };
  });

  send('bolo:capture-clip', { nonce, ms: ms || 1400, deviceId: settings.get('micDeviceId') || '' });
  return result;
}

// Hold the microphone open without recording anything, so the wake-word gate has
// a live level stream. This is the only path that keeps the OS microphone
// indicator lit while the app is idle, and it only runs when the user has turned
// the wake word on.
//
// Deliberately does NOT go through start(): that begins a dictation, and a wake
// word that recorded you before it recognised you would be the wrong trade.
async function monitor(on) {
  // Keep-warm wins over a stop request: when the mic is meant to stay hot, the
  // wake word turning its monitor off (wake.stop → monitor(false)) must not close
  // the shared stream. A stop is honoured only while keep-warm is off.
  const want = !!on || keepWarm;
  if (monitoring === want) return { ok: true, monitoring };
  monitoring = want;
  send('bolo:capture-monitor', { on: want, deviceId: settings.get('micDeviceId') || '' });
  return { ok: true, monitoring };
}

// Keep the microphone hot at all times so the first dictation of a session pays
// no cold start. Owns the monitor stream independently of the wake word, which
// also uses monitor() but releases it on stop. Note: this keeps the OS mic
// indicator lit whenever the app runs — the user asked for exactly that trade.
let keepWarm = false;
function setKeepWarm(on) {
  keepWarm = !!on;
  if (keepWarm) monitor(true);
}

function isListening() {
  return listening;
}

function getState() {
  return {
    listening,
    monitoring,
    lastError,
    // Honest about the backend: there is no local stub in this path any more.
    backend: 'renderer-mediaRecorder',
    mime: (lastState && lastState.mime) || null
  };
}

module.exports = {
  start, stop, clip, monitor, setKeepWarm, isListening, getState,
  setLevelListener, getLevelListener, attach,
  feedLevel, feedState, feedDone, feedClip, abort
};