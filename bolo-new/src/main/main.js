const { app, BrowserWindow, ipcMain, clipboard, screen, shell: electronShell, session, globalShortcut } = require('electron');
const path = require('path');

const settings = require('./settings');
const shortcuts = require('./shortcuts');
const activation = require('./activation');
const modes = require('./modes');
const voice = require('./voice');
const context = require('./context');
const capabilities = require('./capabilities');
const sidecar = require('./sidecar');
const agent = require('./agent');
const workflows = require('./workflows');
const coding = require('./coding');
const history = require('./history');
const audio = require('./audio');
const shell = require('./shell');
const notch = require('./notch');
const intro = require('./intro');
const wake = require('./wake');
const onboarding = require('./onboarding');
const keys = require('./keys');
const capture = require('./capture');
const doctor = require('./doctor');
const stt = require('./stt');
const tts = require('./tts');
const trace = require('./trace');

const isDev = process.argv.includes('--dev');
const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');
const rendererDir = path.join(__dirname, '..', 'renderer');
const rendererFile = path.join(rendererDir, 'index.html');

function sendTo(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(channel, payload) {
  sendTo(shell.getMain(), channel, payload);
}

// Some channels (mic level, voice state) are meaningful to the pill and the
// notch too, so they fan out to every window that renders voice state.
//
// `bolo:notch` is overloaded and the two meanings have different audiences:
// with a `phase` it is the voice state machine asking the notch to change what
// it is showing, and it goes to the notch window only; without one it is the
// notch's appearance state on its way to the Settings pane. Fanning the first
// kind out to the dashboard would hand the appearance controls a phase payload.
function broadcastAll(channel, payload) {
  if (channel === 'bolo:notch' && payload && payload.phase) {
    // A new phase owns the timeline: drop any pending dwell collapse.
    cancelDwell();
    // An error the capsule may not be allowed to show — it is held down for the
    // first part of the intro — still has to reach the user. Mirror it into the
    // intro window; outside setup this is a no-op.
    if (payload.phase === 'error') setupError(payload.text, 'voice pipeline');
    // notch.show forwards the phase on to its own renderer.
    notch.show(payload.phase, payload);
    // A reply is worth saying out loud, not just showing. Fire-and-forget: the
    // text is on screen immediately and the audio arrives when Deepgram has it,
    // so a slow synthesis never delays the answer itself.
    if (payload.phase === 'reply' && payload.text) {
      speakReply(payload.text);
      // Muted / TTS off: no voice is coming, so the dwell starts now rather
      // than on a speaking-end report that will never arrive.
      if (!settings.get('ttsEnabled') || !settings.get('interactionSounds')) {
        notch.suppressAutoHide(true);
        scheduleDwellCollapse();
      }
    }
    return;
  }
  broadcast(channel, payload);
  sendTo(shell.getPill(), channel, payload);
  sendTo(notch.getWindow(), channel, payload);
  // The intro window now hosts the whole first-run setup, including the live
  // voice demos, so it needs the same voice-state / transcript / mode /
  // ob-demo-result traffic the dashboard does. Without this the demo beats sit
  // dead — the intro never hears the pipeline it is meant to be showing.
  sendTo(intro.getWindow(), channel, payload);
}

// Reply dwell: the text is painted the moment it is generated (the renderer no
// longer stages it behind the voice), and the expanded capsule collapses back
// to the resting tab exactly REPLY_DWELL_MS after the voice finishes — never on
// the settings auto-hide timer, which started at text time and would cut speech
// short or linger unpredictably.
const REPLY_DWELL_MS = 2500;
let dwellTimer = null;
let dwellToken = 0;

function cancelDwell() {
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  dwellToken++;
}

function collapseReply() {
  cancelDwell();
  notch.suppressAutoHide(false);
  const st = notch.getState();
  // Only the reply collapses itself: a new session (listening/thinking) or a
  // user hover owns the capsule now.
  if (st.phase !== 'reply' || st.hovered) return;
  notch.rest();
}

function scheduleDwellCollapse() {
  cancelDwell();
  const token = dwellToken;
  dwellTimer = setTimeout(() => {
    dwellTimer = null;
    if (token !== dwellToken) return;
    collapseReply();
  }, REPLY_DWELL_MS);
}

// A failure the user has to be told about during setup.
//
// The capsule is where bolo normally says things, and it is the right surface
// once setup is over. During the first run it is the wrong one: the intro holds
// it down for the opening beats, so anything sent only there is invisible at
// exactly the moment the user is staring at a step that is not working. That is
// how a trial that could never run produced no error, no hint and no message.
// This paints it in the intro window instead, and traces it either way.
function setupError(message, detail) {
  const text = String(message || 'Something went wrong.');
  const extra = detail === undefined || detail === null ? '' : String(detail);
  trace.log('setup', text, extra);
  if (intro.isActive()) {
    sendTo(intro.getWindow(), 'bolo:setup-error', { message: text, detail: extra });
  }
  return { ok: true };
}

// Push to a webContents directly. The streaming paths address `ipcMain`'s
// `event.sender`, which is a webContents and not a window.
function pushTo(wc, channel, payload) {
  try {
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  } catch (_) {}
}

function senderOf(win) {
  if (!win) return null;
  return win.webContents ? win.webContents : win;
}

// Speak `text` on `win` as it is generated: begin, chunk…, end. Playback starts
// the moment the provider returns its first bytes, which is the point — the
// one-shot path could not say one word until it had every word.
//
// One stream at a time, and every failure degrades to the old behaviour rather
// than to silence: a provider that answers in one piece is played as one piece,
// and a stream that dies after it started speaking is ended rather than
// cancelled, so the audio already heard is not cut off mid-word.
let speakSeq = 0;

async function speakOn(win, text, opts = {}) {
  const wc = senderOf(win);
  const voice = opts.voice || settings.get('ttsVoice');
  const id = 'sp' + ++speakSeq;
  let any = false;

  const begin = (mime) => {
    any = true;
    pushTo(wc, 'bolo:speak-begin', { id, mime: mime || 'audio/mpeg' });
  };

  try {
    const r = await tts.synthesizeStream(
      text,
      { voice, onBegin: begin },
      (bytes) => {
        any = true;
        pushTo(wc, 'bolo:speak-chunk', { id, bytes });
      }
    );

    if (r && r.ok && r.streamed) {
      pushTo(wc, 'bolo:speak-end', { id });
      return r;
    }
    if (r && r.ok && r.audio) {
      // The provider answered in one piece after all.
      pushTo(wc, 'bolo:speak-cancel', { id });
      pushTo(wc, 'bolo:say', { audio: r.audio, mime: r.mime, text });
      return r;
    }

    if (any) pushTo(wc, 'bolo:speak-end', { id });
    else pushTo(wc, 'bolo:speak-cancel', { id });
    return r || { ok: false, error: 'unknown' };
  } catch (e) {
    if (any) pushTo(wc, 'bolo:speak-end', { id });
    else pushTo(wc, 'bolo:speak-cancel', { id });
    return { ok: false, error: e.message };
  }
}

// Speak a reply on the notch. Kept in main rather than in voice.js because the
// audio has to be played by a window with a DOM, and the notch is the surface
// that owns the reply.
//
// The gate lives in tts.js's IPC handler and here — synthesising at all when the
// user has muted the app would be a wasted round trip, and a wasted charge.
//
// The hold is taken *before* the synthesis, not when the audio arrives: the text
// is already on screen and the settings auto-hide timer has already started,
// so a slow voice would collapse the panel mid-sentence. The notch renderer
// reports speaking end (bolo:notch-speaking) and the dwell collapse below takes
// it from there; every failure path here starts the dwell too — a reply that
// never goes away is worse than one that leaves.
async function speakReply(text) {
  if (!settings.get('ttsEnabled') || !settings.get('interactionSounds')) return;
  const clean = String(text || '').trim();
  if (!clean) return;

  notch.suppressAutoHide(true);
  try {
    const r = await speakOn(notch.getWindow(), clean, { voice: settings.get('ttsVoice') });
    if (!r || !r.ok) {
      console.warn('[bolo tts] reply not spoken:', (r && r.error) || 'unknown');
      scheduleDwellCollapse();
      return;
    }
    // Nothing more to do here on success: the hold is taken above and the dwell
    // starts when the renderer reports speaking end (bolo:notch-speaking). The
    // audio is a stream now, so "the bytes arrived" stopped being the same
    // moment as "the sentence has been said".
  } catch (e) {
    console.warn('[bolo tts] reply failed:', e.message);
    scheduleDwellCollapse();
  }
}

/* ---------------------------------------------------------------------------
   Shortcuts
   One accelerator — the voice key — plus repeat-last-transcript. There used to
   be four, one per mode; the intent router replaced them. Global accelerators
   fire on press only, so the voice key is press-to-start / press-to-stop.
   ------------------------------------------------------------------------ */
function voiceInfo() {
  return {
    voice: { ...modes.VOICE },
    intents: modes.INTENTS.map((i) => ({ ...i })),
    shortcut: settings.voiceShortcut(),
    pasteLastShortcut: settings.get('pasteLastShortcut') || modes.PASTE_LAST_DEFAULT,
    pasteLastId: modes.PASTE_LAST_ID,
    // `bindings` is what actually got registered, which can differ from the
    // requested accelerator when another app already owns it — and, for the
    // activation keys, when the platform cannot bind the key at all (Fn is not a
    // Windows key). Settings shows both.
    bindings: shortcuts.getBindings(),
    modeShortcuts: MODE_KEYS.map((m) => ({
      id: m.id,
      requested: settings.get(m.setting) || m.fallback,
      bound: shortcuts.getBinding(m.id)
    })),
    cancelShortcut: settings.get('cancelShortcut') || 'Escape',
    // How the keys behave (hold vs toggle) and whether true hold-to-talk is even
    // possible here — Settings shows the toggle, and greys "Hold" out with an
    // explanation when the native hook could not load.
    activationMode: activation.available() ? (settings.get('activationMode') || 'hold') : 'toggle',
    holdAvailable: activation.available()
  };
}

function applyShortcuts() {
  const results = {};

  // Dictation IS the voice key — there is no second binding for it. Pressing it
  // is what says "this utterance is a dictation", so it lights the same chip that
  // Edit and Agent do.
  const voiceAcc = settings.voiceShortcut();
  shortcuts.setHandler(modes.VOICE_ID, () => {
    setMode('dictation');
    return triggerVoice({ mode: 'dictation' });
  });
  results[modes.VOICE_ID] = shortcuts.registerTolerant(modes.VOICE_ID, voiceAcc);

  const pasteAcc = settings.get('pasteLastShortcut') || modes.PASTE_LAST_DEFAULT;
  shortcuts.setHandler(modes.PASTE_LAST_ID, () => pasteLast());
  results[modes.PASTE_LAST_ID] = shortcuts.registerTolerant(modes.PASTE_LAST_ID, pasteAcc);

  broadcast('bolo:hotkey', results[modes.VOICE_ID]);
  broadcast('bolo:voice', voiceInfo());
  return results;
}

/* ---------------------------------------------------------------------------
   Activation shortcuts — dictation / edit / agent
   These do not bring back a mode picker: the intent router still decides what
   the words were for. They put a thumb on the scale and light the notch, so the
   user can see which thumb it was. The requested accelerators are Fn, Ctrl+Fn
   and Ctrl+Alt; Fn is not a Windows key (the embedded controller swallows it and
   no key event reaches an app), so shortcuts.register substitutes a working
   binding and reports what it actually got.
   ------------------------------------------------------------------------ */
const MODE_KEYS = [
  { id: 'edit', setting: 'editShortcut', fallback: settings.DEFAULT_EDIT_SHORTCUT },
  { id: 'agent', setting: 'agentShortcut', fallback: settings.DEFAULT_AGENT_SHORTCUT }
];

let liveMode = null;

// The chip is driven from here rather than from the voice state machine because
// it has to appear on the key press — before anything is recording, and even if
// the session never starts.
function setMode(mode) {
  if (liveMode === mode) return;
  liveMode = mode;
  const payload = { mode };
  sendTo(notch.getWindow(), 'bolo:mode', payload);
  sendTo(shell.getPill(), 'bolo:mode', payload);
  sendTo(intro.getWindow(), 'bolo:mode', payload);
  broadcast('bolo:mode', payload);
  return payload;
}

function applyModeShortcuts() {
  const results = {};
  for (const m of MODE_KEYS) {
    const acc = settings.get(m.setting) || m.fallback;
    shortcuts.setHandler(m.id, () => {
      setMode(m.id);
      return triggerVoice({ mode: m.id });
    });
    results[m.id] = shortcuts.registerTolerant(m.id, acc);
  }
  return results;
}

/* ---------------------------------------------------------------------------
   Hold-to-talk

   The activation keys can behave two ways (Settings → Audio & Speech):

     hold    hold the key to record, release to send — true push-to-talk. Needs
             the native key hook (activation.js / uiohook-napi), which reports the
             key RELEASE that Electron's press-only globalShortcut never sees.
     toggle  press to start, press to stop — the globalShortcut path above.

   applyActivation() is the single switch. In hold mode it takes the three keys
   OFF globalShortcut (so they do not fire twice) and drives them through the
   native hook; in toggle mode — or when the hook could not load — it puts them
   back on globalShortcut. Everything that changes a binding calls it, so the two
   worlds can never both own a key.
   ------------------------------------------------------------------------ */
// First run only: a mode key being pressed is exactly the moment the capsule has
// to be on screen, because the trial it opens is the only place onboarding shows
// the notch doing anything. Driving it from here rather than trusting the intro's
// phase bookkeeping to have revealed it already means a press can never land on a
// capsule that is still held down.
async function revealNotchForTrial() {
  try {
    if (intro.isActive()) intro.revealNotch();
  } catch (_) {}
}

async function startHold(mode) {
  console.log('[bolo hold] press mode=' + mode);
  trace.log('hold', 'press', { mode });
  // A press that arrives while a session is already live is a duplicate or a
  // delayed hook delivery (the intro trial's IPC fallback may have started the
  // session first). Toggling here would stop the live session mid-utterance.
  // In hold semantics a second press without an intervening release cannot be
  // a new session, so ignoring it is strictly more correct.
  if (voice.getState().state === 'listening') {
    trace.log('hold', 'press ignored: already listening', { mode });
    return { state: 'listening' };
  }
  revealNotchForTrial();
  setMode(mode);
  cancelDwell();
  let r;
  try {
    r = await voice.toggle({ broadcast: broadcastAll, mode });
  } catch (e) {
    // Same guarantee as triggerVoice: a throw must surface, never vanish.
    const msg = (e && e.message) || String(e);
    console.error('[bolo hold] toggle threw: ' + msg);
    setupError('Voice failed: ' + msg, 'hold start threw');
    setVoiceVisual('idle');
    setMode(null);
    notch.show('error', { text: 'Voice failed: ' + msg });
    broadcast('bolo:voice', voiceInfo());
    return { state: 'idle', error: msg };
  }
  console.log('[bolo hold] state → ' + (r && r.state) + ((r && r.error) ? ' error=' + r.error : ''));
  trace.log('hold', 'state', { state: r && r.state, error: (r && r.error) || null, started: !!(r && r.started) });
  setVoiceVisual(r.state);
  if (r.state === 'listening') notch.show('listening', { label: null });
  broadcast('bolo:voice', voiceInfo());
}

async function stopHold() {
  console.log('[bolo hold] release, voice=' + voice.getState().state);
  // A stray key-up (the key was released after the session already ended, or the
  // press never opened the mic) must not toggle a NEW session on.
  if (voice.getState().state !== 'listening') {
    trace.log('hold', 'release ignored: not listening', { state: voice.getState().state });
    setMode(null);
    return;
  }
  const r = await voice.toggle({ broadcast: broadcastAll });
  setVoiceVisual(r.state);
  setMode(null);
  broadcast('bolo:voice', voiceInfo());
}

// The three activation keys, as { mode, accelerator }, read from settings.
function activationBindings() {
  return [
    { mode: 'dictation', accelerator: settings.voiceShortcut() },
    { mode: 'edit', accelerator: settings.get('editShortcut') || settings.DEFAULT_EDIT_SHORTCUT },
    { mode: 'agent', accelerator: settings.get('agentShortcut') || settings.DEFAULT_AGENT_SHORTCUT }
  ];
}

let holdWired = false;
function applyActivation() {
  const wantHold = activation.available() && (settings.get('activationMode') || 'hold') === 'hold';

  if (wantHold) {
    // Take the keys off globalShortcut so a press does not both toggle AND start
    // a hold. pasteLast keeps its globalShortcut binding — it is not a hold key.
    shortcuts.unregister(modes.VOICE_ID);
    for (const m of MODE_KEYS) shortcuts.unregister(m.id);

    if (!holdWired) {
      activation.onPress((mode) => { startHold(mode); });
      activation.onRelease(() => { stopHold(); });
      holdWired = true;
    }
    const r = activation.setBindings(activationBindings());
    console.log('[bolo activation] mode=hold bindings=' + JSON.stringify((r && r.bound) || []));
    if (r && r.dropped && r.dropped.length) {
      console.log('[bolo activation] hold unavailable for: ' + r.dropped.join(', ') + ' (key has no native mapping)');
    }
    activation.start();
  } else {
    // Toggle (or no native hook): stop the hook and make sure the keys are on
    // globalShortcut. applyShortcuts / applyModeShortcuts are idempotent.
    console.log('[bolo activation] mode=toggle hookAvailable=' + activation.available());
    activation.stop();
    applyShortcuts();
    applyModeShortcuts();
  }
  return wantHold ? 'hold' : 'toggle';
}

/* ---------------------------------------------------------------------------
   Voice
   ------------------------------------------------------------------------ */
function setVoiceVisual(state) {
  shell.setPillState(state);
  broadcastAll('bolo:voice-state', voice.getState());
}

// Double-tap-to-go-hands-free lives here, not in voice.js, because it is a
// property of how the *key* was pressed, not of the state machine. globalShortcut
// is press-only, so a "double tap" is two fires of the same accelerator inside a
// short window. bolo's own copy: "tap twice and just talk. One more tap ends it."
const DOUBLE_TAP_MS = 400;
let lastTapAt = 0;

function handsFreeLabel() {
  return modes.VOICE.label + ' · Hands-free';
}

async function triggerVoice(opts = {}) {
  const now = Date.now();
  const isDouble = (now - lastTapAt) < DOUBLE_TAP_MS;
  console.log('[bolo voice] toggle mode=' + (opts.mode || liveMode || 'infer'));
  trace.log('voice', 'trigger', { mode: opts.mode || liveMode || 'infer', isDouble });
  revealNotchForTrial();
  lastTapAt = now;
  cancelDwell();

  // A double-tap that lands while the first tap's session is still listening
  // promotes it in place instead of stopping it. If nothing is listening yet,
  // the double-tap starts a hands-free session.
  if (isDouble && voice.markHandsFree()) {
    const st = voice.getState();
    setVoiceVisual(st.state);
    notch.show('listening', { label: handsFreeLabel() });
    broadcastAll('bolo:voice-state', st);
    return st;
  }

  const r = await voice.toggle({
    broadcast: broadcastAll,
    handsFree: isDouble,
    mode: opts.mode || liveMode
  }).catch((e) => ({ state: 'idle', error: (e && e.message) || String(e) }));
  if (r && r.error && r.state === 'idle' && !r.started && !r.transcript) {
    // The machine itself threw (not a mic refusal — that carries `started`).
    // Without this a throw is an unhandled rejection and the key silently dies.
    console.error('[bolo voice] toggle threw: ' + r.error);
    setupError('Voice failed: ' + r.error, 'voice toggle threw');
    setVoiceVisual('idle');
    setMode(null);
    notch.show('error', { text: 'Voice failed: ' + r.error });
    broadcast('bolo:voice', voiceInfo());
    return r;
  }
  setVoiceVisual(r.state);

  if (r.state === 'listening') {
    notch.show('listening', { label: isDouble ? handsFreeLabel() : null });
  } else if (!r.busy) {
    // The session ended: the chip has done its job. A press swallowed
    // mid-transcription (busy) leaves the chip alone — its session is live.
    setMode(null);
  }
  // history.push now happens inside voice.toggle, next to the decision that
  // supplies the intent it is filed under.
  broadcast('bolo:voice', voiceInfo());
  return r;
}

async function pasteLast() {
  const r = await voice.pasteLast();
  cancelDwell();
  if (r.ok) {
    broadcast('bolo:injected', r.injected);
    notch.show('reply', { text: r.text, label: 'Inserted again' });
  } else {
    notch.show('error', { text: 'Nothing to insert yet.' });
  }
  return r;
}

/* ---------------------------------------------------------------------------
   Doctor Mode
   ------------------------------------------------------------------------ */
// The doctor window's toggle: opens the window if it is not open, then runs a
// doctor-flagged voice session. The transcript bypasses the router and the
// injector — voice.js emits bolo:doctor-result and the doctor window owns the
// note from there. The notch stays out of it: the doctor window shows its own
// state, and a capsule popping over the clinic's software would be noise.
async function triggerDoctor() {
  if (!doctor.isOpen()) doctor.create(preloadPath, rendererDir);
  doctor.show();
  const r = await voice.toggle({
    broadcast: broadcastAll,
    mode: 'dictation',
    doctor: true
  }).catch((e) => ({ state: 'idle', error: (e && e.message) || String(e) }));
  if (r && r.error && r.state === 'idle' && !r.started && !r.transcript) {
    console.error('[bolo doctor] toggle threw: ' + r.error);
  }
  return r;
}

// One global shortcut for Doctor Mode: Ctrl+Shift+D. Press-only, like the
// other activation keys — it toggles the doctor dictation, opening the window
// first when it is not open.
function registerDoctorShortcut() {
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+D', () => {
      triggerDoctor().catch((e) => console.error('[bolo doctor] shortcut: ' + e.message));
    });
    if (!ok) console.log('[bolo doctor] shortcut Ctrl+Shift+D was taken by another app');
  } catch (e) {
    console.log('[bolo doctor] shortcut failed: ' + e.message);
  }
}

