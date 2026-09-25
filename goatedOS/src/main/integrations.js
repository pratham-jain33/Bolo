const settings = require('./settings');
const gmail = require('./gmail');
const calendar = require('./calendar');
const spotify = require('./spotify');
const obsidian = require('./obsidian');
const localFiles = require('./local-files');
const localNotes = require('./local-notes');
const chatImport = require('./chat-import');
const maps = require('./maps');
const mcp = require('./mcp');

// Integration registry.
//
// Every adapter below is real code written for bolo — same functional areas an
// assistant needs, no bolo code. Gmail and Calendar share one Google grant
// (./google.js); the Apple-only services report unavailable on Windows because
// they genuinely are, not because they are unfinished.
//
// Each entry now carries the metadata the Integrations Studio needs, not just a
// status function: what it is, which category it belongs to, how it
// authenticates, and which actions it exposes. The Studio is a browse/connect
// surface, so the catalogue has to be readable without running anything —
// `status()` is the only part that touches the outside world.

const CATEGORIES = [
  { id: 'communication', label: 'Communication', blurb: 'Messages, mail, and calls.' },
  { id: 'productivity', label: 'Productivity', blurb: 'Calendar, tasks, and reminders.' },
  { id: 'knowledge', label: 'Knowledge', blurb: 'Notes, files, and imports.' },
  { id: 'media', label: 'Media', blurb: 'Music and playback control.' },
  { id: 'system', label: 'System', blurb: 'Built into this machine.' }
];

async function ok(name, extra = {}) {
  return { ok: true, integration: name, ...extra };
}
async function unavailable(name, reason) {
  return { ok: false, integration: name, available: false, reason };
}

