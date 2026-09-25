/* ============================================================================
   bolo — renderer
   Dashboard shell, dictation loop, mode picker, Integrations Studio, notch
   appearance, wake word, and the onboarding flow.
   ========================================================================== */

const $ = (id) => document.getElementById(id);

// `var`, not `const` — and this one keyword is load-bearing.
//
// contextBridge defines `bolo` on window as a NON-CONFIGURABLE property. The
// spec (GlobalDeclarationInstantiation -> HasRestrictedGlobalProperty) makes a
// top-level let/const whose name matches a non-configurable global property a
// SyntaxError *at parse time*, which kills the entire file before a single
// statement runs: no boot, no listeners, no diagnostics, just a dead window.
// `var` is explicitly permitted to redeclare an existing global property, so it
// binds to the bridge correctly. Do not "modernise" this to const.
var bolo = window.bolo;

/* ---------------------------------------------------------------------------
   Theme
   The class on <html> is the source of truth; boot.js has already applied the
   stored value before first paint, so this only syncs the segmented control and
   handles later changes. "auto" clears the class and lets the media query win.
   ------------------------------------------------------------------------ */
function applyTheme(mode) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (mode === 'light' || mode === 'dark') root.classList.add(mode);
  for (const b of document.querySelectorAll('#themeSeg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.theme === mode));
  }
}

let themeMode = 'auto';
try {
  themeMode = localStorage.getItem('bolo.theme') || 'auto';
} catch (_) { /* storage unavailable — stay on auto */ }
applyTheme(themeMode);

for (const b of document.querySelectorAll('#themeSeg button')) {
  b.onclick = () => {
    themeMode = b.dataset.theme;
    applyTheme(themeMode);
    try { localStorage.setItem('bolo.theme', themeMode); } catch (_) {}
  };
}

/* ---------------------------------------------------------------------------
   Frameless window chrome
   ------------------------------------------------------------------------ */
bolo.getPlatform().then(({ platform }) => {
  document.documentElement.dataset.platform = platform;
  $('titlebar').dataset.platform = platform;
  // macOS draws its own traffic lights via titleBarStyle; hide ours so there
  // aren't two sets of controls.
  if (platform === 'darwin') $('windowControls').hidden = true;
});

$('winMin').onclick = () => bolo.windowMinimize();
$('winMax').onclick = () => bolo.windowMaximizeToggle();
$('winClose').onclick = () => bolo.windowClose();

/* ---------------------------------------------------------------------------
   Toasts
   ------------------------------------------------------------------------ */
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, 2400);
}

/* ---------------------------------------------------------------------------
   Views
   ------------------------------------------------------------------------ */
// `fromBroadcast` is load-bearing. This function tells the main process which
// view is showing, main echoes it back on `bolo:view`, and this function is
// that channel's handler — so without the flag every click re-enters forever.
// The loop was invisible and ruinous: each pass re-added `.active`, restarting
// the `fadeUp` animation (the flicker), and reset `main.scrollTop` to 0, which
// made the content pane impossible to scroll because something was resetting
// it thousands of times a second. It also saturated the main process, which is
// why the notch stopped appearing and LCP went through the roof.
function setView(name, fromBroadcast) {
  for (const b of document.querySelectorAll('.nav')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === 'view-' + name);
  }
  $('main').scrollTop = 0;
  if (!fromBroadcast) bolo.setView(name);
}

for (const b of document.querySelectorAll('.nav')) {
  b.onclick = () => setView(b.dataset.view);
}
bolo.on('bolo:view', (v) => setView(v, true));

/* ---------------------------------------------------------------------------
   Dashboard

   The reference's home screen, re-authored against its own numbers: one card
   per activation key carrying the key that is actually bound, and a 340×236
   card rail of real sessions. Nothing here is a mock-up — the chips come from
   the live bindings and the cards from the local history, so a rebound key or
   an empty history shows up as itself rather than as a placeholder.

   Deliberately absent: the reference's subscription meter, referral card and
   affiliate card. bolo has no paywall, so there is nothing to put in them.
   ------------------------------------------------------------------------ */
const HOME_ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="2.6" width="6" height="11.4" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6V21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20.2l4.2-1.1L18.8 8.5a2.2 2.2 0 0 0-3.1-3.1L5.1 16z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.2l1.9 5.4 5.4 1.9-5.4 1.9L12 17.8l-1.9-5.4L4.7 10.5l5.4-1.9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
};

// The three activation keys, in the reference's card shape. Its own copy is
// "Hold <keys> in any text field" / "to ask"; bolo has three real modes, so
// each card names what its key does rather than inventing an "Ask" mode that
// no key opens.
const HOME_MODES = [
  { mode: 'dictation', label: 'Dictation', icon: 'mic', tail: 'in any text field' },
  { mode: 'edit', label: 'Edit', icon: 'pen', tail: 'on what you selected' },
  { mode: 'agent', label: 'Agent', icon: 'spark', tail: 'to carry it out' }
];

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

// "Good evening, Pratham" — the reference's greeting, with the name the setup
// flow already collected. Falls back to the bare greeting rather than printing
// "undefined" at someone who skipped that step.
function greetingText(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const who = String(name || '').trim();
  return who ? part + ', ' + who : part;
}

function renderHomeCards() {
  const host = $('homeQuick');
  if (!host) return;
  host.textContent = '';
  for (const m of HOME_MODES) {
    const card = mk('div', 'mcard');
    const head = mk('h4');
    head.insertAdjacentHTML('beforeend', HOME_ICON[m.icon] || '');
    head.append(document.createTextNode(m.label));
    card.append(head);

    const row = mk('div', 'mrow');
    row.append(mk('span', 'txt', 'Hold'));
    const keys = mk('div', 'keys');
    const parts = accelParts(keyForMode(m.mode));
    parts.forEach((p, i) => {
      if (i) keys.append(mk('span', 'kplus', '+'));
      keys.append(mk('span', 'kcap', prettyAccel(p)));
    });
    row.append(keys, mk('span', 'txt', m.tail));
    card.append(row);
    host.append(card);
  }
}

// The rail's edge fades. The reference computes them from the scroll position
// (~56px of smoothstep at whichever edge has more behind it); this is the same
// idea from the same signal. Called on scroll and on every re-render, because a
// rail that fits entirely must show no fade at all.
function paintRailEdges() {
  const rail = $('homeRail');
  if (!rail) return;
  const max = rail.scrollWidth - rail.clientWidth;
  const atStart = rail.scrollLeft <= 1;
  const atEnd = rail.scrollLeft >= max - 1;
  const overflows = max > 2;
  rail.classList.toggle('at-start', atStart);
  rail.classList.toggle('at-end', atEnd);
  rail.classList.toggle('fade-left', overflows && !atStart);
  rail.classList.toggle('fade-right', overflows && !atEnd);
}

async function renderHomeRail() {
  const rail = $('homeRail');
  if (!rail) return;
  let items = [];
  try { items = (await bolo.historyList(24)) || []; } catch (_) { items = []; }
  rail.textContent = '';

  if (!items.length) {
    rail.append(mk('div', 'rail-empty',
      'No sessions yet. Hold your Dictation key and speak — your words land wherever the cursor is.'));
    paintRailEdges();
    return;
  }

  for (const it of items) {
    const card = mk('div', 'scard');
    // The router's own label for the utterance (insert / edit / ask / act), so
    // the card says what bolo decided the words were for.
    card.append(mk('span', 'tag', String(it.kind || 'session')));
    card.append(mk('div', 'body', it.text || ''));
    const foot = mk('div', 'foot');
    foot.append(mk('span', null, fmtTime(it.at)));
    if (it.result) foot.append(mk('span', 'act', 'rewritten'));
    card.append(foot);
    rail.append(card);
  }
  rail.scrollLeft = 0;
  paintRailEdges();
}

async function renderDash() {
  if (!$('view-dashboard')) return;
  const greet = $('homeGreeting');
  if (greet && !greet.dataset.named) {
    // Read the name once. It cannot change while the dashboard is up, and a
    // second read would overwrite the greeting with the same string mid-fade.
    greet.dataset.named = '1';
    let first = '';
    try {
      const ob = await bolo.obGet();
      first = (ob && ob.data && ob.data.firstName) || '';
    } catch (_) { first = ''; }
    greet.textContent = greetingText(first);
  }
  renderHomeCards();
  await renderHomeRail();
}

$('homeRail').addEventListener('scroll', paintRailEdges, { passive: true });
window.addEventListener('resize', paintRailEdges);

// The keys and the session list both change under the dashboard: a rebinding
// re-renders the chips, and the end of a session adds a card. bolo:voice fires
// on both edges of a session, so it covers the new card; the echo is cheap.
bolo.on('bolo:voice', () => { renderDash().catch(() => {}); });

/* ---------------------------------------------------------------------------
   Waveform
   ------------------------------------------------------------------------ */
const WAVE_W = 960;
const WAVE_H = 128;
const canvas = $('wave');
const ctx = canvas.getContext('2d');

let level = 0;          // 0..1, driven by the mic
let smoothed = 0;       // eased value so bars don't jitter
let phase = 0;          // travels the envelope so the bar field feels alive
let listening = false;
let processing = false;

function draw() {
  const bars = 56;
  const gap = 3;
  const barW = (WAVE_W - gap * (bars - 1)) / bars;
  const mid = WAVE_H / 2;

  if (listening) {
    smoothed += (level - smoothed) * 0.22;
  } else {
    smoothed += (0 - smoothed) * 0.08;
  }
  phase += listening ? 0.16 : 0.04;

  ctx.clearRect(0, 0, WAVE_W, WAVE_H);

  const accent = processing
    ? '37, 99, 235'
    : listening
      ? '22, 163, 74'
      : '120, 120, 128';

  for (let i = 0; i < bars; i++) {
    // A travelling envelope over a resting baseline, scaled by mic level.
    const wave = Math.sin(phase + i * 0.32) * 0.5 + 0.5;
    const rest = listening ? 6 : 4;
    const h = rest + wave * smoothed * (WAVE_H - 26);

    const x = i * (barW + gap);
    const alpha = listening || processing ? 0.35 + wave * 0.55 : 0.22;
    ctx.fillStyle = `rgba(${accent}, ${alpha.toFixed(3)})`;

    const r = Math.min(barW / 2, 3);
    const y = mid - h / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, h, r);
    ctx.fill();
  }

  requestAnimationFrame(draw);
}
draw();

/* ---------------------------------------------------------------------------
   Modes
   Four entry points into one state machine; see src/main/modes.js.
   ------------------------------------------------------------------------ */
const STATE_LABEL = {
  idle: 'Idle',
  listening: 'Listening',
  // voice.js routes under the state name `routing`, which was missing from this
  // map — so the pill dropped to "Idle" at exactly the moment the app was
  // busiest, which is the moment a demo most needs to look alive.
  routing: 'Thinking',
  processing: 'Processing',
  error: 'Error'
};

// There is no "current mode" any more. The words themselves say what they were
// for, and the router in the main process decides (src/main/intent.js) — so the
// only binding this file tracks is the one voice key.
const DEFAULT_SHORTCUT = 'Control+Shift+D';
let voiceKey = DEFAULT_SHORTCUT;
let voiceBlurb = 'Speak, and bolo works out what you meant.';

// The other two activation keys. Each drives a distinct mode (Edit rewrites the
// selection, Agent carries the instruction out), so onboarding and Settings can
// show and rebind all three. Populated from voiceInfo().modeShortcuts.
let editKey = 'Control+Shift+E';
let agentKey = 'Control+Shift+A';

