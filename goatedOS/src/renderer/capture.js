// The microphone, and nothing else.
//
// This window is never shown and never focused. It exists because it is the only
// surface guaranteed to be alive for the whole session: the notch is hidden most
// of the time, the dashboard can be closed to the tray, and the intro is gone
// after first run. A microphone that lives in any of those would go silent with
// them.
//
// It owns three things and reports all of them to main:
//
//   1. The live level stream. Real RMS off an AnalyserNode, not a random number —
//      the pill's meter, the notch's waveform and the wake-word gate all read it,
//      and two of those are only meaningful if the signal is real.
//   2. The recording. MediaRecorder -> Blob -> ArrayBuffer, straight over IPC.
//      No temp file, so a dictation never leaves a fragment of your voice on disk.
//   3. Stream lifetime. The mic is opened on demand and released when nothing
//      needs it, so the OS microphone indicator goes out when the app is idle.
//      An always-open microphone is a real privacy cost, not a rounding error.
//
// Everything here is driven by main; this file has no opinion about when a
// recording should happen.

var bolo = window.bolo;

/* ---------------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------------ */

// Opus in WebM is what Chromium produces natively and what Groq's transcription
// endpoint accepts directly. The order matters: the first format the browser
// admits to supporting wins, and the plain `audio/webm` fallback is only for a
// build without the Opus encoder.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4'
];

// ~16 updates/second. The waveform and the meter are both smoothed in the
// renderer, so this only has to be fast enough to look continuous.
const LEVEL_INTERVAL_MS = 60;

// Speech sits around 0.02–0.15 RMS; this maps that onto most of 0–1 so the
// meter actually uses its range. Below ~0.002 is room tone and reads as near
// zero, which is what makes the pill look still when you are not talking.
const RMS_FULL_SCALE = 0.12;

// How long the stream stays open with nothing recording, so that a pause
// between two dictations does not have to re-open the microphone (and re-pay
// the ~200ms device spin-up) every time.
const IDLE_RELEASE_MS = 45000;

/* ---------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------ */
let stream = null;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let samples = null;

let recorder = null;
let chunks = [];
let recording = false;
let recordStartedAt = 0;
let recordMime = '';

let levelTimer = null;
let idleTimer = null;
let monitoring = false; // the wake word is holding the mic open
let smoothed = 0;
let lastError = null;
// The device the last open fell back *from*, when the saved one was gone. Held
// so the next state report can name it instead of the app looking like it
// silently ignored the setting.
let fellBackFrom = '';

/* ---------------------------------------------------------------------------
   Microphone
   ------------------------------------------------------------------------ */
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) { /* keep trying */ }
  }
  return '';
}

function report(payload) {
  try { if (bolo && bolo.captureState) bolo.captureState(payload); } catch (_) {}
}

function fail(stage, err) {
  lastError = { stage, message: String((err && err.message) || err || 'unknown') };
  report({ ok: false, stage, error: lastError.message });
  return lastError;
}

// Open (or reuse) the microphone. `deviceId` empty means "whatever Windows has
// as default", which is what getUserMedia does when the constraint is absent —
// passing an empty `exact` would instead fail with OverconstrainedError.
async function ensureStream(deviceId) {
  if (stream && stream.active) {
    const track = stream.getAudioTracks()[0];
    const current = track && track.getSettings ? track.getSettings().deviceId : null;
    // A device change means the held stream is the wrong mic; drop it and
    // re-open rather than silently recording from the old one.
    if (!deviceId || !current || current === deviceId) return stream;
    releaseStream();
  }

  const base = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  };

  if (deviceId) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: deviceId } }, video: false
      });
      attachAnalyser();
      return stream;
    } catch (e) {
      // The saved microphone is unplugged, disabled or renamed. Falling back to
      // the system default is the difference between "the app is broken" and
      // "the app used a different microphone" — a `{exact: …}` constraint that
      // no longer resolves would otherwise leave bolo permanently mute.
      // Only this one error is retried: NotAllowedError and NotFoundError mean
      // something else entirely and are reported rather than papered over.
      if (!e || e.name !== 'OverconstrainedError') throw e;
      fellBackFrom = deviceId;
    }
  }

  stream = await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  attachAnalyser();
  return stream;
}

// Which device the live stream actually belongs to. Read back rather than
// assumed, because the fallback above means the requested id and the opened one
// are not always the same.
function liveDeviceId() {
  const track = stream && stream.getAudioTracks()[0];
  try { return (track && track.getSettings && track.getSettings().deviceId) || ''; }
  catch (_) { return ''; }
}