const adapters = {
  // The one adapter that is not a stub. It owns a real OAuth connection (see
  // gmail.js) and every action below is a real Gmail REST call.
  gmail: {
    label: 'Gmail',
    category: 'communication',
    description: 'Send, read, reply to and search mail by voice, through your own Google account.',
    auth: 'oauth',
    actions: ['list_unread', 'read', 'send', 'reply', 'search', 'mark_read'],
    status: () => gmail.status(),
    connect: () => gmail.connect(),
    disconnect: () => gmail.disconnect(),
    action: (a, args) => gmailAction(a, args)
  },
  imessage: {
    label: 'Messages',
    category: 'communication',
    description: 'Send and read messages in the system messaging app.',
    auth: 'system',
    actions: ['send', 'read'],
    platforms: ['darwin'],
    status: async () => unavailable('imessage', 'macOS-only — not available on this platform'),
    action: async () => unavailable('imessage', 'unsupported-platform')
  },
  calendar: {
    label: 'Calendar',
    category: 'productivity',
    description: 'Check your schedule, add events and find free slots without opening a calendar.',
    auth: 'oauth',
    actions: ['today', 'tomorrow', 'next', 'find_free_slots', 'create_event', 'quick_add', 'move_event', 'delete_event', 'find_event', 'calendars'],
    status: () => calendar.status(),
    connect: () => calendar.connect(),
    disconnect: () => calendar.disconnect(),
    action: (a, args) => calendarAction(a, args)
  },
  reminders: {
    label: 'Reminders',
    category: 'productivity',
    description: 'Capture tasks and reminders as you think of them.',
    auth: 'system',
    actions: ['add', 'list'],
    platforms: ['darwin'],
    status: async () => unavailable('reminders', 'macOS-only — not available on this platform'),
    action: async () => unavailable('reminders', 'unsupported-platform')
  },
  obsidian: {
    label: 'Obsidian',
    category: 'knowledge',
    description: 'Append dictated notes straight into a vault, and read back what is in it.',
    auth: 'path',
    actions: ['append_note', 'read_note', 'list_notes', 'search', 'daily', 'set_vault'],
    status: () => obsidian.status(),
    // No connect() on purpose: the vault path *is* the connection, and set_vault
    // is the action that sets it. connect() here would only toggle a switch and
    // claim a readiness the module would then have to contradict.
    action: dispatcher('obsidian', obsidian, {
      append_note: 'appendNote', append: 'appendNote', add_note: 'appendNote', note: 'appendNote',
      read_note: 'readNote', read: 'readNote', open_note: 'readNote',
      list_notes: 'listNotes', list: 'listNotes', notes: 'listNotes',
      search: 'search', find: 'search',
      daily: 'daily', daily_note: 'daily', journal: 'daily',
      set_vault: 'setVault', set_path: 'setVault'
    })
  },
  localFiles: {
    label: 'Local files',
    category: 'knowledge',
    description: 'Search, open and reveal files under your documents, desktop and downloads folders.',
    auth: 'none',
    actions: ['search', 'open', 'reveal', 'recent'],
    status: () => localFiles.status(),
    action: dispatcher('localFiles', localFiles, {
      search: 'search', find: 'search', files: 'search',
      open: 'open', open_file: 'open',
      reveal: 'reveal', show: 'reveal',
      recent: 'recent', latest: 'recent'
    })
  },
  localNotes: {
    label: 'Local notes',
    category: 'knowledge',
    description: 'A plain notes store that needs no account at all.',
    auth: 'none',
    actions: ['add', 'list', 'read', 'remove', 'search'],
    status: () => localNotes.status(),
    action: dispatcher('localNotes', localNotes, {
      add: 'add', note: 'add', save: 'add', remember: 'add',
      list: 'list', notes: 'list',
      read: 'read', open: 'read',
      remove: 'remove', delete: 'remove', forget: 'remove',
      search: 'search', find: 'search'
    })
  },
  chatgptImport: {
    label: 'Chat history import',
    category: 'knowledge',
    description: 'Import an exported chat history so the agent knows your context.',
    auth: 'file',
    actions: ['import', 'profile', 'forget'],
    status: () => chatImport.status(),
    action: dispatcher('chatgptImport', chatImport, {
      import: 'import', load: 'import',
      profile: 'profile', context: 'profile',
      forget: 'forget', clear: 'forget'
    })
  },
  spotify: {
    label: 'Spotify',
    category: 'media',
    description: 'Play, pause, skip and search by voice, through your own Spotify account.',
    auth: 'oauth',
    actions: ['play', 'pause', 'next', 'previous', 'now_playing', 'search', 'volume', 'shuffle', 'repeat', 'like', 'devices'],
    status: () => spotify.status(),
    connect: () => spotify.connect(),
    disconnect: () => spotify.disconnect(),
    action: dispatcher('spotify', spotify, {
      play: 'play', resume: 'play',
      pause: 'pause', stop: 'pause',
      next: 'next', skip: 'next', skip_next: 'next',
      previous: 'previous', skip_back: 'previous', back: 'previous',
      now_playing: 'nowPlaying', nowplaying: 'nowPlaying', current: 'nowPlaying', what_is_playing: 'nowPlaying',
      search: 'search', find: 'search',
      volume: 'volume', set_volume: 'volume',
      shuffle: 'shuffle', repeat: 'repeat',
      like: 'like', save: 'like', unlike: 'like',
      devices: 'devices'
    })
  },
  maps: {
    label: 'Maps',
    category: 'system',
    description: 'Look up a place, or open directions, in the default browser.',
    auth: 'none',
    actions: ['search', 'directions', 'place', 'open_url', 'set_place'],
    status: () => maps.status(),
    action: dispatcher('maps', maps, {
      search: 'search', find: 'search', where: 'search',
      directions: 'directions', navigate: 'directions', route: 'directions',
      place: 'place', lookup: 'place',
      open_url: 'openUrl', open: 'openUrl',
      set_place: 'setPlace', set_home: 'setPlace', set_work: 'setPlace'
    })
  },
  // The user's own MCP servers, over stdio — see mcp.js for the protocol.
  //
  // This is the one adapter that fronts a *list* rather than a provider, which is
  // why it has no `connect()` on the adapter itself: connecting is something you
  // do to one named server, not to "MCP", so it lives in `actions` with the rest
  // rather than behind the Studio's single connect switch. Its own `action` is
  // hand-written for the same reason — every other adapter is one verb into one
  // one-argument module function, and these take a server name and a tool name.
  mcp: {
    label: 'MCP servers',
    category: 'system',
    description: 'Add your own tool servers — anything that speaks Model Context Protocol over stdio.',
    auth: 'none',
    actions: ['servers', 'connect', 'disconnect', 'tools', 'call'],
    status: () => mcp.status(),
    action: (a, args) => mcpAction(a, args)
  }
};

// Every adapter's actions are the same shape — one name in, one real function
// out, an argument object through — so the table is shared rather than written
// six times. The unknown-action refusal is the part that matters: a router that
// hallucinates a verb gets a sentence it can say, not a TypeError.
function dispatcher(name, mod, map) {
  return async (action, args) => {
    const key = String(action || '').toLowerCase();
    const fn = map[key];
    if (!fn) {
      return {
        ok: false, integration: name, error: 'unknown-action',
        reason: name + ' has no action called "' + String(action || '') + '".'
      };
    }
    return mod[fn](args && typeof args === 'object' ? args : {});
  };
}