// Pull the live edit/agent bindings out of a voiceInfo() payload. `bound` is
// what actually got registered (a fallback if the requested chord was taken);
// that is the key the user presses, so it is the one shown and matched.
function captureModeKeys(info) {
  const list = (info && info.modeShortcuts) || [];
  for (const m of list) {
    const key = m.bound || m.requested;
    if (!key) continue;
    if (m.id === 'edit') editKey = key;
    else if (m.id === 'agent') agentKey = key;
  }
}

// The bound key for a given mode, for the onboarding key-check cards.
function keyForMode(mode) {
  if (mode === 'edit') return editKey;
  if (mode === 'agent') return agentKey;
  return voiceKey || DEFAULT_SHORTCUT;
}

// Key labels come from the shared formatter, so one binding reads "Ctrl + A" on
// Windows and "⌘ + A" on macOS without a branch here. src/shared/keylabel.js.
const Keys = window.BoloKeys;

function prettyAccel(a) {
  return Keys ? Keys.label(a) : String(a || '');
}

// The same split the formatter uses, for the places that lay out a binding as
// separate chips rather than one string.
function accelParts(a) {
  return Keys ? Keys.parts(a) : String(a || '').split('+').map((s) => s.trim()).filter(Boolean);
}

// The blurb, the key and the tail are three separate nodes so re-rendering the
// sentence never destroys the element the shortcut readout lives in.
function renderVoiceBlurb() {
  $('voiceBlurbText').textContent = 'Press';
  $('hkHint').textContent = prettyAccel(voiceKey);
  $('voiceBlurbTail').textContent = ' to start, and again to stop. ' + voiceBlurb;
}

// One key means one row, but it is still a function: a rebind from anywhere (the
// reset button, a rejected accelerator falling back) has to rebuild the input,
// which holds its own copy of the binding.
async function renderVoiceShortcut() {
  const info = (await bolo.voiceInfo()) || {};
  if (info.voice) {
    voiceKey = info.voice.shortcut || voiceKey;
    voiceBlurb = info.voice.blurb || voiceBlurb;
  }
  if (info.shortcut) voiceKey = info.shortcut;
  captureModeKeys(info);

  const host = $('voiceShortcuts');
  host.innerHTML = '';
  host.append(shortcutRow({
    id: (info.voice && info.voice.id) || 'voice',
    label: 'Voice',
    desc: 'One key for everything. Say what you want and it is filed for you.',
    value: voiceKey,
    onSave: (acc) => bolo.setVoiceShortcut(acc)
  }));

  host.append(activationModeRow(info));

  // Shown pretty, stored raw. The input is what the user reads, so it gets
  // "Ctrl + Shift + V"; the accelerator the main process needs is kept on the
  // element itself and is what gets sent back on Apply.
  const paste = $('pasteLastInput');
  paste.dataset.raw = info.pasteLastShortcut || '';
  paste.value = prettyAccel(paste.dataset.raw);
  paste.oninput = () => { paste.dataset.raw = ''; };
  renderVoiceBlurb();
}

/* ---------------------------------------------------------------------------
   Dictation state
   ------------------------------------------------------------------------ */
function setVoiceState(state) {
  const s = STATE_LABEL[state] ? state : 'idle';

  $('talkBtn').className = 'pill-large ' + s;

  listening = s === 'listening';
  processing = s === 'processing';
  if (!listening) level = 0;

  $('pillMini').className = 'dot ' +
    (s === 'listening' ? 'live' : s === 'processing' ? 'busy' : 'idle');

  $('voiceState').textContent = STATE_LABEL[s];
}

function showTranscript(t) {
  const box = $('transcriptBox');
  const text = t && typeof t === 'object' ? t.text : t;
  if (text) {
    box.textContent = text;
    box.classList.remove('is-empty');
  } else {
    box.textContent = 'Your transcript will appear here.';
    box.classList.add('is-empty');
  }
}

$('talkBtn').onclick = async () => {
  setVoiceState('processing');
  try {
    // No mode argument: the router decides. See src/main/intent.js.
    const r = await bolo.voiceToggle();
    setVoiceState(r.state);
    if (r.transcript) showTranscript(r.transcript);
    if (r.answer && !r.answer.ok) toast('Model: ' + r.answer.error);
    else if (r.transcript && r.transcript.mode === 'passthrough-external') {
      toast('External STT owns transcription');
    } else if (r.injected) toast('Pasted into the focused app');
    await refreshHistory();
  } catch (err) {
    const pill = $('talkBtn');
    pill.classList.add('shake');
    setTimeout(() => pill.classList.remove('shake'), 320);
    toast('Dictation failed: ' + err.message);
    setVoiceState('idle');
  }
};

bolo.on('bolo:voice-state', (s) => {
  setVoiceState(s.state);
  // A shortcut firing is what drives this event, so it doubles as the
  // onboarding "your key works" signal.
  lightKeyTest();
  if (demoLive) demoLive.state(s.state);
});
bolo.on('bolo:voice-level', (p) => {
  level = p.level || 0;
  if (demoLive) demoLive.level(level);
});
bolo.on('bolo:transcript', (t) => {
  showTranscript(t);
  if (demoLive && t && t.text) demoLive.heard(t.text);
});
bolo.on('bolo:voice', (p) => {
  if (!p) return;
  if (p.voice) {
    voiceKey = p.voice.shortcut || voiceKey;
    voiceBlurb = p.voice.blurb || voiceBlurb;
  }
  if (p.shortcut) voiceKey = p.shortcut;
  captureModeKeys(p);
  renderVoiceBlurb();
  // The Settings row keeps its own copy of the binding in an input, so it has to
  // be rebuilt when the key changes anywhere else.
  if ($('voiceShortcuts')) renderVoiceShortcut();
});

// What the router made of the utterance. It arrives after the transcript is
// already on screen, so it annotates rather than replaces — a misread is worth
// seeing, not worth hiding.
bolo.on('bolo:intent', (p) => {
  if (!p || !p.intent) return;
  const tag = $('intentTag');
  if (tag) {
    tag.textContent = p.label || p.intent;
    tag.dataset.intent = p.intent;
    tag.hidden = false;
  }
  if (demoLive) demoLive.intent(p.label || p.intent, p.intent);
});

// During the dictation/edit demo steps a voice result is routed back to the
// dashboard's own textarea instead of being pasted into whatever app has focus.
// main.js sets the flag; voice.js emits this on the shared broadcast channel.
bolo.on('bolo:ob-demo-result', async (payload) => {
  if (!payload || !demoLive) return;
  const { text, intent } = payload;
  const t = String(text || '');
  demoLive.heard(t);
  demoLive.state('idle');
  demoLive.intent(intent === 'edit' ? 'Rewrote' : 'Typed', intent || 'insert');

  // Dictation: append the spoken text to the textarea so the user sees their words
  // accumulate there, not just in the "heard" line.
  // Edit: replace the selected text with the rewritten text.
  if (intent === 'insert') {
    const ta = $('obDictationTextarea');
    if (ta && ta.isConnected) {
      ta.value = ta.value + t;
      ta.scrollTop = ta.scrollHeight;
    }
    if (obState) await bolo.obSet({ dictationDemoText: ta ? ta.value : t });
  } else if (intent === 'edit') {
    const ta = $('obEditTextarea');
    if (ta && ta.isConnected && t) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + t + ta.value.slice(end);
    }
  }
});

// When the user presses a mode key during the three_modes_keys step, mark that
// key as tested so the card lights and Continue can enable. The event fires on
// key press (before recording), so the chip responds immediately.
bolo.on('bolo:mode', (payload) => {
  if (!obState || obState.step !== 'three_modes_keys') return;
  const m = payload && payload.mode;
  const field = { dictation: 'dictationTriggerTested', edit: 'editTriggerTested', agent: 'agentTriggerTested' }[m];
  if (!field) return;
  bolo.obSet({ [field]: true }).then((s) => { obState = s; renderOb(); });
});

/* ---------------------------------------------------------------------------
   Paste last transcript
   ------------------------------------------------------------------------ */
$('pasteLastBtn').onclick = async () => {
  const r = await bolo.pasteLast();
  toast(r && r.ok ? 'Pasted the previous transcript' : 'Nothing to paste yet');
};

/* ---------------------------------------------------------------------------
   History
   ------------------------------------------------------------------------ */
function fmtTime(at) {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

async function refreshHistory() {
  const items = (await bolo.historyList(50)) || [];
  const list = $('histList');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<div class="empty">No sessions yet. Press the pill and start talking.</div>';
    return;
  }

  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.animationDelay = Math.min(i * 25, 300) + 'ms';

    const main = document.createElement('div');
    main.className = 'list-row-main';

    const title = document.createElement('div');
    title.className = 'list-row-title';
    title.textContent = it.text || it.kind || 'Entry';

    const meta = document.createElement('div');
    meta.className = 'list-row-meta';
    meta.textContent = (it.kind ? it.kind + ' · ' : '') + fmtTime(it.at);

    main.append(title, meta);
    row.append(main);
    list.append(row);
  });
}

$('histBtn').onclick = refreshHistory;
$('histClear').onclick = async () => {
  await bolo.historyClear();
  toast('History cleared');
  refreshHistory();
};

/* ---------------------------------------------------------------------------
   Customize — dictionary (local for now; the store moves to SQLite later)
   ------------------------------------------------------------------------ */
const DICT_KEY = 'bolo.dictionary';

function readDictionary() {
  try {
    return JSON.parse(localStorage.getItem(DICT_KEY) || '[]');
  } catch (_) {
    return [];
  }
}

function writeDictionary(words) {
  try { localStorage.setItem(DICT_KEY, JSON.stringify(words)); } catch (_) {}
}

function renderDictionary() {
  const words = readDictionary();
  const list = $('dictList');
  list.innerHTML = '';

  if (!words.length) {
    list.innerHTML = '<div class="empty">No words added yet.</div>';
    return;
  }

  words.forEach((w, i) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.animationDelay = Math.min(i * 25, 300) + 'ms';

    const main = document.createElement('div');
    main.className = 'list-row-main';

    const title = document.createElement('div');
    title.className = 'list-row-title';
    title.textContent = w;
    main.append(title);

    const rm = document.createElement('button');
    rm.className = 'btn btn-sm btn-ghost';
    rm.textContent = 'Remove';
    rm.onclick = () => {
      writeDictionary(readDictionary().filter((x) => x !== w));
      renderDictionary();
    };

    row.append(main, rm);
    list.append(row);
  });
}

function addDictionaryWord(word) {
  const w = String(word || '').trim();
  if (!w) return false;
  const words = readDictionary();
  if (words.includes(w)) return false;
  words.push(w);
  writeDictionary(words);
  renderDictionary();
  return true;
}

$('dictAdd').onclick = () => {
  const input = $('dictInput');
  if (addDictionaryWord(input.value)) {
    toast('Added “' + input.value.trim() + '”');
    input.value = '';
  } else if (input.value.trim()) {
    toast('Already in your dictionary');
  }
};
$('dictInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('dictAdd').click();
});
renderDictionary();

/* ---------------------------------------------------------------------------
   Replacements
   Unlike the dictionary, this list lives in the main process rather than in
   localStorage: it has to be applied to the transcript there, before the router
   reads the words, and a renderer-side copy could drift from the one that is
   actually doing the work.
   ------------------------------------------------------------------------ */
let replacements = [];

async function writeReplacements(next) {
  const r = await bolo.replacementsSet(next);
  replacements = (r && r.list) || [];
  return replacements;
}