/* ---------------------------------------------------------------------------
   The device list

   This is the only window Chromium lets hold the microphone, and a page without
   permission sees blank labels — a picker of four identically nameless
   microphones. So enumeration lives here and nowhere else, and Settings asks
   main, which asks this window.
   ------------------------------------------------------------------------ */
function deviceName(d, i) {
  return d.label || 'Microphone ' + (i + 1);
}

async function listDevices() {
  const md = navigator.mediaDevices;
  if (!md || !md.enumerateDevices) return { ok: false, error: 'device-enumeration-unavailable' };

  let opened = null;
  try {
    let inputs = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');

    // Labels are withheld until the origin holds microphone permission. Opening
    // the device once is what unlocks them; the tracks are stopped in the
    // `finally` below, so this is a permission grant and not a recording.
    if (inputs.some((d) => !d.label)) {
      try {
        opened = await md.getUserMedia({ audio: true, video: false });
        inputs = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      } catch (e) {
        // Refused, or no device at all. The ids are still worth returning —
        // they are what the picker stores — but say the labels are missing
        // rather than letting them read as an unhelpful list of blanks.
        return {
          ok: true, labels: false, devices: inputs.map((d, i) => ({ id: d.deviceId, label: deviceName(d, i) })),
          error: String((e && e.message) || e)
        };
      }
    }

    return { ok: true, labels: true, devices: inputs.map((d, i) => ({ id: d.deviceId, label: deviceName(d, i) })) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (opened) { try { opened.getTracks().forEach((t) => t.stop()); } catch (_) {} }
  }
}

function attachAnalyser() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    // A window that has never been clicked can still be born suspended. Levels
    // would then read as flat silence forever, which looks exactly like a
    // broken microphone, so resume and say so if it refuses.
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    if (sourceNode) { try { sourceNode.disconnect(); } catch (_) {} }
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    sourceNode.connect(analyser);
    samples = new Uint8Array(analyser.fftSize);
  } catch (e) {
    fail('analyser', e);
  }
}

function releaseStream() {
  stopLevelLoop();
  if (stream) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    stream = null;
  }
  if (sourceNode) { try { sourceNode.disconnect(); } catch (_) {} sourceNode = null; }
  analyser = null;
  smoothed = 0;
}

// Call the microphone back after a quiet spell — but only when nothing is using
// it. Recording and the wake word both hold it; idle does not.
function armIdleRelease() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!recording && !monitoring) releaseStream();
  }, IDLE_RELEASE_MS);
}

/* ---------------------------------------------------------------------------
   Levels
   ------------------------------------------------------------------------ */
function readLevel() {
  if (!analyser || !samples) return 0;
  analyser.getByteTimeDomainData(samples);

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);

  const raw = Math.min(1, Math.sqrt(rms / RMS_FULL_SCALE));
  // Fast attack, slow release: a meter that falls as fast as it rises reads as
  // flicker rather than as a voice.
  smoothed = raw > smoothed ? raw : smoothed * 0.72 + raw * 0.28;
  return Math.max(0, Math.min(1, smoothed));
}

function startLevelLoop() {
  if (levelTimer) return;
  levelTimer = setInterval(() => {
    const level = readLevel();
    try { if (bolo && bolo.captureLevel) bolo.captureLevel(level); } catch (_) {}
  }, LEVEL_INTERVAL_MS);
}

function stopLevelLoop() {
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
}

/* ---------------------------------------------------------------------------
   Recording
   ------------------------------------------------------------------------ */
