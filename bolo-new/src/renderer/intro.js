/* ============================================================================
   bolo — the cinematic intro renderer.

   Drives the opening, narrates it out loud, collects a name and a language, and
   hands off to the dashboard. The notch window is a separate always-on-top
   surface; this file talks to it through `bolo.introNarrate`, so the words on
   screen and the words in the capsule are always the same ones.

   Two house rules shape the code below:

   1. Nothing may strand the window. Every await is bounded, the sequence is
      kicked off on a timer rather than as the last statement, and Escape leaves
      from any point.
   2. `var bolo`, never `const`. contextBridge installs `bolo` on `window` as
      a non-configurable property, and a top-level `const` of the same name is a
      parse-time SyntaxError that kills the whole file.
   ========================================================================== */

function reportError(message, detail) {
  if (window.__boloDiag) {
    window.__boloDiag(message, detail);
    return;
  }
  try {
    if (window.bolo && window.bolo.introError) {
      window.bolo.introError({ message: String(message), detail: String(detail || '') });
    }
  } catch (_) { /* bridge unavailable — the on-screen line still shows */ }

  const el = document.getElementById('diag');
  if (el) {
    el.hidden = false;
    el.textContent = String(message) + (detail ? '  (' + detail + ')' : '');
  }
}

var bolo = window.bolo;
var Keys = window.BoloKeys;
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
   The onboarding steps run inside this intro window as beats 4–10.
   Each step is rendered into #beat; Back/Continue live in #beatnav. The whole
   surface — scrim, name pills, narration — stays alive so first-run reads as
   one continuous sequence rather than intro-then-dashboard.
   --------------------------------------------------------------------------- */
let obState = null;
let demoLive = null;   // the live voice demo stage, if one is mounted
let demoText = '';     // typed/dictated text held in the live textarea
const STEPS = [
  'system_permissions',
  'three_modes_keys',
  'dictation_demo',
  'edit_demo',
  'agent_mode_try'
];
let curIndex = -1;
let demoStep = null; // always null now: no demo routing, kept so Finish teardown stays safe

function firstIntroIndex() {
  if (!obState || !Array.isArray(obState.steps)) return 0;
  const i = obState.steps.indexOf(STEPS[0]);
  return i < 0 ? 0 : i;
}

function isLastIntroStep() {
  if (!obState) return false;
  if (obState.step === 'agent_mode_try') return true;
  const total = obState.totalSteps || (Array.isArray(obState.steps) ? obState.steps.length : 0);
  return obState.stepIndex >= Math.max(0, total - 1);
}

function syncDemoMode() {
  // No demo routing anywhere in the intro: every beat drives the real voice
  // pipeline (real mic → real router → real injection / real agent acts), so
  // there is never a demo binding to open. This only ever closes a stale one
  // left behind by an older run.
  if (!window.bolo) return;
  if (demoStep) {
    demoStep = null;
    try { if (bolo.obDemoEnd) bolo.obDemoEnd().catch(() => {}); } catch (_) {}
  }
}

const DEFAULT_SHORTCUT = 'Control+Shift+D';
let voiceKey = DEFAULT_SHORTCUT;
let editKey = 'Control+Shift+E';
let agentKey = 'Control+Shift+A';

function keyForMode(mode) {
  if (mode === 'edit') return editKey;
  if (mode === 'agent') return agentKey;
  return voiceKey || DEFAULT_SHORTCUT;
}

function prettyAccel(a) {
  return Keys ? Keys.label(a) : String(a || '');
}
function accelParts(a) {
  return Keys ? Keys.parts(a) : String(a || '').split('+').map((s) => s.trim()).filter(Boolean);
}

function captureModeKeys(info) {
  const list = (info && info.modeShortcuts) || [];
  for (const m of list) {
    const key = m.bound || m.requested;
    if (!key) continue;
    if (m.id === 'edit') editKey = key;
    else if (m.id === 'agent') agentKey = key;
    else if (m.id === 'voice' || m.id === 'dictation') voiceKey = key;
  }
}

function obEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = String(text);
  return el;
}

const TICK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

if (!bolo) reportError('window.bolo is missing — the preload bridge did not load');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------------------
   The mark
   ------------------------------------------------------------------------ */
try {
  const mark = $('mark');
  if (mark && window.boloWordmark) mark.innerHTML = window.boloWordmark.svg({ label: 'bolo' });
  else if (mark) reportError('wordmark.js did not load');
} catch (e) {
  reportError('wordmark failed to render', e.message);
}

/* ---------------------------------------------------------------------------
   Narration
   Two voices, in order. Deepgram through the main process is the good one — it
   is the voice the product actually has — and the platform synthesiser is the
   fallback for a machine with no key, no network or no sound device. Either way
   the words land on screen in step with the audio, and the notch is told the
   same line so the capsule and the screen never disagree.

   Nothing here is allowed to hang: every path resolves, and a hard ceiling
   catches a synthesiser that reports neither end nor error.
   ------------------------------------------------------------------------ */
const synth = window.speechSynthesis;
const CEILING_MS = 12000;
const WORD_MS = 330;          // reveal cadence *estimate*, when a clip reports no length
const AUDIO_START_MS = 3500;  // how long to wait for Deepgram before falling back
const TAIL_MS = 180;          // let the last word settle before the voice stops
const MIN_STEP_MS = 90;       // a very short clip must not flash its words
const MAX_STEP_MS = 700;      // nor may a long one crawl

// How fast to reveal one line, given how long the clip actually is.
//
// This is the "text and audio are misaligned" fix. A fixed step is only right for
// one speaking rate: a slow line had all its words on screen while the voice was
// still talking, a fast one lagged behind it, and the two never lined up because
// nothing tied them together. The clip's own duration is that tie — spread the
// words across it and the last one lands as the sentence does.
function stepFor(ms, words) {
  const usable = (ms > 0 ? ms : words.length * WORD_MS) - TAIL_MS;
  // Divided by the gaps between the words, not by the words: the first word is
  // revealed the moment the voice starts, so six words are five steps. Dividing
  // by six finished the line a step early — the words were all up while the
  // voice still had a syllable to go, which is the same drift in miniature.
  const step = usable / Math.max(1, words.length - 1);
  return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, step));
}

// The letter-by-letter cadence, the same idea one level finer: spread the
// characters across the clip's real length so the last letter lands as the
// sentence does. Used everywhere the reveal is per-character (which is now the
// default look — the user asked for letters, not words).
const CHAR_MS = 52;        // per-char estimate when a clip reports no length
const MIN_CHAR_STEP_MS = 12;
const MAX_CHAR_STEP_MS = 90;
function stepForChars(ms, text) {
  const n = Array.from(String(text)).length;
  const usable = (ms > 0 ? ms : n * CHAR_MS) - TAIL_MS;
  const step = usable / Math.max(1, n - 1);
  return Math.min(MAX_CHAR_STEP_MS, Math.max(MIN_CHAR_STEP_MS, step));
}

// Reveal a line character by character. Resolves once the whole line is up.
// `onWord` is still honoured — it fires as each word is *completed* (its trailing
// space, or the end of the line), so word-pinned cues like the name pills keep
// working even though the reveal itself is per-letter.
function revealChars(text, el, stepMs, onWord) {
  return new Promise((resolve) => {
    if (!el) return resolve();
    const full = String(text);
    const chars = Array.from(full);
    let i = 0;
    let wordsFired = 0;
    const step = () => {
      if (i >= chars.length) {
        el.textContent = full;
        return resolve();
      }
      i += 1;
      const shown = chars.slice(0, i).join('');
      el.textContent = shown;
      if (onWord && (chars[i - 1] === ' ' || i === chars.length)) {
        const w = shown.split(/\s+/).filter(Boolean);
        if (w.length > wordsFired) {
          wordsFired = w.length;
          try { onWord(w[w.length - 1], w.length - 1); } catch (_) { /* a cue is not worth a dead line */ }
        }
      }
      setTimeout(step, stepMs);
    };
    step();
  });
}

let muted = false;

function pickVoice(lang) {
  if (!synth) return null;
  const voices = synth.getVoices() || [];
  if (!voices.length) return null;
  const exact = voices.find((v) => v.lang && v.lang.toLowerCase() === String(lang).toLowerCase());
  if (exact) return exact;
  const base = String(lang).split('-')[0].toLowerCase();
  return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(base)) || null;
}