function renderReplacements() {
  const list = $('repList');
  list.innerHTML = '';

  if (!replacements.length) {
    list.innerHTML = '<div class="empty">No replacements yet.</div>';
    return;
  }

  replacements.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.animationDelay = Math.min(i * 25, 300) + 'ms';

    const main = document.createElement('div');
    main.className = 'list-row-main';
    const title = document.createElement('div');
    title.className = 'list-row-title';
    title.textContent = r.from + '  →  ' + (r.to || '(nothing)');
    main.append(title);

    const rm = document.createElement('button');
    rm.className = 'btn btn-sm btn-ghost';
    rm.textContent = 'Remove';
    rm.onclick = async () => {
      await writeReplacements(replacements.filter((_, j) => j !== i));
      renderReplacements();
    };

    row.append(main, rm);
    list.append(row);
  });
}

async function addReplacement() {
  const from = $('repFrom').value.trim();
  const to = $('repTo').value.trim();
  if (!from) {
    toast('Nothing to replace — fill in the “say” box');
    return;
  }
  if (replacements.some((r) => r.from.toLowerCase() === from.toLowerCase())) {
    toast('“' + from + '” already has a replacement');
    return;
  }
  await writeReplacements([...replacements, { from, to }]);
  $('repFrom').value = '';
  $('repTo').value = '';
  renderReplacements();
  toast('“' + from + '” will be written as “' + (to || 'nothing') + '”');
}

$('repAdd').onclick = addReplacement;
for (const id of ['repFrom', 'repTo']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addReplacement(); });
}

/* ---------------------------------------------------------------------------
   The sidebar logotype
   Drawn rather than set in the UI font: the mark's filled disc before the
   trailing "s" is the whole identity, and a font can never produce it. If
   wordmark.js failed to load the name still reads, just as plain text.
   ------------------------------------------------------------------------ */
if ($('brand')) {
  if (window.boloWordmark) {
    $('brand').innerHTML = window.boloWordmark.svg({
      className: 'brand-wordmark',
      label: 'bolo'
    });
  } else {
    $('brand').textContent = 'bolo';
  }
}

/* ---------------------------------------------------------------------------
   Private mode
   ------------------------------------------------------------------------ */
const PRIVATE_KEY = 'bolo.privateMode';

function readPrivateMode() {
  try { return localStorage.getItem(PRIVATE_KEY) === '1'; } catch (_) { return false; }
}

function privateSwitchInit() {
  const on = readPrivateMode();
  const el = $('privateToggle');
  el.setAttribute('aria-checked', String(on));
  el.onclick = () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    try { localStorage.setItem(PRIVATE_KEY, next ? '1' : '0'); } catch (_) {}
    toast(next ? 'Private mode on — nothing is stored' : 'Private mode off');
  };
}

/* ---------------------------------------------------------------------------
   Settings — switches
   ------------------------------------------------------------------------ */
function bindSwitch(el, initial, onChange, msgOn, msgOff) {
  let on = !!initial;
  el.setAttribute('aria-checked', String(on));
  el.onclick = async () => {
    on = !on;
    el.setAttribute('aria-checked', String(on));
    await onChange(on);
    if (msgOn || msgOff) toast(on ? msgOn : msgOff);
  };
  return {
    set(v) {
      on = !!v;
      el.setAttribute('aria-checked', String(on));
    }
  };
}

/* ---------------------------------------------------------------------------
   Settings — model backend and keys

   Two providers, one list. `#keyProvider` names the provider that Add, Rotate
   and Clear act on; the list underneath always shows both, because a key you
   cannot see is a key you cannot tell is missing — and a missing Deepgram key
   looks exactly like the voice being broken.
   ------------------------------------------------------------------------ */
const PROVIDER_LABEL = { groq: 'Groq', deepgram: 'Deepgram' };
const PROVIDER_PLACEHOLDER = { groq: 'gsk_…', deepgram: 'Deepgram API key' };
const PROVIDER_HELP = {
  groq: 'Add a Groq key to enable transcription and the model.',
  deepgram: 'Add a Deepgram key to enable the spoken voice.'
};

// Held so the `bolo:keys` listener below can keep the speaker switch in step
// with the intro's own sound button, which writes the same setting.
let ttsSwitch = null;
let soundsSwitch = null;

function currentProvider() {
  const sel = $('keyProvider');
  return (sel && sel.value) || 'groq';
}

async function refreshKeys() {
  const r = await bolo.keysList();
  const active = currentProvider();

  $('groqBox').textContent = r.count
    ? r.count + (r.count === 1 ? ' key' : ' keys') + ' · ' + r.model
    : 'No keys added yet · ' + r.model;

  // The field follows the provider, so it never asks for a gsk_ key while
  // Deepgram is selected.
  $('keyInput').placeholder = PROVIDER_PLACEHOLDER[active] || 'Key';

  const list = $('keyList');
  list.innerHTML = '';

  const providers = r.providers || {};
  const names = Object.keys(providers);
  if (!names.length) {
    list.innerHTML = '<div class="list-empty">No key store — settings could not be read.</div>';
    return;
  }

  for (const name of names) {
    const info = providers[name] || { keys: [], count: 0 };

    const head = document.createElement('div');
    head.className = 'list-head';
    head.textContent = (PROVIDER_LABEL[name] || name) + ' · ' +
      (info.count ? info.count + (info.count === 1 ? ' key' : ' keys') : 'none');
    list.append(head);

    if (!info.count) {
      const none = document.createElement('div');
      none.className = 'list-empty';
      none.textContent = PROVIDER_HELP[name] || 'No keys.';
      list.append(none);
      continue;
    }

    for (const k of info.keys) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.animationDelay = Math.min(k.index * 25, 300) + 'ms';

      const main = document.createElement('div');
      main.className = 'list-row-main';

      const title = document.createElement('div');
      title.className = 'list-row-title';
      title.textContent = k.masked;

      const meta = document.createElement('div');
      meta.className = 'list-row-meta';
      meta.textContent = k.active ? 'Active' : 'Standby';
      main.append(title, meta);

      const rm = document.createElement('button');
      rm.className = 'btn btn-sm btn-ghost';
      rm.textContent = 'Remove';
      rm.onclick = async () => {
        // The provider is passed explicitly: the list shows both, so the index
        // alone would remove the right key from the wrong store.
        await bolo.keysRemove(k.index, name);
        refreshKeys();
      };

      row.append(main, rm);
      list.append(row);
    }
  }
}

$('keyProvider').onchange = () => refreshKeys();

// One render per change, driven by main's broadcast rather than by each handler.
// The handlers used to re-render themselves *and* receive this, which replayed
// every row's fade-in a second time and read as a flicker.
bolo.on('bolo:keys', (r) => {
  if (!r) return;
  // The speaker switch is in the same payload, so it stays honest if the intro's
  // own sound button is what changed it.
  if (r.ttsEnabled != null && ttsSwitch) ttsSwitch.set(r.ttsEnabled);
  refreshKeys();
});

// Preferences changed somewhere else — most often the setup pages' speaker
// button, which writes the same `interactionSounds`. `set` only repaints; it
// does not call back into main, so this cannot echo.
bolo.on('bolo:prefs', (p) => {
  if (!p) return;
  if (p.ttsEnabled != null && ttsSwitch) ttsSwitch.set(p.ttsEnabled);
  if (p.interactionSounds != null && soundsSwitch) soundsSwitch.set(p.interactionSounds);
});

$('keyAdd').onclick = async () => {
  const v = $('keyInput').value.trim();
  if (!v) return;
  const p = currentProvider();
  const r = await bolo.keysAdd(v, p);
  $('keyInput').value = '';
  toast(r.ok ? (PROVIDER_LABEL[p] || p) + ' key added' : 'Key rejected: ' + r.error);
};
$('keyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('keyAdd').click();
});
$('keyRotate').onclick = async () => {
  const p = currentProvider();
  await bolo.keysRotate(p);
  toast('Rotated the ' + (PROVIDER_LABEL[p] || p) + ' key');
};
$('keyClear').onclick = async () => {
  const p = currentProvider();
  await bolo.keysClear(p);
  toast('Cleared every ' + (PROVIDER_LABEL[p] || p) + ' key');
};
$('groqTest').onclick = async () => {
  $('groqBox').textContent = 'Testing…';
  const r = await bolo.groqTest();
  const ok = r && (r.ok || r.content || r.text);
  $('groqBox').textContent = ok ? 'Model responded — ready' : 'Test failed: ' + JSON.stringify(r);
  toast(ok ? 'Model is reachable' : 'Model test failed');
};
$('modelSave').onclick = async () => {
  const r = await bolo.setModel($('modelInput').value.trim());
  toast('Model set to ' + r.model);
  refreshKeys();
};

/* ---------------------------------------------------------------------------
   Settings — listening and speaking

   Three controls, all of which make a real call when you press Test. A live
   check is the only kind worth having here: "reachable" can be true while
   transcription or speech is broken, which is the failure a user would
   actually hit.
   ------------------------------------------------------------------------ */
let voiceCatalogue = null;

// Fills the picker from main's catalogue rather than from a copy kept here, so
// the list in Settings cannot drift from the list of voices Deepgram serves.
async function refreshVoices() {
  const sel = $('ttsVoiceSel');
  if (!sel) return null;

  const r = await bolo.ttsVoices();
  voiceCatalogue = r;

  const groups = r.families || [];
  const byFamily = new Map(groups.map((f) => [f.id, []]));
  for (const v of r.voices || []) {
    if (!byFamily.has(v.family)) byFamily.set(v.family, []);
    byFamily.get(v.family).push(v);
  }

  sel.innerHTML = '';
  for (const [id, list] of byFamily) {
    if (!list.length) continue;
    const meta = groups.find((f) => f.id === id);
    const group = document.createElement('optgroup');
    group.label = meta ? meta.label + ' — ' + meta.note : id;
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      // The gender is in the label because it is the thing a person is actually
      // choosing between, and it is not guessable from "Sienna" or "Orion".
      o.textContent = v.label + ' — ' + v.gender;
      o.title = v.desc || '';
      group.append(o);
    }
    sel.append(group);
  }
  sel.value = r.current || '';

  const current = (r.voices || []).find((v) => v.id === r.current);
  $('ttsBox').textContent = current
    ? current.label + ' · ' + current.gender + ' · ' + current.desc
    : 'No voice selected.';
  return r;
}

/* ---------------------------------------------------------------------------
   The microphone

   The list is built by the capture window, not here — see micOptions — because
   the device *names* only exist for a page Chromium has granted the microphone
   to, and that is the only window that ever is. Settings and onboarding both
   read this one list, so the two cannot offer different microphones.

   The saved choice is `micDeviceId`, which main hands to the capture window on
   every open. An empty id is not the absence of a choice — it means "follow the
   system default", which is what makes a headset take over the moment it is
   plugged in.
   ------------------------------------------------------------------------ */
async function micOptions() {
  const r = await bolo.micDevices();
  const devices = (r && r.devices) || [];
  const opts = [{ id: '', label: 'System default' }];
  for (const d of devices) opts.push({ id: d.id, label: d.label });
  return { opts, devices, error: (r && r.error) || '', labels: !!(r && r.labels) };
}

function micNote(wanted, devices) {
  if (!wanted) {
    // Naming what Windows currently resolves to is the point, not decoration.
    // A machine with a virtual audio cable installed has *that* as its default
    // recording device — silent, or picking up whatever is playing into it —
    // and "it only ever hears a word or two" is precisely what that sounds like.
    // Showing the resolved name turns a mystery into a two-second fix.
    const d = devices.find((x) => x.id === 'default');
    const name = d ? String(d.label).replace(/^Default\s*[-–]\s*/i, '') : '';
    return name
      ? 'Follows Windows — currently ' + name + '.'
      : 'Follows Windows, so headphones take over the moment they are plugged in.';
  }
  const chosen = devices.find((d) => d.id === wanted);
  if (chosen) return 'Listening on ' + chosen.label + '.';
  // Named rather than hidden: the stored id is deliberately kept while the
  // device is away, so re-plugging it restores the choice.
  return 'That microphone is not connected right now — the system default is used until it is back.';
}

