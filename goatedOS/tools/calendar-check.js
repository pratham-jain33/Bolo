// Exercises the parts of the Google integrations that can be wrong silently.
// No network, no credentials: everything here is arithmetic and string building
// — which is exactly where the bugs that nobody notices live.
//
// The time cases matter most. A calendar bug is not a crash; it is a meeting
// offered at the wrong hour, or an all-day event turned into an appointment at
// midnight, and neither shows up until the user is already late.
//   electron tools/calendar-check.js
const { app } = require('electron');
const calendar = require('../src/main/calendar');
const google = require('../src/main/google');

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label +
    (ok ? '' : '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)));
}

function truthy(label, v) {
  check(label, !!v, true);
}

app.whenReady().then(() => {
  const { asDate, instant, dateOnly, buildBody, freeWindows, localZone } = calendar._internals;

  console.log('\n— time formatting —');

  // A wall-clock time keeps its wall-clock hour. toISOString() would move it,
  // and "today" would then mean the wrong day for half the planet.
  const local = new Date(2026, 8, 22, 15, 30, 0);
  const iso = instant(local);
  truthy('instant() ends with a numeric offset', /[+-]\d{2}:\d{2}$/.test(iso));
  check('instant() keeps the local hour', iso.slice(11, 16), '15:30');
  check('instant() parses back to the same moment', new Date(iso).getTime(), local.getTime());

  check('dateOnly()', dateOnly(new Date(2026, 8, 22, 23, 59)), '2026-09-22');
  check('asDate() on a bare date is local midnight', asDate('2026-09-22').getHours(), 0);
  check('asDate() on a bare date is the right day', asDate('2026-09-22').getDate(), 22);
  check('asDate() on a Date passes it through', asDate(local).getTime(), local.getTime());
  check('asDate() on an API { dateTime } object', asDate({ dateTime: iso }).getTime(), local.getTime());
  check('asDate() on an API { date } object', asDate({ date: '2026-09-22' }).getDate(), 22);
  check('asDate() on nonsense', asDate('not a date'), null);
  truthy('localZone() resolves', typeof localZone() === 'string' && localZone().length > 0);

  console.log('\n— building an event —');

  const e1 = buildBody({ title: 'Standup', start: new Date(2026, 8, 22, 9, 30).toISOString() });
  check('timed event is a dateTime', !!e1.body.start.dateTime, true);
  check('no all-day flag', e1.allDay, false);
  check('default length is an hour', new Date(e1.body.end.dateTime) - new Date(e1.body.start.dateTime), HOUR);
  check('title lands on summary', e1.body.summary, 'Standup');

  const e2 = buildBody({ title: 'Standup', start: new Date(2026, 8, 22, 9, 30).toISOString(), minutes: 15 });
  check('explicit length is used', new Date(e2.body.end.dateTime) - new Date(e2.body.start.dateTime), 15 * MIN);

  const e3 = buildBody({ title: 'Diwali', date: '2026-11-08' });
  check('a date-only input is all-day', e3.allDay, true);
  check('an all-day event uses { date }', e3.body.start.date, '2026-11-08');
  check('an all-day event ends the next day', e3.body.end.date, '2026-11-09');
  check('an all-day event has no dateTime', e3.body.start.dateTime, undefined);

  const e4 = buildBody({ title: 'X' });
  check('no start is an error, not a midnight event', e4.error, 'bad-start');

  const e5 = buildBody({ title: 'Sync', start: new Date(2026, 8, 22, 9, 0).toISOString(), attendees: 'a@b.com, not-an-address, c@d.org' });
  check('junk attendees are dropped, not passed through', e5.body.attendees, [{ email: 'a@b.com' }, { email: 'c@d.org' }]);
  check('an event with no attendees carries no field', buildBody({ title: 'Y', start: new Date().toISOString() }).body.attendees, undefined);
  check('a title with a newline cannot inject a field', buildBody({ title: 'a\r\nX: y', start: new Date().toISOString() }).body.summary, 'a X: y');
  check('a missing title still produces one', buildBody({ start: new Date().toISOString() }).body.summary, '(no title)');

  console.log('\n— free windows —');

  const day = new Date(2026, 8, 22, 9, 0).getTime();   // 09:00
  const win = { from: day, to: day + 8 * HOUR, need: 30 * MIN }; // 09:00–17:00

  const busy = (a, b) => [day + a * HOUR, day + b * HOUR];
  const fmt = (w) => w.map(([s, t]) => [(s - day) / HOUR, (t - day) / HOUR]);

  check('an empty day offers the whole window first',
    fmt(freeWindows([], win.from, win.to, win.need, 1)), [[0, 8]]);

  check('a 10–11 meeting leaves 09:00 before it',
    fmt(freeWindows([busy(1, 2)], win.from, win.to, win.need, 1)), [[0, 1]]);

  check('two meetings that touch are one block, not a gap',
    fmt(freeWindows([busy(1, 2), busy(2, 3)], win.from, win.to, win.need, 1)), [[0, 1]]);

  check('overlapping meetings merge',
    fmt(freeWindows([busy(1, 3), busy(2, 4)], win.from, win.to, win.need, 1)), [[0, 1]]);

  check('a block shorter than the ask is not offered',
    fmt(freeWindows([busy(0, 1), busy(1.25, 8)], win.from, win.to, win.need, 3)), []);

  check('a busy day with one 45-minute hole offers it',
    fmt(freeWindows([busy(0, 1), busy(1.75, 8)], win.from, win.to, win.need, 3)), [[1, 1.75]]);

  check('meetings outside the window are ignored',
    fmt(freeWindows([[day - 5 * HOUR, day - 4 * HOUR]], win.from, win.to, win.need, 1)), [[0, 8]]);

  check('the limit is respected',
    freeWindows([busy(1, 1.5), busy(2, 2.5), busy(3, 3.5)], win.from, win.to, win.need, 2).length, 2);

  check('a window too short for anything offers nothing',
    fmt(freeWindows([], day, day + 10 * MIN, 30 * MIN, 3)), []);

  check('a touch at the very end is not a slot',
    fmt(freeWindows([busy(0, 7.75)], win.from, win.to, win.need, 3)), []);
  check('a full 30 minutes at the end is a slot',
    fmt(freeWindows([busy(0, 7.5)], win.from, win.to, win.need, 3)), [[7.5, 8]]);

  console.log('\n— the shared grant —');

  const SCOPES = calendar.SCOPES;
  check('calendar asks for exactly one scope', SCOPES.length, 1);
  truthy('and it is the events scope', /calendar\.events$/.test(SCOPES[0]));
  // The union is what stops a second consent screen from silently breaking the
  // first integration: Google issues a fresh refresh token for the scopes in the
  // request, so anything already granted has to travel with it.
  truthy('SETUP_HINT names the file to edit', /seed-keys\.js/.test(calendar.SETUP_HINT));
  truthy('SETUP_HINT names the redirect to allow', /127\.0\.0\.1/.test(calendar.SETUP_HINT));
  check('the gmail and calendar hints are the same object', google.SETUP_HINT, calendar.SETUP_HINT);
  // Both read the one grant, so they can never disagree about whether an account
  // is connected — which is the bug the shared module exists to prevent.
  check('calendar and google agree on connected',
    calendar.status().connected, google.connected());
  check('status() always names its integration', calendar.status().integration, 'calendar');
  check('no token ever leaves the module',
    Object.keys(calendar.status()).some((k) => /token|secret/i.test(k)), false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
});