/* ---------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------ */
let introPending = false;
let introStarted = false;

// One instance only. Without this, "Restart onboarding" (which relaunches via
// app.relaunch() + app.exit(0)) can let the fresh process overlap the exiting
// one, and with no lock BOTH reach app.whenReady() and each builds a full window
// set — the "two windows on restart" bug. The per-process introPending/activate
// guards below cannot deduplicate across two OS processes; only the lock can.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
else app.on('second-instance', () => { try { shell.showMain(); } catch (_) {} });

if (gotSingleInstanceLock) app.whenReady().then(() => {
  settings.init();
  history.init();
  onboarding.init();
  keys.init();
  trace.init();

  // The intro replaces the dashboard's first paint, so decide before creating
  // the window whether it should reveal itself. --doctor skips the animated
  // onboarding entirely: the doctor window opens instead, and the dashboard
  // stays hidden until the tray asks for it. The consumer path is untouched.
  const doctorMode = process.argv.includes('--doctor');
  const ob = onboarding.get();
  introPending = !doctorMode && !ob.completed && !ob.introSeen;

  shell.createMain(preloadPath, rendererFile, isDev, { deferShow: introPending || doctorMode });

  try { shell.createPill(preloadPath, rendererDir); } catch (_) {}
  try { notch.create(preloadPath, rendererDir); } catch (_) {}
  // Push the skin (variant, material, side, voice key) before anything asks the
  // notch to speak. Without this the renderer paints the top/solid defaults from
  // its own CSS until the first phase change arrives, so a side or glass notch
  // would flash the wrong shape on its first appearance.
  try { notch.applyAppearance(); } catch (_) {}
  // Nothing is ever held back by a setting at open time: the capsule comes up
  // on its first paint and every permission the agent or the pipeline gates on
  // is forced on rather than left to whatever an old install left behind.
  try {
    for (const k of ['agentCanOpenApps', 'agentCanEditFiles', 'agentCanScreenshot', 'notchEnabled']) {
      if (!settings.get(k)) settings.set(k, true);
    }
    if (!onboarding.get().data || !onboarding.get().data.micGranted) onboarding.set({ micGranted: true });
    if (!onboarding.get().data || !onboarding.get().data.accessibilityGranted) onboarding.set({ accessibilityGranted: true });
    notch.rest();
  } catch (_) {}
  shell.createTray(() => shell.showMain(), () => { app.quitting = true; app.quit(); });

  shortcuts.setHandler(modes.VOICE_ID, () => triggerVoice());
  applyShortcuts();
  applyModeShortcuts();
  // Switch the three activation keys to hold-to-talk if that is the mode and the
  // native hook loaded; otherwise this leaves them on the globalShortcut toggle
  // just registered.
  try { applyActivation(); } catch (e) { console.log('[bolo activation] ' + e.message); }

  // Doctor Mode's one global shortcut. Registered in every launch, not just
  // --doctor, so the doctor window is always one key away.
  registerDoctorShortcut();

  if (doctorMode) {
    doctor.create(preloadPath, rendererDir);
    const dw = doctor.getWindow();
    if (dw) dw.once('ready-to-show', () => doctor.show());
  }

  // The microphone. Permission handlers have to be installed before any renderer
  // asks for getUserMedia, and the capture window is created at boot so the first
  // dictation does not also pay for a window's startup. It is hidden, skipped by
  // the taskbar, and never focused — see src/main/capture.js.
  capture.installPermissions(session.defaultSession);
  capture.installIpc(ipcMain);
  capture.create(preloadPath, rendererDir);
  // audio.js reaches the capture window through this rather than requiring it,
  // which would be a require cycle between the two.
  audio.attach((channel, payload) => capture.send(channel, payload));

  audio.setLevelListener((level) => broadcastAll('bolo:voice-level', { level }));

  // The gate must never spend a transcription on a sentence the user is already
  // dictating — that audio belongs to the voice machine, and the capture window
  // refuses a clip while it is recording anyway. This is what keeps the wake
  // word from even asking.
  wake.setBusyCheck(() => voice.getState().state !== 'idle');

  wake.setHandler(async (result) => {
    // `result` is a match, not the settings state. Merging it over the real
    // state keeps the Settings pane showing the right toggle and phrase when a
    // wake word fires — sending the bare match would read as "off".
    broadcast('bolo:wake', { ...wake.getState(), fired: true, match: result });
    // A wake word is a request to talk, and there is only one thing to talk to
    // now — the router decides what the words were for.
    if (voice.getState().state === 'idle') {
      await triggerVoice();
    }
  });
  wake.apply();

  // Keep the microphone hot from boot so the first dictation pays no cold start.
  // Runs after wake.apply() so it owns the monitor stream regardless of whether
  // the wake word turned it on or off. The OS mic indicator stays lit — the user
  // asked for the mic to be always warm.
  try { audio.setKeepWarm(true); } catch (_) {}

  if (introPending) {
    intro.create(preloadPath, rendererDir);
    const w = intro.getWindow();
    // The intro window is created hidden; reveal it on its first paint so the
    // aurora is already running when it appears.
    if (w) {
      w.once('ready-to-show', () => {
        // A transparent intro window (desktop capture + fonts + aurora) can paint
        // AFTER the fail-open below has already revealed the dashboard. Starting it
        // then would float the intro on top of the live dashboard + onboarding
        // overlay — the "dashboard loads, then the intro pops up too" bug. If the
        // fail-open already ran, introPending is false: stand down.
        if (!introPending) return;
        introStarted = true;
        intro.start();
        armIntroWatchdog();
      });
      // Closing the intro from the taskbar quits: revealing the dashboard here
      // is what popped the old dashboard onboarding overlay over an unfinished
      // run. A closed intro is a closed app; relaunch replays onboarding.
      w.on('closed', () => {
        if (introPending) {
          introPending = false;
          clearIntroWatchdog();
          app.quitting = true;
          app.quit();
        }
      });
    }
    // The dashboard is being held back for the intro, so if the intro window
    // never paints there would be nothing on screen at all. Fail open — but
    // only when the intro genuinely never appeared.
    setTimeout(() => {
      if (introPending && !introStarted) {
        console.warn('[bolo] intro window never painted — opening the dashboard');
        introPending = false;
        shell.showMain();
      }
    }, 8000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      shell.createMain(preloadPath, rendererFile, isDev);
      return;
    }
    // While the intro is live it is the one switchable, taskbar-tracked window
    // (the dashboard is deferShow-hidden, the pill/notch skip the taskbar).
    // Focusing it — rather than the dashboard behind it — is what tells the OS
    // unambiguously which window is frontmost on the return Alt+Tab.
    if (intro.isActive()) {
      const w = intro.getWindow();
      if (w && !w.isDestroyed()) { w.show(); w.focus(); }
      return;
    }
    shell.showMain();
  });
});

