// The intent router.
//
// One spoken utterance arrives; this decides whether it was dictation, a
// question, an edit instruction, or a command — and produces whatever payload
// that decision needs. It replaces the four user-facing modes.
//
// Two stages, deliberately:
//
//   1. A local heuristic pass. Cheap, synchronous, no network. Plain dictation
//      is by far the commonest thing a person says into this app, and it must
//      not cost a model round-trip: if the words look like text, they are typed
//      immediately and nothing else happens.
//
//   2. A model pass, but ONLY for the utterances the heuristic flagged as
//      needing judgement. It is given the heuristic's guess as a hint and is
//      free to disagree — including downgrading back to plain dictation.
//
// The asymmetry is the safety property. `insert` and `edit` change text in
// someone else's document; `answer` and `act` only put something on the notch.
// So the heuristic never guesses its way into mutation on an ambiguous
// utterance — it guesses its way OUT of it. A misrouted command means nothing
// was typed and the notch says what happened, which the user can undo by
// hitting Insert. A misrouted dictation would silently edit their document.
//
// Reading the selection: context.getSelection() reads the focused window's
// selected text through UI Automation, so "rewrite this" can take "this" from
// the selection. It is not always there — a control with no text model answers
// empty, and the clipboard is the fallback, which is what a person who just
// highlighted something and pressed the key usually has anyway.

const modes = require('./modes');

