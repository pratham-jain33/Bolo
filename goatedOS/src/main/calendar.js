'use strict';

// Real Google Calendar, on the same grant as Gmail (see ./google.js).
//
// One scope: calendar.events. That is read *and* write on events across every
// calendar the account can see, which is exactly what this file does — list,
// search, create, move, delete. calendar.readonly would be redundant next to it
// (it adds the calendar *list*, which nothing here needs) and freebusy is
// deliberately not used: an account with the events scope can already read every
// busy interval, so free-slot search is computed here from the events it can
// see. Fewer scopes, and one fewer round trip.
//
// Times are the hard part and are handled explicitly:
//   - A wall-clock time with no offset is converted using the *machine's* zone,
//     which is the only zone the user is actually in when they say "at three".
//   - `timeMin`/`timeMax` are RFC3339 instants, and Google rejects a bare local
//     time there, so they are always formatted with the local offset.
//   - An all-day event is `{ date: 'YYYY-MM-DD' }`, never a dateTime at midnight;
//     sending the latter turns a birthday into an 00:00–00:00 appointment.
//
// Everything returns { ok, ... } and never throws.

const google = require('./google');

const API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// primary is the account's own calendar. Named so the user can be told which
// calendar an event landed on.
const DEFAULT_CALENDAR = 'primary';

const MAX_EVENTS = 50;
const MAX_TITLE = 200;
const MAX_DESC = 8000;
const MAX_LOCATION = 400;
const MAX_ATTENDEES = 50;

/* ---------------------------------------------------------------------------
   Time
   ------------------------------------------------------------------------ */

// The zone the machine is in, which is the zone the user means.
function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// An instant as RFC3339 *with an offset*. `toISOString()` would be UTC, which is
// correct and unreadable and, worse, makes "today" mean the wrong day for
// anyone east or west of Greenwich — so the offset is preserved.
function instant(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  const off = -t.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return (
    t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
    'T' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  );
}

function dateOnly(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Accepts what a person or a model actually produces — an ISO string, a Date, a
// { dateTime } / { date } object straight out of the API — and returns a Date.
function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') return asDate(v.dateTime || v.date);
  const s = String(v).trim();
  // A date with no time is midnight local, not midnight UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : t;
}

// What goes into the API for a start/end. An all-day event is `{ date }` and
// everything else is a `dateTime` in the local zone — the two shapes are not
// interchangeable, and sending midnight as a dateTime turns a holiday into a
// 00:00–00:00 appointment that shows up on nobody's calendar.
//
// `allDay` is passed in rather than sniffed, because the two callers know it and
// a guess here is what produced a dateTime for a bare 'YYYY-MM-DD'.
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}$/;

function whenInput(raw, allDay) {
  const asObject = raw && typeof raw === 'object' && !(raw instanceof Date) ? raw : null;
  const dateShaped = !!(asObject && asObject.date && !asObject.dateTime) || DATE_SHAPED.test(String(raw == null ? '' : raw).trim());
  const t = asDate(raw);
  if (!t) return null;
  if (allDay || dateShaped) return { date: dateOnly(t) };
  return { dateTime: instant(t), timeZone: localZone() };
}

/* ---------------------------------------------------------------------------
   Status
   ------------------------------------------------------------------------ */

function status() {
  const s = google.status();
  if (s.connected && google.missingScopes(SCOPES).length) {
    return {
      ok: false, integration: 'calendar', connected: false, configured: true,
      email: s.email || null, needsReconnect: true, error: 'missing-scopes',
      reason: 'The connected Google account has not granted Calendar access. Connect Calendar to allow it.'
    };
  }
  return { ...s, integration: 'calendar' };
}

// The account's address, without needing the Gmail scope: on the primary
// calendar, the calendar's `id` *is* the address. That is the only place
// Calendar exposes it, and it is why a Calendar-only grant can still name the
// account in the pane.
async function resolveEmail() {
  const r = await request('GET', '/calendars/primary');
  const id = r.ok && r.data && r.data.id ? String(r.data.id) : '';
  return /@/.test(id) ? id : null;
}