app.on('will-quit', () => { shortcuts.unregisterAll(); try { activation.stop(); } catch (_) {} });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------------------------------------------------------
   Shell
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:show', async () => { shell.showMain(); return { ok: true }; });
ipcMain.handle('bolo:set-view', async (_e, view) => ({ view: shell.setView(String(view || 'dashboard')) }));
ipcMain.handle('bolo:get-view', async () => ({ view: shell.getView() }));

ipcMain.handle('bolo:window-minimize', async () => { shell.minimizeMain(); return { ok: true }; });
ipcMain.handle('bolo:window-maximize-toggle', async () => ({ maximized: shell.toggleMaximizeMain() }));
ipcMain.handle('bolo:window-maximized', async () => ({ maximized: shell.isMainMaximized() }));
ipcMain.handle('bolo:window-close', async () => {
  // The titlebar's X. With Close to tray on — the reference's default — it
  // hides the window and leaves the voice key live; with it off it is a real
  // quit, which is the only way out for someone who does not want a background
  // process they cannot see. The window's own close handler hides either way.
  if (settings.get('closeToTray')) {
    const w = shell.getMain();
    if (w && !w.isDestroyed()) w.hide();
    return { ok: true, hidden: true };
  }
  app.quitting = true;
  shell.closeMain();
  return { ok: true, hidden: false };
});
ipcMain.handle('bolo:get-platform', async () => ({ platform: process.platform }));