// Fill a <select> with the list, keeping a saved-but-absent device as an option.
// Without that the select would silently snap to the default while the store
// still held the old id, so the pane and the setting would disagree.
function fillMicSelect(sel, wanted, opts, devices) {
  sel.innerHTML = '';
  for (const o of opts) sel.append(new Option(o.label, o.id));
  if (wanted && !devices.some((d) => d.id === wanted)) sel.append(new Option('(not connected)', wanted));
  sel.value = wanted;
}

async function refreshMics() {
  const sel = $('micSel');
  if (!sel) return;
  const s = await bolo.getSettings();
  const wanted = s.micDeviceId || '';
  const { opts, devices } = await micOptions();
  fillMicSelect(sel, wanted, opts, devices);
  const box = $('micBox');
  if (box) box.textContent = micNote(wanted, devices);
}

$('micSel').onchange = async () => {
  const id = $('micSel').value;
  const r = await bolo.setPref('micDeviceId', id);
  if (!r || !r.ok) {
    // Put the picker back where the store still is, rather than leaving it
    // showing a microphone the app did not accept.
    await refreshMics();
    toast('Could not save that microphone');
    return;
  }
  await refreshMics();
  toast('Microphone set to ' + (($('micSel').selectedOptions[0] || {}).textContent || 'the system default'));
};

$('micTest').onclick = async () => {
  const btn = $('micTest');
  const was = btn.textContent;
  const name = ($('micSel').selectedOptions[0] || {}).textContent || 'the system default';

  btn.disabled = true;
  btn.textContent = 'Recording…';
  $('micBox').textContent = 'Listening on ' + name + ' — say something.';

  // Deliberately the same call the transcription row makes. It opens the device
  // that is *saved*, so this tests the picker above it rather than the model —
  // which is the whole point: "it only ever hears one word" is a question about
  // the microphone, not about Whisper.
  const r = await bolo.sttTest({ ms: 3000 });

  btn.disabled = false;
  btn.textContent = was;

  if (r && r.ok && r.text) {
    $('micBox').textContent = 'Heard: “' + r.text.trim() + '”';
    toast('That microphone is picking you up');
    return;
  }
  // A silent device is not the same failure as a device that could not be
  // opened, and the two need different answers — so they read differently.
  if (r && r.ok) {
    $('micBox').textContent = 'The microphone opened but heard nothing. Check it is not muted in Windows, and that the right one is selected above.';
    toast('No sound reached the microphone');
    return;
  }
  const why = (r && (r.hint || r.error)) || 'no answer';
  $('micBox').textContent = 'Test failed: ' + why + (r && r.stage ? ' (' + r.stage + ')' : '');
  toast('Microphone test failed — ' + why);
};

async function refreshSpeech() {
  const s = await bolo.getSettings();

  $('sttInput').value = s.sttModel || '';
  $('sttBox').textContent = s.sttModel
    ? 'Groq · ' + s.sttModel
    : 'No transcription model set.';

  ttsSwitch = bindSwitch(
    $('ttsToggle'), s.ttsEnabled,
    (on) => bolo.setTts(on),
    'Replies will be spoken', 'Replies stay silent'
  );

  // The same setting the setup pages' speaker button writes. Both controls are
  // shown because both are real: this is the master, `ttsToggle` is the reply
  // voice alone.
  const sounds = $('soundsToggle');
  if (sounds) {
    soundsSwitch = bindSwitch(
      sounds, s.interactionSounds !== false,
      (on) => bolo.setSounds(on),
      'Sound on', 'Sound off — the intro and replies stay silent'
    );
  }

  await refreshVoices();
  await refreshMics();
}

$('sttSave').onclick = async () => {
  const r = await bolo.setSttModel($('sttInput').value.trim());
  $('sttBox').textContent = 'Groq · ' + r.model;
  toast('Transcription model set to ' + r.model);
};

$('sttTest').onclick = async () => {
  const btn = $('sttTest');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Recording…';
  $('sttBox').textContent = 'Listening for three seconds — say something.';

  const r = await bolo.sttTest({ ms: 3000 });

  btn.disabled = false;
  btn.textContent = was;

  if (r && r.ok && r.text) {
    $('sttBox').textContent = 'Heard: “' + r.text.trim() + '”';
    toast('Transcription works');
    return;
  }
  const why = (r && (r.hint || r.error)) || 'no answer';
  $('sttBox').textContent = 'Test failed: ' + why +
    (r && r.stage ? ' (' + r.stage + ')' : '');
  toast('Transcription test failed — ' + why);
};

$('ttsVoiceSel').onchange = async () => {
  const r = await bolo.setTtsVoice($('ttsVoiceSel').value);
  if (!r || !r.ok) {
    // Put the picker back where it was rather than leaving it showing a voice
    // that the app did not accept.
    $('ttsVoiceSel').value = (r && r.voice) || '';
    toast('That voice is not available');
    return;
  }
  await refreshVoices();
  toast('Voice set to ' + ($('ttsVoiceSel').selectedOptions[0] || {}).textContent);
};

$('ttsTestBtn').onclick = async () => {
  const btn = $('ttsTestBtn');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Speaking…';
  $('ttsBox').textContent = 'Synthesising…';

  // The same path a reply takes, so a pass here means replies will be audible.
  const r = await window.boloAudio.say('This is how I sound when I answer you.', {
    voice: $('ttsVoiceSel').value
  });

  btn.disabled = false;
  btn.textContent = was;

  const voice = (voiceCatalogue && (voiceCatalogue.voices || [])
    .find((v) => v.id === $('ttsVoiceSel').value)) || {};
  $('ttsBox').textContent = voice.label
    ? voice.label + ' · ' + voice.gender + ' · ' + voice.desc
    : 'No voice selected.';

  if (!r.ok) {
    toast('Voice test failed — ' + (r.error || r.reason));
    return;
  }
  toast('Spoke in ' + (voice.label || 'the selected voice'));
};

/* ---------------------------------------------------------------------------
   Settings — shortcuts, one row per mode
   ------------------------------------------------------------------------ */

// Hold-to-talk vs press-to-toggle. Two buttons, the live one marked. Greyed out
// with an explanation when the native key hook could not load (holdAvailable).
function activationModeRow(info) {
  const holdOk = info.holdAvailable !== false;
  const row = document.createElement('div');
  row.className = 'setting';

  const text = document.createElement('div');
  text.className = 'setting-text';
  const l = document.createElement('div');
  l.className = 'setting-label';
  l.textContent = 'Key behaviour';
  const d = document.createElement('div');
  d.className = 'setting-desc';
  d.textContent = holdOk
    ? 'Hold to talk holds the key while you speak and sends on release. Toggle presses once to start and again to send.'
    : 'Press once to start, press again to send. Hold-to-talk needs a native key hook that could not load here.';
  text.append(l, d);

  const controls = document.createElement('div');
  controls.className = 'row';

  const holdBtn = document.createElement('button');
  holdBtn.className = 'btn btn-sm';
  holdBtn.textContent = 'Hold to talk';
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn btn-sm';
  toggleBtn.textContent = 'Toggle';

  const mark = (mode) => {
    holdBtn.classList.toggle('active', mode === 'hold');
    toggleBtn.classList.toggle('active', mode === 'toggle');
  };

  const choose = (mode) => async () => {
    const r = await bolo.setActivationMode(mode);
    if (r && r.ok) {
      mark(r.activationMode);
      toast(r.activationMode === 'hold' ? 'Hold to talk' : 'Press to toggle');
    } else {
      mark('toggle');
      toast(r && r.error === 'hold-unavailable' ? 'Hold-to-talk is not available here' : 'Could not change key behaviour');
    }
  };

  holdBtn.onclick = choose('hold');
  toggleBtn.onclick = choose('toggle');
  if (!holdOk) holdBtn.disabled = true;
  mark(info.activationMode || (holdOk ? 'hold' : 'toggle'));

  controls.append(holdBtn, toggleBtn);
  row.append(text, controls);
  return row;
}

function shortcutRow({ id, label, desc, value, onSave }) {
  const row = document.createElement('div');
  row.className = 'setting';

  const text = document.createElement('div');
  text.className = 'setting-text';
  const l = document.createElement('div');
  l.className = 'setting-label';
  l.textContent = label;
  const d = document.createElement('div');
  d.className = 'setting-desc';
  d.textContent = desc;
  text.append(l, d);

  const controls = document.createElement('div');
  controls.className = 'row';

  const input = document.createElement('input');
  input.className = 'field';
  input.style.width = '200px';
  // The field shows the binding the way a person reads it — "Ctrl + A" — not
  // the way Electron spells it — "CommandOrControl+A", which is what used to be
  // on screen. The real accelerator rides along in `dataset.raw`, so a field
  // nobody touched saves the exact binding back; only a hand-edited field is
  // taken as a raw accelerator.
  input.dataset.raw = value || '';
  input.value = prettyAccel(value);
  input.title = 'Accelerator, e.g. CommandOrControl+Shift+A';
  input.oninput = () => { input.dataset.raw = ''; };

  const status = document.createElement('span');
  status.className = 'hint';

  const save = document.createElement('button');
  save.className = 'btn btn-sm';
  save.textContent = 'Apply';
  save.onclick = async () => {
    const r = await onSave(input.dataset.raw || input.value.trim());
    if (r && r.ok) {
      // Re-render from what actually got registered, which can differ from what
      // was asked for when another app already owns the accelerator.
      input.dataset.raw = r.accelerator || '';
      input.value = prettyAccel(r.accelerator);
      status.textContent = 'Registered';
      toast(label + ' set to ' + prettyAccel(r.accelerator));
    } else {
      status.textContent = (r && r.error) || 'Failed';
      toast(label + ': ' + ((r && r.error) || 'failed'));
    }
    setTimeout(() => { status.textContent = ''; }, 2600);
  };

  controls.append(input, save, status);
  row.append(text, controls);
  row.dataset.mode = id || '';
  return row;
}

$('pasteLastSave').onclick = async () => {
  const el = $('pasteLastInput');
  const r = await bolo.setPasteLastShortcut(el.dataset.raw || el.value.trim());
  if (r && r.ok) {
    el.dataset.raw = r.accelerator || el.dataset.raw;
    el.value = prettyAccel(el.dataset.raw);
  }
  toast(r.ok ? 'Paste-last shortcut applied' : 'Failed: ' + r.error);
};
$('shortcutReset').onclick = async () => {
  await bolo.resetShortcuts();
  await renderVoiceShortcut();
  toast('Shortcuts reset to defaults');
};

/* ---------------------------------------------------------------------------
   Settings — wake word
   ------------------------------------------------------------------------ */
let wakeSwitch = null;
let wakeFiredTimer = null;

function sensLabel(v) {
  return Math.round(v * 100) + '%';
}

function wakeIdleText(state) {
  // A switch that is on and a feature that cannot work is the worst of both, so
  // the reason it cannot hear you comes before the state it is in.
  if (state.ready === false) return state.reason || 'Not available';
  return state.running
    ? 'Listening for “' + state.phrase + '”'
    : state.enabled
      ? 'Enabled but not running'
      : 'Off';
}

function paintWake(state) {
  if (!state) return;

  // A fire event carries the full settings state plus `fired`, so everything
  // below stays in sync; only the status line changes.
  $('wakeStatus').textContent = state.fired
    ? 'Heard “' + (state.phrase || '') + '” — starting'
    : wakeIdleText(state);

  if (state.fired) {
    // The line is transient: after a beat it goes back to reporting the gate.
    if (wakeFiredTimer) clearTimeout(wakeFiredTimer);
    wakeFiredTimer = setTimeout(() => {
      $('wakeStatus').textContent = wakeIdleText(state);
    }, 4000);
  }

  $('wakePhrase').value = state.phrase || '';
  $('wakeSens').value = String(Math.round((state.sensitivity || 0.6) * 100));
  $('wakeSensLabel').textContent = sensLabel(state.sensitivity || 0.6);
  if (wakeSwitch) wakeSwitch.set(state.enabled);
}