// Reveal a line word by word. Resolves once the whole line is on screen, so a
// caller can sequence the next beat behind it. The timer is not cleared on the
// way out — the words are the last thing to arrive either way.
//
// `onWord` is told each word as it lands, which is how a beat can be pinned to a
// word instead of to a stopwatch: the name pills wait for the spoken "you", not
// for 520 ms of wall clock. A cue that throws must not break the reveal.
function revealWords(words, el, text, stepMs, onWord) {
  return new Promise((resolve) => {
    if (!el) return resolve();
    let i = 0;
    const step = () => {
      if (i >= words.length) {
        el.textContent = text;
        return resolve();
      }
      const word = words[i];
      el.textContent = words.slice(0, ++i).join(' ');
      if (onWord) {
        try { onWord(word, i - 1); } catch (_) { /* a cue is not worth a dead line */ }
      }
      setTimeout(step, stepMs);
    };
    step();
  });
}

// The fallback voice. Resolves when the line has been read to the end, or when
// the synthesiser gives up — the two are the same thing to the sequence.
function speakPlatform(text, el, words, lang, onWord) {
  return new Promise((resolve) => {
    let done = false;
    let ceiling = null;

    function finish() {
      if (done) return;
      done = true;
      if (ceiling) clearTimeout(ceiling);
      el.textContent = text;
      resolve({ spoken: true, muted: muted, voice: 'platform' });
    }

    ceiling = setTimeout(finish, CEILING_MS);

    if (!synth) {
      revealChars(text, el, 24, onWord).then(finish);
      return;
    }

    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(lang || 'en');
      if (v) u.voice = v;
      u.lang = (v && v.lang) || lang || 'en';
      u.rate = 1.02;
      u.pitch = 1.0;
      u.onend = finish;
      u.onerror = finish;
      u.onboundary = (e) => {
        if (typeof e.charIndex !== 'number') return;
        const upto = text.slice(0, e.charIndex + (e.charLength || 1)).trim();
        el.textContent = upto;
        // A boundary names the word being spoken, so the same cue the clip path
        // gets is available here too — the fallback below is only for a
        // synthesiser that reports no boundaries at all.
        if (onWord) {
          try { onWord(upto.split(/\s+/).pop(), -1); } catch (_) { /* as above */ }
        }
      };
      synth.cancel();
      synth.speak(u);
    } catch (_) {
      revealChars(text, el, 24, onWord).then(finish);
    }
  });
}

// One line: on screen word by word, and out loud.
//
// `pre` is an already-started `bolo.speak` call for this text. `say()` uses it
// to put the second line in flight while the first is still being spoken, so the
// pair costs one round trip rather than two.
//
// `hooks.onSpeakStart` fires the moment the line is on screen and being read;
// `hooks.onWord` is passed straight through to whichever reveal path runs.
async function speakLine(text, el, lang, pre, hooks) {
  if (!el || !text) return { spoken: false };

  el.textContent = '';
  el.classList.remove('out');
  el.classList.add('on');

  // The capsule says the same words. It is told before the audio starts so the
  // two surfaces are never more than one beat apart.
  try {
    if (bolo && bolo.introNarrate) bolo.introNarrate({ text: text, lang: lang || 'en' });
  } catch (_) { /* narration is decorative; the sequence does not depend on it */ }

  if (hooks && hooks.onSpeakStart) {
    try { hooks.onSpeakStart(); } catch (_) { /* a cue must never stop the line */ }
  }

  const words = String(text).split(/\s+/).filter(Boolean);
  const onWord = (hooks && hooks.onWord) || null;

  // Muted, or no playback path at all: still show the words, at reading pace.
  // A beat must never become a dead end for want of a speaker.
  if (muted || !window.boloAudio) {
    await Promise.race([revealChars(text, el, 24, onWord), wait(CEILING_MS)]);
    return { spoken: false, muted: muted };
  }

  // The audio is fetched *before* a word is revealed, because its length is what
  // sets the cadence. Bounded like everything else here, and never unguarded: a
  // request that fails is what the fallback below is for.
  let clip = null;
  try {
    const req = pre || (bolo && bolo.speak ? bolo.speak({ text: text }) : null);
    if (req) {
      req.catch(() => {});
      clip = await Promise.race([req, wait(AUDIO_START_MS).then(() => null)]);
    }
  } catch (_) { clip = null; }

  // Nothing came back in time — a missing key, a slow network, a muted device.
  // Drop the clip rather than let it start talking over the fallback later.
  if (!clip || !clip.ok || !clip.audio) {
    try { window.boloAudio.stop(); } catch (_) {}
    return speakPlatform(text, el, words, lang, onWord);
  }

  const known = await window.boloAudio.meta(clip.audio, clip.mime).catch(() => ({ ms: 0 }));
  const step = stepForChars((known && known.ms) || 0, text);

  // `onStart` is what makes this work: the reveal may not begin until the audio
  // does, or the words are all on screen before the sentence is half spoken.
  let beganResolve = null;
  const began = new Promise((resolve) => { beganResolve = resolve; });

  const played = window.boloAudio.play(clip.audio, clip.mime, { onStart: () => beganResolve(true) });
  // Nothing may await `played` unguarded: it is also what reports a failure.
  played.catch(() => {});

  const heard = await Promise.race([began, wait(AUDIO_START_MS).then(() => false)]);

  if (heard) {
    await Promise.race([revealChars(text, el, step, onWord), wait(CEILING_MS)]);
    const r = await Promise.race([played, wait(CEILING_MS).then(() => null)]);
    return { spoken: true, voice: clip.voice || 'deepgram', ms: (known && known.ms) || 0, step };
  }

  try { window.boloAudio.stop(); } catch (_) {}
  return speakPlatform(text, el, words, lang, onWord);
}

/* Two lines. They are spoken one after the other, not one over the other: the
   previous 360 ms stagger relied on the platform synthesiser, which resolved it
   by cancelling the first line mid-word, and with Deepgram it would have put two
   clips in the air at once. The second lands as the first finishes — the same
   statement-then-question beat, with neither line cut off.

   The second line is *synthesised* while the first is being *spoken*, though.
   Sequentially they were two round trips end to end, and the pause between them
   was the network rather than the pause after a question — which is what "too
   much gap between sentences" was. Only the audio is overlapped, never the
   speech: line two is in the renderer's hand before line one has finished.

   `hooks.between` runs in the seam — after line one has been read to its end and
   before line two starts — which is where the logotype leaves. */
async function say(line1, line2, lang, hooks) {
  const a = $('line1'), b = $('line2');
  if (a) { a.textContent = ''; a.classList.remove('on', 'out'); }
  if (b) { b.textContent = ''; b.classList.remove('on', 'out'); }

  let second = null;
  try {
    if (!muted && bolo && bolo.speak && line2) {
      second = bolo.speak({ text: line2 });
      second.catch(() => {});
    }
  } catch (_) { second = null; }

  await speakLine(line1, a, lang);
  if (abandoned) return;
  if (hooks && hooks.between) {
    try { hooks.between(); } catch (_) { /* chrome only; the line still gets said */ }
  }
  await speakLine(line2, b, lang, second, hooks);
}

function hush() {
  for (const el of [$('line1'), $('line2')]) {
    if (el) { el.classList.remove('on'); el.classList.add('out'); }
  }
}

/* ---------------------------------------------------------------------------
   Beats
   ------------------------------------------------------------------------ */
const LANGUAGES = [
  { code: 'en', label: 'English', ack: 'English it is.' },
  { code: 'hi', label: 'हिन्दी', ack: 'ठीक है, हिन्दी।' },
  { code: 'es', label: 'Español', ack: 'Perfecto, español.' },
  { code: 'fr', label: 'Français', ack: 'Parfait, français.' },
  { code: 'de', label: 'Deutsch', ack: 'Alles klar, Deutsch.' },
  { code: 'pt', label: 'Português', ack: 'Perfeito, português.' },
  { code: 'it', label: 'Italiano', ack: 'Perfetto, italiano.' },
  { code: 'ja', label: '日本語', ack: 'わかりました、日本語。' },
  { code: 'ko', label: '한국어', ack: '알겠습니다, 한국어.' },
  { code: 'zh', label: '中文', ack: '好的，中文。' },
  { code: 'ar', label: 'العربية', ack: 'حسنًا، العربية.' },
  { code: 'ru', label: 'Русский', ack: 'Хорошо, русский.' }
];