/* ---------------------------------------------------------------------------
   Status / usage (local only)
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:get-status', async () => ({
  planType: 'local_dev', status: 'active', isActive: true,
  entitlement: 'dev', currentPeriodEnd: null, cancelAtPeriodEnd: false
}));
ipcMain.handle('bolo:get-usage', async () => ({
  currentUsage: 0, weeklyLimit: -1, planType: 'local_dev', percentUsed: 0, entitlement: 'dev'
}));

/* ---------------------------------------------------------------------------
   Voice
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:voice-toggle', async (_e, p) => triggerVoice({ mode: p && p.mode }));
ipcMain.handle('bolo:voice-state', async () => voice.getState());
ipcMain.handle('bolo:paste-last', async () => pasteLast());

/* ---------------------------------------------------------------------------
   Doctor Mode
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:doctor-toggle', async () => triggerDoctor());
ipcMain.handle('bolo:doctor-open', async () => {
  if (!doctor.isOpen()) doctor.create(preloadPath, rendererDir);
  doctor.show();
  return { ok: true };
});
// Output target, per spec: no clinic-software pasting. The doctor gets one
// clean formatted note with three buttons — Copy (in the renderer, via
// navigator.clipboard), Save (a dated text file per patient), and Print (the
// system print dialog from a hidden window carrying only the note).
ipcMain.handle('bolo:doctor-save', async (_e, fields) => doctor.saveNote(fields || {}));
ipcMain.handle('bolo:doctor-print', async (_e, fields) => doctor.printNote(fields || {}));
// Organize a raw dictation into the fixed patient-note template. Never throws
// away the dictation: on failure everything lands in Complaints.
ipcMain.handle('bolo:doctor-structure', async (_e, text) => doctor.structureNote(String(text || '')));

/* ---------------------------------------------------------------------------
   The voice key and the intent table
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:voice-info', async () => voiceInfo());

ipcMain.handle('bolo:set-voice-shortcut', async (_e, accelerator) => {
  const acc = String(accelerator || '').trim();
  const res = shortcuts.register(modes.VOICE_ID, acc);
  if (!res.ok) return res;
  settings.setVoiceShortcut(acc);
  broadcast('bolo:voice', voiceInfo());
  return res;
});

ipcMain.handle('bolo:set-paste-last-shortcut', async (_e, accelerator) => {
  const acc = String(accelerator || '').trim();
  const res = shortcuts.register(modes.PASTE_LAST_ID, acc);
  if (!res.ok) return res;
  settings.set('pasteLastShortcut', acc);
  broadcast('bolo:voice', voiceInfo());
  return res;
});

// One setter for all three activation keys, so onboarding and Settings can
// rebind any of them the same way. `mode` is 'dictation' | 'edit' | 'agent'.
// Dictation is the voice key (its own setting); edit and agent live in
// MODE_KEYS. The binding is registered first — a key another app owns is
// refused and NOT saved, so the store never records a dead binding — then
// persisted, then broadcast so every open surface re-reads it.
const MODE_SETTING = { edit: 'editShortcut', agent: 'agentShortcut' };

ipcMain.handle('bolo:set-mode-shortcut', async (_e, payload) => {
  const p = payload || {};
  const mode = String(p.mode || '').trim();
  const acc = String(p.accelerator || '').trim();
  if (!acc) return { ok: false, error: 'no-accelerator', mode };

  if (mode === 'dictation') {
    // Register on globalShortcut first — it validates the accelerator and reports
    // a substitution when another app owns it, and a taken key is refused before
    // it is ever saved. applyActivation() then moves it to the hold hook if that
    // is the active mode.
    const res = shortcuts.register(modes.VOICE_ID, acc);
    if (!res.ok) return { ...res, mode };
    settings.setVoiceShortcut(acc);
    applyActivation();
    broadcast('bolo:voice', voiceInfo());
    return { ...res, mode };
  }

  const setting = MODE_SETTING[mode];
  if (!setting) return { ok: false, error: 'unknown-mode', mode };

  const res = shortcuts.register(mode, acc);
  if (!res.ok) return { ...res, mode };
  shortcuts.setHandler(mode, () => {
    setMode(mode);
    return triggerVoice({ mode });
  });
  settings.set(setting, acc);
  applyActivation();
  broadcast('bolo:voice', voiceInfo());
  return { ...res, mode };
});

ipcMain.handle('bolo:reset-shortcuts', async () => {
  settings.setVoiceShortcut(settings.DEFAULT_VOICE_SHORTCUT);
  settings.set('editShortcut', settings.DEFAULT_EDIT_SHORTCUT);
  settings.set('agentShortcut', settings.DEFAULT_AGENT_SHORTCUT);
  settings.set('pasteLastShortcut', modes.PASTE_LAST_DEFAULT);
  const r = applyShortcuts();
  const m = applyModeShortcuts();
  applyActivation();
  broadcast('bolo:voice', voiceInfo());
  return { ok: true, results: { ...r, ...m } };
});

// Switch between hold-to-talk and press-to-toggle. Saved, then applied at once so
// the change takes effect without a restart.
ipcMain.handle('bolo:set-activation-mode', async (_e, mode) => {
  const m = String(mode || '').trim();
  if (m !== 'hold' && m !== 'toggle') return { ok: false, error: 'bad-mode' };
  if (m === 'hold' && !activation.available()) {
    return { ok: false, error: 'hold-unavailable', activationMode: 'toggle' };
  }
  settings.set('activationMode', m);
  const applied = applyActivation();
  broadcast('bolo:voice', voiceInfo());
  return { ok: true, activationMode: applied };
});

/* ---------------------------------------------------------------------------
   Wake word
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:wake-get', async () => wake.getState());
ipcMain.handle('bolo:wake-set', async (_e, patch) => {
  const p = patch || {};
  if ('enabled' in p) settings.set('wakeEnabled', !!p.enabled);
  if ('phrase' in p) settings.set('wakePhrase', String(p.phrase || '').trim() || 'hey bolo');
  if ('sensitivity' in p) {
    const n = Number(p.sensitivity);
    settings.set('wakeSensitivity', Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6);
  }
  const state = wake.apply();
  broadcast('bolo:wake', state);
  return state;
});

// Say the phrase now, without waiting for a room to be loud in. This is the only
// way to test the feature without making a noise and hoping, and it skips only
// the gate — the clip, the recogniser and the match are the real ones.
ipcMain.handle('bolo:wake-listen', async () => {
  const r = await wake.listen();
  broadcast('bolo:wake', { ...wake.getState(), fired: !!(r && r.matched), match: r || null });
  return r;
});

/* ---------------------------------------------------------------------------
   Notch
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:notch-get', async () => notch.getState());

ipcMain.handle('bolo:notch-set', async (_e, patch) => {
  const p = patch || {};
  const numeric = {
    notchWidth: [180, 640],
    notchOffsetX: [-4000, 4000],
    notchOffsetY: [-4000, 4000],
    notchOpacity: [0.15, 1],
    notchAutoHideMs: [0, 60000]
  };
  const strings = ['notchPosition', 'notchVariant', 'notchMaterial'];
  const bools = ['notchEnabled', 'notchAlwaysOnTop', 'notchShowOnHover'];

  for (const [k, [lo, hi]] of Object.entries(numeric)) {
    if (k in p) {
      const n = Number(p[k]);
      settings.set(k, Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : settings.get(k));
    }
  }
  for (const k of strings) if (k in p) settings.set(k, String(p[k]));
  for (const k of bools) if (k in p) settings.set(k, !!p[k]);

  notch.applyAppearance();
  const state = notch.getState();
  broadcast('bolo:notch', state);
  return state;
});

ipcMain.handle('bolo:notch-preview', async () => {
  cancelDwell();
  notch.show('reply', {
    text: 'This is where the agent answers. It stays out of the way until there is something to say.',
    label: 'Preview'
  });
  // No voice on a preview: dwell from now.
  notch.suppressAutoHide(true);
  scheduleDwellCollapse();
  return notch.getState();
});

ipcMain.handle('bolo:notch-resize', async (_e, h) => { notch.resizeContent(h); return { ok: true }; });
ipcMain.handle('bolo:notch-hover', async (_e, on) => { notch.setHovered(!!on); return { ok: true }; });
// The capsule's heartbeat. See notch.noteAlive / startAliveWatch: this is what
// turns "the notch stopped responding" from an observation into a log line.
ipcMain.handle('bolo:notch-alive', async (_e, info) => notch.noteAlive(info));
// The notch renderer owns the playback promise, so it is the only thing that
// knows when a reply's voice actually stops. Speaking end starts the dwell
// collapse (2.5s of text, then the resting tab). See REPLY_DWELL_MS.
ipcMain.handle('bolo:notch-speaking', async (_e, on) => {
  if (on) { cancelDwell(); notch.suppressAutoHide(true); }
  else scheduleDwellCollapse();
  return { ok: true };
});
ipcMain.handle('bolo:notch-copy', async (_e, text) => {
  try { clipboard.writeText(String(text || '')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('bolo:notch-dismiss', async () => {
  // Dismissing the capsule also drops any action waiting to be confirmed — the
  // user closing the card is a "no", not a "leave it armed".
  try { voice.clearPending(); } catch (_) {}
  broadcastAll('bolo:speak-cancel', {});
  notch.rest();
  return { ok: true };
});

// Buttons inside the expanded capsule. Kept as one small dispatch table rather
// than a channel per button, because every one of them is "do the obvious thing
// for this label" and the set grows with the panel.
ipcMain.handle('bolo:notch-action', async (_e, action) => {
  const id = action && action.id ? String(action.id) : '';
  switch (id) {
    case 'change-mic':
    case 'mic-settings':
      await electronShell.openExternal('ms-settings:sound');
      return { ok: true };
    case 'insert':
      return pasteLast();
    case 'copy':
      clipboard.writeText(String((action && action.value) || ''));
      return { ok: true };
    case 'dashboard':
      shell.showMain();
      notch.rest();
      return { ok: true };
    case 'confirm':
      // Confirm button on a critical-action card: run the staged action. The
      // result (or "cancelled") is shown and spoken through broadcastAll.
      return voice.resolvePending(broadcastAll, true);
    case 'cancel':
      return voice.resolvePending(broadcastAll, false);
    default:
      console.log('[bolo notch] unhandled action: ' + id);
      return { ok: false, error: 'unknown-action' };
  }
});

/* ---------------------------------------------------------------------------
   Visibility
   The reference's third settings section: hiding whole surfaces rather than
   moving them. Each write re-applies the surface it affects immediately, so the
   switch and its effect are the same event.
   ------------------------------------------------------------------------ */
