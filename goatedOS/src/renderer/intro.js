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
  'agent_mode_connect',
  'agent_mode_try',
  'refer_a_friend'
];
let curIndex = -1;

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
  // Paint the blurred desktop before anything brightens, so the scrim fades in
  // over the finished backdrop rather than over a sharp one.
  try {
    const shot = bolo.introDesktop ? await bolo.introDesktop() : null;
    const img = $('backdropImg');
    const bd = $('backdrop');
    if (shot && shot.ok && shot.dataUrl && img && bd) {
      img.src = shot.dataUrl;
      bd.classList.add('have');
    }
  } catch (_) { /* dimming the live desktop is a perfectly good fallback */ }

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
   the machine calls commit on Continue. Demo beats also call obDemoStart/end via
   the shared bridge.
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
  if (back) back.hidden = obState.stepIndex <= 0;
  if (go) go.disabled = !obNextReady;
}

/* --- 4. permissions ------------------------------------------------------ */
function renderPermissions() {
  const b = showBeat('Enable core features',
    'A few one-time permissions so bolo can listen, type, and see your screen.',
    buildPerms);
  return b;
}

const TICK_TEXT = '✓';
function buildPerms(b) {
  const d = obState.data || {};
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

  perm(
    d.micGranted ? 'Microphone permission granted.' : 'Allow the microphone',
    d.micGranted ? 'Your speech will be transcribed.' : 'bolo only listens while you hold your key.',
    !!d.micGranted,
    async () => { obState = await bolo.obSet({ micGranted: true }); renderPermissions(); }
  );

  perm(
    d.accessibilityGranted ? 'Accessibility permission granted.' : 'Allow accessibility',
    d.accessibilityGranted ? 'bolo can insert and edit text.' : 'So your words can be typed into other apps.',
    !!d.accessibilityGranted,
    async () => { obState = await bolo.obSet({ accessibilityGranted: true }); renderPermissions(); }
  );

  const screenGranted = !!d.micGranted && !!d.accessibilityGranted;
  perm(
    screenGranted ? 'Screen permission granted.' : 'Allow bolo to see your screen.',
    screenGranted
      ? 'Agent Mode can answer questions about your screen.'
      : 'Only when you ask Agent Mode for help. Screenshots are never stored or shared.',
    screenGranted,
    null
  );
}

/* --- 5. three modes ------------------------------------------------------ */
function renderThreeModes() {
  showBeat('Three keys, three modes',
    'Press each key once to confirm it works, or rebind below.',
    buildModes);
}

const MODES = [
  { mode: 'dictation', label: 'Dictation', glyph: '🖊' },
  { mode: 'edit', label: 'Edit', glyph: '✎' },
  { mode: 'agent', label: 'Agent', glyph: '★' }
];

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

// Register the live key listeners once at module scope. The keydown lights the
// matching cap(s); keyup clears only the released one so a held chord stays lit
// until fully released.
window.addEventListener('keydown', (e) => {
  if (keyCapture) { keyCapture.keydown(e); return; }
  if (typingInField(e)) return;
  const label = capLabelFor(e);
  if (label) lightKeyTest(label);
}, true);

window.addEventListener('keyup', (e) => {
  if (keyCapture) return;
  if (typingInField(e)) return;
  const label = capLabelFor(e);
  if (label) unlightKeyTest(label);
}, true);

