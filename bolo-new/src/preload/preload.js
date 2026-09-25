const { contextBridge, ipcRenderer } = require('electron');

// Channels the renderer may subscribe to. An allowlist rather than a raw
// `ipcRenderer.on` passthrough, so a renderer compromise can't sit on arbitrary
// main-process traffic.
const EVENTS = [
  'bolo:voice-state',
  'bolo:voice-level',
  'bolo:transcript',
  'bolo:injected',
  'bolo:hotkey',
  'bolo:view',
  'bolo:onboarding',
  'bolo:pill-state',
  'bolo:notch-state',
  'bolo:notch',
  'bolo:answer',
  'bolo:intent',
  'bolo:voice',
  'bolo:visibility',
  'bolo:prefs',
  'bolo:intro-phase',
  'bolo:wake',
  // Spoken audio pushed from main to a window that can play it (the notch's
  // replies, notably — main has no audio device of its own).
  'bolo:say',
  // Commands into the hidden capture window. Only capture.html subscribes.
  'bolo:capture-start',
  'bolo:capture-stop',
  'bolo:capture-monitor',
  'bolo:capture-clip',
  'bolo:capture-devices',
  'bolo:capture-device',
  // A microphone plugged in or unplugged, re-broadcast for an open picker.
  'bolo:mic-devices-changed',
  'bolo:keys',
  // Streaming speech: main pushes a reply's audio to the window that plays it as
  // Deepgram generates it, so playback starts on the first words rather than on
  // the last. src/renderer/speak.js subscribes once and plays; no caller opts in.
  'bolo:speak-begin',
  'bolo:speak-chunk',
  'bolo:speak-end',
  'bolo:speak-cancel',
  // Which activation shortcut is live — dictation / edit / agent — for the notch
  // chip, so it can say which mode is live before a word has been recorded.
  'bolo:mode',
  // Something in the setup flow failed in a way the user needs to be told about,
  // sent to the intro window because that is the surface they are looking at.
  // The capsule is not a reliable place to report it: it is held down for the
  // first part of the intro, so an error sent only there is invisible.
  'bolo:setup-error',
  // During the onboarding demo steps a dictation/edit result is routed here
  // instead of being pasted into the foreground app — see onboardingDemoMode in
  // main.js. The demo card writes the text into its own textarea.
  'bolo:ob-demo-result'
];

