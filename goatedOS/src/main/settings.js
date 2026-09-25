const Store = require('electron-store');

// Three real modes, three keys. Dictation is the voice key; Edit and Agent are
// their own bindings. Each key now drives a different backend path (see
// voice.js): Dictation types what you say, Edit rewrites the text you selected,
// Agent carries the instruction out. The key you press decides the mode — it is
// no longer only a hint to a guesser.
//
// The defaults are deliberately bindable on Windows. The reference product's
// requested defaults were Fn / Ctrl+Fn / Ctrl+Alt, but Fn is not a Windows key
// at all — the embedded controller swallows it and no key event ever reaches an
// application, so `globalShortcut.register('Fn')` fails and the key is dead. That
// left the app advertising a key that could never fire and onboarding waiting on
// a cap that could never light. So the defaults are mnemonic, working chords:
//   Dictation  Ctrl+Shift+D
//   Edit       Ctrl+Shift+E
//   Agent      Ctrl+Shift+A
// `shortcuts.registerTolerant` still substitutes a fallback if another app owns
// one of these, and Settings shows what was actually bound.
const DEFAULT_VOICE_SHORTCUT = 'Control+Shift+D';
const DEFAULT_EDIT_SHORTCUT = 'Control+Shift+E';
const DEFAULT_AGENT_SHORTCUT = 'Control+Shift+A';

// Cancel dismisses whatever bolo has on screen. Deliberately NOT registered as a
// global accelerator: a global Escape would swallow the key in every other
// application on the machine, which costs far more than the feature is worth.
// Each surface already handles it locally.
const DEFAULT_CANCEL_SHORTCUT = 'Escape';