let chosenLanguage = 'en';
let firstName = '';
let abandoned = false;

// The opening narration's first line. A module const so the pre-warm in open()
// and the spoken call in askName() use a byte-identical cache key — tts.js caches
// by voice|text, so warming it during the gate dwell makes the click-time fetch a
// cache hit instead of a cold ~1-2s round trip (which otherwise fell back to the
// robotic platform voice at AUDIO_START_MS). The apostrophe is U+2019; it must
// match exactly or the cache misses.
const WELCOME = 'Welcome to bolo. I’m your assistant.';

function phase(name) {
  try { if (bolo && bolo.introPhase) bolo.introPhase(name); } catch (_) {}
}

/* --- 1. open ------------------------------------------------------------- */
async function open() {
  document.body.classList.add('lit');
  await wait(reduced() ? 200 : 2600);
  const gate = $('gate');
  if (gate) gate.classList.add('on');

  // Tell main the intro reached its healthy wait-for-click state. Main's watchdog
  // treats 'glow'/'idle' as "stuck and should hand off to the dashboard"; without
  // this signal a user who reads the screen for a few seconds trips it and gets
  // the dashboard yanked up under them. 'get-started' means "waiting on the user,
  // not frozen" — the watchdog leaves it alone.
  phase('get-started');

  // Warm the TTS cache for the first narration line while the user dwells at the
  // gate, so it speaks the moment they click instead of paying a cold round trip.
  // Fire-and-forget; a failure just means askName() fetches it the old way.
  if (!muted) { try { if (bolo && bolo.speak) bolo.speak({ text: WELCOME }).catch(() => {}); } catch (_) {} }
}

/* --- 2. the name --------------------------------------------------------- */
function wireAskbar() {
  const bar = $('askbar');
  const first = $('firstName');
  const last = $('lastName');
  if (!bar || !first) return null;

  const sync = () => {
    for (const input of [first, last]) {
      if (!input) continue;
      const wrap = input.closest('.field');
      if (wrap) wrap.classList.toggle('filled', input.value.trim().length > 0);
    }
    bar.classList.toggle('ready', first.value.trim().length > 0);
  };
  first.addEventListener('input', sync);
  if (last) last.addEventListener('input', sync);

  return {
    bar: bar,
    first: first,
    last: last,
    sync: sync,
    show() {
      bar.classList.add('on');
      sync();
      setTimeout(() => first.focus({ preventScroll: true }), reduced() ? 0 : 420);
    },
    hide() {
      bar.classList.remove('on', 'ready');
      try { first.blur(); if (last) last.blur(); } catch (_) {}
    }
  };
}

/* The mark steps out in the seam between the two lines. The opening line is
   spoken over the logotype; the question that asks for a name is not — the pills
   arrive in its place, and a mark still sitting behind them was the note that
   started this. One way only: it does not come back. */
function markOut() {
  try {
    const mark = $('mark');
    if (mark) mark.classList.add('out');
  } catch (_) { /* the fade is decoration; the beat never waits on it */ }
}

async function askName() {
  phase('name');
  const ask = wireAskbar();
  if (!ask) return;

  // The pills land on the spoken word "you" — the last word of "So, what should
  // I call you?" — rather than on a stopwatch. That is the beat the reference
  // has: the fields appear as the question closes, not 520 ms after it opened.
  let cued = false;
  let cueResolve = null;
  const cue = new Promise((resolve) => { cueResolve = resolve; });
  const fire = () => {
    if (cued) return;
    cued = true;
    cueResolve(true);
  };
  // "you?" and "you," are the same word to the ear and to this test.
  const isYou = (w) => String(w == null ? '' : w).toLowerCase().replace(/[^a-z]/g, '') === 'you';

  // Line two being on screen is what a fallback can be measured from. Without
  // it a synthesiser that reports no boundaries would leave the pills off screen
  // for the whole line, and the beat would never advance.
  let up = false;
  let upResolve = null;
  const started = new Promise((resolve) => { upResolve = resolve; });
  const onSpeakStart = () => {
    if (up) return;
    up = true;
    upResolve(true);
  };

  const said = say(WELCOME, 'So, what should I call you?', 'en', {
    between: markOut,
    onWord: (w) => { if (isYou(w)) fire(); },
    onSpeakStart: onSpeakStart
  });

  // Two ways the cue never arrives: a voice path that reports no words at all,
  // and a second line that never begins. Neither may strand the beat, so the
  // pills are shown on a short fixed wait behind the word timing — and behind
  // that, a ceiling, so the beat completes even if line two never starts.
  const fallback = Promise.race([started.then(() => wait(3200)), wait(9000)]).then(fire);

  await Promise.race([cue, fallback]);
  if (abandoned) return;
  ask.show();
  await said;

  await new Promise((resolve) => {
    let submitting = false;

    const submit = async () => {
      const value = (ask.first.value || '').trim();
      if (!value || submitting) {
        ask.first.focus();
        return;
      }
      submitting = true;
      firstName = value;
      ask.bar.classList.remove('ready');

      try {
        await bolo.introSubmitName({ firstName: value, lastName: (ask.last.value || '').trim() });
      } catch (_) { /* persisted to onboarding regardless; never block the beat */ }

      ask.hide();
      resolve();
    };

    ask.bar.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    if (ask.last) {
      // Enter in the surname field is the same gesture as the arrow.
      ask.last.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    }
  });

  hush();
  await wait(360);
}

/* --- 3. the language ----------------------------------------------------- */
function wireLangs(onPick) {
  const box = $('langs');
  if (!box) return null;

  box.innerHTML = '';
  LANGUAGES.forEach((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang';
    b.textContent = l.label;
    b.dataset.code = l.code;
    b.addEventListener('click', () => onPick(l));
    box.append(b);
  });

  return {
    show() { box.classList.add('on'); },
    hide() { box.classList.remove('on'); },
    select(code) {
      for (const c of box.querySelectorAll('.lang')) c.classList.toggle('sel', c.dataset.code === code);
    }
  };
}

async function askLanguage() {
  phase('language');

  let settle = null;
  const picked = new Promise((resolve) => { settle = resolve; });

  const langs = wireLangs((l) => {
    chosenLanguage = l.code;
    if (langs) langs.select(l.code);
    settle(l);
  });

  const said = say(
    'Hey ' + (firstName || 'there') + ', it’s great to meet you!',
    'What language do you speak?',
    'en'
  );

  // The reference answers this one by listening. bolo does not listen here
  // yet — the microphone lives in the capture window, not this one — so the list
  // is the honest affordance: it stays out of the way while the line is being
  // spoken and appears if nothing has been picked.
  const fallback = (async () => {
    await wait(5200);
    if (!abandoned && langs) langs.show();
  })();

  const entry = await Promise.race([picked, fallback.then(() => picked)]);

  await wait(700);
  if (langs) langs.hide();

  try {
    await bolo.introSubmitLanguage({
      defaultLanguage: entry.code,
      enabledLanguages: [entry.code]
    });
  } catch (_) { /* see above */ }

  // The greeting was already spoken when this beat opened ("Hey <name>, it's
  // great to meet you!"). Repeating the name here is the "hey pratham twice" bug —
  // after picking a language, just acknowledge it and move on.
  await waitedSay(entry.ack, 'Let’s get you set up.', entry.code);

  return entry;
}

// A line pair that must not overlap: hush the previous before speaking.
async function waitedSay(a, b, lang) {
  hush();
  await wait(340);
  return say(a, b, lang);
}

/* ---------------------------------------------------------------------------
   Beats 4–10 — the rest of setup, hosted in the intro window so the whole first
   run is one continuous cinematic sequence over the same blurred-scrim surface.
   Each beat renders its controls into #beat and hands back a commit function;
   the machine calls commit on Continue. Every voice beat drives the real
   pipeline — no demo redirect.
   ------------------------------------------------------------------------ */
function beatEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function clearBeat() {
  const b = $('beat');
  if (b) b.innerHTML = '';
}