// Which integrations the user has switched on. Persisted, because the Studio is
// a connect/disconnect surface and that state has to survive a restart.
function enabledMap() {
  const v = settings.get('integrationsEnabled');
  return v && typeof v === 'object' ? v : {};
}

function isEnabled(name) {
  return enabledMap()[name] === true;
}

// The browse surface: metadata only, no I/O. Anything that could be slow or
// fail lives behind statusAll().
function catalog() {
  return Object.entries(adapters).map(([id, a]) => ({
    id,
    label: a.label || id,
    category: a.category || 'system',
    description: a.description || '',
    auth: a.auth || 'none',
    actions: a.actions || [],
    platforms: a.platforms || null,
    enabled: isEnabled(id)
  }));
}

function categories() {
  return CATEGORIES.map((c) => ({ ...c }));
}

function detail(name) {
  const a = adapters[name];
  if (!a) return null;
  return {
    id: name,
    label: a.label || name,
    category: a.category || 'system',
    description: a.description || '',
    auth: a.auth || 'none',
    actions: a.actions || [],
    platforms: a.platforms || null,
    enabled: isEnabled(name)
  };
}

async function statusAll() {
  const out = {};
  for (const [k, v] of Object.entries(adapters)) {
    try {
      const s = await v.status();
      out[k] = { ...s, enabled: isEnabled(k) };
    } catch (e) {
      out[k] = { ok: false, integration: k, error: e.message, enabled: isEnabled(k) };
    }
  }
  return out;
}

async function status(name) {
  const a = adapters[name];
  if (!a) return { ok: false, error: 'unknown-integration', name };
  try {
    return { ...(await a.status()), enabled: isEnabled(name) };
  } catch (e) {
    return { ok: false, integration: name, error: e.message };
  }
}

function setEnabled(name, on) {
  if (!adapters[name]) return { ok: false, error: 'unknown-integration', name };
  const next = { ...enabledMap(), [name]: !!on };
  settings.set('integrationsEnabled', next);
  return { ok: true, id: name, enabled: !!on };
}

async function connect(name) {
  const d = detail(name);
  if (!d) return { ok: false, error: 'unknown-integration', name };

  if (d.platforms && !d.platforms.includes(process.platform)) {
    return {
      ok: false,
      id: name,
      error: 'unsupported-platform',
      reason: 'Only available on ' + d.platforms.join(', ')
    };
  }

  const a = adapters[name];
  const s = await status(name);

  // An adapter that owns a real connection runs it: this is where the browser
  // opens and the loopback server waits for the Google code, so it can take a
  // couple of minutes. A failure here is reported, never swallowed.
  if (a && typeof a.connect === 'function') {
    const r = await a.connect();
    if (!r || !r.ok) {
      return {
        ok: false, id: name, enabled: false, ready: false,
        error: (r && r.error) || 'connect-failed',
        reason: (r && (r.reason || r.error)) || 'The provider refused the connection.',
        hint: (r && r.hint) || null,
        needsAuth: true
      };
    }
    setEnabled(name, true);
    return { ok: true, id: name, enabled: true, ready: true, reason: null, email: r.email || null, needsAuth: false };
  }

  // Honest about the stubs: an integration whose provider isn't wired can be
  // switched on so the agent will route to it, but it still reports why it
  // can't actually do anything yet.
  setEnabled(name, true);
  return {
    ok: true,
    id: name,
    enabled: true,
    ready: !!s.ok,
    reason: s.ok ? null : s.reason || s.error || 'provider not configured',
    needsAuth: d.auth === 'oauth' && !s.ok
  };
}

function disconnect(name) {
  const a = adapters[name];
  if (!a) return { ok: false, error: 'unknown-integration', name };
  // Revoking is a network call, and this function's contract is synchronous —
  // so the local token is dropped immediately and the revoke is fired off
  // behind it. The connection is gone either way.
  if (typeof a.disconnect === 'function') {
    try { Promise.resolve(a.disconnect()).catch(() => {}); } catch (_) {}
  }
  setEnabled(name, false);
  return { ok: true, id: name, enabled: false };
}

/* ---------------------------------------------------------------------------
   Gmail actions
   ------------------------------------------------------------------------ */