const defaults = {
  // Canonical voice shortcut. Kept as `hotkey` too because the shape of this
  // key predates the rename and every read site is already on it.
  hotkey: DEFAULT_VOICE_SHORTCUT,
  voiceShortcut: DEFAULT_VOICE_SHORTCUT,
  // The other two activation keys. `voiceShortcut` *is* dictation; it is not
  // duplicated here under a third name.
  editShortcut: DEFAULT_EDIT_SHORTCUT,
  agentShortcut: DEFAULT_AGENT_SHORTCUT,
  cancelShortcut: DEFAULT_CANCEL_SHORTCUT,
  pasteLastShortcut: 'CommandOrControl+Shift+V',

  // How the activation keys behave. 'hold' is true hold-to-talk (hold the key to
  // record, release to send) — the default, and needs the native key hook
  // (uiohook-napi). 'toggle' is press-to-start / press-to-stop, which works with
  // Electron's press-only globalShortcut alone. main.js falls back to 'toggle' if
  // the native hook is unavailable, whatever this says.
  activationMode: 'hold',

  transcriptionEnabled: true,
  injectionEnabled: true,
  audioDucking: false,
  // How loud everything else goes while the microphone is open, as a fraction of
  // what it was. 0.25 is quiet enough to stop music bleeding into a transcript
  // and loud enough that the user still hears what they were listening to.
  duckLevel: 0.25,
  // Which Spotify device playback goes to. Empty means Spotify's own default,
  // which is whatever the user last played on.
  spotifyDeviceId: '',
  // Answers are worth pasting without a second gesture — this is the reference
  // product's "auto-paste in ask mode".
  autoPasteAnswers: true,

  // The speaker toggle in the corner of the setup pages. It gates the spoken
  // narration (the intro's voice and the notch's replies), which is the only
  // audio this app makes on its own behalf.
  interactionSounds: true,
  // Spoken replies, separately from the master speaker switch: the switch says
  // whether the app may make noise at all, this says whether the voice is worth
  // the round trip. Off here and the notch still shows every reply in text.
  ttsEnabled: true,
  // Delia — aura-2, feminine, and the app's default voice. Flux voices are served
  // from Deepgram's /v2/speak and Aura-2 from /v1/speak; see tts.js for the
  // catalogue and why the endpoint depends on the id.
  ttsVoice: 'aura-2-delia-en',
  serverUrl: 'http://localhost:8787',
  groqModel: 'qwen/qwen3.8-27b',
  // Speech-to-text. Groq serves whisper-large-v3-turbo, which is the fast one —
  // large-v3 is more accurate and several times slower.
  sttModel: 'whisper-large-v3-turbo',

  // Wake word. Off by default: an always-open microphone is a real cost and a
  // real privacy surface, so it has to be opted into.
  wakeEnabled: false,
  wakePhrase: 'hey bolo',
  wakeSensitivity: 0.6,

  // Notch. `variant` is which edge it hangs from and `material` is what it is
  // made of — the two axes the reference product exposes. Liquid Glass is the
  // translucent macOS-26 material; Solid Black is the opaque one, and is the
  // one the reference recording actually shows.
  notchEnabled: true,
  notchVariant: 'top',
  notchSide: 'right',
  // Liquid Glass is the default look now — opaque black at the top edge fading
  // to a see-through glassy lower half. "Solid Black" is still selectable for
  // the opaque reference material.
  notchMaterial: 'glass',
  notchWidth: 286,
  notchOffsetX: 0,
  notchOffsetY: 0,
  notchOpacity: 1,
  notchAutoHideMs: 4000,
  notchAlwaysOnTop: true,
  notchShowOnHover: false,

  // Visibility — the reference's third settings section, and the only one that
  // hides whole surfaces rather than moving them.
  hidePill: false,
  hideTopNotch: false,
  hideSideNotch: false,

  // General / Context Awareness / Extras. Flat preferences with no behaviour of
  // their own beyond being read back; see PREF_KEYS in main.js for the writer.
  closeToTray: true,
  creatorMode: false,
  practiceMode: false,
  // Off by default: reading the focused window's text is the one thing here
  // that touches somebody else's data, so it is opted into rather than out of.
  contextAwareness: true,
  privateMode: false,

  // What the agent may actually do when the router reads an utterance as a
  // command. Three separate switches rather than one, because the three carry
  // very different risk: opening an app is easy to see and easy to undo, taking
  // a screenshot touches what is on screen but changes nothing, and editing a
  // file can destroy work.
  //
  // Defaults follow that order. Opening apps is ON — it is the least surprising
  // and hardest to abuse, and it is the thing the user asked for by name.
  // Screenshots are ON, and are already taken by the intro. Editing files is
  // OFF: it can overwrite somebody's document, so it is opted into rather than
  // out of, exactly like `contextAwareness` above.
  agentCanOpenApps: true,
  agentCanEditFiles: false,
  agentCanScreenshot: true,
  micDeviceId: '',
  languages: ['en'],
  defaultLanguage: 'en',

  // Customize -> Replacements. A list of { from, to } applied to the transcript
  // after recognition and before the router sees it, so a replacement can be
  // what makes an utterance read as a command. Case-insensitive on `from`,
  // whole-word, and applied in order.
  replacements: [],

  // MCP servers — the user's own, spoken to over stdio. Empty by default, and
  // that default is the point: a server is a program this app starts on the
  // user's behalf, so shipping one switched on would be launching a process they
  // never asked for. The shape is { name, command, args, env, enabled }, where
  // `env` is where a server's token lives — it is stored and never echoed back,
  // never logged and never returned (see the redaction note in mcp.js).
  mcpServers: []
};

let store = null;

// The id of the single voice entry in the shortcut registry. Named here so the
// migration below and the shortcut registration in main.js cannot disagree.
const VOICE_KEY = 'voice';

function init(customDefaults = {}) {
  store = new Store({
    name: 'bolo-settings',
    defaults: { ...defaults, ...customDefaults }
  });
  migrate();
  return store;
}

// An install that predates the single voice key has `modeShortcuts` holding
// dictation/ask/edit/agent and no `voiceShortcut`, so it would come up on the
// default and silently drop whatever the user had bound. Carry the dictation
// binding across instead — it was the one they actually used for typing.
//
// This one is deliberately NOT version-gated: it is idempotent (it deletes the
// key it reads) and it has to keep working for anyone still on a pre-v1 store.
function carryLegacyModeShortcuts() {
  const legacy = store.get('modeShortcuts');
  if (!legacy || typeof legacy !== 'object') return;

  const carried = legacy[VOICE_KEY] || legacy.dictation;
  const current = store.get('voiceShortcut');
  if (carried && (!current || current === DEFAULT_VOICE_SHORTCUT)) {
    store.set('voiceShortcut', carried);
    store.set('hotkey', carried);
  }
  store.delete('modeShortcuts');
}