async function refreshWake() {
  paintWake(await bolo.wakeGet());
}

$('wakePhrase').addEventListener('change', async () => {
  paintWake(await bolo.wakeSet({ phrase: $('wakePhrase').value }));
});
$('wakeSens').addEventListener('input', () => {
  $('wakeSensLabel').textContent = sensLabel($('wakeSens').value / 100);
});
$('wakeSens').addEventListener('change', async () => {
  paintWake(await bolo.wakeSet({ sensitivity: $('wakeSens').value / 100 }));
});

// The test path. It runs the real clip, the real recogniser and the real match,
// and it prints what was heard — because "nothing happened" is indistinguishable
// from "it heard you and the phrase was wrong" without it.
$('wakeTest').addEventListener('click', async () => {
  const out = $('wakeTestResult');
  const btn = $('wakeTest');
  btn.disabled = true;
  out.textContent = 'Listening…';
  try {
    const r = await bolo.wakeListen();
    if (!r || !r.ok) {
      out.textContent = r && r.reason ? r.reason : 'Nothing was recorded — check the microphone.';
    } else if (r.heard) {
      out.textContent = 'Heard “' + r.heard + '” (' + Math.round((r.score || 0) * 100) + '% match)' +
        (r.matched ? ' — matched.' : ' — not close enough; try a longer phrase.');
    } else {
      out.textContent = 'Heard nothing.';
    }
  } catch (e) {
    out.textContent = 'The test failed: ' + ((e && e.message) || e);
  } finally {
    btn.disabled = false;
  }
});

bolo.on('bolo:wake', paintWake);

/* ---------------------------------------------------------------------------
   Settings — notch appearance
   ------------------------------------------------------------------------ */
let notchState = null;
const notchSwitches = {};

// Every control writes straight through on change: the notch is visible while
// you drag, so the setting and its effect should be the same event.
function notchControl(inputId, labelId, key, transform, fmt) {
  const el = $(inputId);
  if (!el) return;
  const isRange = el.type === 'range';

  const push = async () => {
    const raw = isRange ? Number(el.value) : el.value;
    const value = transform ? transform(raw) : raw;
    if (labelId && fmt) $(labelId).textContent = fmt(raw);
    notchState = await bolo.notchSet({ [key]: value });
  };

  // A range fires `input` continuously; a select only fires `change`. Listening
  // for both on both would double every write.
  el.addEventListener(isRange ? 'input' : 'change', push);
}

function paintNotch(state) {
  if (!state) return;
  notchState = state;

  if (notchSwitches.enabled) notchSwitches.enabled.set(state.enabled);
  if (notchSwitches.hover) notchSwitches.hover.set(state.showOnHover);
  if (notchSwitches.aot) notchSwitches.aot.set(state.alwaysOnTop);

  $('notchPosition').value = state.position || 'top-center';
  $('notchWidth').value = String(state.width || 286);
  $('notchWidthLabel').textContent = (state.width || 286) + 'px';
  $('notchOffsetX').value = String(state.offsetX || 0);
  $('notchOffsetXLabel').textContent = (state.offsetX || 0) + 'px';
  $('notchOffsetY').value = String(state.offsetY || 0);
  $('notchOffsetYLabel').textContent = (state.offsetY || 0) + 'px';
  $('notchOpacity').value = String(Math.round((state.opacity || 1) * 100));
  $('notchOpacityLabel').textContent = Math.round((state.opacity || 1) * 100) + '%';
  $('notchAutoHide').value = String(state.autoHideMs || 0);
  // Reads under "Collapse after a reply". At 0 the capsule does not shrink back
  // at all and stays open until it is dismissed, which is a real choice rather
  // than an off switch — the resting tab is always there regardless.
  $('notchAutoHideLabel').textContent = state.autoHideMs
    ? 'after ' + Math.round(state.autoHideMs / 1000) + 's'
    : 'stays open';

  // Variant and material are segmented controls rather than selects, so they are
  // painted by marking the matching button instead of setting a value. The side
  // control only means anything for a side notch, hence the disable.
  paintSeg('variantSeg', state.variant || 'top');
  paintSeg('materialSeg', state.material || 'solid');
  paintSeg('sideSeg', state.side || 'right');
  const sideDisabled = (state.variant || 'top') !== 'side';
  const sideSeg = $('sideSeg');
  if (sideSeg) {
    sideSeg.classList.toggle('is-disabled', sideDisabled);
    for (const b of sideSeg.querySelectorAll('button')) b.disabled = sideDisabled;
  }
  // Position is a top-notch concept; a side notch is always vertically centred.
  const posRow = $('notchPositionRow');
  if (posRow) posRow.hidden = sideDisabled;
}

function paintSeg(id, value) {
  const seg = $(id);
  if (!seg) return;
  for (const b of seg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }
}

// A segmented control that writes straight through, like the notch sliders: the
// capsule is on screen while you click, so the change and its effect should be
// the same event.
function segControl(id, key) {
  const seg = $(id);
  if (!seg) return;
  seg.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !b.dataset.value) return;
    paintSeg(id, b.dataset.value);
    notchState = await bolo.notchSet({ [key]: b.dataset.value });
    // A variant swap moves the controls that only apply to one of them, so the
    // whole pane is repainted from the authoritative state rather than patched.
    paintNotch(notchState);
  };
}

segControl('variantSeg', 'notchVariant');
segControl('materialSeg', 'notchMaterial');
segControl('sideSeg', 'notchSide');

notchControl('notchPosition', null, 'notchPosition');
notchControl('notchWidth', 'notchWidthLabel', 'notchWidth', Number, (v) => v + 'px');
notchControl('notchOffsetX', 'notchOffsetXLabel', 'notchOffsetX', Number, (v) => v + 'px');
notchControl('notchOffsetY', 'notchOffsetYLabel', 'notchOffsetY', Number, (v) => v + 'px');
notchControl('notchOpacity', 'notchOpacityLabel', 'notchOpacity', (v) => v / 100, (v) => v + '%');
notchControl(
  'notchAutoHide', 'notchAutoHideLabel', 'notchAutoHideMs',
  Number, (v) => (Number(v) ? Math.round(Number(v) / 1000) + 's' : 'Never')
);

$('notchPreview').onclick = async () => {
  await bolo.notchPreview();
};

bolo.on('bolo:notch', paintNotch);

/* ---------------------------------------------------------------------------
   Agents
   ------------------------------------------------------------------------ */
$('agentListBtn').onclick = async () => {
  const intents = (await bolo.agentList()) || [];
  const box = $('agentBox');
  box.innerHTML = '';

  if (!intents.length) {
    box.innerHTML = '<div class="empty">No intents registered.</div>';
    return;
  }

  intents.forEach((it, i) => {
    const name = typeof it === 'string' ? it : it.name || it.intent || JSON.stringify(it);
    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.animationDelay = Math.min(i * 25, 300) + 'ms';
    row.innerHTML = '<div class="list-row-main"><div class="list-row-title"></div></div>';
    row.querySelector('.list-row-title').textContent = name;
    box.append(row);
  });
};

function resultRow(label, value) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.innerHTML =
    '<div class="list-row-main"><div class="list-row-title"></div><div class="list-row-meta mono"></div></div>';
  row.querySelector('.list-row-title').textContent = label;
  row.querySelector('.list-row-meta').textContent = JSON.stringify(value);
  return row;
}

$('wfBtn').onclick = async () => {
  $('agentBox').innerHTML = '<div class="empty">Running…</div>';
  const r = await bolo.workflowRun({ steps: [{ intent: 'echo', args: { text: 'hi' } }] });
  $('agentBox').innerHTML = '';
  $('agentBox').append(resultRow('Workflow finished', r));
};

async function runCoding(fn, label) {
  const prompt = $('codePrompt').value.trim() || 'hi';
  $('agentBox').innerHTML = '<div class="empty">Handing off to ' + label + '…</div>';
  const r = await fn(prompt);
  $('agentBox').innerHTML = '';
  $('agentBox').append(resultRow(label, r));
}

$('claudeBtn').onclick = () => runCoding(bolo.codeClaude, 'Claude Code');
$('codexBtn').onclick = () => runCoding(bolo.codeCodex, 'Codex');

/* ---------------------------------------------------------------------------
   Context capture
   ------------------------------------------------------------------------ */
async function showContext(promise, label) {
  $('transcriptBox').classList.remove('is-empty');
  $('transcriptBox').textContent = 'Capturing ' + label + '…';
  const r = await promise;
  $('transcriptBox').textContent = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
}
$('ctxBtn').onclick = () => showContext(bolo.getContext(), 'context');
$('shotBtn').onclick = () => showContext(bolo.screenshot(), 'screenshot');

/* ---------------------------------------------------------------------------
   Settings bootstrap
   ------------------------------------------------------------------------ */
async function refreshSettings() {
  const s = await bolo.getSettings();

  // The shortcut readouts are owned by renderVoiceBlurb, which runs as part of
  // renderVoiceShortcut.
  $('modelInput').value = s.groqModel || '';

  bindSwitch(
    $('transToggle'), s.transcriptionEnabled,
    (on) => bolo.setTranscription(on),
    'Inbuilt transcription on', 'External STT will handle transcription'
  );
  bindSwitch($('injectToggle'), s.injectionEnabled, (on) => bolo.setInjection(on));
  bindSwitch($('duckToggle'), s.audioDucking, (on) => bolo.setDucking(on));
  bindSwitch($('autoPasteToggle'), s.autoPasteAnswers, (on) => bolo.setAutoPaste(on),
    'Answers paste themselves', 'Answers stay in the notch');
  privateSwitchInit();

  // General / Context Awareness / Extras — flat preferences, all written through
  // the one allowlisted channel. See PREF_KEYS in main.js.
  for (const [id, key] of [
    ['closeToTrayToggle', 'closeToTray'],
    ['contextToggle', 'contextAwareness'],
    ['practiceToggle', 'practiceMode'],
    ['creatorToggle', 'creatorMode']
  ]) {
    const el = $(id);
    if (el) bindSwitch(el, s[key], (on) => bolo.setPref(key, on));
  }

  // Agent permissions — what the agent may actually do on this machine. Same
  // switch component as everything else; the writer is its own channel because
  // main has to re-check the resulting set before broadcasting it (the
  // capability gate reads the same keys).
  for (const [id, key] of [
    ['agentAppsToggle', 'agentCanOpenApps'],
    ['agentShotToggle', 'agentCanScreenshot'],
    ['agentFilesToggle', 'agentCanEditFiles']
  ]) {
    const el = $(id);
    if (el) {
      bindSwitch(el, s[key], (on) => bolo.setAgentPermission(key, on));
    }
  }

  // Visibility. Each of these hides a whole surface rather than moving it, so
  // the handler re-applies through main rather than touching anything here.
  for (const [id, key] of [
    ['hidePillToggle', 'hidePill'],
    ['hideTopToggle', 'hideTopNotch'],
    ['hideSideToggle', 'hideSideNotch']
  ]) {
    const el = $(id);
    if (el) bindSwitch(el, s[key], (on) => bolo.visibilitySet({ [key]: on }));
  }

  // Launch at login is the OS's setting, not ours — it is read back from the
  // login-item API rather than from the store, so the switch tells the truth
  // even if something else changed it.
  const login = $('loginToggle');
  if (login) {
    const sw = bindSwitch(login, false, (on) => bolo.setLoginItem(on),
      'bolo will start with Windows', 'bolo will not start on its own');
    const li = await bolo.getLoginItem();
    sw.set(!!(li && li.openAtLogin));
  }

  wakeSwitch = bindSwitch($('wakeToggle'), false, (on) => bolo.wakeSet({ enabled: on }),
    'Wake word on — say the phrase to start', 'Wake word off');

  notchSwitches.enabled = bindSwitch(
    $('notchEnabled'), true, (on) => bolo.notchSet({ notchEnabled: on }),
    'Notch shown', 'Notch hidden'
  );
  notchSwitches.hover = bindSwitch($('notchShowOnHover'), false, (on) => bolo.notchSet({ notchShowOnHover: on }));
  notchSwitches.aot = bindSwitch($('notchAlwaysOnTop'), true, (on) => bolo.notchSet({ notchAlwaysOnTop: on }));

  const status = await bolo.getStatus();
  $('statusBox').textContent = 'Plan: ' + (status.planType || 'local') + ' · ' + (status.status || 'active');
  const usage = await bolo.getUsage();
  $('usageBox').textContent = usage.weeklyLimit > 0
    ? 'Usage: ' + usage.currentUsage + ' / ' + usage.weeklyLimit
    : 'Unlimited local usage';

  await renderVoiceShortcut();
  await refreshKeys();
  await refreshSpeech();
  await refreshHistory();
  await refreshWake();
  paintNotch(await bolo.notchGet());
}