function applyVisibility() {
  // Re-running the pill state is what hides or restores it — setPillState
  // already knows the current voice state and already consults the setting.
  try { shell.setPillState(voice.getState().state); } catch (_) {}
}

ipcMain.handle('bolo:visibility-set', async (_e, patch) => {
  const p = patch || {};
  for (const k of ['hidePill', 'hideTopNotch', 'hideSideNotch']) {
    if (k in p) settings.set(k, !!p[k]);
  }
  applyVisibility();
  notch.applyAppearance();
  const state = {
    hidePill: !!settings.get('hidePill'),
    hideTopNotch: !!settings.get('hideTopNotch'),
    hideSideNotch: !!settings.get('hideSideNotch')
  };
  broadcast('bolo:visibility', state);
  return state;
});

/* ---------------------------------------------------------------------------
   Flat preferences
   One writer for the settings that are nothing but a value in the store, so the
   pane does not need an IPC channel per switch.

   An allowlist, not a passthrough: a renderer can read settings.all(), and an
   unrestricted setter would let it rewrite the shortcut binding or the model
   name — which are handled by their own handlers, with their own validation.
   ------------------------------------------------------------------------ */
const PREF_KEYS = new Set([
  'micDeviceId', 'languages', 'defaultLanguage',
  'closeToTray', 'creatorMode', 'practiceMode',
  'contextAwareness', 'privateMode'
]);

