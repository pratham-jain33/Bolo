const settings = require('./settings');
const audio = require('./audio');
const stt = require('./stt');
const keys = require('./keys');

// Wake word.
//
// This used to be a stub that fired on any sustained loudness, because a level
// cannot tell "someone is talking" from "someone said the phrase". It can't —
// so the level is no longer asked to. The work is split where the information
// actually is:
//
//   1. The gate (local, free, always on). An adaptive noise floor over the
//      capture window's level stream decides *when* someone is speaking. It is
//      what keeps the recogniser from being called on room tone, and it is the
//      only part of this that runs continuously.
//
//   2. The recogniser (Groq whisper, the same model and key as dictation). A
//      short clip is transcribed with the wake phrase as a decoding prompt, and
//      the transcript is matched against the phrase. This is what turns "speech
//      happened" into "the user said the words", which is the whole feature.
//
// The clip is requested at the *onset* of speech, not after it — waiting for the
// end of the phrase would mean recording the phrase after it had been said. The
// gate then keeps checking loudness while that clip records, and a run too short
// to be a word is thrown away without spending a transcription.
//
// `setMatcher` is still here: a different recogniser (a local keyword spotter, a
// cloud one) is a one-function swap, and the phrase is handed to it untouched.

// How long loudness must stay up before the clip is worth transcribing.
const MIN_SPEECH_MS = 180;
// A run with no level at all is not a run.
const STALE_MS = 4000;
// Ignore re-triggers right after firing.
const COOLDOWN_MS = 2500;
// Floor on how often the recogniser may be called, matching or not. One
// transcription per utterance is the point; one per syllable is a bill.
const MIN_ATTEMPT_GAP_MS = 1200;
// How much audio is handed to the recogniser. Long enough for "hey bolo, what's
// the weather" to be caught whole from its first frame, short enough that the
// upload is trivial.
const CLIP_MS = 1800;
// The margin over the noise floor that counts as speech, at sensitivity 0 and 1.
const MARGIN_LOUD = 0.22;
const MARGIN_QUIET = 0.06;
// Floor movement. Rising slowly is what stops a passing lorry from raising the
// floor above the user's voice; falling faster lets the gate recover in a room
// that has just gone quiet.
const FLOOR_RISE = 0.02;
const FLOOR_FALL = 0.06;
const FLOOR_SEED = 0.02;

let running = false;
let timer = null;
let onWake = null;
let lastFiredAt = 0;
let lastAttemptAt = 0;
let previousLevelListener = null;

let floor = FLOOR_SEED;     // the room, as the gate currently believes it to be
let speakingSince = null;   // when the current run of loudness started
let clipBusy = false;       // a clip is in flight
let last = null;            // the last recogniser result, for getState()
let custom = null;          // a swapped-in matcher, if any

// Injected by main.js rather than required, so this file has no edge to the
// voice machine and cannot take part in a require cycle with it.
let busyCheck = () => false;

function setBusyCheck(fn) {
  busyCheck = typeof fn === 'function' ? fn : () => false;
}

function sensitivity() {
  const s = Number(settings.get('wakeSensitivity'));
  return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0.6;
}

function margin() {
  // Higher sensitivity means a smaller margin over the room, i.e. easier to trip.
  return MARGIN_LOUD - sensitivity() * (MARGIN_LOUD - MARGIN_QUIET);
}

function phrase() {
  return String(settings.get('wakePhrase') || 'hey bolo').trim() || 'hey bolo';
}

function ready() {
  return keys.has('groq');
}

/* ---------------------------------------------------------------------------
   Matching

   Whisper on a two-word clip is confident but not literal: it renders the same
   phrase as "hey bolo", "Hey, Bolo.", "hey bollo" or "a bolo" depending on the
   room. An exact string compare would miss most of those, so the comparison is
   edit distance over the normalised text, plus a containment check so a phrase
   said mid-sentence still counts.
   ------------------------------------------------------------------------ */

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 0;
  return 1 - levenshtein(a, b) / longest;
}

// The best score for `phrase` against any equally-long window of `heard`, so
// "hey bolo can you" scores as "hey bolo" rather than as a 15-character
// mismatch. Falls back to the whole-string score when the phrase is longer than
// what was heard.
function scoreAgainst(heard, want) {
  const h = normalize(heard);
  const w = normalize(want);
  if (!h || !w) return 0;

  const hw = h.split(' ');
  const ww = w.split(' ');
  if (hw.length < ww.length) return similarity(h, w);

  let best = 0;
  for (let i = 0; i + ww.length <= hw.length; i++) {
    const s = similarity(hw.slice(i, i + ww.length).join(' '), w);
    if (s > best) best = s;
  }
  return best;
}