$('introReplay').onclick = async () => {
  await bolo.startIntro();
  toast('Replaying the intro');
};

/* ---------------------------------------------------------------------------
   Onboarding
   The step sequence is the one in src/main/onboarding.js. Each step renders
   itself and, where the step is a real action (a key test, a connection, a
   dictionary import), it performs that action rather than only describing it.
   ------------------------------------------------------------------------ */
/* ---------------------------------------------------------------------------
   Onboarding
   The step sequence is the one in src/main/onboarding.js. The layout follows
   the reference recording: a full-window page with a thin progress bar near the
   top, a content column, and Back / Continue at the bottom corners. Most steps
   use a left column; the key-check and "ask a simple question" steps sit in a
   single centred column instead, which is what the reference does.

   Where a step is a real action (a key test, a connection, a dictionary import)
   it performs that action rather than only describing it.
   ------------------------------------------------------------------------ */
let obState = null;

const OB_LANGUAGES = [
  ['en', 'English'], ['hi', 'हिन्दी'], ['es', 'Español'], ['fr', 'Français'],
  ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['ja', '日本語'],
  ['ko', '한국어'], ['zh', '中文'], ['ar', 'العربية'], ['ru', 'Русский']
];

const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.6 4.5L19 7"/></svg>';

function obPercent() {
  if (!obState || !obState.totalSteps) return 0;
  return Math.round(((obState.stepIndex + 1) / obState.totalSteps) * 100);
}

function obEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// A live key tester: each cap lights when *its own* key goes down, so holding
// Ctrl alone lights Ctrl, pressing A alone lights A, and the chord lights both.
// Lighting the whole row on any key event read as a half-broken step when the
// user pressed the modifier by itself.
//
// Both listeners are registered once at module scope rather than per render —
// renderOb runs on every state change, and adding a listener each time would
// stack up hundreds of them over one onboarding run.
//
// `litKey.els` holds { part, el } pairs. `part` is the label the shared
// formatter printed for that cap ("Ctrl", "A"), and it is what a live event is
// normalised onto.
let litKey = null;

// Set while the key-check card is listening for a new binding; the listeners
// below hand the event to it instead of lighting caps. Declared up here because
// they are registered before the card that fills it in.
let keyCapture = null;

// A KeyboardEvent onto the token Electron's accelerators are written in, so a
// cap label ("Ctrl") and an event ("Control") can be compared as strings.
function accelTokenFor(e) {
  const raw = String((e && e.key) || '');
  const k = raw.toLowerCase();
  if (k === 'control' || k === 'ctrl') return 'Control';
  if (k === 'alt' || k === 'option') return 'Alt';
  if (k === 'shift') return 'Shift';
  if (k === 'meta' || k === 'super' || k === 'os') return 'CommandOrControl';
  if (raw === ' ') return 'Space';
  if (raw === 'Escape') return 'Esc';
  return raw.length === 1 ? raw.toUpperCase() : raw;
}

function isModifierToken(t) {
  return t === 'Control' || t === 'Alt' || t === 'Shift' || t === 'CommandOrControl';
}

// The label the formatter would print for this event — Control becomes "Ctrl"
// on Windows and "⌃" on macOS, because that is what the cap carries.
function capLabelFor(e) {
  const token = accelTokenFor(e);
  if (!token) return '';
  const p = Keys ? Keys.parts(token) : null;
  return String((p && p[0]) || token).toLowerCase();
}

// The name fields and the keyword input are live while these listeners are on
// the window, so a key typed into a field must not flash the keycaps.
function typingInField(e) {
  const el = (e && e.target) || document.activeElement;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true;
}

// With no argument the whole row lights, which is what the app's own "your key
// fired" event wants; with a part, only that cap does.
function lightKeyTest(part) {
  const pairs = ((litKey && litKey.els) || []).filter((p) => p.el && p.el.isConnected);
  if (!pairs.length) return;
  const want = part ? String(part).toLowerCase() : null;
  const hit = want ? pairs.filter((p) => String(p.part).toLowerCase() === want) : pairs;
  if (!hit.length) return;
  for (const p of hit) p.el.classList.add('lit');
  if (litKey.timer) clearTimeout(litKey.timer);
  litKey.timer = setTimeout(() => {
    for (const p of pairs) p.el.classList.remove('lit');
  }, 900);
  if (litKey.mark) litKey.mark();
}

// A keyup clears its own cap only, so a held Ctrl stays blue until it is let go.
function unlightKeyTest(part) {
  const want = String(part || '').toLowerCase();
  const pairs = ((litKey && litKey.els) || []).filter((p) => p.el && p.el.isConnected);
  for (const p of pairs) {
    if (!want || String(p.part).toLowerCase() === want) p.el.classList.remove('lit');
  }
}

window.addEventListener('keydown', (e) => {
  if (keyCapture) { keyCapture.keydown(e); return; }
  if (typingInField(e)) return;
  // An event with no key name (a dead key) maps onto nothing, and an empty
  // label would read as "light the whole row".
  const label = capLabelFor(e);
  if (label) lightKeyTest(label);
}, true);

window.addEventListener('keyup', (e) => {
  if (keyCapture) { try { keyCapture.keyup(e); } catch (_) {} return; }
  if (typingInField(e)) return;
  const label = capLabelFor(e);
  if (label) unlightKeyTest(label);
}, true);
window.addEventListener('blur', () => {
  try { if (litKey && litKey.els) for (const p of litKey.els) p.el.classList.remove('lit'); } catch (_) {}
  if (keyCapture) { try { keyCapture.cancel && keyCapture.cancel(); } catch (_) {} keyCapture = null; }
}, true);

/* ---------------------------------------------------------------------------
   The demo stage
   ---------------------------------------------------------------------------
   The reference's demo beats show the thing *happening* — in the recording, both
   "Ask a simple question" and "Do a task with your voice" land in the notch with
   a transcript running live. bolo's steps were a numbered list and nothing
   else, so pressing the key during onboarding produced no visible result on any
   surface, and the step read as broken even when the key worked perfectly.

   This renders the pipeline the way the user experiences it: it hears you, it
   works out what you meant, it does it. It is driven by the same events the
   dashboard listens to, so what plays here is what the app actually does — and it
   can also play itself, because a step that waits on a microphone which may not
   exist is not a demo either.
   ------------------------------------------------------------------------ */
let demoLive = null;