ipcMain.handle('bolo:set-pref', async (_e, key, value) => {
  const k = String(key || '');
  if (!PREF_KEYS.has(k)) return { ok: false, error: 'not-a-preference', key: k };
  settings.set(k, value);

  // The microphone is the one preference with a live consumer. A stream the
  // capture window is already holding belongs to the *old* device and nothing
  // re-opens it until the next dictation, so changing this while the wake word
  // is armed would look like it did nothing at all. Told, not asked: the
  // capture window decides whether it is holding anything worth dropping.
  if (k === 'micDeviceId') capture.send('bolo:capture-device', { deviceId: String(value || '') });

  broadcast('bolo:prefs', { [k]: value });
  return { ok: true, key: k, value };
});

/* ---------------------------------------------------------------------------
   Replacements (Customize)

   The whole list is written at once rather than add/remove by index. It is a
   handful of rows that the user edits by hand, and a whole-list write has no
   index to go stale between the click and the write.
   ------------------------------------------------------------------------ */
function cleanReplacements(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => ({
      from: String((r && r.from) || '').trim(),
      to: String((r && r.to) || '')
    }))
    .filter((r) => r.from)
    .slice(0, 200);
}

ipcMain.handle('bolo:replacements-get', async () => ({
  list: cleanReplacements(settings.get('replacements'))
}));

ipcMain.handle('bolo:replacements-set', async (_e, list) => {
  const cleaned = cleanReplacements(list);
  settings.set('replacements', cleaned);
  return { ok: true, list: cleaned };
});

/* ---------------------------------------------------------------------------
   Launch at login
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:get-login-item', async () => {
  try {
    return { openAtLogin: !!app.getLoginItemSettings().openAtLogin };
  } catch (e) {
    return { openAtLogin: false, error: e.message };
  }
});

ipcMain.handle('bolo:set-login-item', async (_e, on) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { openAtLogin: !!app.getLoginItemSettings().openAtLogin };
  } catch (e) {
    return { openAtLogin: false, error: e.message };
  }
});

/* ---------------------------------------------------------------------------
   Settings
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:get-settings', async () => ({
  ...settings.all(),
  hotkeyActive: shortcuts.getBinding('dictation'),
  bindings: shortcuts.getBindings()
}));

ipcMain.handle('bolo:set-hotkey', async (_e, hotkey) => {
  const acc = String(hotkey || '').trim();
  const res = shortcuts.register(modes.VOICE_ID, acc);
  if (!res.ok) return res;
  settings.setVoiceShortcut(acc);
  broadcast('bolo:voice', voiceInfo());
  broadcast('bolo:hotkey', res);
  return res;
});

ipcMain.handle('bolo:set-transcription', async (_e, on) => {
  settings.set('transcriptionEnabled', !!on);
  return voice.getState();
});
ipcMain.handle('bolo:set-injection', async (_e, on) => {
  settings.set('injectionEnabled', !!on);
  return voice.getState();
});
ipcMain.handle('bolo:set-autopaste', async (_e, on) => {
  settings.set('autoPasteAnswers', !!on);
  return voice.getState();
});
ipcMain.handle('bolo:set-ducking', async (_e, on) => {
  settings.set('audioDucking', !!on);
  return voice.getState();
});

// The speaker toggle on the setup pages. Gates the app's own narration — the
// intro's voice and the notch's spoken replies — and nothing else.
//
// Broadcast, because Settings has a switch for the same setting and the setup
// pages can change it while Settings is open. Without this the two would
// disagree until a reload, which is how a muted app comes to look broken.
ipcMain.handle('bolo:set-sounds', async (_e, on) => {
  settings.set('interactionSounds', !!on);
  broadcast('bolo:prefs', { interactionSounds: !!on });
  return { ok: true, on: !!on };
});

/* ---------------------------------------------------------------------------
   Context / automation
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:get-context', async () => context.getContext());
ipcMain.handle('bolo:screenshot', async () => capabilities.screenshot());
ipcMain.handle('bolo:agent-list', async () => agent.list());
ipcMain.handle('bolo:agent-run', async (_e, intent, args) => agent.run(intent, args));
ipcMain.handle('bolo:workflow-run', async (_e, def) => workflows.runWorkflow(def));
ipcMain.handle('bolo:workflow-samples', async () => workflows.samples);
ipcMain.handle('bolo:code-claude', async (_e, prompt) => coding.runClaudeCode(prompt));
ipcMain.handle('bolo:code-codex', async (_e, prompt) => coding.runCodex(prompt));
ipcMain.handle('bolo:history-list', async (_e, limit) => history.list(limit || 50));
ipcMain.handle('bolo:history-clear', async () => history.clear());

/* ---------------------------------------------------------------------------
   Agent permissions

   What the agent is allowed to do on this machine: open apps, edit files, take
   screenshots. Three switches on one channel pair rather than three more flat
   preferences, because these are the only settings in the app that gate whether
   something may touch the machine — capabilities.js reads the same keys, so the
   switch and the refusal can never disagree about what is on.
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:agent-perms', async () => capabilities.permissions());

ipcMain.handle('bolo:set-agent-perm', async (_e, key, value) => {
  const k = String(key || '');
  if (!Object.prototype.hasOwnProperty.call(capabilities.permissions(), k)) {
    return { ok: false, error: 'not-a-permission', key: k };
  }
  // The agent's three switches never close: the app opens with everything on,
  // and turning one off is not a state this build has. The Settings UI keeps
  // the switch — it just always lands back on, and the value reported is the
  // one that is actually in force.
  settings.set(k, true);
  const permissions = capabilities.permissions();
  broadcast('bolo:prefs', permissions);
  return { ok: true, key: k, value: true, permissions };
});

/* ---------------------------------------------------------------------------
   Teardown
   Every module that holds a resource outside this process tears it down here.
   duck.dispose() restores the volume and releases the PowerShell child; the
   context reader releases its compiled UI-Automation child; the injector
   releases the paste-keystroke child. Leaving a machine quiet after the app
   exits is the failure mode all of these guard against.
   ------------------------------------------------------------------------ */
app.on('will-quit', () => {
  require('./duck').dispose();
  // The context reader holds a compiled PowerShell child with a UI Automation
  // connection to the desktop. It is the one handle here that keeps a live COM
  // link open, so releasing it on quit is not just tidiness.
  require('./context').dispose();
  // The injector holds its own PowerShell child (the one that synthesizes the
  // paste keystroke). Same reasoning — release it rather than orphan it.
  require('./injector').dispose();
});

/* ---------------------------------------------------------------------------
   Keys (Groq for speech-to-text and the model, Deepgram for the voice)
   Full values never leave main; the renderer only ever sees a masked list.
   ------------------------------------------------------------------------ */
function keysSnapshot() {
  const byProvider = {};
  for (const p of keys.PROVIDERS) {
    byProvider[p] = { keys: keys.listMasked(p), count: keys.count(p) };
  }
  return {
    // `keys`/`count` stay flat and Groq-shaped because the Extras pane already
    // renders a Groq list from them; the per-provider view sits alongside.
    keys: byProvider.groq.keys,
    count: byProvider.groq.count,
    providers: byProvider,
    model: settings.get('groqModel'),
    sttModel: settings.get('sttModel'),
    ttsVoice: settings.get('ttsVoice'),
    ttsEnabled: settings.get('ttsEnabled'),
    voices: tts.voices
  };
}

function broadcastKeys() {
  broadcast('bolo:keys', keysSnapshot());
}