// "bolo" is one word, and the recogniser's near misses of it are predictable.
// Only the final word is varied: the leading word of a phrase is usually heard
// correctly, and broadening it would start matching "hey" alone in ordinary
// speech. Kept short and literal on purpose — a homophone list is a false-accept
// budget, and this spends it only where whisper actually errs.
const HOMOPHONES = {
  bolo: ['bollo', 'bolo', 'boloh', 'volo', 'bola', 'bolu'],
  bollo: ['bolo', 'bollo']
};

function variants(want) {
  const parts = normalize(want).split(' ');
  const tail = parts[parts.length - 1];
  const list = HOMOPHONES[tail];
  if (!list) return [want];
  const head = parts.slice(0, -1);
  return list.map((v) => head.concat(v).join(' '));
}

function bestMatch(heard) {
  const want = phrase();
  const threshold = 0.92 - sensitivity() * 0.28;
  let best = { score: 0, against: want, mode: 'phrase' };
  for (const v of variants(want)) {
    const s = scoreAgainst(heard, v);
    if (s > best.score) best = { score: s, against: v, mode: 'phrase' };
  }

  // Being addressed by name is the other half of what a wake word is. "Hey
  // bolo" scores on its own above; "okay bolo, what time is it" and a clipped
  // "a bolo" do not, and both are unmistakably the user talking to the app.
  // So the name alone, near the start of the utterance, is a match — the same
  // rule a commercial wake word uses, and the reason it is limited to the first
  // two words: a wake word that fires from the middle of a sentence fires on
  // other people's conversations.
  const address = addressScore(heard);
  if (address > best.score) best = { score: address, against: want, mode: 'address' };

  return { ...best, threshold, matched: best.score >= threshold };
}

// Words that are only ever the tail of a phrase, never a name to be called.
// Without this a phrase like "hey there" would fire on "there is a problem".
const NOT_A_NAME = new Set([
  'there', 'here', 'this', 'that', 'it', 'you', 'your', 'is', 'are', 'was', 'and',
  'the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'at', 'me', 'my', 'we', 'us'
]);

// How likely it is that the user was addressing the app by name. 0 means no.
function addressScore(heard) {
  const h = normalize(heard).split(' ').filter(Boolean);
  if (!h.length) return 0;

  const words = normalize(phrase()).split(' ').filter(Boolean);
  const name = words[words.length - 1];
  if (!name || name.length < 3 || NOT_A_NAME.has(name)) return 0;

  const names = HOMOPHONES[name] || [name];
  const head = h.slice(0, Math.min(2, h.length));
  return head.some((w) => names.includes(w)) ? 0.9 : 0;
}

/* ---------------------------------------------------------------------------
   The gate
   ------------------------------------------------------------------------ */

function threshold() {
  return Math.min(0.95, floor + margin());
}

function updateFloor(level) {
  // Only quiet samples move the floor: a loud one is the thing being detected,
  // not the thing to measure the room with.
  if (level <= floor) floor += (level - floor) * FLOOR_FALL * 4;
  else if (level < threshold()) floor += (level - floor) * FLOOR_RISE;
  floor = Math.max(0.002, Math.min(0.5, floor));
}

async function attempt(reason) {
  const now = Date.now();
  lastAttemptAt = now;
  const started = now;

  const clip = await audio.clip(CLIP_MS);
  if (!clip.ok) {
    last = { at: now, ok: false, error: clip.error, heard: null, score: 0 };
    return;
  }

  // The run has to have lasted long enough to be a word. This is the cheap
  // filter that stops a door slam from costing a transcription, and it is
  // checked *after* the clip so the audio still starts at the onset.
  const sustained = speakingSince === null ? 0 : Date.now() - speakingSince;
  if (sustained < MIN_SPEECH_MS && reason !== 'manual') {
    last = { at: now, ok: false, error: 'too-short', heard: null, score: 0 };
    return;
  }

  const r = await stt.transcribe(clip.buffer, { mime: clip.mime, prompt: phrase() });
  if (!r || !r.ok) {
    last = { at: now, ok: false, error: (r && r.error) || 'transcribe-failed', heard: null, score: 0 };
    return;
  }

  const heard = r.text || '';
  const m = bestMatch(heard);
  last = {
    at: now, ok: true, heard, score: Number(m.score.toFixed(3)),
    against: m.against, mode: m.mode, matched: m.matched, ms: Date.now() - started
  };

  if (!m.matched) return;
  if (Date.now() - lastFiredAt < COOLDOWN_MS) return;

  lastFiredAt = Date.now();
  speakingSince = null;
  if (typeof onWake === 'function') {
    onWake({
      matched: true,
      phrase: phrase(),
      heard,
      confidence: Number(m.score.toFixed(3)),
      recogniser: 'groq/' + stt.DEFAULT_MODEL
    });
  }
}