function demoStage(sample) {
  const wrap = obEl('div', 'obp-demo');

  const head = obEl('div', 'obp-demo-head');
  const dot = obEl('span', 'obp-demo-dot');
  const stateEl = obEl('span', 'obp-demo-state');
  const meter = obEl('span', 'obp-demo-meter');
  const bar = obEl('i');
  meter.append(bar);
  head.append(dot, stateEl, meter);

  const heard = obEl('p', 'obp-demo-heard');
  const trail = obEl('div', 'obp-demo-trail');
  trail.hidden = true;

  const foot = obEl('div', 'obp-demo-foot');
  const play = obEl('button', 'obp-link strong', 'Play demo');
  play.type = 'button';
  foot.append(play);

  wrap.append(head, heard, trail, foot);

  let playing = false;
  const timers = [];

  const clearTimers = () => { while (timers.length) clearTimeout(timers.pop()); };
  const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };

  const paint = (text, cls) => {
    stateEl.textContent = text;
    dot.className = 'obp-demo-dot' + (cls ? ' ' + cls : '');
    meter.classList.toggle('on', cls === 'live');
  };

  const idle = () => {
    playing = false;
    clearTimers();
    heard.textContent = 'Press your key and say something.';
    heard.classList.add('muted');
    trail.hidden = true;
    trail.textContent = '';
    paint('Ready when you are', '');
  };

  const say = (text) => {
    heard.textContent = text;
    heard.classList.remove('muted');
  };

  // Reveal text letter-by-letter into the "heard" line, the same feel as the
  // notch and the intro. Every step is a scheduled timer so clearTimers() stops
  // a reveal a real key press has superseded. Returns the total run length so the
  // caller can sequence the next beat behind it.
  const revealInto = (text, stepMs) => {
    heard.classList.remove('muted');
    heard.textContent = '';
    const chars = Array.from(String(text || ''));
    chars.forEach((_, i) => later(i * stepMs, () => { heard.textContent = chars.slice(0, i + 1).join(''); }));
    return chars.length * stepMs;
  };

  // The trail is the part that was missing entirely: what it understood, and
  // what it then did about it.
  const rule = (label, id, msg) => {
    trail.textContent = '';
    const chip = obEl('span', 'obp-demo-chip', label);
    chip.dataset.intent = id || '';
    trail.append(chip, obEl('span', 'obp-demo-msg', msg));
    trail.hidden = false;
  };

  play.onclick = () => {
    if (playing) { idle(); play.textContent = 'Play demo'; return; }
    playing = true;
    play.textContent = 'Stop';
    trail.hidden = true;
    heard.classList.remove('muted');
    heard.textContent = '';

    // Paced to the real pipeline's own beats: listen, think, act. The words now
    // land letter-by-letter, in step with how the notch reveals a reply.
    paint('Listening…', 'live');
    const CHAR_STEP = 34;
    const run = revealInto(sample.words, CHAR_STEP);
    const after = 320 + run;
    later(after + 140, () => paint('Working out what you meant…', 'busy'));
    later(after + 720, () => rule(sample.label, sample.intent, sample.done));
    later(after + 860, () => paint('Done', 'done'));
    later(after + 1500, () => { playing = false; play.textContent = 'Play demo'; });
  };

  idle();

  // Exposed to the module-scope listeners above, which is how a *real* key press
  // drives the same display. Every entry is guarded on still being on screen:
  // renderOb rebuilds the step on each state change, so without this a stage from
  // a step the user has already left would keep writing into detached nodes.
  const live = (fn) => (...args) => { if (wrap.isConnected) fn(...args); };

  demoLive = {
    // A real press takes over from a scripted run rather than fighting it.
    state: live((s) => {
      if (!s) return;
      if (playing) { playing = false; play.textContent = 'Play demo'; clearTimers(); }
      if (s === 'listening') { heard.classList.remove('muted'); heard.textContent = ''; paint('Listening…', 'live'); }
      else if (s === 'routing' || s === 'processing') paint('Working out what you meant…', 'busy');
      else if (s === 'error') paint('That did not work', 'busy');
      else if (s === 'idle' && !heard.classList.contains('muted')) paint('Done', 'done');
    }),
    heard: live((t) => { if (t) { clearTimers(); revealInto(t, 26); } }),
    intent: live((label, id) => rule(label, id, sample.done)),
    level: live((v) => { bar.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%'; }),
    reset: idle
  };

  return wrap;
}

/* The key-check card: the question, a recessed panel holding the two keys, and
   a Yes/change-keys row. Shared by both trigger-key steps because the reference
   uses one layout for both. */
// `mode` is 'dictation' | 'edit' | 'agent'. The card shows that mode's bound
// key, and "No, change keys" rebinds THAT key — the rebind saves through
// bolo.setModeShortcut, so it persists and re-registers immediately.
function keyCheckCard(mode, opts) {
  opts = opts || {};
  const accel = keyForMode(mode);
  const modeLabel = mode === 'edit' ? 'Edit' : mode === 'agent' ? 'Agent' : 'Dictation';
  const wrap = obEl('div', 'obp-card big obp-keycheck');
  wrap.classList.add('keycheck-' + mode);
  const inner = obEl('div', 'obp-card-pad wide');

  // Mode header: coloured dot + label, so each key-check card on the combined
  // three_modes_keys screen reads at a glance.
  const header = obEl('div', 'obp-keycheck-head');
  header.append(obEl('span', 'obp-keycheck-dot', ''));
  header.append(obEl('span', 'obp-keycheck-name', modeLabel));
  inner.append(header);

  const panel = obEl('div', 'obp-inner');
  const row = obEl('div', 'obp-keyrow');

  // One cap per key, built from the shared formatter. The reference draws a
  // macOS keycap: the label, the raw key name under it, and "(left)" on the
  // modifiers, which is the only place that legend means anything.
  //
  // Each cap is remembered as a { part, el } pair. The part is the label the
  // formatter printed, and it is what a live keydown is matched against — so
  // pressing Ctrl alone lights Ctrl, not the whole row.
  const caps = [];
  const cap = (part) => {
    const c = obEl('div', 'obp-keycap');
    c.append(obEl('b', null, prettyAccel(part || 'Ctrl')));
    c.append(obEl('i', null, String(part || 'control').toLowerCase()));
    const hint = Keys ? Keys.sideHint(part) : '';
    if (hint) c.append(obEl('u', null, hint));
    caps.push({ part: part || 'Ctrl', el: c });
    return c;
  };

  // Rebuilt in place when the binding changes, so a rebind does not need the
  // whole step re-rendered to show the new keys.
  const paint = (a) => {
    row.innerHTML = '';
    caps.length = 0;
    const parts = accelParts(a);
    row.append(cap(parts[0]));
    for (const p of parts.slice(1)) {
      row.append(obEl('span', 'obp-plus', '+'));
      row.append(cap(p));
    }
    litKey = { els: caps, timer: null, mark: null };
  };
  paint(accel);

  // Shown only while the card is listening for a new chord.
  const keyHint = obEl('p', 'obp-meta', '');
  keyHint.hidden = true;

  panel.append(row);
  inner.append(keyHint, panel);

  const actions = obEl('div', 'obp-actions-row');
  const no = obEl('button', 'obp-link strong', 'No, change keys');
  no.type = 'button';

  // "No, change keys" rebinds inline. Sending the user to Settings was useless
  // here — onboarding covers the dashboard, so the panel it opened was behind
  // the step the user was looking at.
  const listening = (on) => {
    wrap.classList.toggle('capturing', on);
    row.style.opacity = on ? '0.45' : '';
    keyHint.hidden = !on;
    keyHint.textContent = on ? 'Press your new key combination — Escape keeps the old one.' : '';
    no.disabled = on;
    no.textContent = on ? 'Listening…' : 'No, change keys';
  };

  const remember = (acc) => {
    if (mode === 'edit') editKey = acc;
    else if (mode === 'agent') agentKey = acc;
    else voiceKey = acc;
  };

  no.onclick = () => {
    const previous = keyForMode(mode);
    let mods = [];
    let bare = null;
    listening(true);

    const finish = async (tokens) => {
      keyCapture = null;
      if (bare) { clearTimeout(bare); bare = null; }
      listening(false);
      if (!tokens) { toast('Kept ' + prettyAccel(previous)); return; }
      // Two or three parts at most: the browser will not honour more anyway.
      const acc = tokens.slice(0, 3).join('+');
      try {
        const r = await bolo.setModeShortcut(mode, acc);
        if (r && r.ok === false) {
          toast('That key is taken — kept ' + prettyAccel(previous));
          return;
        }
        // main may have substituted a fallback if the exact chord was refused;
        // show what actually bound.
        const bound = (r && r.accelerator) || acc;
        remember(bound);
        paint(bound);
        await renderOb();
        toast(modeLabel + ' key set to ' + prettyAccel(bound));
      } catch (err) {
        toast('Could not save that key: ' + err.message);
      }
    };

    keyCapture = {
      keydown: (e) => {
        if (e.preventDefault) e.preventDefault();
        if (bare) { clearTimeout(bare); bare = null; }
        // Escape backs out of the capture only — it is not swallowed anywhere
        // else in the flow.
        if (e.key === 'Escape') { finish(null); return; }
        const token = accelTokenFor(e);
        if (isModifierToken(token)) {
          if (!mods.includes(token)) mods.push(token);
          return;
        }
        // The chord is captured on its non-modifier key, written in the
        // conventional Ctrl/Alt/Shift order the formatter prints.
        const order = ['CommandOrControl', 'Control', 'Alt', 'Shift'];
        finish(order.filter((m) => mods.includes(m)).concat([token]));
      },
      keyup: (e) => {
        const token = accelTokenFor(e);
        if (!isModifierToken(token)) return;
        mods = mods.filter((m) => m !== token);
        if (mods.length) return;
        // A modifier released on its own is a legal trigger key, but a slow
        // chord must not save "Ctrl" a beat before Shift arrives.
        bare = setTimeout(() => finish([token]), 350);
      }
    };
  };
  const yes = obEl('button', 'obp-next', 'Yes');
  yes.type = 'button';
  yes.onclick = async () => {
    yes.disabled = true;
    const TESTED = {
      agent: 'agentTriggerTested',
      edit: 'editTriggerTested',
      dictation: 'dictationTriggerTested'
    };
    const key = TESTED[mode] || 'dictationTriggerTested';
    await bolo.obSet({ [key]: true });
    // On the combined three_modes_keys screen, "Yes" only marks this key confirmed
    // — it does not advance, because the other two still need testing.
    if (!opts.noAdvance) {
      obState = await bolo.obNext();
    } else {
      obState = await bolo.obGet();
    }
    renderOb();
  };
  actions.append(no, yes);
  inner.append(actions);

  wrap.append(inner);

  return wrap;
}

/* A numbered instruction row, as used by "ask a simple question". */
function stepRow(n, label, accel) {
  const row = obEl('div', 'obp-steprow');
  row.append(obEl('span', 'obp-step', String(n)));
  row.append(obEl('span', 'obp-h', label));

  if (accel) {
    const parts = accelParts(accel);
    for (let i = 0; i < parts.length; i++) {
      if (i) row.append(obEl('span', 'obp-plus', '+'));
      const cap = obEl('div', 'obp-keycap sm');
      cap.append(obEl('b', null, prettyAccel(parts[i])));
      cap.append(obEl('i', null, String(parts[i]).toLowerCase()));
      const hint = Keys ? Keys.sideHint(parts[i]) : '';
      if (hint) cap.append(obEl('u', null, hint));
      row.append(cap);
    }
  }
  return row;
}

/* The illustration the reference shows beside the permissions step: a macOS
   Screen Recording settings window. Drawn rather than shipped, so there is no
   third-party artwork in the tree. */
function screenRecordingArt() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 320 320');
  svg.setAttribute('class', 'obp-art');
  svg.innerHTML = `
    <rect x="8" y="16" width="304" height="288" rx="12" fill="#fff" stroke="#e8eaed"/>
    <rect x="8" y="16" width="112" height="288" rx="12" fill="#f5f6f7"/>
    <rect x="108" y="16" width="12" height="288" fill="#f5f6f7"/>
    <circle cx="26" cy="36" r="3.4" fill="#f25f58"/><circle cx="38" cy="36" r="3.4" fill="#fdbc2e"/><circle cx="50" cy="36" r="3.4" fill="#4ac25a"/>
    <rect x="24" y="60" width="80" height="9" rx="4.5" fill="#dfe1e4"/>
    <rect x="24" y="80" width="66" height="9" rx="4.5" fill="#e8eaed"/>
    <rect x="24" y="100" width="74" height="9" rx="4.5" fill="#e8eaed"/>
    <rect x="20" y="122" width="88" height="20" rx="10" fill="#0b6bff"/>
    <rect x="32" y="129" width="64" height="6" rx="3" fill="#ffffff" opacity=".92"/>
    <rect x="24" y="156" width="72" height="9" rx="4.5" fill="#e8eaed"/>
    <rect x="24" y="176" width="60" height="9" rx="4.5" fill="#e8eaed"/>
    <rect x="24" y="196" width="78" height="9" rx="4.5" fill="#e8eaed"/>
    <rect x="136" y="60" width="150" height="9" rx="4.5" fill="#dfe1e4"/>
    <rect x="136" y="82" width="164" height="8" rx="4" fill="#eceef0"/>
    <rect x="136" y="112" width="164" height="30" rx="7" fill="#f4f5f6"/>
    <rect x="146" y="122" width="60" height="10" rx="5" fill="#e2e4e7"/>
    <rect x="262" y="120" width="26" height="14" rx="7" fill="#d6d9dc"/>
    <circle cx="281" cy="127" r="5.5" fill="#fff"/>
    <rect x="136" y="152" width="164" height="30" rx="7" fill="#f4f5f6"/>
    <rect x="146" y="162" width="48" height="10" rx="5" fill="#e2e4e7"/>
    <rect x="262" y="160" width="26" height="14" rx="7" fill="#d6d9dc"/>
    <circle cx="281" cy="167" r="5.5" fill="#fff"/>
    <rect x="136" y="192" width="164" height="30" rx="7" fill="#f4f5f6"/>
    <rect x="146" y="199" width="9" height="9" rx="2" fill="#0b6bff"/>
    <rect x="162" y="200" width="40" height="8" rx="4" fill="#b9bec4"/>
    <rect x="262" y="200" width="26" height="14" rx="7" fill="#0b6bff"/>
    <circle cx="281" cy="207" r="5.5" fill="#fff"/>`;
  return svg;
}

// Which microphone, decided while the user is already deciding whether bolo
// may have one at all. Both are the same decision, so they sit in the same card
// stack — and it is the only moment the answer is cheap to get, because the
// person setting the app up is sitting in front of the machine.
//
// The list is fetched rather than passed in: this card is rebuilt on every
// onboarding render, and a stale list is the one thing a picker must not show.
function micCard() {
  const card = obEl('div', 'obp-card');
  const pad = obEl('div', 'obp-card-pad');

  pad.append(obEl('h3', 'obp-h', 'Which microphone?'));
  pad.append(obEl('p', 'obp-p', 'bolo listens through this one. You can change it later in Settings.'));

  const row = obEl('div', 'obp-row');
  const sel = document.createElement('select');
  sel.className = 'field';
  sel.id = 'obMicSel';
  sel.style.maxWidth = '320px';

  const note = obEl('p', 'obp-p obp-mic-note', '');

  (async () => {
    const s = await bolo.getSettings();
    const wanted = s.micDeviceId || '';
    const { opts, devices, labels, error } = await micOptions();
    fillMicSelect(sel, wanted, opts, devices);
    note.textContent = micNote(wanted, devices);
    // The one failure worth explaining: without microphone permission every
    // device reads blank, and a picker of four identical labels looks like a
    // bug rather than like a refusal.
    if (!labels && error) note.textContent = 'Windows would not name the microphones (' + error + '). The list still works.';
  })().catch(() => { note.textContent = 'Could not read the microphone list. Settings can still set it later.'; });

  sel.onchange = async () => {
    const r = await bolo.setPref('micDeviceId', sel.value);
    if (!r || !r.ok) { toast('Could not save that microphone'); return; }
    const { devices } = await micOptions();
    note.textContent = micNote(sel.value, devices);
  };

  row.append(sel);
  pad.append(row, note);
  card.append(pad);
  return card;
}

