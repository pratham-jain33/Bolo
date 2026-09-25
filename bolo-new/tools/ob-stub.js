/* Stand-in for the preload bridge, injected at document-start by shot.js so the
   dashboard can be screenshotted outside Electron's real preload. Not part of
   the app — nothing here ships. */
(function () {
  const STEPS = ['name_collection', 'language_selection', 'system_permissions',
    'three_modes_keys', 'dictation_demo', 'edit_demo', 'agent_mode_connect',
    'agent_mode_try', 'refer_a_friend'];

  const q = new URLSearchParams(location.search);
  const step = STEPS.includes(q.get('step')) ? q.get('step') : 'system_permissions';

  // The Integrations pane no longer exists (the account-based adapters were
  // removed); the stub still returns the shape a screenshot harness expects
  // but with no catalogue, so the pane renders empty rather than crashing.

  const data = {
    firstName: 'Pratham', lastName: 'Jain',
    defaultLanguage: 'en', enabledLanguages: ['en'],
    // Matches the app's own defaults: mic and accessibility are granted up front,
    // the screen permission is the one that needs a decision.
    micGranted: q.get('granted') !== '0', accessibilityGranted: q.get('granted') !== '0',
    agentTriggerTested: false, agentConnectedApp: q.get('app') || null, agentTried: false,
    editTriggerTested: false, dictationTriggerTested: false,
    dictationDemoText: '', editDemoText: '', keywordLimit: '',
    referralCode: null, introSeen: true, completed: q.get('done') === '1'
  };

  const state = () => ({
    steps: STEPS, categories: [], step: data.step || step,
    stepIndex: Math.max(0, STEPS.indexOf(data.step || step)),
    totalSteps: STEPS.length, category: 'setup',
    completed: q.get('done') === '1', introSeen: true,
    data: Object.assign({}, data)
  });
  data.step = step;

  // Listeners are captured rather than dropped so a screenshot run can fire the
  // app's own channels at the page (see __obFire below). Without this the page's
  // event-driven states — the lit keycap, the demo stage — are unreachable
  // outside the real app, which is exactly what they need checking most.
  const handlers = {};

  const impl = {
    on: (ch, fn) => { (handlers[ch] || (handlers[ch] = [])).push(fn); },
    obGet: async () => state(),
    obSet: async (p) => { Object.assign(data, p || {}); return state(); },
    obNext: async () => { const i = STEPS.indexOf(data.step); data.step = STEPS[Math.min(STEPS.length - 1, i + 1)]; return state(); },
    obBack: async () => { const i = STEPS.indexOf(data.step); data.step = STEPS[Math.max(0, i - 1)]; return state(); },
    obGo: async (s) => { data.step = s; return state(); },
    obComplete: async () => state(),
    obReset: async () => state(),
    obDemoStart: async () => ({ ok: true }),
    obDemoEnd: async () => ({ ok: true }),
    onboardingGet: async () => state(),
    getStatus: async () => ({ ready: true, version: '1.0.0', model: 'qwen3', keyCount: 1 }),
    getUsage: async () => ({ todayRequests: 0, totalRequests: 0 }),
    // Realistic rather than empty, so a screenshot shows the pane in the state a
    // real install would be in — switches on, a notch configured, a key bound.
    getSettings: async () => ({
      groqModel: 'qwen/qwen3.8-27b',
      sttModel: 'whisper-large-v3-turbo',
      ttsEnabled: true,
      transcriptionEnabled: true, injectionEnabled: true, audioDucking: false,
      autoPasteAnswers: true, interactionSounds: true,
      closeToTray: true, creatorMode: false, practiceMode: false,
      contextAwareness: true, privateMode: false,
      hidePill: false, hideTopNotch: false, hideSideNotch: false
    }),
    // The real defaults, not arbitrary ones. These read 'CommandOrControl+A'
    // once, which made the dashboard's Dictation card print "Ctrl + A" — a
    // screenshot that looks exactly like a wrong binding and is really the
    // harness. A stub is a stand-in for the main process; if it disagrees with
    // the main process, every picture taken through it is a lie.
    voiceInfo: async () => ({
      voice: { id: 'voice', label: 'Voice', shortcut: 'CommandOrControl+Shift+D', blurb: '' },
      shortcut: 'CommandOrControl+Shift+D',
      modeShortcuts: [
        { id: 'voice', requested: 'CommandOrControl+Shift+D', bound: 'CommandOrControl+Shift+D' },
        { id: 'edit', requested: 'CommandOrControl+Shift+E', bound: 'CommandOrControl+Shift+E' },
        { id: 'agent', requested: 'CommandOrControl+Shift+A', bound: 'CommandOrControl+Shift+A' }
      ],
      pasteLastShortcut: 'CommandOrControl+Shift+V',
      intents: []
    }),
    setVoiceShortcut: async (a) => ({ ok: true, accelerator: a }),
    setPasteLastShortcut: async (a) => ({ ok: true, accelerator: a }),
    notchGet: async () => ({
      enabled: true, variant: 'top', side: 'right', material: 'solid',
      position: 'top-center', width: 286, offsetX: 0, offsetY: 0,
      opacity: 1, autoHideMs: 4000, alwaysOnTop: true, showOnHover: false,
      hidePill: false, hideTopNotch: false, hideSideNotch: false
    }),
    getLoginItem: async () => ({ openAtLogin: true }),
    replacementsGet: async () => ({ list: [{ from: 'scratch that', to: 'rewrite this' }] }),
    replacementsSet: async (l) => ({ ok: true, list: l || [] }),
    setLoginItem: async (on) => ({ openAtLogin: !!on }),
    wakeGet: async () => ({}),
    // Two sessions of realistic shape — { at, kind, text } is exactly what
    // src/main/history.js stores, so the dashboard's rail renders real cards
    // instead of only its empty state.
    historyList: async () => [
      {
        at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        kind: 'insert',
        text: 'Remind me to send the deck to the team before Friday, and to chase the invoice if I have not heard back.'
      },
      {
        at: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
        kind: 'edit',
        text: 'The quick brown fox jumps over the lazy dog.',
        result: 'The quick brown fox launches over the lazy dog.'
      },
      {
        at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        kind: 'act',
        text: 'open Notepad on my computer'
      }
    ],
    historyClear: async () => ({}),
    // The Integrations pane no longer exists (the account-based adapters were
    // removed); these return empty so a stale harness path that still calls
    // them degrades to a blank grid rather than crashing.
    intCatalog: async () => [],
    intCategories: async () => [],
    intDetail: async () => null,
    // The real five voices and two families, copied from src/main/tts.js. The
    // empty-object default this used to fall through to made the Settings pane
    // screenshot with an empty voice picker, which reads as a bug in the app.
    ttsVoices: async () => ({
      voices: [
        { id: 'flux-cole-en', label: 'Cole', gender: 'male', family: 'flux', desc: 'Young adult, American.' },
        { id: 'flux-sienna-en', label: 'Sienna', gender: 'female', family: 'flux', desc: 'Young adult, American.' },
        { id: 'flux-alexis-en', label: 'Alexis', gender: 'female', family: 'flux', desc: 'Adult, American.' },
        { id: 'aura-2-delia-en', label: 'Delia', gender: 'female', family: 'aura-2', desc: 'Casual and friendly, with a little breath.' },
        { id: 'aura-2-orion-en', label: 'Orion', gender: 'male', family: 'aura-2', desc: 'Calm, approachable and polite.' }
      ],
      families: [
        { id: 'flux', label: 'Flux', note: 'Deepgram’s newest voices.' },
        { id: 'aura-2', label: 'Aura 2', note: 'The previous generation.' }
      ],
      current: 'flux-cole-en'
    }),
    setTtsVoice: async (v) => ({ ok: true, voice: v }),
    setTts: async (on) => ({ on: !!on }),
    setSttModel: async (m) => ({ model: m || 'whisper-large-v3-turbo' }),
    setSounds: async (on) => ({ ok: true, on: !!on }),
    // Same shape the real handlers return, with the keys the real store is
    // seeded with. A flat, Groq-only shape here would hide the provider grouping.
    keysList: async () => ({
      keys: [
        { index: 0, masked: 'gsk…mDZl', active: true },
        { index: 1, masked: 'gsk…whOP', active: false }
      ],
      count: 2,
      providers: {
        groq: {
          keys: [
            { index: 0, masked: 'gsk…mDZl', active: true },
            { index: 1, masked: 'gsk…whOP', active: false }
          ],
          count: 2
        },
        deepgram: { keys: [{ index: 0, masked: 'bc2…13fa', active: true }], count: 1 }
      },
      model: 'qwen/qwen3.8-27b',
      sttModel: 'whisper-large-v3-turbo',
      ttsVoice: 'flux-cole-en',
      ttsEnabled: true
    }),
    keysAdd: async () => ({ ok: true }),
    keysRemove: async () => ({ ok: true }),
    keysClear: async () => ({ ok: true }),
    keysRotate: async () => ({ ok: true }),
    integrationsStatus: async () => ({}),
    voiceState: async () => ({ state: 'idle' }),
    getPlatform: async () => ({ platform: 'win32' }),
    windowMaximized: async () => ({ maximized: false }),
    getView: async () => ({ view: 'voice' }),
    setView: async () => ({}),
    pasteLast: async () => ({ ok: true }),
    notchCopy: async () => ({ ok: true }),
    getContext: async () => ({}),
    agentList: async () => [],
    workflowSamples: async () => [],
    resetShortcuts: async () => ({}),
    setHotkey: async () => ({}),
    notchSet: async () => ({}),
    wakeSet: async () => ({}),
    setTranscription: async () => ({}),
    setInjection: async () => ({}),
    setDucking: async () => ({}),
    groqTest: async () => ({ ok: true }),
    setModeShortcut: async (mode, acc) => ({ ok: true, mode: mode, accelerator: acc, requested: acc, substituted: acc }),
    getModeShortcuts: async () => ({
      dictation: 'Control+Shift+D', edit: 'Control+Shift+E', agent: 'Control+Shift+A'
    })
  };

  // Unknown members resolve to an empty object rather than throwing, so the
  // dashboard can boot against this stub without a per-call allowlist.
  window.bolo = new Proxy(impl, {
    get(t, k) { return k in t ? t[k] : async () => ({}); }
  });

  // Fire a channel at whatever the page has listening. Harness-only.
  window.__obFire = (ch, payload) => {
    const list = handlers[ch] || [];
    for (const fn of list) { try { fn(payload); } catch (e) { console.log('handler threw:', ch, e.message); } }
    return list.length;
  };
})();