function startRecording() {
  if (recording) return { ok: true, already: true, mime: recordMime };

  const mime = pickMime();
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  } catch (e) {
    // Some builds reject an explicit bitrate or an unusual mime; retry bare
    // rather than losing the dictation over a codec preference.
    try { mr = new MediaRecorder(stream); } catch (e2) { fail('recorder', e2); return { ok: false, error: lastError.message }; }
  }

  chunks = [];
  recordMime = mr.mimeType || mime || 'audio/webm';
  recordStartedAt = Date.now();
  recording = true;

  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onerror = (e) => fail('recorder', (e && e.error) || 'recorder error');
  mr.onstop = async () => {
    const ms = Date.now() - recordStartedAt;
    const type = recordMime;
    const parts = chunks;
    chunks = [];
    recording = false;
    recorder = null;
    // The session is over, so stop pushing levels. Without this the pill and the
    // notch keep animating a live meter while the app is in its "thinking" state,
    // and the wake gate keeps being fed a signal it is no longer gated on. The
    // wake word holds its own loop, so monitoring keeps it running.
    if (!monitoring) stopLevelLoop();
    armIdleRelease();

    let buffer = null;
    try {
      const blob = new Blob(parts, { type });
      buffer = await blob.arrayBuffer();
    } catch (e) {
      fail('encode', e);
      try { if (bolo && bolo.captureDone) bolo.captureDone({ ok: false, error: lastError.message }); } catch (_) {}
      return;
    }

    try {
      if (bolo && bolo.captureDone) {
        bolo.captureDone({ ok: true, buffer, mime: type, ms, bytes: buffer.byteLength });
      }
    } catch (e) {
      fail('deliver', e);
    }
  };

  try {
    // A timeslice makes the recorder flush as it goes, so a crash mid-session
    // still leaves the audio that had already been spoken.
    mr.start(250);
  } catch (e) {
    // `recording` was set optimistically above, and leaving it true here would
    // report a live session to main for a recorder that never started.
    recording = false;
    recorder = null;
    fail('start', e);
    return { ok: false, error: lastError.message };
  }

  recorder = mr;
  startLevelLoop();
  return { ok: true, mime: recordMime };
}

function stopRecording() {
  if (!recorder || !recording) {
    // Nothing was ever captured — report an empty result rather than hanging
    // main on a promise that will never settle.
    recording = false;
    if (!monitoring) stopLevelLoop();
    armIdleRelease();
    try { if (bolo && bolo.captureDone) bolo.captureDone({ ok: false, error: 'not-recording' }); } catch (_) {}
    return { ok: false, error: 'not-recording' };
  }
  try { recorder.stop(); } catch (e) { fail('stop', e); }
  return { ok: true };
}

/* ---------------------------------------------------------------------------
   Clips for the wake-word recogniser

   A wake phrase cannot be recognised from a level: "how loud is the room" is not
   "what was said". So the gate stays where it is — cheap, local, and it decides
   *when* someone is speaking — and this hands main the audio for the part it
   cannot answer, which is what those words were.

   Deliberately not routed through startRecording(): a dictation owns the
   recorder and its result goes to the voice machine. This is a second, shorter
   consumer of the same open stream, and the two must not consume each other's
   audio — so this refuses while a dictation is live rather than interleaving.
   ------------------------------------------------------------------------ */
function recordClip(payload) {
  const nonce = payload && payload.nonce;
  const ms = Math.max(400, Math.min(4000, Number(payload && payload.ms) || 1400));
  const reply = (r) => { try { if (bolo && bolo.captureClip) bolo.captureClip({ nonce, ...r }); } catch (_) {} };

  // A dictation in flight: its words are the user's, and they are not a wake
  // phrase. Answering "busy" costs one wake attempt; interleaving would cost the
  // sentence they are in the middle of.
  if (recording) return reply({ ok: false, error: 'busy' });
  if (!stream || !stream.active) return reply({ ok: false, error: 'no-stream' });

  const mime = pickMime();
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  } catch (e) {
    try { mr = new MediaRecorder(stream); } catch (e2) {
      return reply({ ok: false, error: String((e2 && e2.message) || e2) });
    }
  }

  const parts = [];
  const startedAt = Date.now();
  let settled = false;
  let timer = null;

  const finish = async (reason) => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    recording = false;
    recorder = null;
    if (!monitoring) stopLevelLoop();

    if (reason !== 'ok') return reply({ ok: false, error: reason });

    let buffer;
    try {
      const type = mr.mimeType || mime || 'audio/webm';
      buffer = await new Blob(parts, { type }).arrayBuffer();
      return reply({ ok: true, buffer, mime: type, ms: Date.now() - startedAt, bytes: buffer.byteLength });
    } catch (e) {
      return reply({ ok: false, error: String((e && e.message) || e) });
    }
  };

  mr.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  mr.onerror = () => finish('recorder-error');
  mr.onstop = () => { finish('ok'); };

  // `recording` is set here rather than through startRecording() so the
  // dictation path — which reads the same flag — sees the microphone as busy for
  // exactly as long as it is.
  recording = true;
  recorder = mr;
  startLevelLoop();

  // Stopping is driven by the clock, not by the endpointer: a fixed window is
  // the right shape for a phrase that is only ever two words long, and it means
  // the clip cannot run long on a noisy room and cost a bigger upload.
  timer = setTimeout(() => { try { mr.stop(); } catch (_) { finish('stop-failed'); } }, ms);

  try {
    mr.start(250);
  } catch (e) {
    return finish('start-failed');
  }
  return { ok: true, mime };
}