// The voice key's default used to be Ctrl+Space. An install still holding that
// value never chose it — it was simply the default at the time — and leaving it
// there meant the app advertised one key in Settings and answered to a different
// one, which also left the onboarding key-check waiting on a cap that lit for a
// binding the copy no longer named. Anything else is a deliberate rebind and is
// left strictly alone.
const LEGACY_VOICE_SHORTCUT = 'CommandOrControl+Space';
const SCHEMA_VERSION = 3;

function migrateToV2() {
  const swap = (key) => {
    if (store.get(key) === LEGACY_VOICE_SHORTCUT) store.set(key, DEFAULT_VOICE_SHORTCUT);
  };
  swap('voiceShortcut');
  swap('hotkey');

  // notchWidth shipped as a 260px guess before the recording was measured; the
  // measured value is 286. Same reasoning as above — a guess is not a preference.
  if (store.get('notchWidth') === 260) store.set('notchWidth', 286);

  // Written by the mode system, which no longer exists. Nothing reads it; it is
  // cleared so the store stops describing a UI the app cannot show.
  store.delete('lastMode');
}

// The three activation keys defaulted to Fn / Ctrl+Fn / Ctrl+Alt, and Fn cannot
// be bound on Windows — so those installs advertised keys that never fired. An
// install still holding one of the dead defaults never chose it; swap it for the
// new working default. Anything else is a deliberate rebind and is left alone.
const DEAD_DEFAULTS = {
  voiceShortcut: 'Fn',
  hotkey: 'Fn',
  editShortcut: 'Control+Fn',
  agentShortcut: 'Control+Alt'
};

function migrateToV3() {
  for (const [key, dead] of Object.entries(DEAD_DEFAULTS)) {
    if (store.get(key) === dead) {
      if (key === 'voiceShortcut' || key === 'hotkey') store.set(key, DEFAULT_VOICE_SHORTCUT);
      else if (key === 'editShortcut') store.set(key, DEFAULT_EDIT_SHORTCUT);
      else if (key === 'agentShortcut') store.set(key, DEFAULT_AGENT_SHORTCUT);
    }
  }
}

// Version-gated so each fix runs exactly once. The version is deliberately NOT in
// `defaults`: a default would make a fresh store report the current version and
// skip every migration below it.
function migrate() {
  carryLegacyModeShortcuts();
  const version = store.get('schemaVersion') || 1;
  if (version < 2) migrateToV2();
  if (version < 3) migrateToV3();
  if (version < SCHEMA_VERSION) store.set('schemaVersion', SCHEMA_VERSION);
}

// Named so the migration above and the shortcut registration below cannot
// disagree about the key.
function ensure() {
  if (!store) init();
}

function get(key) {
  ensure();
  return store.get(key);
}

function set(key, value) {
  ensure();
  store.set(key, value);
}

function all() {
  ensure();
  return store.store;
}

// Merge a patch into one object-valued key without clobbering its siblings.
function merge(key, patch) {
  ensure();
  const cur = store.get(key) || {};
  const next = { ...cur, ...(patch || {}) };
  store.set(key, next);
  return next;
}

// Factory reset. Every key in this store is a preference, so wiping it is the
// whole operation. Two things are deliberately out of scope:
//
//   * the API keys, which live in their own store (keys.js → bolo-keys.json)
//     and are therefore untouched by construction. Re-pasting three keys every
//     time someone replays the onboarding would be a punishment, not a reset.
//   * `schemaVersion`, which records which migrations have already run. That is
//     bookkeeping rather than a preference, and dropping it would re-run them.
function reset() {
  ensure();
  store.clear();
  // clear() replaces the store object with an empty one — defaults included — so
  // the instance is rebuilt rather than reused. A cleared store answers
  // `undefined` for every key, and a read site would have to defend against
  // that; rebuilding puts the defaults back where every caller expects them.
  store = null;
  init();
  return store.store;
}

function voiceShortcut() {
  ensure();
  return store.get('voiceShortcut') || store.get('hotkey') || DEFAULT_VOICE_SHORTCUT;
}

function setVoiceShortcut(accelerator) {
  ensure();
  store.set('voiceShortcut', accelerator);
  store.set('hotkey', accelerator);
  return accelerator;
}

module.exports = {
  init,
  get,
  set,
  all,
  merge,
  reset,
  defaults,
  voiceShortcut,
  setVoiceShortcut,
  DEFAULT_VOICE_SHORTCUT,
  DEFAULT_EDIT_SHORTCUT,
  DEFAULT_AGENT_SHORTCUT,
  VOICE_KEY
};