function showBeat(title, sub, build) {
  clearBeat();
  const b = $('beat');
  if (!b) return null;
  b.classList.remove('beat-leaving', 'beat-entering');
  b.classList.add('on');
  b.append(beatEl('h2', null, title));
  const s = beatEl('p', 'bsub', sub || '');
  if (!sub) s.hidden = true;
  b.append(s);
  if (build) build(b);
  return b;
}

function beatNav() {
  const back = $('beatBack');
  const go = $('beatGo');
  if (back) back.hidden = !obState || obState.stepIndex <= firstIntroIndex();
  if (go) go.disabled = !obNextReady;
}

/* --- 4. permissions (auto tech-check) --------------------------------------- */
let techCheckTimer = null;
function renderPermissions() {
  const d = (obState && obState.data) || {};
  const missing = [];
  if (!d.micGranted) missing.push('mic');
  if (!d.accessibilityGranted) missing.push('accessibility');
  if (missing.length === 0) {
    // All granted (normal case — both pre-granted): transient confirmation,
    // then auto-advance. No Allow buttons, no stop.
    showBeat('Everything’s ready',
      'Microphone, typing and screen — all set.',
      null);
    syncBeatNav();
    if (techCheckTimer) clearTimeout(techCheckTimer);
    techCheckTimer = setTimeout(async () => {
      techCheckTimer = null;
      if (!obState || obState.step !== 'system_permissions' || abandoned) return;
      try { obState = await bolo.obNext(); } catch (_) {}
      renderOb();
    }, reduced() ? 200 : 1200);
    return null;
  }
  if (techCheckTimer) { clearTimeout(techCheckTimer); techCheckTimer = null; }
  const b = showBeat('One thing needs you',
    'Only what’s missing is shown — fix it and we move on.',
    (el) => buildPerms(el, missing));
  try { say('One thing needs you.', 'Only what’s missing is shown.', chosenLanguage || 'en').catch(() => {}); } catch (_) {}
  return b;
}

const TICK_TEXT = '✓';
function buildPerms(b, only) {
  const d = obState.data || {};
  const show = (k) => !Array.isArray(only) || only.includes(k);
  const perms = b.appendChild(beatEl('div', 'perms'));

  const perm = (heading, body, granted, onGrant) => {
    const row = beatEl('div', 'perm', null);
    const text = beatEl('div', 'perm-text');
    text.append(beatEl('div', 'perm-title', heading));
    const sub = beatEl('div', 'perm-sub', body);
    text.append(sub);
    const act = granted
      ? beatEl('span', 'perm-check', TICK_TEXT)
      : beatEl('button', 'perm-btn', 'Allow');
    if (onGrant) act.onclick = onGrant;
    row.append(text, act);
    perms.append(row);
    return row;
  };

  if (show('mic')) perm(
    d.micGranted ? 'Microphone permission granted.' : 'Allow the microphone',
    d.micGranted ? 'Your speech will be transcribed.' : 'bolo only listens while you hold your key.',
    !!d.micGranted,
    async () => { obState = await bolo.obSet({ micGranted: true }); renderPermissions(); }
  );

  if (show('accessibility')) perm(
    d.accessibilityGranted ? 'Accessibility permission granted.' : 'Allow accessibility',
    d.accessibilityGranted ? 'bolo can insert and edit text.' : 'So your words can be typed into other apps.',
    !!d.accessibilityGranted,
    async () => { obState = await bolo.obSet({ accessibilityGranted: true }); renderPermissions(); }
  );

  const screenGranted = !!d.micGranted && !!d.accessibilityGranted;
  if (show('mic') || show('accessibility')) perm(
    screenGranted ? 'Screen permission granted.' : 'Allow bolo to see your screen.',
    screenGranted
      ? 'Agent Mode can answer questions about your screen.'
      : 'Only when you ask Agent Mode for help. Screenshots are never stored or shared.',
    screenGranted,
    null
  );
}

/* ---------------------------------------------------------------------------
   Setup failures

   The capsule is where bolo says things, and for the opening beats it is held
   down on purpose, so a message sent only there is invisible at exactly the
   moment the user is staring at a step that does not work. This is the same
   message painted on the surface they are already looking at.

   Deliberately not a toast: it has to survive the re-renders that happen on
   every keypress during the key step, and it must never land under the card or
   the navigation.
   ------------------------------------------------------------------------ */
let setupErrorEl = null;

function showSetupError(message, detail) {
  const text = String(message == null ? '' : message).trim();
  if (!text) return;
  try {
    if (!setupErrorEl) {
      setupErrorEl = document.createElement('div');
      setupErrorEl.className = 'setup-error';
      setupErrorEl.setAttribute('role', 'status');
      const msg = document.createElement('span');
      msg.className = 'setup-error-text';
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'setup-error-x';
      hide.setAttribute('aria-label', 'Dismiss');
      hide.textContent = '×';
      hide.onclick = () => { setupErrorEl.hidden = true; };
      setupErrorEl.append(msg, hide);
      document.body.append(setupErrorEl);
    }
    const line = setupErrorEl.querySelector('.setup-error-text');
    if (line) line.textContent = detail ? text + ' — ' + detail : text;
    setupErrorEl.hidden = false;
  } catch (_) { /* a banner that can break setup is worse than no banner */ }
}

/* --- 5. three modes ------------------------------------------------------ */
const MODES = [
  { mode: 'dictation', label: 'Dictation', glyph: '🖊', blurb: 'Types what you say, wherever your cursor is.' },
  { mode: 'edit', label: 'Edit', glyph: '✎', blurb: 'Rewrites what you selected, the way you describe.' },
  { mode: 'agent', label: 'Agent', glyph: '★', blurb: 'Carries out the task, then reports back.' }
];

// One screen per key: the store step stays `three_modes_keys`, the pager is
// local. keyPageSpoken gates narration so a re-render (each keypress lands one)
// does not re-speak the line.
let keyPage = 0;
let keyPageSpoken = -1;
let keyAdvanceTimer = null;
let keyPinned = false;
let keyTestedSig = '';

// Which key trials the user has actually RUN in this pass through the step.
//
// The store's `*TriggerTested` flags are a record of an earlier run: they
// pre-confirm a card (the reference shows a tick on a key already tested) and
// they are what lets Continue enable. They must never be what decides whether a
// trial may open. Trusting them closed the trials for good — a relaunch replayed
// the intro, every card painted as already confirmed, markKeyTested() bailed on
// `d[field]` and there was no way left to exercise the voice pipeline at all, so
// the capsule looked broken because nothing could ever ask it to show anything.
// Reset on a fresh entry to the step (see renderOb) and on "Try it again".
const keyTrialDone = { dictation: false, edit: false, agent: false };

function resetKeyTrials() {
  keyTrialDone.dictation = false;
  keyTrialDone.edit = false;
  keyTrialDone.agent = false;
}

function renderThreeModes() {
  const d = (obState && obState.data) || {};
  const sig = MODES.map((m) => (d[testedKeyFor(m)] ? '1' : '0')).join('');
  if (sig !== keyTestedSig) { keyTestedSig = sig; keyPinned = false; }
  // Prefer a key that has neither been confirmed before nor been run in this
  // pass, so a replayed intro opens on Dictation rather than parking on the
  // last card with nothing left to try.
  let first = MODES.findIndex((m) => !d[testedKeyFor(m)] || !keyTrialDone[m.mode]);
  if (first < 0) first = MODES.length - 1;
  if (keyPage < 0 || keyPage >= MODES.length) keyPage = first;
  const m = MODES[keyPage];
  const combo = accelParts(keyForMode(m.mode)).map(prettyAccel).join(' + ');
  // Mid-trial the "press once" check copy is wrong — the trial needs a hold.
  const trialLive = !!(keyTrial && keyTrial.mode === m.mode);
  showBeat(m.label, trialLive
    ? 'Hold ' + combo + ' and speak — release to send.'
    : m.blurb + ' Press ' + combo + ' once to confirm it works.',
    (b) => buildKeyPage(b, m));
  if (keyPage !== keyPageSpoken) {
    keyPageSpoken = keyPage;
    try { say(m.label + '.', 'Press ' + combo + ' once.', chosenLanguage || 'en').catch(() => {}); } catch (_) {}
  }
  // Advancing is driven by markKeyTested (speak-then-slide), not a timer:
  // nothing to do here on re-render beyond painting the current state.
}