async function connect() {
  const st = status();
  if (st.ok) return { ok: true, integration: 'calendar', enabled: true, connected: true, email: st.email || null };

  const r = await google.connect(SCOPES, 'Calendar', resolveEmail);
  if (!r.ok) return fail(r.error || 'connect-failed', r.reason, r.hint ? { hint: r.hint } : null);
  return { ok: true, integration: 'calendar', enabled: true, connected: true, email: r.email || null };
}

// Signs out of the shared Google grant — which means Gmail too, and the pane
// says so before it asks.
async function disconnect() {
  await google.disconnect();
  return { ok: true, integration: 'calendar', connected: false, email: null, shared: true };
}

function shutdown() {
  google.shutdown();
}

function fail(error, reason, extra) {
  return { ok: false, integration: 'calendar', error, reason: reason || error, ...(extra || {}) };
}

function request(method, path, opts) {
  return google.request(method, API + path, { ...(opts || {}), base: 'calendar' });
}

/* ---------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------ */

function normEvent(e) {
  if (!e) return null;
  const allDay = !!(e.start && e.start.date && !e.start.dateTime);
  return {
    id: e.id,
    status: e.status || 'confirmed',
    summary: e.summary || '(no title)',
    description: e.description || '',
    location: e.location || '',
    allDay,
    start: (e.start && (e.start.dateTime || e.start.date)) || null,
    end: (e.end && (e.end.dateTime || e.end.date)) || null,
    // A Date, so callers never have to know which of the two shapes came back.
    startAt: asDate(e.start) ? asDate(e.start).toISOString() : null,
    endAt: asDate(e.end) ? asDate(e.end).toISOString() : null,
    htmlLink: e.htmlLink || null,
    hangoutLink: e.hangoutLink || null,
    attendees: (e.attendees || []).map((a) => ({ email: a.email, name: a.displayName || null, self: !!a.self })),
    organizer: e.organizer ? { email: e.organizer.email, self: !!e.organizer.self } : null,
    recurringEventId: e.recurringEventId || null
  };
}

// Events between two instants. `singleEvents: true` expands a recurring series
// into the individual occurrences; without it a weekly stand-up comes back once
// with a rule attached, which is not what "what's on tomorrow" means.
async function listEvents({ from, to, max, calendarId, query } = {}) {
  const min = from ? instant(asDate(from)) : instant(new Date());
  const end = to ? asDate(to) : new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const maxTime = to ? instant(end) : instant(end);
  if (!min || !maxTime) return fail('bad-range', 'Those dates could not be read.');

  const r = await request('GET', '/calendars/' + encodeURIComponent(calendarId || DEFAULT_CALENDAR) + '/events', {
    query: {
      timeMin: min,
      timeMax: maxTime,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: Math.max(1, Math.min(MAX_EVENTS, Number(max) || 15)),
      ...(query ? { q: String(query).slice(0, 256) } : {})
    }
  });
  if (!r.ok) return fail(r.error, r.reason);

  const events = ((r.data && r.data.items) || []).map(normEvent).filter(Boolean)
    .filter((e) => e.status !== 'cancelled');
  return { ok: true, integration: 'calendar', count: events.length, events, calendarId: calendarId || DEFAULT_CALENDAR };
}

// A single day, from midnight to midnight local — which is the only range that
// answers "what's on today" without an off-by-one at the edges.
async function day({ date, max, calendarId } = {}) {
  const base = asDate(date) || new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const r = await listEvents({ from: start, to: end, max, calendarId });
  if (!r.ok) return r;
  return { ...r, day: dateOnly(start), label: start.toDateString() };
}

// Today, then tomorrow: the two the voice answers ask for by name.
function today(opts) {
  return day(opts);
}

function tomorrow(opts) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return day({ ...(opts || {}), date: d });
}

async function next({ max } = {}) {
  const r = await listEvents({ from: new Date(), to: new Date(Date.now() + 30 * 24 * 3600 * 1000), max: max || 1 });
  if (!r.ok) return r;
  return { ok: true, integration: 'calendar', event: r.events[0] || null };
}