// Every name a router or a spoken sentence might arrive under, onto one of the
// six real calls in gmail.js.
const GMAIL_ACTIONS = {
  list_unread: 'listUnread', list: 'listUnread', unread: 'listUnread', inbox: 'listUnread',
  read: 'readMessage', read_email: 'readMessage', open: 'readMessage',
  send: 'send', send_email: 'send', compose: 'send',
  reply: 'reply', reply_email: 'reply',
  search: 'search', search_email: 'search',
  mark_read: 'markRead', markread: 'markRead'
};

async function gmailAction(action, args) {
  const key = String(action || '').toLowerCase();
  const fn = GMAIL_ACTIONS[key];
  if (!fn) {
    return {
      ok: false, integration: 'gmail', error: 'unknown-action',
      reason: 'Gmail has no action called "' + String(action || '') + '".'
    };
  }
  return gmail[fn](args && typeof args === 'object' ? args : {});
}

// The act path.
//
// This is the one function the assistant needs to reach email by voice: give it
// the intent name the router decided on plus whatever was extracted from the
// sentence, and it does the call and hands back something to say. It is exported
// so agent.js / voice.js can call it without those files importing gmail.js
// themselves:
//
//     const r = await require('./integrations').emailIntent(intent, args);
//
// `args` are the router's own: { to, subject, body, cc, bcc, id, threadId, query }.
// A message body that comes back is data for the user to hear — nothing in it is
// treated as an instruction, here or anywhere downstream.
async function emailIntent(intent, args) {
  const a = args && typeof args === 'object' ? args : {};
  const name = String(intent || '').toLowerCase();

  // Refuse before doing anything if Gmail was never connected, so the user gets
  // one clear sentence instead of a Google error.
  const st = await status('gmail');
  if (!st.ok) {
    return {
      ok: false, integration: 'gmail', intent: name,
      error: st.error || 'not-connected',
      reason: st.reason || st.hint || 'Gmail is not connected.',
      speech: st.configured === false ? 'Gmail is not set up yet. ' + gmail.SETUP_HINT
        : 'Gmail is not connected yet. Connect it in Integrations first.'
    };
  }

  if (name === 'send_email' || name === 'send' || name === 'compose') {
    const r = await gmail.send({ to: a.to, subject: a.subject, body: a.body, cc: a.cc, bcc: a.bcc });
    return { ...r, intent: name, speech: r.ok ? 'Email sent to ' + r.to + '.' : 'I could not send that: ' + r.reason };
  }

  if (name === 'reply_email' || name === 'reply') {
    const target = a.id || a.threadId ? a : await newestUnread();
    const r = await gmail.reply({ id: target.id, threadId: target.threadId, body: a.body });
    return { ...r, intent: name, speech: r.ok ? 'Reply sent to ' + r.to + '.' : 'I could not reply: ' + r.reason };
  }

  if (name === 'search_email' || name === 'search') {
    const q = a.query || a.q || '';
    const r = await gmail.search({ query: q });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not search your mail: ' + r.reason };
    return {
      ...r, intent: name,
      speech: r.count
        ? r.count + ' message' + (r.count === 1 ? '' : 's') + ' match. The newest is from ' +
          shortFrom(r.messages[0]) + ': ' + (r.messages[0].subject || '(no subject)') + '.'
        : 'Nothing matched "' + q + '".'
    };
  }

  if (name === 'read_email' || name === 'read') {
    const r = a.id ? await gmail.readMessage({ id: a.id }) : await readNewestUnread(a.query);
    if (!r.ok) return { ...r, intent: name, speech: 'I could not read that: ' + r.reason };
    await gmail.markRead({ id: r.message.id });
    return {
      ...r, intent: name,
      speech: spokenBody(r.message)
    };
  }

  if (name === 'list_unread' || name === 'list' || name === 'inbox') {
    const r = await gmail.listUnread({ limit: a.limit });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not read your inbox: ' + r.reason };
    return {
      ...r, intent: name,
      speech: r.count
        ? 'You have ' + r.count + ' unread. The newest is from ' + shortFrom(r.messages[0]) + ': ' +
          (r.messages[0].subject || '(no subject)') + '.'
        : 'Nothing unread.'
    };
  }

  return {
    ok: false, integration: 'gmail', intent: name, error: 'unknown-intent',
    reason: 'No email action for "' + name + '".',
    speech: 'I am not sure what to do with your mail there.'
  };
}

/* ---------------------------------------------------------------------------
   Calendar actions + intent (delegated to calendar.js for the connection)
   ------------------------------------------------------------------------ */

async function calendarAction(action, args) {
  const r = await calendarActionImpl(action, args);
  return r;
}