contextBridge.exposeInMainWorld('bolo', {
  /* ── App / status ─────────────────────────────────────────────────────── */
  getStatus: () => ipcRenderer.invoke('bolo:get-status'),
  getUsage: () => ipcRenderer.invoke('bolo:get-usage'),
  show: () => ipcRenderer.invoke('bolo:show'),
  setView: (v) => ipcRenderer.invoke('bolo:set-view', v),
  getView: () => ipcRenderer.invoke('bolo:get-view'),

  /* ── Frameless window chrome ──────────────────────────────────────────── */
  getPlatform: () => ipcRenderer.invoke('bolo:get-platform'),
  windowMinimize: () => ipcRenderer.invoke('bolo:window-minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('bolo:window-maximize-toggle'),
  windowMaximized: () => ipcRenderer.invoke('bolo:window-maximized'),
  windowClose: () => ipcRenderer.invoke('bolo:window-close'),

  /* ── Voice ────────────────────────────────────────────────────────────── */
  // One key, no mode argument: the intent router decides what the words were
  // for. See src/main/intent.js.
  voiceToggle: () => ipcRenderer.invoke('bolo:voice-toggle'),
  voiceState: () => ipcRenderer.invoke('bolo:voice-state'),
  pasteLast: () => ipcRenderer.invoke('bolo:paste-last'),

  /* ── The voice key ────────────────────────────────────────────────────── */
  voiceInfo: () => ipcRenderer.invoke('bolo:voice-info'),
  setVoiceShortcut: (accelerator) =>
    ipcRenderer.invoke('bolo:set-voice-shortcut', accelerator),
  // Rebind any activation key — mode is 'dictation' | 'edit' | 'agent'.
  setModeShortcut: (mode, accelerator) =>
    ipcRenderer.invoke('bolo:set-mode-shortcut', { mode, accelerator }),
  setPasteLastShortcut: (accelerator) =>
    ipcRenderer.invoke('bolo:set-paste-last-shortcut', accelerator),
  resetShortcuts: () => ipcRenderer.invoke('bolo:reset-shortcuts'),
  // Switch hold-to-talk vs press-to-toggle — mode is 'hold' | 'toggle'.
  setActivationMode: (mode) => ipcRenderer.invoke('bolo:set-activation-mode', mode),

  /* ── Wake word ────────────────────────────────────────────────────────── */
  wakeGet: () => ipcRenderer.invoke('bolo:wake-get'),
  wakeSet: (patch) => ipcRenderer.invoke('bolo:wake-set', patch),
  // Say the phrase now and report what the recogniser actually heard — the only
  // way to check the wake word without making a noise and hoping.
  wakeListen: () => ipcRenderer.invoke('bolo:wake-listen'),

  /* ── Notch ────────────────────────────────────────────────────────────── */
  notchGet: () => ipcRenderer.invoke('bolo:notch-get'),
  notchSet: (patch) => ipcRenderer.invoke('bolo:notch-set', patch),
  notchPreview: () => ipcRenderer.invoke('bolo:notch-preview'),
  // Called by the notch renderer itself.
  notchResize: (size) => ipcRenderer.invoke('bolo:notch-resize', size),
  notchHover: (on) => ipcRenderer.invoke('bolo:notch-hover', on),
  // True while a reply's audio is playing here: main holds the auto-hide open
  // until it stops, so the text cannot vanish mid-sentence.
  notchSpeaking: (on) => ipcRenderer.invoke('bolo:notch-speaking', on),
  notchCopy: (text) => ipcRenderer.invoke('bolo:notch-copy', text),
  notchAction: (action) => ipcRenderer.invoke('bolo:notch-action', action),
  notchDismiss: () => ipcRenderer.invoke('bolo:notch-dismiss'),
  // The notch renderer's heartbeat. Carries its animation-frame tick count so
  // main can tell "still drawing" from "alive but throttled" — the difference
  // between a glued capsule and a dead one, which otherwise look identical.
  notchAlive: (info) => ipcRenderer.invoke('bolo:notch-alive', info),

  /* ── Settings ─────────────────────────────────────────────────────────── */
  getSettings: () => ipcRenderer.invoke('bolo:get-settings'),
  setHotkey: (hk) => ipcRenderer.invoke('bolo:set-hotkey', hk),
  setTranscription: (on) => ipcRenderer.invoke('bolo:set-transcription', on),
  setInjection: (on) => ipcRenderer.invoke('bolo:set-injection', on),
  setAutoPaste: (on) => ipcRenderer.invoke('bolo:set-autopaste', on),
  setDucking: (on) => ipcRenderer.invoke('bolo:set-ducking', on),
  setSounds: (on) => ipcRenderer.invoke('bolo:set-sounds', on),

  /* ── Visibility ───────────────────────────────────────────────────────── */
  visibilitySet: (patch) => ipcRenderer.invoke('bolo:visibility-set', patch),

  /* ── Flat preferences ─────────────────────────────────────────────────── */
  setPref: (key, value) => ipcRenderer.invoke('bolo:set-pref', key, value),
  getLoginItem: () => ipcRenderer.invoke('bolo:get-login-item'),
  setLoginItem: (on) => ipcRenderer.invoke('bolo:set-login-item', on),

  /* ── Context / automation ─────────────────────────────────────────────── */
  getContext: () => ipcRenderer.invoke('bolo:get-context'),
  screenshot: () => ipcRenderer.invoke('bolo:screenshot'),
  agentList: () => ipcRenderer.invoke('bolo:agent-list'),
  agentRun: (intent, args) => ipcRenderer.invoke('bolo:agent-run', intent, args),
  workflowRun: (def) => ipcRenderer.invoke('bolo:workflow-run', def),
  workflowSamples: () => ipcRenderer.invoke('bolo:workflow-samples'),
  codeClaude: (p) => ipcRenderer.invoke('bolo:code-claude', p),
  codeCodex: (p) => ipcRenderer.invoke('bolo:code-codex', p),
  historyList: (n) => ipcRenderer.invoke('bolo:history-list', n),
  historyClear: () => ipcRenderer.invoke('bolo:history-clear'),
  // What the agent may do on this machine. Booleans in, booleans out — there is
  // nothing secret on this channel, which is why it can be a plain invoke
  // rather than anything masked.
  agentPermissions: () => ipcRenderer.invoke('bolo:agent-perms'),
  setAgentPermission: (key, value) => ipcRenderer.invoke('bolo:set-agent-perm', key, value),

  /* ── Customize: replacements ──────────────────────────────────────────── */
  replacementsGet: () => ipcRenderer.invoke('bolo:replacements-get'),
  replacementsSet: (list) => ipcRenderer.invoke('bolo:replacements-set', list),

  /* ── Microphone (capture window only) ─────────────────────────────────── */
  // Fire-and-forget on purpose: levels arrive ~16x/second and none of them has
  // an answer worth waiting for, so a round trip per frame would be pure cost.
  captureLevel: (level) => ipcRenderer.send('bolo:capture-level', level),
  captureState: (payload) => ipcRenderer.send('bolo:capture-state', payload),
  // Carries the recorded ArrayBuffer. Structured clone handles it, so the clip
  // goes straight from memory to main and never touches the disk.
  captureDone: (payload) => ipcRenderer.send('bolo:capture-done', payload),
  // The device list, answered on its own channel because the request arrives on
  // a one-way one. Main pairs the two by nonce.
  captureDevices: (payload) => ipcRenderer.send('bolo:capture-devices-result', payload),
  captureDevicesChanged: (payload) => ipcRenderer.send('bolo:capture-devices-changed', payload),
  // A short clip for the wake-word recogniser. Answers on its own channel for
  // the same reason the device list does: the request is one-way, and main pairs
  // the answer back by nonce.
  captureClip: (payload) => ipcRenderer.send('bolo:capture-clip-result', payload),

  /* ── Choosing a microphone ────────────────────────────────────────────── */
  // The list of microphones to offer, with their real names. Read through the
  // capture window, which is the only surface Chromium grants the microphone to.
  micDevices: () => ipcRenderer.invoke('bolo:mic-devices'),

  /* ── Speaking ─────────────────────────────────────────────────────────── */
  // Returns { ok, audio: Uint8Array, mime } for the caller to play, or
  // { ok:false, error:'muted' } when the speaker switch is off. The Deepgram key
  // stays in main; a renderer only ever receives the finished audio.
  speak: (payload) => ipcRenderer.invoke('bolo:speak', payload),
  // The same thing, played as it is generated. Main pushes bolo:speak-begin /
  // -chunk / -end at the window that asked; `speakStream` itself resolves only
  // when the stream is over, so a caller that does not care can ignore it.
  speakStream: (payload) => ipcRenderer.invoke('bolo:speak-stream', payload),
  // Which activation shortcut fired. `{ mode: 'dictation'|'edit'|'agent'|null }`.
  onMode: (fn) => ipcRenderer.on('bolo:mode', (_e, payload) => fn(payload)),

  /* ── Keys ─────────────────────────────────────────────────────────────── */
  keysList: () => ipcRenderer.invoke('bolo:keys-list'),
  keysAdd: (k, provider) => ipcRenderer.invoke('bolo:keys-add', k, provider),
  keysRemove: (i, provider) => ipcRenderer.invoke('bolo:keys-remove', i, provider),
  keysClear: (provider) => ipcRenderer.invoke('bolo:keys-clear', provider),
  keysRotate: (provider) => ipcRenderer.invoke('bolo:keys-rotate', provider),
  setModel: (m) => ipcRenderer.invoke('bolo:set-model', m),
  setSttModel: (m) => ipcRenderer.invoke('bolo:set-stt-model', m),
  setTts: (on) => ipcRenderer.invoke('bolo:set-tts', on),
  setTtsVoice: (v) => ipcRenderer.invoke('bolo:set-tts-voice', v),
  ttsVoices: () => ipcRenderer.invoke('bolo:tts-voices'),
  groqTest: () => ipcRenderer.invoke('bolo:groq-test'),
  // Exercises the whole chain: permission, device, MediaRecorder, codec, Groq.
  sttTest: (payload) => ipcRenderer.invoke('bolo:stt-test', payload),
  ttsTest: (payload) => ipcRenderer.invoke('bolo:tts-test', payload),

  /* ── Onboarding ───────────────────────────────────────────────────────── */
  obGet: () => ipcRenderer.invoke('bolo:onboarding-get'),
  obSet: (p) => ipcRenderer.invoke('bolo:onboarding-set', p),
  obNext: () => ipcRenderer.invoke('bolo:onboarding-next'),
  obBack: () => ipcRenderer.invoke('bolo:onboarding-back'),
  obGo: (s) => ipcRenderer.invoke('bolo:onboarding-go', s),
  obComplete: () => ipcRenderer.invoke('bolo:onboarding-complete'),
  obReset: () => ipcRenderer.invoke('bolo:onboarding-reset'),
  // Enter / leave onboarding demo mode. While it is on, a dictation or edit
  // result is routed back to this window (bolo:ob-demo-result) instead of being
  // pasted into whatever app had focus — so the demo lands in the onboarding
  // textarea, not in the user's editor behind it.
  obDemoStart: (step) => ipcRenderer.invoke('bolo:ob-demo-start', step),
  obDemoEnd: () => ipcRenderer.invoke('bolo:ob-demo-end'),

  /* ── Cinematic intro (intro window only) ──────────────────────────────── */
  introPhase: (phase, payload) => ipcRenderer.invoke('bolo:intro-phase', phase, payload),
  introNarrate: (payload) => ipcRenderer.invoke('bolo:intro-narrate', payload),
  introSubmitName: (p) => ipcRenderer.invoke('bolo:intro-submit-name', p),
  introSubmitLanguage: (p) => ipcRenderer.invoke('bolo:intro-submit-language', p),
  introFinish: (outcome) => ipcRenderer.invoke('bolo:intro-finish', outcome),
  startIntro: () => ipcRenderer.invoke('bolo:intro-start'),
  // The intro window has no DevTools and no terminal; this is how a failure in
  // it becomes visible.
  introError: (p) => ipcRenderer.invoke('bolo:intro-error', p),
  // Same idea for the dashboard. Sent by diag.js, which loads before anything
  // else so that even a parse error in app.js is reported.
  rendererError: (p) => ipcRenderer.invoke('bolo:renderer-error', p),
  // Setup-flow failures, for the intro window to paint as a banner. See
  // bolo:setup-error in EVENTS.
  onSetupError: (fn) => ipcRenderer.on('bolo:setup-error', (_e, p) => fn(p)),

  /* ── Events ───────────────────────────────────────────────────────────── */
  on: (channel, fn) => {
    if (!EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