// Render keycaps that light up when the user presses the mode's activation key.
// Each cap is a { part, el } pair tracked in the shared litKey map so a keydown
// lights only its own cap, not the whole row. The "Yes" button on each card
// marks that key confirmed in the store and re-renders to show the checkmark.
function buildModes(b) {
  const d = obState.data || {};
  const row = b.appendChild(beatEl('div', 'modes'));
  // Collect all keycap pairs across all three cards so the live keydown listener
  // can light the right one regardless of which card it belongs to.
  const allCaps = [];
  litKey = { els: allCaps, timer: null, mark: null };

  for (const m of MODES) {
    const tested = d[testedKeyFor(m)];
    const card = beatEl('div', 'mode-card' + (tested ? ' tested' : ''), null);
    card.append(beatEl('div', 'mode-glyph', m.glyph));
    card.append(beatEl('div', 'mode-name', m.label));
    const keyRow = beatEl('div', 'mode-keyrow');
    const parts = accelParts(keyForMode(m.mode));
    for (let i = 0; i < parts.length; i++) {
      if (i) keyRow.append(beatEl('span', 'mode-plus', '+'));
      const cap = beatEl('div', 'mode-cap');
      cap.append(beatEl('b', null, prettyAccel(parts[i])));
      cap.append(beatEl('i', null, String(parts[i]).toLowerCase()));
      const hint = Keys ? Keys.sideHint(parts[i]) : '';
      if (hint) cap.append(beatEl('u', null, hint));
      cap.dataset.part = String(parts[i]);
      allCaps.push({ part: String(parts[i]), el: cap, mode: m.mode });
      keyRow.append(cap);
    }
    card.append(keyRow);
    if (tested) card.append(beatEl('span', 'mode-check', TICK));
    const yes = beatEl('button', 'mode-yes', 'Yes');
    yes.type = 'button';
    yes.disabled = !!tested;
    yes.onclick = async () => {
      yes.disabled = true;
      await bolo.obSet({ [testedKeyFor(m)]: true });
      renderThreeModes();
    };
    card.append(yes);
    row.append(card);
  }
}

/* --- 6. dictation demo --------------------------------------------------- */
function renderDictationDemo() {
  showBeat('Dictation',
    'Press Ctrl+Shift+D and say something. Your words appear here.',
    buildDemo.bind(null, 'dictation', 'The quick brown fox jumps over the lazy dog.', 'insert', 'Typed', 'Typed where your cursor was, punctuation and all.', 'dictationDemoText'));
}

/* --- 7. edit demo -------------------------------------------------------- */
function renderEditDemo() {
  showBeat('Edit',
    'Select text in the box below, then press Ctrl+Shift+E and say how to change it.',
    buildDemo.bind(null, 'edit', 'Make it sound excited', 'edit', 'Rewrote', 'Rewrote your selection in place.', 'editDemoText'));
}

function buildDemo(step, sampleWords, intent, label, doneMsg, storeKey) {
  const b = $('beat');
  const d = obState.data || {};
  const existing = d[storeKey] || '';

  if (step === 'edit' && !existing) {
    b.append(beatEl('p', 'bsub', 'Try selecting some text and rewriting it.'));
  }

  const ta = beatEl('textarea', 'demo-textarea', existing);
  ta.placeholder = step === 'dictation' ? 'Your dictated text will land here…' : '';
  ta.readOnly = true;
  ta.minLength = 1;
  b.append(ta);

  bolo.obDemoStart(step);
}

/* --- 8. agent / email ---------------------------------------------------- */
function renderAgentConnect() {
  showBeat('Let’s connect your email',
    'Choose one email account. You can change it later.',
    buildEmail);
}

const GMAIL_SVG = '<svg viewBox="0 0 34 26" width="34" height="26"><path fill="#4285f4" d="M2.4 25h5V12.2L0 6.5V22.6A2.4 2.4 0 0 0 2.4 25z"/><path fill="#34a853" d="M26.6 25h5a2.4 2.4 0 0 0 2.4-2.4V6.5l-7.4 5.7z"/><path fill="#fbbc04" d="M26.6 2.9v9.3L34 6.5V4.1c0-3-3.4-4.7-5.8-2.9z"/><path fill="#ea4335" d="M7.4 12.2V2.9L17 10.1l9.6-7.2v9.3L17 19.4z"/><path fill="#c5221f" d="M0 4.1v2.4l7.4 5.7V2.9L5.8 1.2C3.4-.6 0 1.1 0 4.1z"/></svg>';
const OUTLOOK_SVG = '<svg viewBox="0 0 39 33" width="39" height="33"><defs><linearGradient id="ol" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#28a8ea"/><stop offset="1" stop-color="#0f6cbd"/></linearGradient></defs><rect x="12" y="3" width="27" height="27" rx="3" fill="url(#ol)"/><rect x="0" y="8" width="16" height="17" rx="2.4" fill="#0f6cbd"/><ellipse cx="8" cy="16.5" rx="4.4" ry="5" fill="none" stroke="#fff" stroke-width="2.2"/></svg>';

