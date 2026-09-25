// Medical vocabulary correction for Doctor Mode.
//
// Speech-to-text mangles drug names ("paracitamol", "amlo de pine") and
// clinical terms ("be pee", "diabeetus"). This layer fixes the transcription
// BEFORE it reaches the note template, so the structured note carries the
// canonical spellings.
//
// Two mechanisms:
//
// 1. Explicit variants — common STT mis-transcriptions mapped to the
//    canonical form. Multi-word variants ("amlo de pine") are matched as
//    phrases, longest first.
// 2. Fuzzy matching — for drug names only (long, distinctive words). A word
//    of 8+ letters within edit distance 2 of a canonical drug, or 6-7
//    letters within distance 1, is corrected. Short clinical terms are
//    NEVER fuzzy-matched: "never" is distance 2 from "fever", and that way
//    lies madness.
//
// Design choices, documented because they are deliberate:
//
// - Clinical terms canonicalize to the standard English charting term
//   (bukhar -> fever, be pee -> BP). The note goes into clinic software,
//   where standard terms matter; the rest of the dictation keeps whatever
//   language the doctor used.
// - Corrections are conservative: when in doubt, the word is left alone. A
//   missed correction is a typo the doctor fixes in review; a wrong
//   correction is a drug error.
// - To expand: add entries to DRUGS or TERMS. { name } is the canonical
//   spelling, `variants` are the STT mis-transcriptions seen in the wild.

const DRUGS = [
  { name: 'paracetamol', variants: ['paracitamol', 'paracetamole'] },
  { name: 'ibuprofen', variants: ['ibuprophen', 'ibuprufen', 'ibuprofene'] },
  { name: 'metformin', variants: ['metphormin', 'metformine', 'metformen'] },
  { name: 'amlodipine', variants: ['amlo de pine', 'amlodepine', 'amlodipin', 'amloadipine'] },
  { name: 'azithromycin', variants: ['azithromicin', 'azithromycine', 'azithro'] },
  { name: 'cetirizine', variants: ['cetrizine', 'cetirizene', 'setirizine'] },
  { name: 'omeprazole', variants: ['omeprazol', 'omipresol'] }
];

const TERMS = [
  { name: 'fever', variants: ['bukhar', 'fevr', 'faver', 'feaver'] },
  { name: 'BP', variants: ['be pee', 'b p', 'b.p.', 'bp'] },
  { name: 'diabetes', variants: ['diabeetus', 'diabities', 'diabetese', 'diabetees'] }
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive whole-word/phrase match. Boundaries use lookarounds rather
// than \b so variants starting or ending in punctuation ("b.p.") still match.
function phraseRe(phrase) {
  return new RegExp('(?<![\\w])' + escapeRe(phrase) + '(?![\\w])', 'gi');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

// Canonical drug names, for the structuring prompt: the model spells them
// right most of the time when it has the list, and correct() catches the rest.
function drugList() {
  return DRUGS.map((d) => d.name);
}

// Fix drug/term mis-transcriptions in a transcript. Pure function — safe to
// call on any text, and idempotent.
function correct(text) {
  let out = String(text == null ? '' : text);
  if (!out) return out;

  const entries = DRUGS.concat(TERMS);

  // Pass 1: explicit variants, longest phrase first so "amlo de pine" wins
  // over any shorter overlap. Case-sensitive skip: "BP" is already right,
  // while "bp" still normalizes to "BP".
  const phrases = [];
  for (const e of entries) {
    for (const v of e.variants || []) {
      if (v && v !== e.name) phrases.push({ v, name: e.name });
    }
  }
  phrases.sort((a, b) => b.v.length - a.v.length);
  for (const { v, name } of phrases) {
    out = out.replace(phraseRe(v), name);
  }

  // Pass 2: fuzzy, drug names only. Word-level, so punctuation survives.
  const drugNames = DRUGS.map((d) => d.name.toLowerCase());
  out = out.replace(/[A-Za-z]{6,}/g, (word) => {
    const lower = word.toLowerCase();
    if (drugNames.includes(lower)) return word; // already canonical
    const maxDist = word.length >= 8 ? 2 : 1;
    let best = null, bestDist = Infinity;
    for (const name of drugNames) {
      // Skip absurd length gaps before paying for the distance.
      if (Math.abs(name.length - lower.length) > maxDist) continue;
      const d = levenshtein(lower, name);
      if (d < bestDist) { bestDist = d; best = name; }
    }
    if (best && bestDist <= maxDist && bestDist > 0) {
      // Keep the original capitalisation shape (sentence-initial "Paracitamol").
      const canon = DRUGS.find((d) => d.name.toLowerCase() === best).name;
      return /^[A-Z]/.test(word)
        ? canon.charAt(0).toUpperCase() + canon.slice(1)
        : canon;
    }
    return word;
  });

  return out;
}

module.exports = { correct, drugList, DRUGS, TERMS };