async function getEvent({ id, calendarId } = {}) {
  const eid = String(id || '').trim();
  if (!eid) return fail('bad-id', 'No event id was given.');
  const r = await request('GET', '/calendars/' + encodeURIComponent(calendarId || DEFAULT_CALENDAR) + '/events/' + encodeURIComponent(eid));
  if (!r.ok) return fail(r.error, r.reason);
  return { ok: true, integration: 'calendar', event: normEvent(r.data) };
}

// Text search, over the next year. Calendar's own `q` is a substring match on
// the fields that matter rather than a ranking, so the newest match wins.
async function find({ query, calendarId } = {}) {
  const q = String(query || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 256);
  if (!q) return fail('bad-query', 'Nothing to search for.');
  const r = await listEvents({
    from: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    to: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    max: MAX_EVENTS, calendarId, query: q
  });
  if (!r.ok) return r;
  const upcoming = r.events.filter((e) => !e.endAt || Date.parse(e.endAt) >= Date.now() - 3600 * 1000);
  return { ok: true, integration: 'calendar', query: q, count: upcoming.length, events: upcoming };
}

/* ---------------------------------------------------------------------------
   Free time

   The complement of the day's events, computed here rather than asked of
   freebusy: the events scope already returns every busy interval, so this costs
   nothing and needs no second scope.
   ------------------------------------------------------------------------ */

// Working hours, as the window a free slot is offered inside.
const WORK_START = 9;
const WORK_END = 18;

// The complement of a set of busy intervals inside a window, as pure arithmetic
// on epoch milliseconds. Kept separate from the API call so the part that can be
// wrong in a way nobody notices — an off-by-one that hides a real meeting — is
// testable without a network.
function freeWindows(busy, from, to, needMs, limit) {
  const inWindow = (busy || [])
    .filter(([s, t]) => Number.isFinite(s) && Number.isFinite(t) && t > from && s < to)
    .map(([s, t]) => [Math.max(s, from), Math.min(t, to)])
    .sort((a, b) => a[0] - b[0]);

  // Overlapping and back-to-back intervals become one. Two meetings that touch
  // are not a gap, and a slot offered between them would be a slot inside a
  // meeting.
  const merged = [];
  for (const [s, t] of inWindow) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], t);
    else merged.push([s, t]);
  }

  const cap = Math.max(1, Number(limit) || 3);
  const out = [];
  let cursor = from;
  for (const [s, t] of merged) {
    if (s - cursor >= needMs) out.push([cursor, s]);
    cursor = Math.max(cursor, t);
    if (out.length >= cap) break;
  }
  if (out.length < cap && to - cursor >= needMs) out.push([cursor, to]);
  return out.slice(0, cap);
}

async function freeSlots({ date, minutes, within, calendarId, limit } = {}) {
  const need = Math.max(5, Math.min(8 * 60, Number(minutes) || 30));
  const base = asDate(date) || new Date();
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const r = await listEvents({ from: dayStart, to: new Date(dayStart.getTime() + 24 * 3600 * 1000), max: MAX_EVENTS, calendarId });
  if (!r.ok) return r;

  const win = within || { start: WORK_START, end: WORK_END };
  const from = new Date(dayStart.getTime() + win.start * 3600 * 1000).getTime();
  const to = new Date(dayStart.getTime() + win.end * 3600 * 1000).getTime();

  // An all-day event blocks the whole window — a holiday is not a free
  // afternoon.
  const busy = [];
  for (const e of r.events) {
    if (e.status === 'cancelled') continue;
    if (e.allDay) { busy.push([from, to]); continue; }
    const s = asDate(e.start);
    const t = asDate(e.end);
    if (s && t) busy.push([s.getTime(), t.getTime()]);
  }

  const slots = freeWindows(busy, from, to, need * 60000, limit);
  const out = slots.map(([s, t]) => ({
    start: instant(new Date(s)),
    end: instant(new Date(t)),
    startLocal: new Date(s).toTimeString().slice(0, 5),
    endLocal: new Date(t).toTimeString().slice(0, 5),
    minutes: Math.round((t - s) / 60000)
  }));

  return {
    ok: true, integration: 'calendar', day: dateOnly(dayStart), busyCount: busy.length,
    durationMinutes: need, slots: out, count: out.length
  };
}