const QUESTION_OPENER =
  /^(what|what's|whats|who|whose|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will|shall|am|may|might|any)\b/i;

const QUESTION_ASK =
  /\b(explain|tell me|describe|define|how many|how much|what do you think|difference between|calculate|convert|who is|what is|when is|where is|remind me what)\b/i;

const COMMAND_OPENER =
  /^(send|email|reply|message|open|launch|start|run|close|quit|create|make|add|schedule|book|set|remind|search|find|look up|google|download|install|copy|move|delete|rename|share|post|upload|call|play|pause|turn|toggle|switch|enable|disable|draft|compose|check|read|scan|summari[sz]e|organi[sz]e|clean up|clear|archive|unsubscribe|forward|invite|assign|approve|submit)\b/i;

// Words that only make sense if the utterance is about text someone already
// has. These are what route to `edit` rather than `insert`.
const EDIT_HINT =
  /\b(rewrite|reword|rephrase|make (it|this|that)|fix|correct|shorten|lengthen|expand|tighten|more formal|less formal|casual|friendly|professional|translate|grammar|spell|proofread|punch up|tone|concise|simpler|clean (it|this|that) up)\b/i;

// The assistant's own name, plus the shapes speech-to-text returns it in —
// "gotodos" is what Whisper hears for "bolo". Anything naming the assistant
// is a question about the assistant, and a question about the assistant must
// never be typed into someone's document by mistake.
const SELF_REF = /\b(bolo\s?os|bolo\s?o\s?s|bolo|goat\s?dos|goatdos|gotodos)\b/i;

// Utterances this short are almost never a question or a command being dictated
// verbatim; they are a fragment. Keeps "Yes please." out of the model path.
const MIN_WORDS_FOR_JUDGEMENT = 2;

// A very long utterance is dictation. Nobody speaks a 60-word command, and
// sending one to the model risks it deciding to "helpfully" rewrite an email
// the user was reading out.
const MAX_WORDS_FOR_JUDGEMENT = 60;

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function endsWithQuestion(text) {
  return /\?\s*$/.test(String(text || ''));
}

// Stage 1. Pure function of the transcript — no context, no network, so it can
// be reasoned about and tested on its own.
//
// `hasPayload` is whether there is text to operate on (a selection, or failing
// that the clipboard). It only ever *enables* `edit`; it never forces it.
function classify(text, opts) {
  const utterance = String(text || '').trim();
  const words = wordCount(utterance);
  const hasPayload = !!(opts && opts.hasPayload);

  if (!utterance) return { intent: 'insert', reason: 'empty' };
  if (words < MIN_WORDS_FOR_JUDGEMENT) return { intent: 'insert', reason: 'too-short' };
  if (words > MAX_WORDS_FOR_JUDGEMENT) return { intent: 'insert', reason: 'too-long-to-be-a-command' };

  // Rewrite instructions win over everything: "make this more formal" contains
  // no question word and no command verb, and is the one case where guessing
  // wrong is expensive, so it is tested first and unconditionally.
  if (EDIT_HINT.test(utterance)) return { intent: 'edit', reason: 'edit-words' };

  // A question mark is the strongest single signal a person gives.
  if (endsWithQuestion(utterance)) return { intent: 'answer', reason: 'question-mark' };

  if (QUESTION_OPENER.test(utterance)) return { intent: 'answer', reason: 'question-opener' };

  // "Explain X" / "tell me about X" ask for prose, not an action — but only when
  // no command verb opens the sentence, or "summarize this and send it" would be
  // read as a question.
  if (QUESTION_ASK.test(utterance) && !COMMAND_OPENER.test(utterance)) {
    return { intent: 'answer', reason: 'question-phrase' };
  }

  if (COMMAND_OPENER.test(utterance)) return { intent: 'act', reason: 'command-verb' };

  // A question aimed at bolo — "how can bolo help me", or the same with
  // the name mis-transcribed — is a question about itself, so it answers rather
  // than being typed. Tested after the action verbs, so "open bolo" still
  // acts, and before the payload branch, so it can never land on `edit`.
  if (SELF_REF.test(utterance)) return { intent: 'answer', reason: 'self-reference' };

  // Nothing else matched. With a payload in hand and a directive shape
  // ("...this", "it should be...") the model gets a look; otherwise it is text.
  if (hasPayload && /\b(this|that|it|selection|paragraph|sentence|text)\b/i.test(utterance)) {
    return { intent: 'edit', reason: 'directive-about-existing-text' };
  }

  return { intent: 'insert', reason: 'default' };
}

/* ---------------------------------------------------------------------------
   Stage 2. The model pass.
   ------------------------------------------------------------------------ */

const ROUTER_SYSTEM = [
  'You are the intent router inside bolo, the voice assistant running on the user\'s',
  'own machine. The user spoke ONE utterance.',
  // The name is the one word speech-to-text reliably mangles, and a model that
  // does not know it is its own reads "how can gotodos help me" as text to type.
  'The user mis-hears and mis-transcribes your name constantly: "gotodos", "goat dos",',
  '"bolo dos" and "bolo os" all mean bolo. A question about what you can do —',
  '"how can bolo help me", "what can gotodos do" — is a question about yourself.',
  'It is "answer", and the answer is written as bolo in the first person.',
  'Reply with ONLY a JSON object. No prose, no code fence, no commentary.',
  '',
  '{"intent":"insert"|"answer"|"edit"|"act","text":"..."}',
  '',
  '"insert" — they were dictating. "text" is their words, cleaned up: fix punctuation',
  '  and obvious transcription slips, do NOT rephrase or add anything.',
  '"answer" — they asked a question. "text" is the answer. Keep it EXTREMELY short:',
  '  one sentence when you can, two at the very most. No preamble, no filler, no',
  '  "sure" or "here is". Just the answer.',
  '"edit"   — they want existing text rewritten, translated or fixed. "text" is the',
  '  replacement text ONLY, with no quotes and no explanation.',
  '"act"    — they asked you to do something in an app. "text" is ONE short first-person',
  '  line saying what you did (e.g. "Opened Spotify."), or the exact content to insert.',
  '',
  'When you are unsure between "insert" and anything else, choose "insert".',
  'Typing nothing is a bigger failure than typing something slightly plain.'
].join('\n');

// Models like to wrap JSON in a fence or lead with "Here is the JSON". Both are
// recoverable by slicing to the outermost braces, which is more robust than
// trying to enumerate the ways a model can editorialise.
function parseRoute(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return null;
    const id = String(obj.intent || '').trim().toLowerCase();
    if (modes.INTENT_IDS.indexOf(id) < 0) return null;
    const payload = typeof obj.text === 'string' ? obj.text.trim() : '';
    // `insert` and `edit` are meaningless with no text — a model that returns
    // one without a payload has failed, and falling back to the transcript is
    // better than injecting an empty string.
    if (!payload && (id === 'insert' || id === 'edit')) return null;
    return { intent: id, text: payload };
  } catch (_) {
    return null;
  }
}