async function newestUnread() {
  const r = await gmail.listUnread({ limit: 1 });
  const m = r.ok && r.messages && r.messages[0];
  return m ? { id: m.id, threadId: m.threadId } : {};
}

async function readNewestUnread(query) {
  if (query) {
    const s = await gmail.search({ query });
    const m = s.ok && s.messages && s.messages[0];
    if (m) return gmail.readMessage({ id: m.id });
    return { ok: false, integration: 'gmail', error: 'not-found', reason: 'Nothing matched that search.' };
  }
  const t = await newestUnread();
  if (!t.id) return { ok: false, integration: 'gmail', error: 'empty', reason: 'Nothing is unread.' };
  return gmail.readMessage({ id: t.id });
}

function shortFrom(m) {
  const raw = String((m && m.from) || '');
  const m2 = raw.match(/^\s*"?([^"<]*)"?\s*</);
  return (m2 && m2[1].trim()) || raw.replace(/<.*/, '').trim() || 'someone';
}

// What gets spoken: the sender, the subject, then a readable slice of the body.
function spokenBody(m) {
  const body = String(m.body || '').replace(/\s+/g, ' ').trim();
  const cut = body.length > 600 ? body.slice(0, 600) + '…' : body;
  return 'From ' + shortFrom(m) + ', ' + (m.subject || '(no subject)') + '. ' + cut;
}

/* ---------------------------------------------------------------------------
   Calendar actions
   ------------------------------------------------------------------------ */

// One name per real call in calendar.js, covering the words a router or a spoken
// sentence might arrive under.
const CALENDAR_ACTIONS = {
  today: 'today', calendar_today: 'today', schedule_today: 'today',
  tomorrow: 'tomorrow', calendar_tomorrow: 'tomorrow',
  next: 'next', next_event: 'next', next_meeting: 'next', upcoming: 'next',
  find_free_slots: 'freeSlots', free_slots: 'freeSlots', free: 'freeSlots',
  create_event: 'create', add_event: 'create', schedule: 'create', new_event: 'create',
  quick_add: 'quickAdd', add_to_calendar: 'quickAdd',
  move_event: 'update', reschedule: 'update', update_event: 'update',
  delete_event: 'remove', cancel_event: 'remove', remove_event: 'remove',
  find_event: 'find', search_calendar: 'find', search_events: 'find',
  calendars: 'calendars', list_calendars: 'calendars'
};

async function calendarActionImpl(action, args) {
  const key = String(action || '').toLowerCase();
  const fn = CALENDAR_ACTIONS[key];
  if (!fn) {
    return {
      ok: false, integration: 'calendar', error: 'unknown-action',
      reason: 'Calendar has no action called "' + String(action || '') + '".'
    };
  }
  return calendar[fn](args && typeof args === 'object' ? args : {});
}

function clockOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
}

function spokenEvent(e) {
  if (e.allDay) return e.summary + ', all day';
  return e.summary + ' at ' + clockOf(e.startAt);
}

// What a list of events sounds like. Three is the cap: read out a whole day and
// the answer stops being an answer, and the card on screen carries the rest.
function speakEvents(events, label, cap) {
  if (!events.length) return 'Nothing on your calendar ' + label + '.';
  const n = Math.min(events.length, cap || 3);
  const head = events.length + (events.length === 1 ? ' event ' : ' events ') + label;
  const rest = events.length > n ? ', plus ' + (events.length - n) + ' more' : '';
  return head + '. ' + events.slice(0, n).map(spokenEvent).join(', then ') + rest + '.';
}