function renderOb() {
  const overlay = $('obOverlay');
  const box = $('obStep');
  const aside = $('obAside');

  // Dropped before the rebuild, so the steps that have no demo stage cannot be
  // driven by events meant for one that does. A step that builds a stage sets it
  // again below.
  demoLive = null;

  if (!obState || obState.completed) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;

  const d = obState.data || {};
  const step = obState.step;

  $('obBar').style.width = obPercent() + '%';
  $('obBack').hidden = obState.stepIndex === 0;
  $('obNext').textContent = obState.stepIndex === obState.totalSteps - 1 ? 'Finish' : 'Continue';

  // On three_modes_keys, Continue is gated until all three keys have been tested.
  $('obNext').disabled = step === 'three_modes_keys' && !(d.agentTriggerTested && d.editTriggerTested && d.dictationTriggerTested);

  // Layout mode per step: `center` for the single-column screens, `split` for
  // the ones with an illustration beside them, `wide` for the centred screens
  // whose content is wider than the standard measure.
  const CENTERED = new Set(['three_modes_keys', 'dictation_demo', 'edit_demo', 'agent_mode_try']);
  overlay.classList.toggle('center', CENTERED.has(step));
  overlay.classList.toggle('split', step === 'system_permissions');
  aside.textContent = '';

  box.innerHTML = '';
  const title = (t) => { $('obTitle').textContent = t; };
  const sub = (t) => {
    const s = $('obSub');
    s.textContent = t || '';
    s.hidden = !t;
  };
  const q = (t) => box.append(obEl('p', 'obp-q', t));

  title('');
  sub('');

  switch (step) {
    case 'name_collection': {
      title('What should I call you?');
      sub('Used for sign-offs like email signatures, and to make your name transcribe correctly.');
      const row = obEl('div', 'obp-fields');
      const first = obEl('input', 'obp-input');
      first.placeholder = 'First name';
      first.value = d.firstName || '';
      first.id = 'obFirst';
      const last = obEl('input', 'obp-input');
      last.placeholder = 'Last name';
      last.value = d.lastName || '';
      last.id = 'obLast';
      row.append(first, last);
      box.append(row);
      setTimeout(() => first.focus(), 80);
      break;
    }

    case 'language_selection': {
      title('What language do you speak?');
      sub('Pick your primary language. You can add more later in settings.');
      const chips = obEl('div', 'obp-chips');
      for (const [code, label] of OB_LANGUAGES) {
        const b = obEl('button', 'obp-chip' + (d.defaultLanguage === code ? ' sel' : ''), label);
        b.type = 'button';
        b.onclick = async () => {
          obState = await bolo.obSet({ defaultLanguage: code, enabledLanguages: [code] });
          renderOb();
        };
        chips.append(b);
      }
      box.append(chips);
      break;
    }

    case 'system_permissions': {
      title('Enable core features');

      const perm = (heading, body, granted, onGrant) => {
        const card = obEl('div', 'obp-card');
        if (granted) card.classList.add('perm-granted');
        const pad = obEl('div', 'obp-card-pad');
        const row = obEl('div', 'obp-row');
        const text = obEl('div', 'grow');
        text.append(obEl('h3', 'obp-h', heading));
        if (body) text.append(obEl('p', 'obp-p', body));
        row.append(text);

        const check = obEl('span', 'obp-check' + (granted ? ' on' : ''));
        check.innerHTML = TICK;
        row.append(check);
        pad.append(row);

        if (!granted && onGrant) {
          const btn = obEl('button', 'obp-btn', 'Allow');
          btn.type = 'button';
          btn.onclick = onGrant;
          pad.append(btn);
        }
        card.append(pad);
        return card;
      };

      box.append(perm(
        d.micGranted ? 'Microphone permission granted.' : 'Allow the microphone',
        d.micGranted ? 'Your speech will be transcribed.' : 'bolo only listens while you hold your key.',
        !!d.micGranted,
        async () => { obState = await bolo.obSet({ micGranted: true }); renderOb(); }
      ));

      // The permission card says the microphone is allowed; this says which one.
      box.append(micCard());

      box.append(perm(
        d.accessibilityGranted ? 'Accessibility permission granted.' : 'Allow accessibility',
        d.accessibilityGranted ? 'bolo can insert and edit text.' : 'So your words can be typed into other apps.',
        !!d.accessibilityGranted,
        async () => { obState = await bolo.obSet({ accessibilityGranted: true }); renderOb(); }
      ));

      const screenGranted = !!d.micGranted && !!d.accessibilityGranted;
      box.append(perm(
        screenGranted ? 'Screen permission granted.' : 'Allow bolo to see your screen.',
        screenGranted
          ? 'Agent Mode can answer questions about your screen.'
          : 'Only when you ask Agent Mode for help. Screenshots are never stored or shared.',
        screenGranted,
        null
      ));

      if (screenGranted) aside.append(screenRecordingArt());
      break;
    }

    case 'three_modes_keys': {
      // Three keys, three modes — tested on one combined screen. Each card lights
      // when its key is first pressed; the key can be rebound in place. Continue
      // is enabled once all three have been tested at least once.
      title('Three keys, three modes');
      sub('Press each key once to confirm it works, or rebind below.');

      const MODES = [
        { mode: 'dictation', label: 'Dictation', glyph: 'type' },
        { mode: 'edit', label: 'Edit', glyph: 'rewrite' },
        { mode: 'agent', label: 'Agent', glyph: 'act' }
      ];
      const modeRow = obEl('div', 'obp-modes-row');
      for (const m of MODES) {
        const tested = d[m.mode === 'dictation' ? 'dictationTriggerTested'
                    : m.mode === 'edit' ? 'editTriggerTested'
                    : 'agentTriggerTested'];
        const card = keyCheckCard(m.mode, { noAdvance: true });
        card.classList.toggle('tested', !!tested);
        modeRow.append(card);
      }
      box.append(modeRow);
      break;
    }

    case 'agent_mode_try': {
      // The agent demo: speak an instruction, watch bolo carry it out. Demo mode
      // routes the result back to this screen instead of pasting into the foreground.
      title('Do a task with your voice');
      sub('Open Notepad on your computer');

      const card = obEl('div', 'obp-card big obp-askcard');
      const pad = obEl('div', 'obp-card-pad wide');
      pad.append(stepRow(1, 'Press', agentKey));
      pad.append(stepRow(2, '”Open Notepad on your computer”'));
      pad.append(demoStage({
        words: 'Open Notepad on your computer',
        intent: 'act',
        label: 'Did it',
        done: 'Opened Notepad.'
      }));
      card.append(pad);
      box.append(card);

      const done = obEl('div', 'obp-actions-row');
      const not = obEl('button', 'obp-link', 'Not working?');
      not.type = 'button';
      not.onclick = () => toast('Open Settings → Shortcuts to rebind your key');
      const go = obEl('button', 'obp-next', 'Finish');
      go.type = 'button';
      go.onclick = async () => { obState = await bolo.obComplete(); renderOb(); };
      done.append(not, go);
      box.append(done);
      break;
    }

    case 'dictation_demo': {
      // The dictation demo: speak freely, watch your words appear in the
      // onboarding textarea. Demo mode routes the transcript here instead of
      // pasting into whatever app is behind the dashboard.
      title('Dictation');
      sub('Press Ctrl+Shift+D and say something. Your words appear here.');

      box.append(demoStage({
        words: 'The quick brown fox jumps over the lazy dog.',
        intent: 'insert',
        label: 'Typed',
        done: 'Typed where your cursor was, punctuation and all.'
      }));

      const txt = obEl('textarea', 'obp-demo-textarea obp-dictation-textarea', d.dictationDemoText || '');
      txt.id = 'obDictationTextarea';
      txt.placeholder = 'Your dictated text will land here…';
      txt.readOnly = true;
      box.append(txt);
      // Enter demo mode so voice results route here instead of pasting into apps.
      bolo.obDemoStart('dictation');
      break;
    }

    case 'edit_demo': {
      // The edit demo: select text in the textarea, speak an instruction, watch
      // bolo rewrite the selection in place.
      title('Edit');
      sub('Select text in the box below, then press Ctrl+Shift+E and say how to change it.');

      const txt = obEl('textarea', 'obp-demo-textarea obp-edit-textarea', 'The weather is nice today.');
      txt.id = 'obEditTextarea';
      txt.placeholder = '';
      txt.style.minHeight = '96px';
      box.append(txt);

      txt.addEventListener('mouseup', () => {
        if (txt.selectionStart === txt.selectionEnd) return;
        box.append(demoStage({
          words: 'Make it sound excited',
          intent: 'edit',
          label: 'Rewrote',
          done: 'Rewrote your selection in place.'
        }));
        bolo.obDemoStart('edit');
      });
      break;
    }

    default:
      title('Setup');
      sub('Step: ' + step);
  }
}


// Steps that collect input on the way out rather than as you type.
async function obCommitStep() {
  if (!obState) return;
  // Leave demo mode if we are committing a demo step: main.js must stop routing
  // voice results back to the dashboard.
  if (obState.step === 'dictation_demo' || obState.step === 'edit_demo') {
    await bolo.obDemoEnd();
  }
  if (obState.step === 'name_collection') {
    const first = $('obFirst');
    const last = $('obLast');
    if (first) {
      obState = await bolo.obSet({
        firstName: first.value.trim(),
        lastName: last ? last.value.trim() : ''
      });
    }
  }
}

$('obNext').onclick = async () => {
  await obCommitStep();
  obState = obState && obState.stepIndex === obState.totalSteps - 1
    ? await bolo.obComplete()
    : await bolo.obNext();
  if (obState && obState.completed) toast('You’re all set');
  renderOb();
};
$('obBack').onclick = async () => { obState = await bolo.obBack(); renderOb(); };
$('obSkip').onclick = async () => { obState = await bolo.obComplete(); renderOb(); };

$('obRestart').onclick = async () => {
  obState = await bolo.obReset();
  renderOb();
  // The main process relaunches the app a beat after this returns, so the copy
  // says so rather than promising a flow the user would then watch the window
  // vanish in the middle of.
  toast('Settings wiped — bolo is restarting');
};

const obOnboarding = (s) => {
  obState = s;
  renderOb();
};
bolo.on('bolo:onboarding', obOnboarding);

// A microphone was plugged in or pulled out. Re-read the list rather than
// leaving a picker that offers a device which is no longer there — and, when it
// is the saved one that went away, so the caption says so.
bolo.on('bolo:mic-devices-changed', () => {
  refreshMics().catch(() => {});
  const sel = $('obMicSel');
  if (sel && sel.isConnected) renderOb();
});

/* ---------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------ */
(async function init() {
  setVoiceState('idle');
  await refreshSettings();
  // The replacements list is the one Customize card that lives in the main
  // process, so it needs its own read rather than coming down with settings.
  try {
    const r = await bolo.replacementsGet();
    replacements = (r && r.list) || [];
  } catch (_) {
    replacements = [];
  }
  renderReplacements();
  obState = await bolo.obGet();
  renderOb();
  // The dashboard is the first thing seen, so it fills before onboarding has
  // any chance to cover it.
  await renderDash();
})();
