// Checks bolo's three no-account integrations — local notes, the ChatGPT export
// import, and maps — against pure logic, with no real side effects.
//
//   ./node_modules/.bin/electron tools/misc-check.js
//
// Under Electron, not plain node: chat-import and local-notes resolve their
// store through `app.getPath('userData')`, and `require('electron')` outside an
// Electron process hands back a path string rather than the API.
//
// Nothing here touches anything of the user's:
//
//   * both stores are pointed at a temp directory, so the real notes file is
//     never opened, let alone rewritten;
//   * maps' settings are a fake in-memory object, so the check cannot write
//     `mapsHome` into the settings the app actually runs on;
//   * maps' opener is a spy, so no browser window opens on anybody's desktop.
//
// What is left is the part worth checking: URL building and the URL allowlist,
// the notes store's full round trip through a real file, and the export parser
// against a fixture shaped like a real export — including the nodes a real one
// is full of and a hand-written export is not.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

const notes = require('../src/main/local-notes');
const chat = require('../src/main/chat-import');
const maps = require('../src/main/maps');

const FIXTURE = path.join(__dirname, 'fixtures', 'chatgpt-export.sample.json');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok    ' + label + (detail ? '   ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
  }
}

function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(label, a === b, a === b ? a : 'got ' + a + ', want ' + b);
}