function buildEmail(b) {
  const d = obState.data || {};
  const tiles = b.appendChild(beatEl('div', 'tiles'));
  const tile = (name, sel, svg, sub) => {
    const t = beatEl('button', 'tile' + (sel ? ' sel' : ''), name);
    t.type = 'button';
    const l = beatEl('div', 'tile-logo');
    l.insertAdjacentHTML('beforeend', svg);
    t.append(l);
    t.append(beatEl('div', 'tile-sub', sub));
    return t;
  };
  const g = tile('Gmail', d.agentConnectedApp === 'gmail', GMAIL_SVG, d.agentConnectedApp === 'gmail' ? 'Connected' : 'Connect');
  const o = tile('Outlook', d.agentConnectedApp === 'outlook', OUTLOOK_SVG, d.agentConnectedApp === 'outlook' ? 'Connected' : 'Connect');
  g.onclick = async () => {
    if (d.agentConnectedApp === 'gmail') return;
    g.disabled = true;
    const r = await bolo.gmailConnect();
    if (!r || !r.ok) { g.disabled = false; return; }
    obState = await bolo.obSet({ agentConnectedApp: 'gmail' });
    buildEmail($('beat'));
  };
  o.onclick = async () => {
    obState = await bolo.obSet({ agentConnectedApp: 'outlook' });
    buildEmail($('beat'));
  };
  tiles.append(g, o);
}

/* --- 9. agent demo ------------------------------------------------------- */
function renderAgentTry() {
  showBeat('Do a task with your voice',
    'Send an email to the bolo team saying I completed my first task',
    buildAgentDemo);
}

function buildAgentDemo(b) {
  const ta = beatEl('textarea', 'demo-textarea', 'Send an email to the bolo team saying I completed my first task');
  ta.readOnly = true;
  b.append(ta);
  bolo.obDemoStart('agent');
}

/* --- 10. refer ----------------------------------------------------------- */
function renderRefer() {
  showBeat('That’s everything',
    'You’re set up. Press your voice key anywhere and speak — anything you picked here can change later in Settings.',
    null);
}

const RENDERERS = {
  system_permissions: renderPermissions,
  three_modes_keys: renderThreeModes,
  dictation_demo: renderDictationDemo,
  edit_demo: renderEditDemo,
  agent_mode_connect: renderAgentConnect,
  agent_mode_try: renderAgentTry,
  refer_a_friend: renderRefer
};

let obNextReady = false;

function canAdvance() {
  const d = (obState && obState.data) || {};
  const step = obState ? obState.step : STEPS[0];
  if (step === 'three_modes_keys') {
    return !!(d.agentTriggerTested && d.editTriggerTested && d.dictationTriggerTested);
  }
  // refer_a_friend is the last step — Continue finishes onboarding.
  if (step === 'refer_a_friend') return true;
  return true;
}

function syncBeatNav() {
  const back = $('beatBack');
  const go = $('beatGo');
  if (back) back.hidden = !obState || obState.stepIndex <= 0;
  obNextReady = canAdvance();
  if (go) go.disabled = !obNextReady;
  if (go) go.textContent = obState && obState.stepIndex === Math.max(0, STEPS.length - 1) ? 'Finish' : 'Continue';
}

async function renderOb() {
  if (!obState) return;
  const step = obState.step;
  const renderer = RENDERERS[step];
  if (renderer) renderer();
  syncBeatNav();
}