function testedKeyFor(m) {
  return m.mode === 'dictation' ? 'dictationTriggerTested'
       : m.mode === 'edit' ? 'editTriggerTested'
       : 'agentTriggerTested';
}

// —  — keycap lighting for the three_modes_keys step —  — // When the user presses a modifier or a non-modifier key, the matching cap(s)
// light up. Pressing Ctrl alone lights Ctrl; pressing the chord lights all parts.
// This is the same live-tester the reference uses: a static label read as "broken"
// if the key never lit when the user pressed it.

let litKey = null;
let keyCapture = null;

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

// A key typed into a field must not flash the test caps.
function typingInField(e) {
  const el = (e && e.target) || document.activeElement;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true;
}

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

function unlightKeyTest(part) {
  const want = String(part || '').toLowerCase();
  const pairs = ((litKey && litKey.els) || []).filter((p) => p.el && p.el.isConnected);
  for (const p of pairs) {
    if (!want || String(p.part).toLowerCase() === want) p.el.classList.remove('lit');
  }
}

// The keys physically held right now (canonical lowercase labels). Lets the
// beat confirm a chord the moment it is pressed in this window — independent
// of the global shortcut / native hook path, which is what makes Continue
// enable even when that path is flaky.
const downLabels = new Set();
let keyConfirming = null; // mode with a confirmation sequence in flight

// Live trials: after a chord lands, the screen turns into a trial — an input
// box, one spoken task, and success measured from what actually lands in the
// box. Dictation matches the spoken target line; edit completes on any rewrite
// landing; agent completes on any carried-out action (see the bolo:answer
// listener below).
const TRIAL_TARGET = 'The quick brown fox jumps over the lazy dog';
const TRIAL_DEFAULT_EDIT = 'The weather is nice today.';
const TRIAL_COOL = {
  dictation: ['Cool — Dictation works.', 'Let’s keep going.'],
  edit: ['Nice rewrite — Edit works.', 'Next one.'],
  agent: ['Cool — Agent works.', 'You’re all set here.']
};
const TRIAL_INSTRUCTIONS = {
  dictation: ['Now try it.', 'Say: ' + TRIAL_TARGET + '.'],
  edit: ['Now change it.', 'Select the text, then say how — try: make it sound excited.']
};
let keyTrial = null; // { mode } while a trial is live on the current key screen
const keyTrialText = { dictation: '' }; // dictated line, carried into the edit trial

// Trial-local session driving. The global activation path (uiohook /
// globalShortcut) is flaky while the intro is up — the local chord detector
// above exists for exactly that reason — but it goes quiet during a trial
// because the caret sits in the trial's textarea (typingInField). Without a
// fallback, holding the chord starts no session: the meter never moves and no
// words ever land. While a trial is live, a chord held in THIS window drives
// the session over IPC. The short delay lets a working global path win, so a
// press is never double-driven.
let trialSession = false; // this trial started the session via IPC; it must stop it
let lastVoiceState = 'idle';
function trialChordHeld() {
  if (!keyTrial || abandoned) return false;
  const parts = accelParts(keyForMode(keyTrial.mode)).map((p) => String(p).toLowerCase());
  return parts.length > 0 && parts.every((p) => downLabels.has(p));
}
function trialKeyDown() {
  if (!keyTrial || trialSession || abandoned) return;
  if (!trialChordHeld()) return;
  setTimeout(() => {
    if (!keyTrial || trialSession || abandoned) return;
    // The global path fired: a session is already live, nothing to do.
    if (lastVoiceState === 'listening' || lastVoiceState === 'routing') return;
    trialSession = true;
    try {
      const r = bolo.voiceToggle({ mode: keyTrial.mode });
      if (r && typeof r.catch === 'function') r.catch(() => { trialSession = false; });
    } catch (_) { trialSession = false; }
  }, 350);
}
function trialKeyUp() {
  if (!keyTrial || !trialSession) return;
  // Hold-to-talk semantics: releasing any chord key ends the session.
  if (trialChordHeld()) return;
  trialSession = false;
  try {
    const r = bolo.voiceToggle({ mode: keyTrial.mode });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) {}
}

function trialTextMatch(text, target) {
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const t = words(target);
  if (!t.length) return false;
  const have = new Set(words(text));
  let hit = 0;
  for (const w of t) { if (have.has(w)) hit++; }
  return hit / t.length >= 0.6;
}

// Trials run on the real pipeline, so there is no router binding to open or
// close — ending a trial is just clearing the local state.
function endKeyTrial() {
  if (!keyTrial && !keyConfirming) return;
  keyTrial = null;
  keyConfirming = null;
  trialSession = false;
  // The meter belongs to the trial card that is going away; dropping the
  // reference stops the level stream writing into a detached node.
  trialMeterEl = null;
}

// Shared by the shortcut fan-out (bolo:mode), the local chord detector and
// the skip link: persist the flag, refresh, and open the live trial.
async function markKeyTested(mode) {
  if (!obState || obState.step !== 'three_modes_keys' || abandoned) return;
  const d = (obState.data || {});
  const field = { dictation: 'dictationTriggerTested', edit: 'editTriggerTested', agent: 'agentTriggerTested' }[mode];
  if (!field || keyConfirming === mode) return;
  // Its trial is already on screen — a second press is not a second trial.
  if (keyTrial && keyTrial.mode === mode) return;
  // Already run in this pass: leave the card confirmed and let the user re-run
  // it deliberately with "Try it again". Without this, a press after a
  // completed trial would reopen the trial instead of acting like the key
  // normally does.
  if (keyTrialDone[mode]) return;
  keyConfirming = mode;
  // Persist the confirmation the first time only. A flag left by an earlier run
  // is not permission to refuse the trial — see keyTrialDone.
  if (!d[field]) {
    try { obState = await bolo.obSet({ [field]: true }); } catch (_) {}
  }
  renderThreeModes();
  syncBeatNav();
  startKeyTrial(mode);
}

// Skip link ("my key doesn't work"): mark tested and move on with no trial.
async function skipKey(mode) {
  if (!obState || obState.step !== 'three_modes_keys' || abandoned) return;
  const field = { dictation: 'dictationTriggerTested', edit: 'editTriggerTested', agent: 'agentTriggerTested' }[mode];
  if (!field) return;
  try { obState = await bolo.obSet({ [field]: true }); } catch (_) {}
  // Counts as dealt with for this pass too, so the pager moves on rather than
  // offering the same skipped key again.
  keyTrialDone[mode] = true;
  advanceFromKeyPage();
}

function advanceFromKeyPage() {
  if (abandoned || !obState || obState.step !== 'three_modes_keys') return;
  const dd = (obState.data || {});
  // A key counts as dealt with when it is confirmed AND its trial has been run
  // (or skipped) in this pass. Looking only at the stored flag is what parked
  // the pager with nothing to test.
  const first = MODES.findIndex((mm) => !dd[testedKeyFor(mm)] || !keyTrialDone[mm.mode]);
  if (first < 0) {
    // Everything confirmed — say so once, then sit on the last screen with
    // Continue enabled.
    if (keyPageSpoken !== 'done') {
      keyPageSpoken = 'done';
      say('All three work.', 'Hit Continue when you’re ready.', chosenLanguage || 'en').catch(() => {});
    }
    renderThreeModes();
    syncBeatNav();
    return;
  }
  if (first !== keyPage && !keyPinned) swapKeyPage(first);
  else { renderThreeModes(); syncBeatNav(); }
}

function startKeyTrial(mode) {
  if (!obState || obState.step !== 'three_modes_keys' || abandoned) { keyConfirming = null; return; }
  keyTrial = { mode };
  renderThreeModes();
  syncBeatNav();
  // The real pipeline pastes into whatever has focus, so put the caret in the
  // trial box — otherwise the dictated line lands nowhere visible.
  try {
    const ta = $('beat') && $('beat').querySelector('.demo-textarea');
    if (ta) ta.focus();
  } catch (_) {}
  const lines = TRIAL_INSTRUCTIONS[mode];
  if (mode === 'dictation') {
    if (lines) say(lines[0], lines[1], chosenLanguage || 'en').catch(() => {});
  } else if (mode === 'edit') {
    if (lines) say(lines[0], lines[1], chosenLanguage || 'en').catch(() => {});
  } else if (mode === 'agent') {
    say('Now try it.',
      'Say: open Notepad on your computer.',
      chosenLanguage || 'en').catch(() => {});
  }
}