ipcMain.handle('bolo:keys-list', async () => keysSnapshot());
ipcMain.handle('bolo:keys-add', async (_e, key, provider) => {
  const r = keys.add(key, provider);
  broadcastKeys();
  return r;
});
ipcMain.handle('bolo:keys-remove', async (_e, index, provider) => {
  const r = keys.removeAt(index, provider);
  broadcastKeys();
  return r;
});
ipcMain.handle('bolo:keys-clear', async (_e, provider) => {
  const r = keys.clear(provider);
  broadcastKeys();
  return r;
});
ipcMain.handle('bolo:keys-rotate', async (_e, provider) => {
  const r = keys.rotate(provider);
  broadcastKeys();
  return r;
});
ipcMain.handle('bolo:set-model', async (_e, model) => {
  settings.set('groqModel', String(model || 'qwen/qwen3.8-27b'));
  return { model: settings.get('groqModel') };
});
ipcMain.handle('bolo:set-stt-model', async (_e, model) => {
  settings.set('sttModel', String(model || stt.DEFAULT_MODEL));
  return { model: settings.get('sttModel') };
});
ipcMain.handle('bolo:set-stt-provider', async (_e, provider) => {
  const p = String(provider || '').toLowerCase();
  const valid = ['groq', 'sarvam', 'auto'].includes(p) ? p : 'groq';
  settings.set('sttProvider', valid);
  return { provider: valid };
});
// The Sarvam transcription language. 'unknown' is auto-detect per recording;
// the explicit codes exist for short dictations that get misdetected.
ipcMain.handle('bolo:set-sarvam-language', async (_e, lang) => {
  const l = String(lang || '').toLowerCase();
  const valid = ['unknown', 'hi-in', 'en-in', 'kn-in'].includes(l) ? l : 'unknown';
  settings.set('sarvamLanguage', valid);
  return { language: valid };
});
ipcMain.handle('bolo:set-tts-voice', async (_e, voice) => {
  const id = String(voice || '');
  // Validated against the catalogue rather than stored blindly: an id Deepgram
  // does not serve turns every reply into a silent 400 that looks like the voice
  // feature is broken, which is a much harder bug to find than a rejected click.
  if (!tts.findVoice(id)) {
    return { ok: false, error: 'unknown-voice', voice: settings.get('ttsVoice') };
  }
  settings.set('ttsVoice', id);
  // The cache is keyed by voice, so a stale entry could not be served here — but
  // it would sit in memory forever, so drop it on a voice change.
  tts.clearCache();
  return { ok: true, voice: settings.get('ttsVoice') };
});
ipcMain.handle('bolo:set-tts', async (_e, on) => {
  settings.set('ttsEnabled', !!on);
  broadcast('bolo:prefs', { ttsEnabled: !!on });
  return { on: !!on };
});

// Live checks. Both make a real call rather than probing reachability, because a
// reachability probe can pass while transcription or speech is broken.
ipcMain.handle('bolo:groq-test', async () => {
  const groq = require('./groq');
  return groq.chat([{ role: 'user', content: 'Reply with the word ok.' }], { maxTokens: 16 });
});

// The microphones to offer in Settings and in onboarding.
//
// Routed through the capture window rather than enumerated here, because the
// device *names* only exist for a page Chromium has granted the microphone to,
// and the capture window is the only one that ever is. See capture.listDevices.
ipcMain.handle('bolo:mic-devices', async () => capture.listDevices());

// Headphones plugged in or out. Re-broadcast so an open Settings pane stops
// offering a microphone that is no longer plugged in — the capture window is
// the only window that can hear the OS say so.
ipcMain.on('bolo:capture-devices-changed', () => broadcast('bolo:mic-devices-changed', {}));

// Records a few seconds from the real microphone and transcribes it. This is the
// only test in Settings that exercises the whole chain — permission, device,
// MediaRecorder, the codec, and Groq — so a pass here means dictation works.
ipcMain.handle('bolo:stt-test', async (_e, payload) => {
  if (voice.getState().state !== 'idle') {
    return { ok: false, error: 'busy', hint: 'a dictation is already running' };
  }
  const ms = Math.max(1000, Math.min(10000, Number(payload && payload.ms) || 3000));

  const started = await audio.start();
  if (!started.ok) return { ok: false, error: started.error, stage: started.stage || 'mic' };

  await new Promise((r) => setTimeout(r, ms));
  const clip = await audio.stop();
  if (!clip.ok) return { ok: false, error: clip.error, stage: 'record' };

  const r = await stt.transcribe(clip.buffer, {
    mime: clip.mime,
    language: settings.get('defaultLanguage')
  });
  return { ...r, ms: clip.ms, bytes: clip.bytes };
});

ipcMain.handle('bolo:tts-test', async (_e, payload) => {
  const voiceId = (payload && payload.voice) || settings.get('ttsVoice');
  const r = await tts.test(voiceId);
  if (!r.ok) console.warn('[bolo tts] test failed:', r.error);
  return r;
});

ipcMain.handle('bolo:tts-voices', async () => ({
  voices: tts.voices,
  families: tts.families,
  current: settings.get('ttsVoice')
}));

/* ---------------------------------------------------------------------------
   Speaking
   ------------------------------------------------------------------------ */

// The one gate on whether bolo may make noise on its own behalf: the speaker
// switch in Settings, which is also the switch the intro's speaker button writes.
// Enforced here rather than in each renderer, so a surface that forgot to check
// it cannot become a bug that sounds like a feature.
//
// The audio goes back to the calling renderer as a Uint8Array and is played there
// from an object URL. Nothing is written to disk, and the Deepgram key never
// leaves this process.
ipcMain.handle('bolo:speak', async (_e, payload) => {
  const p = typeof payload === 'string' ? { text: payload } : (payload || {});
  const text = String(p.text == null ? '' : p.text).trim();
  if (!text) return { ok: false, error: 'empty-text' };
  if (!settings.get('ttsEnabled') || !settings.get('interactionSounds')) {
    return { ok: false, error: 'muted' };
  }

  const r = await tts.synthesize(text, { voice: p.voice });
  if (!r.ok) {
    console.warn('[bolo tts]', r.error, r.hint || '');
    return { ok: false, error: r.error, hint: r.hint || null };
  }
  return { ok: true, audio: r.audio, mime: r.mime, voice: r.voice, cached: !!r.cached };
});

// The same thing, played as it is generated. The caller gets begin / chunk / end
// pushed at itself instead of a finished buffer back, and `speakStream` resolves
// when the stream is over — so a caller that only cares that it is spoken can
// ignore the return value. Same gate as above: the speaker switch is the master
// mute for the app's own voice, and synthesising at all when it is off would be a
// wasted round trip and a wasted charge.
ipcMain.handle('bolo:speak-stream', async (e, payload) => {
  const p = typeof payload === 'string' ? { text: payload } : (payload || {});
  const text = String(p.text == null ? '' : p.text).trim();
  if (!text) return { ok: false, error: 'empty-text' };
  if (!settings.get('ttsEnabled') || !settings.get('interactionSounds')) {
    return { ok: false, error: 'muted' };
  }
  const r = await speakOn(e.sender, text, { voice: p.voice });
  if (!r || !r.ok) {
    console.warn('[bolo tts]', (r && r.error) || 'unknown', (r && r.hint) || '');
    return { ok: false, error: (r && r.error) || 'unknown', hint: (r && r.hint) || null };
  }
  return { ok: true, voice: r.voice, streamed: !!r.streamed };
});

/* ---------------------------------------------------------------------------
   Onboarding
   ------------------------------------------------------------------------ */