/* ---------------------------------------------------------------------------
   Writing
   ------------------------------------------------------------------------ */

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function attendeeList(raw) {
  if (raw == null || raw === '') return [];
  const parts = (Array.isArray(raw) ? raw : String(raw).split(/[,;]/)).map((p) => String(p).trim()).filter(Boolean);
  return parts.slice(0, MAX_ATTENDEES)
    .map((p) => ({ email: p.replace(/^.*<([^>]*)>.*$/, '$1').trim() }))
    .filter((a) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/.test(a.email));
}

// A body for the API from what the caller gave. `start` may be a Date, an ISO
// string or { dateTime }; `end` may be omitted, in which case the event is an
// hour long (or, for an all-day event, one day).
function buildBody(a) {
  const allDay = !!(a.date && !a.start) || !!a.allDay;
  // A time is required. Defaulting to "now" would turn a misheard sentence into
  // an appointment in the next hour, which is worse than saying no.
  const raw = allDay ? (a.date || a.start) : a.start;
  if (!raw) return { error: 'bad-start', reason: 'No start time was given.' };

  const start = whenInput(raw, allDay);
  if (!start) return { error: 'bad-start', reason: 'That start time could not be read.' };

  let end = null;
  if (a.end) {
    end = whenInput(a.end, allDay);
    if (!end) return { error: 'bad-end', reason: 'That end time could not be read.' };
  }
  if (!end) {
    const s = asDate(raw);
    const plus = allDay ? 24 * 3600 * 1000 : Math.max(5, Number(a.minutes) || 60) * 60000;
    end = allDay
      ? { date: dateOnly(new Date(s.getTime() + plus)) }
      : { dateTime: instant(new Date(s.getTime() + plus)), timeZone: localZone() };
  }

  const body = {
    summary: clean(a.title || a.summary, MAX_TITLE) || '(no title)',
    start,
    end
  };
  if (a.description) body.description = String(a.description).slice(0, MAX_DESC);
  if (a.location) body.location = clean(a.location, MAX_LOCATION);
  const attendees = attendeeList(a.attendees);
  if (attendees.length) body.attendees = attendees;

  // A conference link is asked for explicitly — `conferenceDataVersion: 1` alone
  // does nothing, and the request has to carry the createRequest.
  if (a.conference) body.conferenceData = { createRequest: { requestId: 'bolo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) } };

  return { body, allDay, conference: !!a.conference };
}

async function create(a = {}) {
  const built = buildBody(a);
  if (built.error) return fail(built.error, built.reason);

  const r = await request('POST', '/calendars/' + encodeURIComponent(a.calendarId || DEFAULT_CALENDAR) + '/events', {
    query: built.conference ? { conferenceDataVersion: 1, sendUpdates: a.notify ? 'all' : 'none' } : (a.notify ? { sendUpdates: 'all' } : undefined),
    body: built.body
  });
  if (!r.ok) return fail(r.error, r.reason);

  const event = normEvent(r.data);
  return {
    ok: true, integration: 'calendar', action: 'create',
    event,
    speech: 'Added ' + event.summary + ' on ' + new Date(event.startAt).toDateString() +
      ' at ' + (event.allDay ? 'all day' : new Date(event.startAt).toTimeString().slice(0, 5)) + '.'
  };
}

// Calendar's own natural-language parser. Worth having separately from create():
// "lunch with Priya tomorrow at 1" is a sentence, not a set of fields, and this
// endpoint is Google's parser for exactly that sentence.
async function quickAdd({ text, calendarId, notify } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!t) return fail('empty-text', 'Nothing to add.');
  const r = await request('POST', '/calendars/' + encodeURIComponent(calendarId || DEFAULT_CALENDAR) + '/events/quickAdd', {
    query: { text: t, ...(notify ? { sendUpdates: 'all' } : {}) }
  });
  if (!r.ok) return fail(r.error, r.reason);
  const event = normEvent(r.data);
  return { ok: true, integration: 'calendar', action: 'quickAdd', event, speech: 'Added ' + event.summary + '.' };
}

async function update({ id, calendarId, ...patch } = {}) {
  const eid = String(id || '').trim();
  if (!eid) return fail('bad-id', 'No event id was given.');

  const base = '/calendars/' + encodeURIComponent(calendarId || DEFAULT_CALENDAR) + '/events/' + encodeURIComponent(eid);
  const current = await request('GET', base);
  if (!current.ok) return fail(current.error, current.reason);

  const body = { ...current.data };
  const wasAllDay = !!(current.data.start && current.data.start.date && !current.data.start.dateTime);
  if (patch.title != null) body.summary = clean(patch.title, MAX_TITLE) || '(no title)';
  if (patch.description != null) body.description = String(patch.description).slice(0, MAX_DESC);
  if (patch.location != null) body.location = clean(patch.location, MAX_LOCATION);
  if (patch.start != null) {
    const s = whenInput(patch.start, wasAllDay);
    if (!s) return fail('bad-start', 'That start time could not be read.');
    body.start = s;
    if (patch.end == null) {
      // Moving the start without an end would leave the event inverted, so the
      // end travels with it — by the original duration for a timed event, and by
      // whole days for an all-day one, where the two shapes must match or the
      // API refuses the write.
      const wasStart = asDate(current.data.start);
      const wasEnd = asDate(current.data.end);
      if (wasAllDay || s.date) {
        const days = wasStart && wasEnd ? Math.max(1, Math.round((wasEnd - wasStart) / 86400000)) : 1;
        body.start = { date: dateOnly(asDate(patch.start)) };
        body.end = { date: dateOnly(new Date(asDate(patch.start).getTime() + days * 86400000)) };
      } else {
        const span = wasStart && wasEnd ? Math.max(300000, wasEnd - wasStart) : 3600000;
        body.end = { dateTime: instant(new Date(asDate(patch.start).getTime() + span)), timeZone: localZone() };
      }
    }
  }
  if (patch.end != null) {
    const e = whenInput(patch.end, wasAllDay || !!(body.start && body.start.date));
    if (!e) return fail('bad-end', 'That end time could not be read.');
    body.end = e;
  }

  const r = await request('PUT', base, { body });
  if (!r.ok) return fail(r.error, r.reason);
  return { ok: true, integration: 'calendar', action: 'update', event: normEvent(r.data) };
}

async function remove({ id, calendarId, notify } = {}) {
  const eid = String(id || '').trim();
  if (!eid) return fail('bad-id', 'No event id was given.');
  const r = await request('DELETE', '/calendars/' + encodeURIComponent(calendarId || DEFAULT_CALENDAR) + '/events/' + encodeURIComponent(eid), {
    query: notify ? { sendUpdates: 'all' } : undefined
  });
  if (!r.ok) return fail(r.error, r.reason);
  return { ok: true, integration: 'calendar', action: 'delete', id: eid, speech: 'Deleted it.' };
}

async function calendars() {
  const r = await request('GET', '/users/me/calendarList', { query: { maxResults: 50 } });
  if (!r.ok) return fail(r.error, r.reason);
  const list = ((r.data && r.data.items) || []).map((c) => ({
    id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole, timeZone: c.timeZone || null
  }));
  return { ok: true, integration: 'calendar', count: list.length, calendars: list };
}

module.exports = {
  SCOPES, SETUP_HINT: google.SETUP_HINT,
  status, connect, disconnect, shutdown,
  listEvents, day, today, tomorrow, next, getEvent, find, freeSlots,
  create, quickAdd, update, remove, calendars,
  _internals: { asDate, instant, dateOnly, buildBody, normEvent, localZone, whenInput, freeWindows }
};