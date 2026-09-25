// The voice key, and the intent table it dispatches to.
//
// bolo has ONE entry point. There are no user-facing modes any more: the
// user presses one key, says what they want, and intent.js works out what the
// words were for. Nothing here is bound to a shortcut except VOICE itself, and
// nothing here is chosen by the user — the router chooses.
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

// Ctrl+A. Chosen by the user. Note this shadows Select All system-wide while
// bolo is running — globalShortcut is exclusive, so Windows never sees the
// keystroke. It is one field in Settings -> Voice if that turns out to be worse
// than it sounds.
const VOICE_DEFAULT_ACCEL = 'CommandOrControl+A';

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