function contextBlock(ctx, transcript) {
  const bits = [];
  if (ctx && ctx.window && ctx.window.title) bits.push('Focused window: ' + ctx.window.title);
  const selection = ctx && ctx.selection && ctx.selection.text;
  if (selection) bits.push('Selected text:\n' + selection);
  else if (ctx && ctx.clipboard && ctx.clipboard.text) {
    bits.push('Clipboard (probably what they mean by "this"):\n' + ctx.clipboard.text.slice(0, 2000));
  }
  bits.push('They said:\n' + transcript);
  return bits.join('\n\n');
}

// Returns a decision of the same shape classify() does, so callers cannot tell
// which stage produced it — except for `source`, which exists so the notch and
// the logs can be honest about whether the model was consulted.
async function route(transcript, ctx, heuristic) {
  const guess = heuristic || classify(transcript, {
    hasPayload: !!(ctx && ((ctx.selection && ctx.selection.text) ||
      (ctx.clipboard && ctx.clipboard.text)))
  });

  let groq;
  try {
    groq = require('./groq');
  } catch (e) {
    return { ...guess, source: 'heuristic', note: 'model backend unavailable' };
  }

  const messages = [
    { role: 'system', content: ROUTER_SYSTEM },
    {
      role: 'user',
      content: 'A local heuristic guessed "' + guess.intent + '". Override it if that is wrong.\n\n' +
        contextBlock(ctx, transcript)
    }
  ];

  let reply;
  try {
    // 800 rather than 512: this one call both routes the utterance and writes the
    // answer, and a 512-token ceiling truncates a real answer mid-sentence.
    const r = await groq.chat(messages, { maxTokens: 800 });
    if (!r || !r.ok) {
      // The model is a second opinion, never a requirement. A rate-limited or
      // unreachable backend falls back to the heuristic instead of blocking the
      // dictation — and the reason travels in `note` so it is not a silent
      // downgrade.
      return {
        ...guess,
        source: 'heuristic',
        note: 'model unavailable: ' + ((r && r.error) || 'unknown')
      };
    }
    reply = r.text;
  } catch (e) {
    return { ...guess, source: 'heuristic', note: 'model call failed: ' + e.message };
  }

  const parsed = parseRoute(reply);
  if (!parsed) {
    return { ...guess, source: 'heuristic', note: 'model reply was not usable' };
  }

  return {
    intent: parsed.intent,
    text: parsed.text,
    reason: 'model',
    source: 'model',
    // Kept so the notch can show that the router changed its mind, which is the
    // only way to debug a misroute without a log file.
    guess: guess.intent
  };
}

// The prompt for the model call that produces an `answer`. Only used when the
// router landed on `answer`, so it is not competing with the routing prompt.
const ANSWER_SYSTEM =
  'You are bolo, the voice assistant running on the user\'s own machine. The user ' +
  'may mis-transcribe your name — "gotodos", "goat dos" and "bolo dos" all mean ' +
  'bolo — and a question about what you can do ("how can bolo help me") is a ' +
  'question about yourself: answer it as bolo, in the first person. ' +
  'Answer the question directly, in the FEWEST words possible — one short sentence ' +
  'when you can, two at the very most. ' +
  'No preamble, no "sure", no "here is", no restating the question, no sign-off. ' +
  'Just the answer.';

