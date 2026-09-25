const Store = require('electron-store');

// Onboarding step machine.
//
// The reference VoiceOS sequence, adapted for bolo: the subscription step is
// dropped (the user owns the key, nothing to sell), and the reference's mode
// explanation becomes `three_modes_explanation` — bolo ships three real modes
// (Dictation / Edit / Agent), each on its own key and each driving a different
// backend path. Every key is tested and can be rebound in its own step.
//
// The reference step order is:
//   name_collection → language_selection → system_permissions →
//   test_agent_trigger_key → agent_mode_ask → agent_mode_connect →
//   agent_mode_try → import_keywords → two_modes_explanation →
//   test_trigger_key → dictation_messages → dictation_email →
//   typing_speed_comparison → subscribe → refer_a_friend
//
// bolo's flow keeps the agent key test in the Agent-mode section, then explains
// the three modes and tests the Edit and Dictation keys back to back.
//
// `intro` is not in this list. The cinematic intro runs in its own window
// before the dashboard flow starts and hands off at the end; see intro.js.

const STEPS = [
  'name_collection',
  'language_selection',
  'system_permissions',
  'three_modes_keys',
  'dictation_demo',
  'edit_demo',
  'agent_mode_try'
];

const CATEGORY_BY_STEP = {
  name_collection: 'about-you',
  language_selection: 'about-you',
  system_permissions: 'setup',
  three_modes_keys: 'voice',
  dictation_demo: 'voice',
  edit_demo: 'voice',
  agent_mode_try: 'agent-mode'
};

const CATEGORIES = [
  { id: 'about-you', label: 'About you' },
  { id: 'setup', label: 'Setup' },
  { id: 'agent-mode', label: 'Agent Mode' },
  { id: 'customize', label: 'Customize' },
  { id: 'voice', label: 'Your Voice' }
];

let store = null;

function init() {
  store = new Store({
    name: 'bolo-onboarding',
    defaults: {
      step: 'name_collection',
      stepIndex: 0,
      completed: false,
      introSeen: false,
      firstName: '',
      lastName: '',
      defaultLanguage: 'en',
      enabledLanguages: ['en'],

      // Microphone and accessibility are granted up front because there is no
      // OS-level prompt to answer for them on this platform; the reference's
      // permissions screen shows both already ticked and only asks about the
      // screen, which is the one that genuinely needs a decision.
      micGranted: true,
      accessibilityGranted: true,

      // The three activation keys are confirmed on one combined screen
      // (three_modes_keys); each card lights when its key is first pressed.
      agentTriggerTested: false,
      editTriggerTested: false,
      dictationTriggerTested: false,

      // The two live demo steps write what the user dictated / edited here, so a
      // bounce back to the step shows their own text rather than a blank box.
      dictationDemoText: '',
      editDemoText: '',

      // The agent trial is an offline machine action (open an app). `agentTried`
      // records whether the user ran it; there is no connected-app field any
      // more — the integrations that used to feed one are gone.
      agentTried: false,

      referralCode: null
    }
  });
  return store;
}

function indexOf(step) {
  const i = STEPS.indexOf(step);
  return i < 0 ? 0 : i;
}

function get() {
  if (!store) init();
  const step = store.get('step');
  const i = indexOf(step);
  const data = { ...store.store };
  // The permissions this screen shows are not something a user has to grant:
  // the mic and accessibility have no OS prompt on this platform, and the
  // user's ask was explicit — everything is on the moment the app opens.
  // The store value is what the UI reads, so it is normalised on the way out.
  data.micGranted = true;
  data.accessibilityGranted = true;
  return {
    steps: STEPS,
    categories: CATEGORIES,
    step,
    stepIndex: i,
    totalSteps: STEPS.length,
    category: CATEGORY_BY_STEP[step] || 'setup',
    completed: !!store.get('completed'),
    introSeen: !!store.get('introSeen'),
    data
  };
}

const WRITABLE = new Set([
  'completed', 'introSeen', 'firstName', 'lastName',
  'defaultLanguage', 'enabledLanguages',
  'micGranted', 'accessibilityGranted',
  'agentTriggerTested', 'editTriggerTested', 'dictationTriggerTested',
  'dictationDemoText', 'editDemoText',
  'agentTried',
  'referralCode'
]);

function set(patch) {
  if (!store) init();
  for (const k of Object.keys(patch || {})) {
    if (!WRITABLE.has(k)) continue;
    // The permission flags can only ever move one way: granted. A page's
    // "Allow" button writes true; nothing in the app has a legitimate reason
    // to write them back to false.
    if ((k === 'micGranted' || k === 'accessibilityGranted') && !patch[k]) continue;
    store.set(k, patch[k]);
  }
  return get();
}

function goTo(step) {
  if (!STEPS.includes(step)) return get();
  store.set('step', step);
  store.set('stepIndex', indexOf(step));
  return get();
}

// Bouncing back from language_selection returns to name_collection rather than
// to nothing — the original flow does this too, and it's the only pair of steps
// that reads as one exchange.
function back() {
  if (!store) init();
  const i = indexOf(store.get('step'));
  if (i > 0) return goTo(STEPS[i - 1]);
  return get();
}

function next() {
  if (!store) init();
  const i = indexOf(store.get('step'));
  if (i >= STEPS.length - 1) return complete();
  return goTo(STEPS[i + 1]);
}

function complete() {
  if (!store) init();
  store.set('completed', true);
  return get();
}

function reset() {
  if (!store) init();
  store.clear();
  return get();
}

module.exports = {
  init, get, set, next, back, go: goTo, complete, reset,
  STEPS, CATEGORIES, CATEGORY_BY_STEP
};