// A trial landed: say the cool line, move on.
async function completeTrial(mode) {
  if (!keyTrial || keyTrial.mode !== mode) return;
  if (!obState || obState.step !== 'three_modes_keys' || abandoned) { endKeyTrial(); return; }
  keyTrialDone[mode] = true;
  endKeyTrial();
  renderThreeModes();
  syncBeatNav();
  const lines = TRIAL_COOL[mode] || ['Confirmed.', 'Moving on.'];
  try { await say(lines[0], lines[1], chosenLanguage || 'en'); } catch (_) {}
  advanceFromKeyPage();
}

// Slide to another key screen with an exit/enter animation.
function swapKeyPage(next) {
  const b = $('beat');
  if (!b || reduced()) {
    keyPage = next;
    renderThreeModes();
    syncBeatNav();
    return;
  }
  const token = { step: obState && obState.step, from: keyPage, to: next };
  b.classList.add('beat-leaving');
  setTimeout(() => {
    if (!obState || obState.step !== token.step || keyPage !== token.from || abandoned) return;
    keyPage = token.to;
    renderThreeModes();
    syncBeatNav();
    const b2 = $('beat');
    if (!b2) return;
    // showBeat() cleared beat-leaving above; reflow, then enter from the right.
    void b2.offsetWidth;
    b2.classList.add('beat-entering');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b3 = $('beat');
      if (b3) b3.classList.remove('beat-entering');
    }));
  }, 210);
}

// Register the live key listeners once at module scope. The keydown lights the
// matching cap(s); keyup clears only the released one so a held chord stays lit
// until fully released.
window.addEventListener('keydown', (e) => {
  if (keyCapture) { keyCapture.keydown(e); return; }
  const label = capLabelFor(e);
  if (typingInField(e)) {
    // A live trial keeps its caret in the trial box, which would otherwise
    // silence the local chord detector exactly when the trial needs it.
    // Track the chord here so the trial can drive its own session over IPC.
    if (label && keyTrial && !abandoned) {
      if (!downLabels.has(label)) downLabels.add(label);
      trialKeyDown();
    }
    return;
  }
  if (label) {
    lightKeyTest(label);
    if (!downLabels.has(label)) {
      downLabels.add(label);
      maybeChordTested();
    }
  }
}, true);

window.addEventListener('keyup', (e) => {
  if (keyCapture) { try { keyCapture.keyup(e); } catch (_) {} return; }
  const label = capLabelFor(e);
  if (typingInField(e)) {
    if (label && keyTrial) {
      downLabels.delete(label);
      trialKeyUp();
    }
    return;
  }
  if (label) {
    unlightKeyTest(label);
    downLabels.delete(label);
  }
}, true);
window.addEventListener('blur', () => {
  if (litKey && litKey.els) for (const p of litKey.els) { try { p.el.classList.remove('lit'); } catch (_) {} }
  downLabels.clear();
  if (keyCapture) { try { keyCapture.cancel && keyCapture.cancel(); } catch (_) {} keyCapture = null; }
}, true);

// Local chord detector: the current screen's full chord held at once marks it
// tested, no shortcut round-trip needed. Backs the bolo:mode fan-out.
function maybeChordTested() {
  if (!obState || obState.step !== 'three_modes_keys' || abandoned) return;
  if (keyPage < 0 || keyPage >= MODES.length) return;
  const m = MODES[keyPage];
  const parts = accelParts(keyForMode(m.mode)).map((p) => String(p).toLowerCase());
  if (!parts.length) return;
  for (const p of parts) { if (!downLabels.has(p)) return; }
  markKeyTested(m.mode);
}

// One key per screen: a large glyph, a single row of clean keycaps (one label
// per cap — the old two-line cap printed "Ctrl" over "ctrl"), live lighting as
// the chord is pressed, a check on success, dots to revisit, and a skip link.
// Once the chord lands, the card is replaced by the live trial (input box +
// one spoken task); dots, progress and Back keep working around it.
function buildKeyPage(b, m) {
  const d = (obState && obState.data) || {};
  const tested = !!d[testedKeyFor(m)];
  const wrap = b.appendChild(beatEl('div', 'keypage' + (tested ? ' tested' : ''), null));

  // A live trial replaces the keycap card on the confirmed screen.
  if (tested && keyTrial && keyTrial.mode === m.mode) buildKeyTrial(wrap, m);
  else {
    buildKeyCaps(wrap, m, tested);
    // A key confirmed by an earlier run still has to be testable now: the
    // capsule is the thing being shown off on this step, and a card that only
    // says "done" gives no way to reach it. Re-running clears the pass flag so
    // the chord opens a live trial again.
    if (tested) {
      const again = beatEl('button', 'keytrial-btn keyagain', keyTrialDone[m.mode] ? 'Try it again' : 'Run the live test');
      again.type = 'button';
      again.onclick = () => {
        keyTrialDone[m.mode] = false;
        keyConfirming = null;
        startKeyTrial(m.mode);
      };
      wrap.append(again);
    }
  }

  const dots = beatEl('div', 'keypage-dots');
  MODES.forEach((other, i) => {
    const dot = beatEl('button', 'keypage-dot'
      + (i === keyPage ? ' cur' : '')
      + (d[testedKeyFor(other)] ? ' done' : ''), null);
    dot.type = 'button';
    dot.setAttribute('aria-label', other.label + (d[testedKeyFor(other)] ? ' (confirmed)' : ''));
    dot.onclick = () => {
      if (i === keyPage) return;
      if (keyAdvanceTimer) { clearTimeout(keyAdvanceTimer); keyAdvanceTimer = null; }
      endKeyTrial();
      keyPage = i;
      keyPinned = true;
      renderThreeModes();
      syncBeatNav();
    };
    dots.append(dot);
  });
  // Dots live outside the card, in the open space between card and nav.
  b.append(dots);
}

function buildKeyCaps(wrap, m, tested) {
  const keyRow = beatEl('div', 'keypage-keyrow');
  const parts = accelParts(keyForMode(m.mode));
  const allCaps = [];
  litKey = { els: allCaps, timer: null, mark: null };
  for (let i = 0; i < parts.length; i++) {
    if (i) keyRow.append(beatEl('span', 'keypage-plus', '+'));
    const cap = beatEl('div', 'keypage-cap');
    cap.append(beatEl('b', null, prettyAccel(parts[i])));
    const hint = Keys ? Keys.sideHint(parts[i]) : '';
    if (hint) cap.append(beatEl('u', null, hint));
    cap.dataset.part = String(parts[i]);
    allCaps.push({ part: String(parts[i]), el: cap, mode: m.mode });
    keyRow.append(cap);
  }
  wrap.append(keyRow);
}

/* The vertical meter that proves the microphone is live.

   The reference puts one next to the trial and it earns its place twice over. It
   is the only feedback that says "bolo can hear you" before a word has been
   recognised — the capsule is not visible enough while the user is reading the
   card — and it is the fastest way to see that the machine is recording from the
   wrong device: a virtual cable, which some Windows setups have as the default
   recording device, shows a flat zero no matter how loudly you speak, where a
   real microphone moves. */
let trialMeterEl = null;

function renderTrialMeter(level) {
  if (!trialMeterEl || !trialMeterEl.box.isConnected) return;
  const lv = Math.max(0, Math.min(1, Number(level) || 0));
  trialMeterEl.fill.style.height = Math.round(4 + lv * 60) + 'px';
  trialMeterEl.num.textContent = String(Math.round(lv * 100));
}

function buildTrialMeter(wrap) {
  const box = beatEl('div', 'trial-mic');
  const track = beatEl('div', 'trial-mic-track');
  const fill = beatEl('i', null, null);
  track.append(fill);
  const num = beatEl('span', 'trial-mic-num', '0');
  box.append(track, num);
  trialMeterEl = { box, fill, num };
  renderTrialMeter(0);
  wrap.append(box);
}