// The act path for the calendar, the same shape as emailIntent: hand it the
// intent the router decided on plus what was extracted from the sentence, and it
// does the call and hands back something to say. Exported so agent.js can route
// to it without importing calendar.js and re-deriving the connection state.
async function calendarIntent(intent, args) {
  const a = args && typeof args === 'object' ? args : {};
  const name = String(intent || '').toLowerCase();

  // Refuse before doing anything if Calendar was never connected, so the user
  // gets one clear sentence instead of a Google error.
  const st = await status('calendar');
  if (!st.ok) {
    return {
      ok: false, integration: 'calendar', intent: name,
      error: st.error || 'not-connected',
      reason: st.reason || st.hint || 'Calendar is not connected.',
      speech: st.configured === false ? 'Calendar is not set up yet. ' + calendar.SETUP_HINT
        : 'Calendar is not connected yet. Connect it in Integrations first.'
    };
  }

  if (name === 'today' || name === 'calendar_today' || name === 'schedule_today') {
    const r = await calendar.today({ max: a.limit });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not read your calendar: ' + r.reason };
    return { ...r, intent: name, speech: speakEvents(r.events, 'today') };
  }

  if (name === 'tomorrow' || name === 'calendar_tomorrow') {
    const r = await calendar.tomorrow({ max: a.limit });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not read your calendar: ' + r.reason };
    return { ...r, intent: name, speech: speakEvents(r.events, 'tomorrow') };
  }

  if (name === 'next_event' || name === 'next' || name === 'next_meeting' || name === 'upcoming') {
    const r = await calendar.next({ max: 1 });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not read your calendar: ' + r.reason };
    const e = r.event;
    return {
      ...r, intent: name,
      speech: e
        ? 'Next up is ' + spokenEvent(e) + (e.allDay ? '.' : ' on ' + new Date(e.startAt).toDateString() + '.')
        : 'Nothing on your calendar in the next month.'
    };
  }

  if (name === 'find_free_slots' || name === 'free_slots' || name === 'free') {
    const r = await calendar.freeSlots({ date: a.date, minutes: a.minutes || a.duration, limit: a.limit });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not check your calendar: ' + r.reason };
    if (!r.count) return { ...r, intent: name, speech: 'You have no free ' + r.durationMinutes + ' minutes left that day.' };
    return {
      ...r, intent: name,
      speech: 'You have ' + r.count + (r.count === 1 ? ' free slot' : ' free slots') + ' of ' + r.durationMinutes +
        ' minutes. The first is ' + r.slots[0].startLocal + ' to ' + r.slots[0].endLocal + '.'
    };
  }

  if (name === 'create_event' || name === 'add_event' || name === 'schedule' || name === 'quick_add' || name === 'add_to_calendar') {
    // quickAdd is Calendar's own natural-language parser, and a spoken sentence
    // is exactly what it is for — so it is preferred whenever the sentence came
    // through whole, and create() is used when the router already split the
    // fields out.
    const text = a.text || a.sentence;
    const r = (text && !a.start)
      ? await calendar.quickAdd({ text })
      : await calendar.create({
          title: a.title || a.summary,
          start: a.start || a.when || a.date,
          end: a.end,
          minutes: a.minutes || a.duration,
          description: a.description,
          location: a.location,
          attendees: a.attendees,
          conference: a.conference
        });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not add that: ' + r.reason };
    return { ...r, intent: name };
  }

  if (name === 'move_event' || name === 'reschedule' || name === 'update_event') {
    const target = a.id ? { id: a.id } : await nextEventId(a.query);
    if (!target.id) return { ok: false, integration: 'calendar', intent: name, error: 'not-found', reason: 'Could not find the event to move.', speech: 'I could not find that event.' };
    const r = await calendar.update({ id: target.id, start: a.start || a.when || a.date, end: a.end, title: a.title });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not move that: ' + r.reason };
    return {
      ...r, intent: name,
      speech: 'Moved ' + r.event.summary + ' to ' + new Date(r.event.startAt).toDateString() + ' at ' + clockOf(r.event.startAt) + '.'
    };
  }

  if (name === 'delete_event' || name === 'cancel_event' || name === 'remove_event') {
    const target = a.id ? { id: a.id } : await nextEventId(a.query);
    if (!target.id) return { ok: false, integration: 'calendar', intent: name, error: 'not-found', reason: 'Could not find the event to delete.', speech: 'I could not find that event.' };
    const r = await calendar.remove({ id: target.id });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not delete that: ' + r.reason };
    return { ...r, intent: name, speech: 'Deleted ' + (target.summary || 'the event') + '.' };
  }

  if (name === 'find_event' || name === 'search_calendar' || name === 'search_events') {
    const q = a.query || a.q || a.title || '';
    const r = await calendar.find({ query: q });
    if (!r.ok) return { ...r, intent: name, speech: 'I could not search your calendar: ' + r.reason };
    return {
      ...r, intent: name,
      speech: r.count ? speakEvents(r.events, 'matching "' + q + '"', 2) : 'Nothing on your calendar matches "' + q + '".'
    };
  }

  return {
    ok: false, integration: 'calendar', intent: name, error: 'unknown-intent',
    reason: 'No calendar action for "' + name + '".',
    speech: 'I am not sure what to do with your calendar there.'
  };
}

/* ---------------------------------------------------------------------------
   MCP actions
   ------------------------------------------------------------------------ */