/* ---------------------------------------------------------------------------
   Commands from main
   ------------------------------------------------------------------------ */
if (bolo && bolo.on) {
  // Begin a dictation. Resolves nothing — main learns the outcome from
  // captureState (started, or why not).
  bolo.on('bolo:capture-start', async (payload) => {
    const opts = payload || {};
    try {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      fellBackFrom = '';
      await ensureStream(opts.deviceId || '');
      const r = startRecording();
      const live = liveDeviceId();
      report({
        ok: !!r.ok, stage: 'start', recording: recording, mime: recordMime,
        error: r.error || null,
        deviceId: live,
        // Named rather than swallowed: "the microphone I chose is not the one it
        // used" is otherwise invisible, and it is the first thing to check when
        // the transcript looks like it came from the wrong room.
        fellBackFrom: fellBackFrom && fellBackFrom !== live ? fellBackFrom : ''
      });
    } catch (e) {
      // NotAllowedError / NotFoundError land here: no microphone, or permission
      // refused. Main turns this into a notch message rather than a silent
      // "listening" state that never produces words.
      report({ ok: false, stage: 'getUserMedia', recording: false, nameless: e && e.name, error: String((e && e.message) || e) });
    }
  });

  bolo.on('bolo:capture-stop', async () => {
    stopRecording();
  });

  // Hold the microphone open without recording, for the wake-word gate.
  bolo.on('bolo:capture-monitor', async (payload) => {
    const on = !!(payload && payload.on);
    monitoring = on;
    if (on) {
      try {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        await ensureStream((payload && payload.deviceId) || '');
        startLevelLoop();
      } catch (e) {
        fail('getUserMedia', e);
      }
    } else {
      if (!recording) { stopLevelLoop(); armIdleRelease(); }
    }
  });

  // The user picked a different microphone. A held stream belongs to the *old*
  // device and nothing re-opens it until the next dictation — which is
  // invisible while the wake word has the mic open, and looks like the setting
  // did nothing. So drop it and re-open on the new one, but only if something
  // is actually holding it: otherwise the next open reads the new setting
  // anyway and re-opening here would just flash the OS microphone indicator.
  bolo.on('bolo:capture-device', async (payload) => {
    const id = (payload && payload.deviceId) || '';
    if (!stream) return;
    if (liveDeviceId() === id) return;
    releaseStream();
    if (monitoring) {
      try { fellBackFrom = ''; await ensureStream(id); startLevelLoop(); }
      catch (e) { fail('getUserMedia', e); }
    }
  });

  // A short clip for the wake-word recogniser. The stream is already open —
  // monitoring holds it — so this is only the recorder, and it answers on
  // bolo.captureClip rather than through the dictation channel.
  bolo.on('bolo:capture-clip', async (payload) => {
    const nonce = payload && payload.nonce;
    try {
      if (!stream || !stream.active) {
        // Nothing is holding the microphone: open it, because the alternative is
        // a wake attempt that fails for a reason the user cannot see.
        await ensureStream((payload && payload.deviceId) || '');
      }
      recordClip(payload);
    } catch (e) {
      try { if (bolo.captureClip) bolo.captureClip({ nonce, ok: false, error: String((e && e.message) || e) }); } catch (_) {}
    }
  });

  // Enumeration, on request. The request arrives on a fire-and-forget channel
  // like everything else here, so the answer goes back on its own channel and is
  // matched to the request by nonce.
  bolo.on('bolo:capture-devices', async (payload) => {
    const nonce = payload && payload.nonce;
    let r;
    try { r = await listDevices(); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    try { if (bolo.captureDevices) bolo.captureDevices({ nonce, ...r }); } catch (_) {}
  });

  // Headphones plugged in or pulled out. Main re-broadcasts, so an open Settings
  // pane stops offering a microphone that is no longer there.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        try { if (bolo.captureDevicesChanged) bolo.captureDevicesChanged({}); } catch (_) {}
      });
    }
  } catch (_) { /* no devicechange on this build; the list is read on demand anyway */ }
}

// A window torn down mid-recording never fires onstop, so main is told here
// rather than being left with a promise that never settles.
window.addEventListener('beforeunload', () => { releaseStream(); });