// Live trial card: input box + one task. Dictation shows the line to say and
// fills as the user speaks; edit reuses the dictated line (or a default) for
// the user to select and rewrite; agent offers the email task when connected,
// otherwise an open-app task, with inline connect buttons.
function buildKeyTrial(wrap, m) {
  const d = (obState && obState.data) || {};

  if (m.mode === 'dictation') {
    wrap.append(beatEl('div', 'keytrial-quote', '“' + TRIAL_TARGET + '”'));
    const ta = beatEl('textarea', 'demo-textarea', (d.dictationDemoText) || '');
    ta.placeholder = 'Hold your Dictation key and say the line — or type it…';
    ta.readOnly = false;
    // Typed counts too: match on every keystroke as well as on voice results.
    ta.addEventListener('input', () => {
      if (!keyTrial || keyTrial.mode !== 'dictation' || abandoned) return;
      if (trialTextMatch(ta.value, TRIAL_TARGET)) {
        keyTrialText.dictation = ta.value;
        completeTrial('dictation');
      }
    });
    // Snapshot so a paste that went to another window can be told apart from
    // one that arrived. See the bolo:injected listener.
    keyTrial.before = ta.value;
    wrap.append(ta);
  } else if (m.mode === 'edit') {
    const seed = keyTrialText.dictation || d.dictationDemoText || d.editDemoText || TRIAL_DEFAULT_EDIT;
    const ta = beatEl('textarea', 'demo-textarea', seed);
    ta.placeholder = '';
    ta.readOnly = false;
    keyTrial.before = seed;
    wrap.append(ta);
    const editCombo = accelParts(keyForMode('edit')).map(prettyAccel).join(' + ');
    wrap.append(beatEl('p', 'bsub', 'Select some text above, then hold ' + editCombo + ' and say how to change it.'));
  } else if (m.mode === 'agent') {
    const agentCombo = accelParts(keyForMode('agent')).map(prettyAccel).join(' + ');
    wrap.append(beatEl('p', 'bsub', 'Hold ' + agentCombo + ' and say: “open Notepad on your computer”.'));
  }

  buildTrialMeter(wrap);
}

function skipTrial() {
  if (abandoned) { endKeyTrial(); return; }
  // Skipping counts as dealt with — otherwise the pager would keep pointing at
  // the key the user just skipped past.
  if (keyTrial) keyTrialDone[keyTrial.mode] = true;
  endKeyTrial();
  advanceFromKeyPage();
}

/* --- 6. dictation demo --------------------------------------------------- */
function renderDictationDemo() {
  showBeat('Dictation',
    'Hold Ctrl+Shift+D and say something. Your words appear here.',
    buildDemo.bind(null, 'dictation', 'The quick brown fox jumps over the lazy dog.', 'insert', 'Typed', 'Typed where your cursor was, punctuation and all.', 'dictationDemoText'));
  try { say('This is Dictation.', 'Hold your key and speak — your words appear here.', chosenLanguage || 'en').catch(() => {}); } catch (_) {}
}

/* --- 7. edit demo -------------------------------------------------------- */
function renderEditDemo() {
  showBeat('Edit',
    'Select text in the box below, then hold Ctrl+Shift+E and say how to change it.',
    buildDemo.bind(null, 'edit', 'Make it sound excited', 'edit', 'Rewrote', 'Rewrote your selection in place.', 'editDemoText'));
  try { say('This is Edit.', 'Select text, then say how to change it.', chosenLanguage || 'en').catch(() => {}); } catch (_) {}
}

function buildDemo(step, sampleWords, intent, label, doneMsg, storeKey) {
  const b = $('beat');
  const d = obState.data || {};
  const existing = d[storeKey] || '';

  if (step === 'edit' && !existing) {
    b.append(beatEl('p', 'bsub', 'Try selecting some text and rewriting it.'));
  }

  const ta = beatEl('textarea', 'demo-textarea', existing);
  ta.placeholder = step === 'dictation' ? 'Hold your key and speak — your words land here…' : '';
  // Editable on purpose: the real pipeline pastes into the focused box, so the
  // box has to take a paste. Focus it so the words land here, not elsewhere.
  ta.readOnly = false;
  ta.minLength = 1;
  b.append(ta);
  try { ta.focus(); } catch (_) {}
}

/* --- 8. agent demo (terminal — Finish completes onboarding) ------------------ */
function renderAgentTry() {
  showBeat('Do a task with your voice',
    'Open Notepad on your computer',
    buildAgentDemo);
  try { say('Last one — Agent.', 'Say it and I’ll do it. Press Finish when you’re done.', chosenLanguage || 'en').catch(() => {}); } catch (_) {}
}

function buildAgentDemo(b) {
  const ta = beatEl('textarea', 'demo-textarea', 'Open Notepad on your computer');
  ta.readOnly = true;
  b.append(ta);
  // No demo binding: the agent runs for real here, same as after onboarding.
}

const RENDERERS = {
  system_permissions: renderPermissions,
  three_modes_keys: renderThreeModes,
  dictation_demo: renderDictationDemo,
  edit_demo: renderEditDemo,
  agent_mode_try: renderAgentTry
};

let obNextReady = false;

function canAdvance() {
  const d = (obState && obState.data) || {};
  const step = obState ? obState.step : STEPS[0];
  if (step === 'three_modes_keys') {
    return !!(d.agentTriggerTested && d.editTriggerTested && d.dictationTriggerTested);
  }
  if (step === 'system_permissions') {
    return !!(d.micGranted && d.accessibilityGranted);
  }
  // agent_mode_try is the last step — Continue finishes onboarding.
  if (step === 'agent_mode_try') return true;
  return true;
}

function syncBeatNav() {
  const back = $('beatBack');
  const go = $('beatGo');
  const skip = $('beatSkip');
  if (back) back.hidden = !obState || obState.stepIndex <= firstIntroIndex();
  obNextReady = canAdvance();
  if (go) go.disabled = !obNextReady;
  if (go) go.textContent = isLastIntroStep() ? 'Finish' : 'Continue';
  if (go) go.title = (!obNextReady && obState && obState.step === 'three_modes_keys')
    ? 'Confirm all three keys to continue'
    : '';
  // Trial skip lives left of Continue, as plain text — for the whole key step:
  // pre-trial it skips the current key, mid-trial it skips the trial.
  if (skip) skip.hidden = !(obState && obState.step === 'three_modes_keys');
}

async function renderOb() {
  if (!obState) return;
  syncDemoMode();
  const step = obState.step;
  if (step !== 'three_modes_keys') {
    keyPageSpoken = -1;
    keyPinned = false;
    keyTestedSig = '';
    endKeyTrial();
    if (keyAdvanceTimer) { clearTimeout(keyAdvanceTimer); keyAdvanceTimer = null; }
  } else if (renderOb._lastStep !== step) {
    // Fresh entry to the pager (not a bounce): every key can be tested again,
    // and the step opens on the first one worth doing.
    resetKeyTrials();
    const dd = (obState.data || {});
    let first = MODES.findIndex((mm) => !dd[testedKeyFor(mm)] || !keyTrialDone[mm.mode]);
    if (first < 0) first = 0;
    keyPage = first;
  }
  renderOb._lastStep = step;
  const renderer = RENDERERS[step];
  if (step !== 'system_permissions' && techCheckTimer) { clearTimeout(techCheckTimer); techCheckTimer = null; }
  if (renderer) renderer();
  else {
    // Pre-intro steps (name/language) have no beat here — handoff() advances
    // past them, but a Back bounce can still land on one. Step forward instead
    // of rendering blank.
    try { obState = await bolo.obNext(); } catch (_) {}
    const retry = RENDERERS[obState && obState.step];
    if (retry) retry();
    else showBeat('Let’s get you set up.', '', null);
  }
  syncBeatNav();
}

function obOnboarding(state) {
  obState = state;
  renderOb();
}