const ACT_SYSTEM =
  'You are a desktop agent. The user gave a spoken instruction. Carry out the part you ' +
  'can and reply with ONE very short line saying what you did (e.g. "Done." or ' +
  '"Opened the file."), followed only by any exact text that must be inserted. ' +
  'No explanation, no preamble, no clarifying questions.';

/* ---------------------------------------------------------------------------
   Forced modes.

   The router above guesses the intent when the user pressed the one plain voice
   key. But bolo also has three dedicated activation keys — Dictation, Edit and
   Agent — and pressing one of those is the user *telling* the app what they
   want, not asking it to guess. `forced()` honours that: the intent is fixed by
   the key, and only the payload is produced.

     dictation  the words are typed as-is (no model round trip — instant)
     edit       the model rewrites the selected/clipboard text per the spoken
                instruction, and the rewrite is put back
     agent      the words are handed to agent.act(), same as a routed `act`

   `source: 'mode'` marks these so the notch and history can show that the user
   chose the mode rather than the router inferring it.
   ------------------------------------------------------------------------ */

const EDIT_SYSTEM = [
  'You are the rewrite engine inside bolo. The user selected some text and spoke an',
  'instruction for how to change it. Apply the instruction to the text.',
  'Return ONLY the rewritten text — no quotes, no preamble, no explanation, no code',
  'fence. If the instruction is a translation, translate it. If it is a tone or length',
  'change, apply it. Preserve the original meaning unless the instruction says otherwise.'
].join('\n');

function editPayload(ctx) {
  const sel = ctx && ctx.selection && ctx.selection.text;
  if (sel) return sel;
  const clip = ctx && ctx.clipboard && ctx.clipboard.text;
  return clip || '';
}

async function rewriteForEdit(transcript, ctx) {
  const payload = editPayload(ctx);
  // Edit with nothing to edit is not an error the model can fix — it needs a
  // selection. The caller turns this into a hint rather than typing the
  // instruction into the document by mistake.
  if (!payload) {
    return { intent: 'edit', text: '', source: 'mode', reason: 'mode-edit', error: 'no-selection' };
  }

  let groq;
  try {
    groq = require('./groq');
  } catch (_) {
    return { intent: 'edit', text: payload, source: 'mode', reason: 'mode-edit', note: 'model backend unavailable' };
  }

  const messages = [
    { role: 'system', content: EDIT_SYSTEM },
    { role: 'user', content: 'Text to rewrite:\n' + payload + '\n\nInstruction:\n' + transcript }
  ];

  try {
    const r = await groq.chat(messages, { maxTokens: 800 });
    if (!r || !r.ok || !String(r.text || '').trim()) {
      // No usable rewrite: leaving the original text untouched is the safe
      // failure — nothing is worse than replacing a paragraph with an error.
      return { intent: 'edit', text: payload, source: 'mode', reason: 'mode-edit', note: 'model unavailable', unchanged: true };
    }
    return { intent: 'edit', text: String(r.text).trim(), source: 'mode', reason: 'mode-edit', guess: 'edit' };
  } catch (e) {
    return { intent: 'edit', text: payload, source: 'mode', reason: 'mode-edit', note: 'model call failed: ' + e.message, unchanged: true };
  }
}

// mode -> decision. `ctx` is only needed (and only gathered by the caller) for
// edit. Returns null for an unknown mode so the caller can fall back to the
// inferring router.
async function forced(mode, transcript, ctx) {
  if (mode === 'dictation') {
    return { intent: 'insert', text: transcript, source: 'mode', reason: 'mode-dictation' };
  }
  if (mode === 'agent') {
    return { intent: 'act', text: transcript, source: 'mode', reason: 'mode-agent' };
  }
  if (mode === 'edit') {
    return rewriteForEdit(transcript, ctx);
  }
  return null;
}

module.exports = {
  classify,
  route,
  forced,
  rewriteForEdit,
  parseRoute,
  wordCount,
  ANSWER_SYSTEM,
  ACT_SYSTEM,
  EDIT_SYSTEM,
  ROUTER_SYSTEM
};
