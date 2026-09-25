// The voice key, and the intent table it dispatches to.
//
// bolo has three real modes on three keys (Dictation / Edit / Agent) — see
// settings.DEFAULT_*_SHORTCUT. The intent router still decides ambiguous
// input, but a dedicated key fixes the intent for that session (voice.js
// sessionMode). Do NOT collapse back to one key.
//
// INTENTS is therefore not a mode list. It is the four things a finished
// transcript can turn into, and it exists so the history list, the notch and
// the settings copy can all name the same four things instead of each inventing
// their own vocabulary. Read it as a result type, not as a picker.
//
//   insert  type it into the focused app, as dictated
//   answer  it was a question; show/write the answer
//   edit    rewrite something and put the rewritten text back
//   act     do something in another app
//
// The real bolo ships these as four separate modes with four separate keys.
// Collapsing them is a deliberate divergence, requested by the user: the point
// is that the user should never have to decide which one they meant.

const VOICE_ID = 'voice';

// Dictation IS the voice key. Kept in sync with settings.DEFAULT_VOICE_SHORTCUT
// ('Control+Shift+D'); settings.voiceShortcut() is the live binding, this is
// the fallback/display value so the two can never disagree again.
const VOICE_DEFAULT_ACCEL = 'Control+Shift+D';

const VOICE = {
  id: VOICE_ID,
  label: 'Voice',
  blurb: 'Say what you want. It is typed, answered, rewritten or done — whichever you meant.',
  shortcut: VOICE_DEFAULT_ACCEL,
  activation: 'toggle',
  // A double-tap on the voice key keeps the microphone open without holding.
  handsFree: true
};

// Labels are past-tense because they describe a finished action ("Typed",
// "Answered") rather than a thing the user picked. `mutates` marks the two that
// change text in another app, which is what the notch uses to decide whether to
// offer an undo-ish "insert instead" affordance.
const INTENTS = [
  {
    id: 'insert',
    label: 'Typed',
    blurb: 'Your words, cleaned up and typed where the cursor is.',
    mutates: true
  },
  {
    id: 'answer',
    label: 'Answered',
    blurb: 'A question, answered on the notch instead of typed.',
    mutates: false
  },
  {
    id: 'edit',
    label: 'Rewrote',
    blurb: 'The text you pointed at, rewritten and put back.',
    mutates: true
  },
  {
    id: 'act',
    label: 'Did it',
    blurb: 'An instruction, carried out in the app it was about.',
    mutates: false
  }
];

const INTENT_IDS = INTENTS.map((i) => i.id);
const byIntentId = new Map(INTENTS.map((i) => [i.id, i]));

function intent(id) {
  return byIntentId.get(id) || null;
}

function intentLabel(id) {
  const i = byIntentId.get(id);
  return i ? i.label : 'Did something';
}

// The mode registry used to be a list of four; callers that still loop over a
// list get the one entry, so the shape of their code did not have to change.
function list() {
  return [{ ...VOICE }];
}

function get(id) {
  return id === VOICE_ID ? { ...VOICE } : null;
}

function has(id) {
  return id === VOICE_ID;
}

// Re-inject the previous transcript without re-recording. Not an intent — it
// never goes through the router — so it lives outside the table above.
const PASTE_LAST_ID = 'pasteLast';
const PASTE_LAST_DEFAULT = 'CommandOrControl+Shift+V';

module.exports = {
  VOICE,
  VOICE_ID,
  VOICE_DEFAULT_ACCEL,
  INTENTS,
  INTENT_IDS,
  intent,
  intentLabel,
  list,
  get,
  has,
  PASTE_LAST_ID,
  PASTE_LAST_DEFAULT
};