ipcMain.handle('bolo:onboarding-get', async () => onboarding.get());
ipcMain.handle('bolo:onboarding-set', async (_e, patch) => {
  const r = onboarding.set(patch || {});
  broadcast('bolo:onboarding', r);
  return r;
});
ipcMain.handle('bolo:onboarding-next', async () => {
  const r = onboarding.next();
  broadcast('bolo:onboarding', r);
  return r;
});
ipcMain.handle('bolo:onboarding-back', async () => {
  const r = onboarding.back();
  broadcast('bolo:onboarding', r);
  return r;
});
ipcMain.handle('bolo:onboarding-go', async (_e, step) => {
  const r = onboarding.go(step);
  broadcast('bolo:onboarding', r);
  return r;
});
ipcMain.handle('bolo:onboarding-complete', async () => {
  const r = onboarding.complete();
  broadcast('bolo:onboarding', r);
  return r;
});
ipcMain.handle('bolo:onboarding-reset', async () => {
  const r = onboarding.reset();

  // The settings go back to their defaults with it. The button offers to restart
  // the onboarding *flow*, and an onboarding that runs on top of the previous
  // answers is not a restart — the first-run steps read these values, and the
  // user asked for the saved settings to be deleted (except the API keys, which
  // live in their own store and so survive by construction).
  settings.reset();

  broadcast('bolo:onboarding', r);

  // …and then the app restarts, which is the only way to be sure every consumer
  // of the values just wiped — the shortcut registry, the notch, the pill, the
  // wake detector, and this window's own renderer — is reading the new ones
  // rather than the ones it read at boot. It is also what makes the dashboard
  // disappear: a fresh start shows the intro, not a dashboard behind an overlay.
  //
  // The delay is for the reply and the confirmation toast. If the relaunch
  // itself fails the app deliberately stays up on the wiped settings with the
  // onboarding showing, which is a usable state; quitting into nothing is not.
  setTimeout(() => {
    try {
      app.relaunch();
    } catch (e) {
      console.warn('[bolo] relaunch failed, staying up: ' + e.message);
      return;
    }
    app.exit(0);
  }, 400);

  return r;
});

/* ---------------------------------------------------------------------------
   Onboarding demo mode
   During the dictation_edit and edit_demo steps, a voice result is routed back to
   the dashboard's own textarea (bolo:ob-demo-result) instead of being pasted into
   the foreground app — so it lands in the onboarding, not in whatever the user
   had open behind it.
   ------------------------------------------------------------------------ */
let onboardingDemoMode = false;

// voice.js emits bolo:ob-demo-result through the shared broadcast channel
// (broadcastAll -> sendTo(shell.getMain(), ...)), so no direct hookup is
// needed here beyond the flag the IPC handlers toggle.
ipcMain.handle('bolo:ob-demo-start', async (_e, step) => {
  onboardingDemoMode = true;
  voice.setDemoMode(true);
  // Bring the dashboard to the front while the demo runs so the activation key
  // fires into it. The onboarding overlay covers the whole surface, so the user
  // is not dictating into a real app they have open behind it.
  // During first run the intro window hosts the demo, so it — not the dashboard —
  // is the surface the activation key should fire into.
  const host = intro.isActive() ? intro.getWindow() : shell.getMain();
  if (host && !host.isDestroyed()) host.focus();
  // The trial is exactly when the notch is needed: make sure the capsule is up
  // over the intro even if the phase handoff raced the demo binding.
  if (intro.isActive()) { try { intro.revealNotch(); } catch (_) {} }
  return { ok: true, step: step || null };
});

ipcMain.handle('bolo:ob-demo-end', async () => {
  onboardingDemoMode = false;
  voice.setDemoMode(false);
  return { ok: true };
});

/* ---------------------------------------------------------------------------
   Cinematic intro
   ------------------------------------------------------------------------ */
// The renderer drives its own beats, so if its script never runs the window
// would sit on its opening frame forever. This is the watchdog for that: if the
// intro hasn't advanced past the opening beat in time, hand off to the
// dashboard rather than leaving the user staring at a full-screen overlay.
let introWatchdog = null;

function armIntroWatchdog() {
  if (introWatchdog) clearTimeout(introWatchdog);
  introWatchdog = setTimeout(async () => {
    introWatchdog = null;
    if (!introPending) return;
    const st = intro.getState();
    if (st.phase === 'glow' || st.phase === 'idle') {
      console.warn('[bolo] intro did not advance past "' + st.phase + '" — handing off to the dashboard');
      introPending = false;
      intro.abort();
      shell.showMain();
    }
  }, 8000);
}

function clearIntroWatchdog() {
  if (introWatchdog) { clearTimeout(introWatchdog); introWatchdog = null; }
}

// The intro window is the one surface with no DevTools and no terminal of its
// own, so its errors are echoed to stdout and onto the window itself.
ipcMain.handle('bolo:intro-error', async (_e, p) => {
  const msg = (p && p.message) || 'unknown intro error';
  const detail = (p && p.detail) || '';
  console.error('[bolo intro] ' + msg + (detail ? '  (' + detail + ')' : ''));
  return { ok: true };
});

// Sent by diag.js in every renderer, including the intro. It loads before the
// app scripts precisely so this fires even when the failure is a parse error
// that stopped those scripts from ever running.
ipcMain.handle('bolo:renderer-error', async (e, p) => {
  const msg = (p && p.message) || 'unknown renderer error';
  const detail = (p && p.detail) || '';
  // Named by URL rather than by window, so a report from the notch or the pill
  // is not misread as coming from the dashboard.
  let where = 'renderer';
  try {
    const url = e.sender.getURL() || '';
    const file = url.split('/').pop().split('?')[0];
    if (file) where = file;
  } catch (_) { /* sender already gone; 'renderer' is fine */ }
  console.error('[bolo ' + where + '] ' + msg + (detail ? '  (' + detail + ')' : ''));
  return { ok: true };
});

ipcMain.handle('bolo:intro-start', async () => {
  let w = intro.getWindow();
  if (!w) {
    w = intro.create(preloadPath, rendererDir);
    // Replaying creates the window from cold, so wait for the renderer to load
    // before revealing it — otherwise the first thing the user sees is a blank
    // frame while the aurora canvas is still booting.
    await new Promise((resolve) => {
      if (!w || w.isDestroyed()) return resolve();
      if (!w.webContents.isLoading()) return resolve();
      w.webContents.once('did-finish-load', resolve);
    });
  }
  const r = intro.start();
  armIntroWatchdog();
  return r;
});

ipcMain.handle('bolo:intro-phase', async (_e, phase, payload) => intro.onPhase(String(phase || ''), payload));

// The renderer narrates with the platform speech synthesiser; main only mirrors
// the line to the notch, which is where the user is looking.
//
// Deliberately silent while onboarding is up: narrated confirmations ("cool,
// Dictation works", "press Control Shift …") would otherwise paint as notch
// reply text over the beats, which reads as clutter. The notch still shows the
// live voice pipeline (listening / thinking / real replies) — only the narrated
// lines are held back.
ipcMain.handle('bolo:intro-narrate', async (_e, payload) => {
  const p = payload || {};
  if (!intro.isActive()) {
    notch.show('reply', { text: p.text || '', label: 'bolo' });
  }
  return { ok: true };
});

ipcMain.handle('bolo:intro-submit-name', async (_e, p) => {
  const first = String((p && p.firstName) || '').trim().slice(0, 48);
  const last = String((p && p.lastName) || '').trim().slice(0, 48);
  if (!first) return { ok: false, error: 'first-name-required' };
  onboarding.set({ firstName: first, lastName: last });
  // The dashboard was loaded at boot and is still hidden, so it painted the
  // step it saw then. Push the new state or it asks for the name again.
  broadcast('bolo:onboarding', onboarding.get());
  return { ok: true, firstName: first, lastName: last };
});

ipcMain.handle('bolo:intro-submit-language', async (_e, p) => {
  const def = String((p && p.defaultLanguage) || '').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?$/.test(def)) {
    return { ok: false, error: 'invalid-language' };
  }
  const list = Array.isArray(p && p.enabledLanguages) && p.enabledLanguages.length
    ? p.enabledLanguages.map((l) => String(l))
    : [def];
  onboarding.set({ defaultLanguage: def, enabledLanguages: list });
  // The intro has already collected the name and language — advance the
  // onboarding store past both to the first step the intro's own renderer
  // handles (system_permissions), so handoff() sees a renderable step.
  onboarding.go('system_permissions');
  broadcast('bolo:onboarding', onboarding.get());
  return { ok: true, defaultLanguage: def, enabledLanguages: list };
});

ipcMain.handle('bolo:intro-finish', async (_e, outcome) => {
  onboardingDemoMode = false;
  try { voice.setDemoMode(false); } catch (_) {}
  const r = intro.finish(String(outcome || 'completed'));
  // finish() completes onboarding via onboarding.complete() (see intro.js) and
  // returns the post-complete state. It runs outside the ipcMain onboarding
  // handlers, so it has to broadcast the same way they do.
  broadcast('bolo:onboarding', r.onboarding);
  // Only now does the dashboard come forward — otherwise the intro would be
  // covering a window the user could already see behind it.
  shell.showMain();
  introPending = false;
  clearIntroWatchdog();
  return r;
});