// Hand-written rather than routed through dispatcher() because these are the
// only actions in the table that take more than one argument — a server name,
// and then a tool name and its arguments — and the shared one-arg table has no
// way to express that. `server` and `name` are both accepted: the router reads a
// sentence, and "which server" arrives under either word.
async function mcpAction(action, args) {
  const a = args && typeof args === 'object' ? args : {};
  const key = String(action || '').toLowerCase();
  const server = a.server || a.serverName || a.name;
  switch (key) {
    case 'servers': case 'list': case 'list_servers':
      return mcp.servers();
    case 'connect': case 'start':
      return mcp.connect(server);
    case 'disconnect': case 'stop':
      return mcp.disconnect(server);
    case 'tools': case 'list_tools':
      return mcp.listTools(server);
    case 'call': case 'call_tool': case 'run_tool':
      return mcp.callTool(server, a.tool || a.toolName, a.arguments || a.args || {});
    default:
      return {
        ok: false, integration: 'mcp', error: 'unknown-action',
        reason: 'MCP servers have no action called "' + String(action || '') + '".'
      };
  }
}

/* ── the rest of the integrations, on the voice path ────────────────────────

   Email and calendar each got a hand-written intent function above, because
   their sentences need real composition — which message, which event, what
   time. These do not. Every other adapter is one verb in, one result out, and
   the modules mostly write their own line already.

   So this is one table: intent name -> which adapter, which action, and the
   sentence to say when the module's own result has none. `speak()` always
   prefers what the module returned; a module that just did the thing knows the
   outcome and the table only fills the silence. */

const VOICE = {
  /* local notes — the plain store, no account */
  add_note:     { integration: 'localNotes', action: 'add',
                  say: (r) => 'Noted.' },
  list_notes:   { integration: 'localNotes', action: 'list',
                  say: (r) => !r.count ? 'You have no notes yet.'
                    : 'You have ' + r.count + ' note' + (r.count === 1 ? '' : 's') + '. ' +
                      r.notes.slice(0, 3).map((n) => n.title).join(', ') + '.' },
  read_note:    { integration: 'localNotes', action: 'read',
                  say: () => 'Here it is.' },
  search_notes: { integration: 'localNotes', action: 'search',
                  say: (r) => !r.count ? 'Nothing in your notes matched that.'
                    : r.count + ' note' + (r.count === 1 ? '' : 's') + ' matched.' },
  delete_note:  { integration: 'localNotes', action: 'remove',
                  say: () => 'Deleted.' },

  /* local files — inside documents, desktop and downloads only */
  find_file:    { integration: 'localFiles', action: 'search',
                  say: (r) => !r.count ? 'I couldn\'t find a file called that.'
                    : r.count === 1 ? 'Found ' + r.files[0].name + '.'
                    : 'Found ' + r.count + ' files — ' + r.files.slice(0, 3).map((f) => f.name).join(', ') + '.' },
  recent_files: { integration: 'localFiles', action: 'recent',
                  say: (r) => !r.count ? 'I couldn\'t find anything recent.'
                    : 'The newest is ' + r.files[0].name + '.' },
  open_file:    { integration: 'localFiles', action: 'open',
                  say: (r) => 'Opened ' + r.name + '.' },
  reveal_file:  { integration: 'localFiles', action: 'reveal',
                  say: (r) => 'Showed ' + r.name + ' in Explorer.' },

  /* spotify — its own module writes the sentence for every transport verb */
  spotify_play:     { integration: 'spotify', action: 'play' },
  spotify_pause:    { integration: 'spotify', action: 'pause' },
  spotify_next:     { integration: 'spotify', action: 'next' },
  spotify_previous: { integration: 'spotify', action: 'previous' },
  spotify_like:     { integration: 'spotify', action: 'like' },
  now_playing:      { integration: 'spotify', action: 'now_playing' },
  spotify_devices:  { integration: 'spotify', action: 'devices',
                      say: (r) => !r.devices.length ? 'Spotify has no devices open.'
                        : 'Spotify is open on ' + r.devices.map((d) => d.name).join(', ') + '.' },

  /* maps — opens in the browser, and says so itself */
  find_place:  { integration: 'maps', action: 'search' },
  directions:  { integration: 'maps', action: 'directions' },

  /* obsidian — appends into the user's own vault */
  append_note: { integration: 'obsidian', action: 'append_note',
                 say: (r) => (r.created ? 'Created ' : 'Added to ') + r.name + '.' },
  daily_note:  { integration: 'obsidian', action: 'daily',
                 say: (r) => r.action === 'read' ? 'Here is today\'s note.'
                   : (r.created ? 'Started today\'s note.' : 'Added that to today\'s note.') },

  /* imported chat history */
  import_history: { integration: 'chatgptImport', action: 'import' },
  my_context:     { integration: 'chatgptImport', action: 'profile' },

  /* mcp — the user's own tool servers. Deliberately only the two that are a
     *listing*: a listing is what a voice is good at, and "which servers do I
     have" and "what can that one do" both read aloud as one sentence.

     There is no intent for calling a tool, and that is a decision rather than an
     omission. An intent for it would have to carry "which tool, with what
     arguments", which no prompt can describe for a server whose schema this app
     only learns at runtime — so the intent would be a hole the model fills by
     guessing. Connecting and disconnecting are Settings-surface actions for the
     same reason: they name a server, which is a thing to pick, not to hear. */
  mcp_servers: { integration: 'mcp', action: 'servers',
                 say: (r) => !r.count ? 'No MCP servers are set up yet.'
                   : 'You have ' + r.count + ' MCP server' + (r.count === 1 ? '' : 's') + ': ' +
                     r.servers.map((s) => s.name).join(', ') + '.' },
  mcp_tools:   { integration: 'mcp', action: 'tools',
                 say: (r) => !r.count ? 'That MCP server offers no tools.'
                   : r.server + ' offers ' + r.count + ' tool' + (r.count === 1 ? '' : 's') + ': ' +
                     r.tools.slice(0, 6).map((t) => t.name).join(', ') +
                     (r.count > 6 ? ', and ' + (r.count - 6) + ' more' : '') + '.' }
};

