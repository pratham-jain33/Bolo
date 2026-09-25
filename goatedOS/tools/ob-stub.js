/* Stand-in for the preload bridge, injected at document-start by shot.js so the
   dashboard can be screenshotted outside Electron's real preload. Not part of
   the app — nothing here ships. */
(function () {
  const STEPS = ['name_collection', 'language_selection', 'system_permissions',
    'three_modes_keys', 'dictation_demo', 'edit_demo', 'agent_mode_connect',
    'agent_mode_try', 'refer_a_friend'];

  const q = new URLSearchParams(location.search);
  const step = STEPS.includes(q.get('step')) ? q.get('step') : 'system_permissions';

  // The Integrations pane's data, copied in shape and content from the real
  // catalogue in src/main/integrations.js. Harness-only: this is what makes a
  // screenshot of that pane show the grid a real install would show.
  const CATEGORIES = [
    { id: 'communication', label: 'Communication', blurb: 'Messages, mail, and calls.' },
    { id: 'productivity', label: 'Productivity', blurb: 'Calendar, tasks, and reminders.' },
    { id: 'knowledge', label: 'Knowledge', blurb: 'Notes, files, and imports.' },
    { id: 'media', label: 'Media', blurb: 'Music and playback control.' },
    { id: 'system', label: 'System', blurb: 'Built into this machine.' }
  ];

  const CATALOG = [
    { id: 'mail', label: 'Mail', category: 'communication', description: 'Draft and send mail by voice, and read out what is in your inbox.', auth: 'oauth', actions: ['compose', 'reply', 'summarise'], platforms: null, enabled: false },
    { id: 'imessage', label: 'Messages', category: 'communication', description: 'Send and read messages in the system messaging app.', auth: 'system', actions: ['send', 'read'], platforms: ['darwin'], enabled: false },
    { id: 'calendar', label: 'Calendar', category: 'productivity', description: 'Check your schedule and find free slots without opening a calendar.', auth: 'oauth', actions: ['find_free_slots', 'create_event', 'today'], platforms: null, enabled: true },
    { id: 'reminders', label: 'Reminders', category: 'productivity', description: 'Capture tasks and reminders as you think of them.', auth: 'system', actions: ['add', 'list'], platforms: ['darwin'], enabled: false },
    { id: 'obsidian', label: 'Obsidian', category: 'knowledge', description: 'Append dictated notes straight into a vault.', auth: 'path', actions: ['append_note', 'open_note'], platforms: null, enabled: false },
    { id: 'localFiles', label: 'Local files', category: 'knowledge', description: 'Search and open files under your documents folder.', auth: 'none', actions: ['search', 'open'], platforms: null, enabled: true },
    { id: 'localNotes', label: 'Local notes', category: 'knowledge', description: 'A plain notes store that needs no account at all.', auth: 'none', actions: ['add', 'list'], platforms: null, enabled: true },
    { id: 'chatgptImport', label: 'Chat history import', category: 'knowledge', description: 'Import an exported chat history so the agent knows your context.', auth: 'file', actions: ['import'], platforms: null, enabled: false },
    { id: 'spotify', label: 'Spotify', category: 'media', description: 'Play, pause, and skip by voice.', auth: 'oauth', actions: ['play', 'pause', 'skip', 'now_playing'], platforms: null, enabled: false },
    { id: 'maps', label: 'Maps', category: 'system', description: 'Look up a place or start directions.', auth: 'none', actions: ['search', 'directions'], platforms: null, enabled: true }
  ];

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
    voiceInfo: async () => ({
      voice: { id: 'voice', label: 'Voice', shortcut: 'CommandOrControl+A', blurb: '' },
      shortcut: 'CommandOrControl+A',
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
    historyList: async () => [],
    historyClear: async () => ({}),
    // Mirrors the real catalogue in src/main/integrations.js — same categories,
    // same shape, same handful of adapters. `intCatalog: async () => []` used to
    // live here, which made the Integrations pane screenshot as an empty grid
    // with a "nothing matches" message and read like a bug in the app.
    intCatalog: async () => CATALOG.map((c) => Object.assign({}, c)),
    intCategories: async () => CATEGORIES.map((c) => Object.assign({}, c)),
    intDetail: async (name) => CATALOG.find((c) => c.id === name) || null,
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