async function handoff() {
  phase('handoff');
  const fade = $('fadeout');
  document.body.classList.add('leaving');
  if (fade) fade.classList.add('on');
  await wait(reduced() ? 120 : 620);
  // The beats live in this same window over the same scrim — lift the
  // crossfade so the stage (and #beat inside it) is visible again. `leaving`
  // + black fadeout assumed a cut to the dashboard; keeping them would bury
  // every beat under opaque black.
  document.body.classList.remove('leaving');
  if (fade) fade.classList.remove('on');
  // Beats layout: narrated lines above the pane (see body.beats rules).
  document.body.classList.add('beats');

  // Hand control of the screen to the onboarding beats. They render inside this
  // same intro window so first-run reads as one continuous sequence. The dashboard
  // stays hidden behind us.
  try { obState = await bolo.obGet(); } catch (_) { obState = null; }
  renderOb();
  // Tell main the intro narration is over and the onboarding beats are live, so
  // the watchdog can disarm and the dashboard can come forward if the window
  // closes. finish() is what actually hides us and shows main — that only happens
  // when the user reaches Finish on the last step.
  try { bolo.introPhase('beats'); } catch (_) {}
}

/* ---------------------------------------------------------------------------
   Chrome — wired in isolation: a failure here must not stop the sequence.
   ------------------------------------------------------------------------ */
try {
  $('getStarted').addEventListener('click', async () => {
    const btn = $('getStarted');
    btn.disabled = true;
    $('gate').classList.add('gone');
    if (abandoned) return;

    await askName();
    if (abandoned) return;

    await askLanguage();
    if (abandoned) return;

    await handoff();
  });

  // Beat navigation — wired after the handoff so the listeners exist even if the
  // user bounces back from a later step.
  const beatBack = $('beatBack');
  const beatGo = $('beatGo');
  const beatSkip = $('beatSkip');
  if (beatSkip) beatSkip.addEventListener('click', async () => {
    if (keyTrial) { skipTrial(); return; }
    if (obState && obState.step === 'three_modes_keys' && MODES[keyPage]) {
      await skipKey(MODES[keyPage].mode);
    }
  });
  if (beatBack) beatBack.addEventListener('click', async () => {
    if (!obState) return;
    // Inside the key pager, Back walks the key screens (Agent → Edit →
    // Dictation) instead of dropping to the permissions beat — which would
    // auto-pass and bounce straight back here, reading as a restart.
    if (obState.step === 'three_modes_keys' && keyPage > 0) {
      endKeyTrial();
      keyPage -= 1;
      keyPinned = true;
      renderThreeModes();
      syncBeatNav();
      return;
    }
    if (obState.stepIndex <= firstIntroIndex()) return;
    endKeyTrial();
    try { obState = await bolo.obBack(); } catch (_) {}
    renderOb();
  });
  if (beatGo) beatGo.addEventListener('click', async () => {
    if (!obState) return;
    if (isLastIntroStep()) {
      // Finish is the terminal step — that is what hands off to the dashboard.
      try { if (demoStep && bolo.obDemoEnd) await bolo.obDemoEnd().catch(() => {}); } catch (_) {}
      demoStep = null;
      try { endKeyTrial(); } catch (_) {}
      try { await bolo.introFinish('completed'); } catch (_) {}
    } else {
      endKeyTrial();
      try { obState = await bolo.obNext(); } catch (_) {}
      renderOb();
    }
  });
} catch (e) {
  reportError('intro chrome failed to wire', e.message);
}

try {
  if (synth) {
    synth.getVoices();
    synth.onvoiceschanged = () => synth.getVoices();
  }
} catch (_) { /* voices stay at the platform default */ }

try {
  bolo.on('bolo:intro-phase', (p) => {
    if (!p) return;
    if (typeof p.sounds === 'boolean') {
      muted = !p.sounds;
      if (muted) {
        try { if (synth) synth.cancel(); } catch (_) {}
        try { if (window.boloAudio) window.boloAudio.stop(); } catch (_) {}
      }
    }
    if (p.phase === 'handoff') {
      // No-op: beats render in this window over the scrim. Blacking the
      // fadeout here would bury them (see handoff()).
    }
  });

  // Keep the local obState in lockstep with the main process store — the key-check
  // caps, the "Yes" confirmation on each mode card, and Continue are all gated on
  // it. main.js broadcasts bolo:onboarding after every obSet/obNext/obBack.
  bolo.on('bolo:onboarding', obOnboarding);

  // Edit trial completion on the real pipeline: the rewrite is pasted into the
  // focused trial box, and voice.js reports the injection.
  //
  // `systemWide` means the keystroke was sent, not that it arrived *here*: the
  // pipeline pastes into whatever window has the foreground, and Windows will
  // not let a background process take it, so with another app focused the text
  // lands there while every layer reports success. The box is the only evidence
  // that a human can see, so the box is what decides — a trial the user cannot
  // observe is not a passing trial. Dictation needs no completion here: the
  // pasted line fires the box's own input matcher.
  bolo.on('bolo:injected', (r) => {
    if (!keyTrial || abandoned) return;
    if (!obState || obState.step !== 'three_modes_keys') return;
    if (!r || !r.ok || !r.systemWide) return;
    const ta = $('beat') && $('beat').querySelector('.demo-textarea');
    // Only the two trials that type into a box can be judged by one; the agent
    // trial has no box and its own listener decides.
    if (!ta) return;
    const landed = ta.value !== keyTrial.before;
    if (!landed) {
      const st = $('keyStatus');
      if (st) st.textContent = 'Your words didn’t land in the box — click it and try again.';
      // The capsule is not where the user is looking, and the paste did work,
      // so this is worth a line on the surface they are looking at.
      showSetupError('bolo could not type into the box', 'click into it and speak again');
      return;
    }
    if (keyTrial.mode === 'edit') completeTrial('edit');
  });

  // Agent trial completion: any carried-out action counts. A failure keeps the
  // trial open with a hint (plus the skip link) rather than advancing on a
  // claim that is not true.
  bolo.on('bolo:answer', (a) => {
    if (!keyTrial || keyTrial.mode !== 'agent') return;
    if (!obState || obState.step !== 'three_modes_keys' || abandoned) return;
    if (!a || a.intent !== 'act') return;
    // `pending: true` is a confirmation card, not a finished action: the
    // critical-tool path (email, calendar, file write) reports `ok: true`
    // with a `pending` flag so the caller can say "yes" to actually run it.
    // Counting that as a passing trial would complete it on the promise
    // rather than the delivery.
    if (a.pending) return;
    if (a.ok) completeTrial('agent');
    else {
      const st = $('keyStatus');
      if (st) st.textContent = 'That didn’t run — try again, or skip the trial.';
    }
  });

  // Auto-mark a mode key as tested when its shortcut fires on three_modes_keys.
  bolo.on('bolo:mode', (payload) => {
    if (!obState || obState.step !== 'three_modes_keys') return;
    const mm = payload && payload.mode;
    if (!mm || !KEY_CONFIRMS[mm]) return;
    markKeyTested(mm);
  });

  // Voice/mic failures while setup is running, painted here because this is the
  // window the user is looking at. See showSetupError.
  if (typeof bolo.onSetupError === 'function') {
    bolo.onSetupError((p) => showSetupError(p && p.message, p && p.detail));
  }

  // The live input level, driving the trial's meter. `level` is 0…1, reported
  // from the real microphone in the hidden capture window.
  bolo.on('bolo:voice-level', (p) => {
    const lv = typeof p === 'number' ? p : (p && p.level) || 0;
    renderTrialMeter(lv);
  });

  // Put the caret back in the trial box the moment a session actually starts.
  //
  // The real pipeline types into the foreground window, and Windows will not let
  // this process take the foreground on its own — so a click elsewhere, a look
  // at the taskbar or the capsule itself can leave the words going to another
  // app, where the user cannot see them. Re-asserting focus when recording
  // begins, rather than only when the card was built, closes that gap.
  bolo.on('bolo:voice-state', (st) => {
    lastVoiceState = (st && st.state) || 'idle';
    if (!keyTrial || abandoned) return;
    if (!st || (st.state !== 'listening' && st.state !== 'routing')) return;
    try { window.focus(); } catch (_) {}
    const ta = $('beat') && $('beat').querySelector('.demo-textarea');
    if (ta && document.activeElement !== ta) { try { ta.focus(); } catch (_) {} }
  });
} catch (e) {
  reportError('intro phase listener failed', e.message);
}

// Dispatched on a timer rather than inline: if anything above threw, this still
// runs, so the opening never becomes a dead end.
setTimeout(() => {
  open().catch((e) => reportError('opening sequence failed', e.message));
}, 0);