function handleLevel(level) {
  if (!running) return;

  updateFloor(level);

  const now = Date.now();
  const loud = level >= threshold();

  if (loud) {
    if (speakingSince === null) {
      speakingSince = now;
      // Fired at the onset, not at the end: the clip has to contain the start of
      // the phrase, and the phrase has already started by the time it is
      // recognisable as one.
      if (!custom && !clipBusy && !busyCheck() && ready() && now - lastAttemptAt >= MIN_ATTEMPT_GAP_MS) {
        clipBusy = true;
        attempt('onset').catch(() => {}).finally(() => { clipBusy = false; });
      }
    }
  } else if (speakingSince !== null && now - speakingSince > 120) {
    // A short release: the gap inside "hey ... bolo" must not read as the end of
    // the utterance, but a real pause must.
    speakingSince = null;
  }

  // A swapped-in matcher owns the decision when one is installed. It gets the
  // same run of loudness the built-in gate sees, and its `matched` is trusted —
  // this is the seam a local keyword spotter drops into.
  if (custom) {
    const sustainedMs = speakingSince === null ? 0 : now - speakingSince;
    if (now - lastFiredAt < COOLDOWN_MS) return;
    let result = null;
    try { result = custom({ sustainedMs, level, phrase: phrase() }); } catch (_) { result = null; }
    if (result && result.matched) {
      lastFiredAt = now;
      speakingSince = null;
      if (typeof onWake === 'function') onWake(result);
    }
  }
}

// audio.js exposes a single level listener, so we chain rather than replace —
// otherwise starting the wake word would blind the waveform and the pill.
function attach() {
  previousLevelListener = audio.getLevelListener ? audio.getLevelListener() : null;
  const prior = previousLevelListener;
  audio.setLevelListener((level) => {
    if (typeof prior === 'function') prior(level);
    handleLevel(level);
  });
}

function detach() {
  const prior = previousLevelListener;
  audio.setLevelListener(typeof prior === 'function' ? prior : null);
  previousLevelListener = null;
}

function start() {
  if (running) return { running: true };
  running = true;
  speakingSince = null;
  floor = FLOOR_SEED;
  attach();
  // The gate needs a live signal, so the wake word holds the microphone open for
  // as long as it is on. This is the one case where the OS microphone indicator
  // stays lit while the app is otherwise idle, which is exactly why the feature
  // is off by default.
  audio.monitor(true);
  // The gate is tick-driven so it still ages out when the level stream goes
  // quiet.
  timer = setInterval(() => {
    if (speakingSince !== null && Date.now() - speakingSince > STALE_MS) speakingSince = null;
  }, 1000);
  return { running: true, phrase: phrase() };
}

function stop() {
  running = false;
  speakingSince = null;
  if (timer) { clearInterval(timer); timer = null; }
  detach();
  // Release the microphone if nothing else is using it.
  audio.monitor(false);
  return { running: false };
}

function apply() {
  if (settings.get('wakeEnabled')) start();
  else stop();
  return getState();
}

// Say the phrase now, without waiting for a room to be loud in. This is what
// Settings' "test the wake word" button calls, and it is the only path that
// skips the gate — everything downstream of it (the clip, the recogniser, the
// match) is the real one, so a pass here means the feature works.
async function listen() {
  if (clipBusy) return { ok: false, error: 'busy', reason: 'Already listening for the phrase.' };
  if (!ready()) return { ok: false, error: 'no-key', reason: 'The wake word needs a Groq key for speech-to-text.' };
  clipBusy = true;
  try {
    await attempt('manual');
  } finally {
    clipBusy = false;
  }
  return last || { ok: false, error: 'no-result' };
}

function getState() {
  const canRecognise = ready();
  return {
    enabled: !!settings.get('wakeEnabled'),
    running,
    phrase: phrase(),
    sensitivity: settings.get('wakeSensitivity'),
    matcher: custom ? 'custom' : 'groq/' + stt.DEFAULT_MODEL,
    ready: canRecognise || !!custom,
    // Named so the pane can say *why* it cannot hear you, rather than showing a
    // switch that is on and a feature that does nothing.
    reason: canRecognise || custom ? null : 'Add a Groq key — the wake word uses the same speech-to-text as dictation.',
    floor: Number(floor.toFixed(4)),
    threshold: Number(threshold().toFixed(4)),
    last,
    lastFiredAt: lastFiredAt || null
  };
}

function setMatcher(fn) {
  custom = typeof fn === 'function' ? fn : null;
}

module.exports = {
  start, stop, apply, getState, listen,
  setHandler: (fn) => { onWake = fn; },
  setMatcher, setBusyCheck,
  _internals: { normalize, levenshtein, similarity, scoreAgainst, bestMatch, variants, threshold, addressScore }
};