function section(name) {
  console.log('\n' + name);
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-misc-'));
  const notesPath = path.join(tmp, 'bolo-notes.json');
  const chatPath = path.join(tmp, 'bolo-chat-import.json');
  const fullPath = path.join(tmp, 'notes-full.json');
  const badPath = path.join(tmp, 'notes-broken.json');

  /* -------------------------------------------------------------------------
     Local notes
     ---------------------------------------------------------------------- */

  section('local notes — round trip');
  notes._internals.setStorePath(notesPath);
  notes._internals.setMaxNotes(notes._internals.MAX_NOTES);

  let st = await notes.status();
  ok('status: empty to start', st.ok && st.count === 0, 'count ' + st.count);
  eq('status: reports the store path', st.path, notesPath);

  const a = await notes.add({ text: 'buy milk and eggs from the corner shop before six' });
  ok('add: ok', a.ok);
  eq('add: title is the first six words', a.note.title, 'buy milk and eggs from the…');
  eq('add: speech is "Noted."', a.speech, 'Noted.');
  ok('add: id looks like time-random', /^[0-9a-z]+-[0-9a-z]{8}$/.test(a.note.id), a.note.id);

  const b = await notes.add({ text: 'two pints of milk', title: 'Groceries', tags: 'home, shopping, HOME' });
  ok('add: ok with a title', b.ok);
  eq('add: keeps the given title', b.note.title, 'Groceries');
  eq('add: tags deduped case-insensitively', b.note.tags, ['home', 'shopping']);
  eq('add: speech names the note', b.speech, 'Saved "Groceries".');

  const noisy = await notes.add({ text: '   \n  ' });
  ok('add: refuses whitespace', !noisy.ok && noisy.error === 'empty');

  let list = await notes.list();
  eq('list: both notes, newest first', list.notes.map((n) => n.title), ['Groceries', 'buy milk and eggs from the…']);
  ok('list: a summary carries a preview, not the whole note', list.notes[0].text === undefined);
  ok('list: preview holds the text', list.notes[1].preview.includes('buy milk'));

  list = await notes.list({ tag: 'SHOPPING' });
  eq('list: tag filter is case-insensitive', list.count, 1);
  list = await notes.list({ tag: 'nope' });
  eq('list: unknown tag matches nothing', list.count, 0);
  list = await notes.list({ query: 'pints' });
  eq('list: query filter', list.count, 1);
  list = await notes.list({ limit: 1 });
  eq('list: limit', list.notes.length, 1);

  let found = await notes.search({ query: 'MILK' });
  eq('search: case-insensitive over the text', found.count, 2);
  ok('search: both hits are text hits', found.notes.every((n) => n.textMatch === true));
  // Newest first, so [0] is "Groceries" — which mentions milk only in its body —
  // and [1] is the note whose *title* was derived from the word.
  ok('search: a title hit is reported as one',
    found.notes[0].titleMatch === false && found.notes[1].titleMatch === true);
  ok('search: excerpt quotes the match', found.notes.every((n) => n.excerpt.toLowerCase().includes('milk')));
  found = await notes.search({ query: 'groceries' });
  ok('search: a title hit sets titleMatch', found.count === 1 && found.notes[0].titleMatch === true);
  found = await notes.search({ query: '' });
  ok('search: refuses an empty query', !found.ok && found.error === 'bad-query');

  const read = await notes.read({ id: a.note.id });
  ok('read: returns the whole note', read.ok && read.note.text === 'buy milk and eggs from the corner shop before six');
  const missing = await notes.read({ id: 'nope' });
  ok('read: unknown id', !missing.ok && missing.error === 'not-found');

  section('local notes — bounds');
  const long = await notes.add({ text: 'x'.repeat(25000) });
  ok('add: caps the text at 20000', long.note.text.length === 20000 && long.truncated === true);

  const ids = new Set();
  for (let i = 0; i < 300; i++) {
    const r = await notes.add({ text: 'note number ' + i });
    ids.add(r.note.id);
  }
  eq('add: 300 ids, no collisions', ids.size, 300);

  const gone = await notes.remove({ id: b.note.id });
  ok('remove: ok', gone.ok && gone.count === 302);
  eq('remove: speech names what went', gone.speech, 'Deleted "Groceries".');
  const again = await notes.remove({ id: b.note.id });
  ok('remove: twice is not-found', !again.ok && again.error === 'not-found');

  // The round trip above proves the calls agree with each other. This proves
  // they agree with the disk, which is the part a rename could get wrong.
  const onDisk = JSON.parse(await fs.readFile(notesPath, 'utf8'));
  eq('disk: the file holds every note', onDisk.notes.length, 302);
  ok('disk: the first note survived', onDisk.notes.some((n) => n.id === a.note.id));
  ok('disk: the removed note is gone', !onDisk.notes.some((n) => n.id === b.note.id));
  const strays = (await fs.readdir(tmp)).filter((f) => f.includes('.tmp'));
  eq('disk: no temp files left behind', strays, []);

  section('local notes — full, and unreadable');
  notes._internals.setStorePath(fullPath);
  notes._internals.setMaxNotes(3);
  for (let i = 0; i < 3; i++) await notes.add({ text: 'filler ' + i });
  const over = await notes.add({ text: 'one too many' });
  ok('add: refuses at the bound', !over.ok && over.error === 'store-full', over.error);
  eq('add: says what to do about it', over.speech, 'Your notes store is full. Delete a few before adding more.');
  const after = await notes.status();
  eq('add: the refusal did not grow the store', after.count, 3);

  // A store that cannot be parsed may still hold every note the user has, so it
  // must be reported rather than overwritten.
  notes._internals.setStorePath(badPath);
  notes._internals.setMaxNotes(notes._internals.MAX_NOTES);
  await fs.writeFile(badPath, '{ this is not json', 'utf8');
  const broken = await notes.status();
  ok('status: reports a store that cannot be parsed', !broken.ok && broken.error === 'store-unreadable', broken.error);
  const refused = await notes.add({ text: 'anything' });
  ok('add: refuses to write over it', !refused.ok && refused.error === 'store-unreadable');
  eq('disk: the broken file is untouched', await fs.readFile(badPath, 'utf8'), '{ this is not json');

  /* -------------------------------------------------------------------------
     ChatGPT export import
     ---------------------------------------------------------------------- */

  section('chat import — parser');
  const raw = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
  const parsed = chat._internals.parseExport(raw);

  ok('parse: ok', parsed.ok);
  eq('parse: three conversations out of six entries', parsed.conversations.length, 3);
  eq('parse: three entries were unreadable', parsed.skipped, 3);
  eq('parse: newest first, untitled defaulted',
    parsed.conversations.map((c) => c.title),
    ['Untitled', 'Deploying to a cluster', 'Kubernetes ingress debugging']);

  const untitled = parsed.conversations[0];
  eq('parse: a missing create_time falls back to the first message',
    untitled.createdAt, '2025-01-03T00:00:00.000Z');
  eq('parse: message count for the untitled one', untitled.messages.length, 2);

  const k8s = parsed.conversations[2];
  eq('parse: five usable messages, malformed nodes skipped', k8s.messages.length, 5);
  eq('parse: ordered by time, not by mapping order',
    k8s.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  ok('parse: no system or tool message survives',
    k8s.messages.every((m) => m.role === 'user' || m.role === 'assistant'));
  eq('parse: a non-string part is dropped, not stringified',
    k8s.messages[2].text,
    'Here is the ingress manifest I have:\nand the 502 is only on the kubernetes path.');
  ok('parse: the empty and partless messages are gone',
    k8s.messages.every((m) => m.text.trim().length > 0));

  const wrapped = chat._internals.parseExport({ conversations: [raw[1]] });
  eq('parse: the { conversations: [...] } shape works too', wrapped.conversations.length, 1);

  const badShape = chat._internals.parseExport({ not: 'an export' });
  ok('parse: refuses an unknown shape', !badShape.ok && badShape.error === 'bad-shape');

  section('chat import — caps');
  const big = {
    title: 'wide',
    create_time: 1735689600,
    mapping: {}
  };
  for (let i = 0; i < 260; i++) {
    big.mapping['m' + i] = {
      message: {
        author: { role: 'user' },
        create_time: 1735689600 + i,
        content: { parts: [i === 0 ? 'y'.repeat(5000) : 'message ' + i] }
      }
    };
  }
  const bigParsed = chat._internals.parseExport([big]);
  eq('cap: 200 messages per conversation', bigParsed.conversations[0].messages.length, 200);
  ok('cap: the tail is kept, not the head',
    bigParsed.conversations[0].messages[0].text === 'message 60',
    bigParsed.conversations[0].messages[0].text);
  const solo = {
    only: {
      message: {
        author: { role: 'user' },
        create_time: 1735689600,
        content: { parts: ['y'.repeat(5000)] }
      }
    }
  };
  eq('cap: one message at 4000 chars', chat._internals.messagesOf(solo)[0].text.length, 4000);

  const many = [];
  for (let i = 0; i < 210; i++) {
    many.push({ title: 'conv ' + i, create_time: 1735689600 + i, mapping: big.mapping });
  }
  const manyParsed = chat._internals.parseExport(many);
  eq('cap: 200 conversations', manyParsed.conversations.length, 200);
  eq('cap: the newest 200 are the ones kept', manyParsed.conversations[0].title, 'conv 209');

  section('chat import — profile');
  const profile = chat._internals.buildProfile(parsed.conversations);
  const kube = profile.topics.find((t) => t.word === 'kubernetes');
  eq('profile: the repeated topic wins', kube && kube.count, 4);
  ok('profile: stopwords are not topics', !profile.topics.some((t) => t.word === 'the' || t.word === 'and'));
  ok('profile: topics are ranked', profile.topics.every((t, i) => i === 0 || profile.topics[i - 1].count >= t.count));
  eq('profile: the standing instructions the user wrote',
    profile.instructions.map((i) => i.text).sort(),
    [
      'Always answer with the YAML first, then explain what changed.',
      'From now on, run every kubernetes command through kubectl with a dry run first.',
      'My name is Pratham and I prefer kubectl examples.'
    ].sort());
  ok('profile: an assistant line that reads like an instruction is not one',
    !profile.instructions.some((i) => i.text.startsWith('Always happy')));
  ok('profile: every instruction carries its conversation',
    profile.instructions.every((i) => typeof i.conversation === 'string' && i.conversation));
  ok('profile: says the text is not for bolo to act on',
    typeof profile.note === 'string' && /not instructions/i.test(profile.note));

  section('chat import — the file');
  chat._internals.setStorePath(chatPath);
  let cst = await chat.status();
  ok('status: nothing imported yet', cst.ok && cst.imported === false && cst.conversations === 0);
  eq('status: reports the store path', cst.path, chatPath);

  const none = await chat.profile();
  ok('profile: empty before an import', none.imported === false && none.profile.topics.length === 0);
  eq('profile: speech', none.speech, 'Nothing imported yet.');

  const noPath = await chat.import({});
  ok('import: refuses without a path', !noPath.ok && noPath.error === 'no-path');
  const noFile = await chat.import({ path: path.join(tmp, 'nope.json') });
  ok('import: refuses a path that is not there', !noFile.ok && noFile.error === 'not-found');

  const imported = await chat.import({ path: FIXTURE });
  ok('import: ok', imported.ok, imported.reason || '');
  ok('import: imported is a flag, conversations is the count', imported.imported === true);
  eq('import: counts conversations', imported.conversations, 3);
  eq('import: counts messages', imported.messages, 10);
  eq('import: speech', imported.speech, 'Imported 3 conversations.');

  cst = await chat.status();
  ok('status: imported', cst.imported === true && cst.conversations === 3);
  ok('status: lastImportAt is a timestamp', typeof cst.lastImportAt === 'string' && !Number.isNaN(Date.parse(cst.lastImportAt)));

  const prof = await chat.profile();
  ok('profile: imported', prof.imported === true);
  ok('profile: titles came across', prof.profile.titles.includes('Deploying to a cluster'));
  eq('profile: source is the file it read', prof.source, FIXTURE);

  const stored = JSON.parse(await fs.readFile(chatPath, 'utf8'));
  ok('disk: conversations, profile, importedAt and source are all stored',
    Array.isArray(stored.conversations) && !!stored.profile && !!stored.importedAt && !!stored.source);
  eq('disk: three conversations on disk', stored.conversations.length, 3);

  const forgot = await chat.forget();
  ok('forget: ok', forgot.ok && forgot.cleared === true);
  cst = await chat.status();
  ok('forget: nothing imported again', cst.imported === false && cst.conversations === 0);
  const exists = await fs.stat(chatPath).then(() => true, () => false);
  ok('forget: the file is gone', !exists);

  /* -------------------------------------------------------------------------
     Maps
     ---------------------------------------------------------------------- */

  section('maps — URL building');
  // A fake settings store: the real one is the user's own preferences and this
  // check has no business writing to it.
  const fake = new Map();
  maps._internals.setStore({
    get: (k) => fake.get(k),
    set: (k, v) => fake.set(k, v)
  });

  eq('search url', maps._internals.buildSearchUrl('SFO international terminal'),
    'https://www.google.com/maps/search/?api=1&query=SFO%20international%20terminal');
  eq('search url encodes punctuation', maps._internals.buildSearchUrl('a&b=c?d/e'),
    'https://www.google.com/maps/search/?api=1&query=a%26b%3Dc%3Fd%2Fe');
  eq('search url refuses empty', maps._internals.buildSearchUrl('   '), null);
  eq('search url caps the query at 300',
    maps._internals.buildSearchUrl('x'.repeat(400)).length,
    'https://www.google.com/maps/search/?api=1&query='.length + 300);

  eq('mode: a word a person says', maps._internals.normalizeMode('walk'), 'walking');
  eq('mode: an allowed value', maps._internals.normalizeMode('BICYCLING'), 'bicycling');
  eq('mode: another word', maps._internals.normalizeMode('Train'), 'transit');
  eq('mode: junk becomes driving, never passed through', maps._internals.normalizeMode('teleport'), 'driving');
  eq('mode: absent becomes driving', maps._internals.normalizeMode(''), 'driving');

  eq('directions url', maps._internals.buildDirectionsUrl({ to: 'SFO', mode: 'walking' }),
    'https://www.google.com/maps/dir/?api=1&destination=SFO&travelmode=walking');
  eq('directions url with an origin',
    maps._internals.buildDirectionsUrl({ from: '221B Baker Street', to: 'SFO' }),
    'https://www.google.com/maps/dir/?api=1&origin=221B%20Baker%20Street&destination=SFO&travelmode=driving');
  eq('directions url refuses no destination', maps._internals.buildDirectionsUrl({ from: 'home' }), null);

  section('maps — home and work');
  maps._internals.setOpener(() => { throw new Error('the check must not open a browser'); });

  let mst = maps.status();
  eq('status: the mode', mst.mode, 'url-opener');
  ok('status: no places saved yet', mst.home === null && mst.work === null);

  const setHome = maps.setPlace({ key: 'home', value: '221B Baker Street, London' });
  ok('setPlace: ok', setHome.ok);
  eq('setPlace: speech', setHome.speech, 'Saved home.');
  eq('setPlace: status reads it back', maps.status().home, '221B Baker Street, London');
  eq('setPlace: the settings key', fake.get('mapsHome'), '221B Baker Street, London');

  maps.setPlace({ key: 'work', value: '1 Infinite Loop, Cupertino' });
  eq('setPlace: work is a separate key', fake.get('mapsWork'), '1 Infinite Loop, Cupertino');
  const badKey = maps.setPlace({ key: 'gym', value: 'somewhere' });
  ok('setPlace: only home and work', !badKey.ok && badKey.error === 'bad-place');

  eq('resolve: a saved place', maps._internals.resolvePlace('Work').place, '1 Infinite Loop, Cupertino');
  eq('resolve: anything else passes through', maps._internals.resolvePlace('SFO').place, 'SFO');
  eq('resolve: an empty place is refused', maps._internals.resolvePlace(' ').ok, false);

  section('maps — actions open the right link');
  const opened = [];
  maps._internals.setOpener((u) => { opened.push(u); });

  const dir = await maps.directions({ to: 'work' });
  ok('directions: ok', dir.ok, dir.reason || '');
  eq('directions: home is the default origin',
    dir.url, 'https://www.google.com/maps/dir/?api=1&origin=221B%20Baker%20Street%2C%20London&destination=1%20Infinite%20Loop%2C%20Cupertino&travelmode=driving');
  eq('directions: speech', dir.speech, 'Opening directions to 1 Infinite Loop, Cupertino from 221B Baker Street, London.');
  eq('directions: exactly one browser call', opened.length, 1);
  eq('directions: opened the url it returned', opened[0], dir.url);

  const transit = await maps.directions({ from: 'home', to: 'SFO', mode: 'transit' });
  ok('directions: travel mode honoured', transit.url.endsWith('travelmode=transit'));

  const nowhere = await maps.directions({});
  ok('directions: no destination is refused', !nowhere.ok && nowhere.error === 'empty');
  eq('directions: and asked, not failed', nowhere.speech, 'Where to?');

  maps.setPlace({ key: 'work', value: '' });
  eq('setPlace: an empty value clears it', maps.status().work, null);
  const noWork = await maps.directions({ to: 'work' });
  ok('directions: an unsaved place is refused', !noWork.ok && noWork.error === 'no-place');
  eq('directions: and says so', noWork.speech, 'There is no work saved yet. Set it in Integrations first.');
  eq('directions: nothing was opened for it', opened.length, 2);

  const calls = opened.length;
  const linkOnly = maps.place({ query: 'coffee near me' });
  ok('place: ok', linkOnly.ok);
  eq('place: builds the search url', linkOnly.url, 'https://www.google.com/maps/search/?api=1&query=coffee%20near%20me');
  eq('place: and opens nothing', opened.length, calls);
  ok('place: refuses an empty query', !maps.place({ query: '' }).ok);

  const search = await maps.search({ query: 'SFO' });
  ok('search: ok', search.ok);
  eq('search: speech', search.speech, 'Opening the map for SFO.');
  eq('search: opened it', opened[opened.length - 1], search.url);
  ok('search: refuses an empty query', !(await maps.search({ query: '  ' })).ok);

  section('maps — the url allowlist');
  const ALLOWED = [
    'https://www.google.com/maps/search/?api=1&query=SFO',
    'https://google.com/maps/place/SFO',
    'https://maps.google.com/?q=SFO',
    'https://maps.apple.com/?q=SFO'
  ];
  const BLOCKED = [
    'http://evil.example/maps',                       // not https
    'http://www.google.com/maps',                     // not https
    'javascript:alert(1)',                            // not a url at all
    'https://evil.example/maps',
    'https://www.google.com.evil.example/maps',       // a host that merely contains google.com
    'https://www.google.com/search?q=google.com/maps', // right host, wrong path
    'https://user:pass@www.google.com/maps',          // credentials in a link we would open
    'not a url'
  ];
  for (const u of ALLOWED) ok('allow: ' + u, !!maps._internals.allowedMapUrl(u));
  for (const u of BLOCKED) ok('block: ' + u, maps._internals.allowedMapUrl(u) === null, '');

  const before = opened.length;
  for (const u of BLOCKED) {
    const r = await maps.openUrl({ url: u });
    if (r.ok) ok('openUrl: refused ' + u, false, 'it opened it');
  }
  eq('openUrl: not one blocked url reached the browser', opened.length, before);
  const blockedRefusal = await maps.openUrl({ url: 'http://evil.example/maps' });
  ok('openUrl: reports why', !blockedRefusal.ok && blockedRefusal.error === 'blocked-url');
  eq('openUrl: speech', blockedRefusal.speech, 'I will not open that link.');

  const good = await maps.openUrl({ url: 'https://www.google.com/maps/place/SFO' });
  ok('openUrl: opens an allowed one', good.ok);
  eq('openUrl: exactly one call', opened.length, before + 1);

  maps._internals.setOpener(() => { throw new Error('no browser here'); });
  const dead = await maps.openUrl({ url: 'https://maps.apple.com/?q=SFO' });
  ok('openUrl: a browser that will not open is reported, not thrown', !dead.ok && dead.error === 'open-failed');

  /* -------------------------------------------------------------------------
     Done
     ---------------------------------------------------------------------- */

  await fs.rm(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  return fail ? 1 : 0;
}

app.whenReady().then(() => {
  main().then((code) => app.exit(code)).catch((e) => {
    console.error('misc-check crashed:', (e && e.stack) || e);
    app.exit(2);
  });
});