function obOnboarding(state) {
  obState = state;
  renderOb();
}

function obDemoResult(payload) {
  if (!payload) return;
  const { text, intent } = payload;
  const t = String(text || '');
  const ta = $('beat') && $('beat').querySelector('.demo-textarea');
  if (!ta) return;
  if (intent === 'insert') {
    ta.value = ta.value + t;
    ta.scrollTop = ta.scrollHeight;
  } else if (intent === 'edit') {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + t + ta.value.slice(end);
  }
  if (obState) {
    const key = intent === 'edit' ? 'editDemoText' : 'dictationDemoText';
    bolo.obSet({ [key]: ta.value }).catch(() => {});
  }
}

async function handoff() {
  phase('handoff');
  const fade = $('fadeout');
  document.body.classList.add('leaving');
  if (fade) fade.classList.add('on');
  await wait(620);

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

function skipIntro() {
  if (abandoned) return;
  abandoned = true;
  try { if (synth) synth.cancel(); } catch (_) {}
  try { if (window.boloAudio) window.boloAudio.stop(); } catch (_) {}
  try { bolo.introFinish('skipped'); } catch (_) {}
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

  $('skip').addEventListener('click', skipIntro);

  // Escape leaves from any beat, including one waiting on something that never
  // arrives.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') skipIntro();
  });

  // Beat navigation — wired after the handoff so the listeners exist even if the
  // user bounces back from a later step.
  const beatBack = $('beatBack');
  const beatGo = $('beatGo');
  if (beatBack) beatBack.addEventListener('click', async () => {
    if (!obState || obState.stepIndex <= 0) return;
    try { obState = await bolo.obBack(); } catch (_) {}
    renderOb();
  });
  if (beatGo) beatGo.addEventListener('click', async () => {
    if (!obState) return;
    const isLast = obState.stepIndex >= STEPS.length - 1;
    if (isLast) {
      // Finish is the terminal step — that is what hands off to the dashboard.
      try { await bolo.introFinish('completed'); } catch (_) {}
    } else {
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
      const fade = $('fadeout');
      if (fade) fade.classList.add('on');
    }
  });

  // Keep the local obState in lockstep with the main process store — the key-check
  // caps, the "Yes" confirmation on each mode card, and Continue are all gated on
  // it. main.js broadcasts bolo:onboarding after every obSet/obNext/obBack.
  bolo.on('bolo:onboarding', obOnboarding);

  // The blurred desktop still the intro captured, so the onboarding beats wear the
  // same translucent scrim the narration did. Only forwarded when the intro
  // actually captured one; the CSS variable falls back to a solid colour otherwise.
  bolo.on('bolo:ob-bg', (payload) => {
    if (payload && payload.dataUrl) {
      const bd = $('backdrop');
      if (bd) bd.style.setProperty('--ob-bg-image', 'url(' + payload.dataUrl + ')');
    }
  });

  // During the dictation/edit demo steps, a voice result is routed back to this
  // window instead of being pasted into the foreground app, so it lands in the
  // beat's textarea rather than in whatever the user has open behind it.
  bolo.on('bolo:ob-demo-result', obDemoResult);

  // Auto-mark a mode key as tested when its key is pressed on three_modes_keys.
  bolo.on('bolo:mode', (payload) => {
    if (!obState || obState.step !== 'three_modes_keys') return;
    const m = payload && payload.mode;
    const field = { dictation: 'dictationTriggerTested', edit: 'editTriggerTested', agent: 'agentTriggerTested' }[m];
    if (!field) return;
    bolo.obSet({ [field]: true }).then((s) => { obState = s; renderOb(); });
  });
} catch (e) {
  reportError('intro phase listener failed', e.message);
}

// Dispatched on a timer rather than inline: if anything above threw, this still
// runs, so the opening never becomes a dead end.
setTimeout(() => {
  open().catch((e) => reportError('opening sequence failed', e.message));
}, 0);