// What went wrong, in one line. The refusal cases are the ones that matter: a
// not-connected adapter has to say which switch to turn on rather than "that
// didn't work", because the user can act on the first and not the second.
function refusalSpeech(integration, result) {
  const err = String((result && result.error) || '');
  const label = (adapters[integration] && adapters[integration].label) || integration;
  if (result && result.reason) return result.reason;
  switch (err) {
    case 'not-connected':
      return label + ' isn\'t switched on. Turn it on in Settings, under Integrations.';
    case 'not-configured':
      return label + ' isn\'t set up yet — that is in Settings, under Integrations.';
    case 'not-authorised':
    case 'unauthorised':
    case 'no-token':
      return label + ' needs you to sign in again.';
    case 'not-found':
      return 'I couldn\'t find that.';
    case 'empty-query':
    case 'empty':
    case 'bad-query':
      return 'Tell me what to look for.';
    default:
      return label + ' couldn\'t do that' + (err ? ' (' + err + ')' : '') + '.';
  }
}

async function voiceIntent(name, args) {
  const row = VOICE[String(name || '')];
  if (!row) {
    return { ok: false, integration: null, intent: name, error: 'unknown-intent',
             speech: 'I don\'t have a way to do that one.' };
  }
  const result = await run(row.integration, row.action, args || {});
  if (!result || result.ok === false) {
    return {
      ok: false, integration: row.integration, intent: name,
      // The module's own line wins even on failure — it is the one that knows
      // whether the store was full or the vault path was wrong.
      speech: (result && result.speech) || refusalSpeech(row.integration, result),
      error: (result && result.error) || 'failed',
      reason: (result && result.reason) || null
    };
  }
  const speech = result.speech || (row.say ? row.say(result, args || {}) : null) || 'Done.';
  return { ...result, ok: true, intent: name, speech };
}

function voiceList() {
  return Object.keys(VOICE);
}

// The event a move/delete is aimed at when the router gave no id: the next one
// up, or the first match for a title. Carries the summary so the confirmation
// line can name what it is about to change.
async function nextEventId(query) {
  if (query) {
    const f = await calendar.find({ query });
    const e = f.ok && f.events && f.events[0];
    return e ? { id: e.id, summary: e.summary } : {};
  }
  const n = await calendar.next({ max: 1 });
  return n.ok && n.event ? { id: n.event.id, summary: n.event.summary } : {};
}

async function run(name, action, args) {
  const a = adapters[name];
  if (!a) return { ok: false, error: 'unknown-integration', name };
  if (!isEnabled(name)) return { ok: false, error: 'not-connected', name };
  return a.action(action, args);
}

function list() {
  return Object.keys(adapters);
}

module.exports = {
  list, catalog, categories, detail, statusAll, status,
  connect, disconnect, setEnabled, isEnabled, run,
  gmailAction, emailIntent, calendarAction, calendarIntent, mcpAction,
  voiceIntent, voiceList, VOICE
};
