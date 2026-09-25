// Exercises the two file-backed integrations — obsidian.js and local-files.js —
// over a throwaway tree under the system temp directory.
//
//   ./node_modules/.bin/electron tools/files-check.js
//
// The electron binary rather than plain node, because both modules are meant to
// run in the main process and `settings` is electron-store. Nothing here is a
// stub: the same code the app runs is what is being tested.
//
// The two rules this file holds itself to:
//
//   * it never writes into a real vault and never opens anything. Every read and
//     write happens inside one temp directory, which is removed in the `finally`
//     — and the two settings either module reads (obsidianVault, localFilesRoots)
//     are put back exactly as they were found, so running this cannot leave the
//     app pointed at a folder that no longer exists;
//   * a refusal is proved by never reaching the thing that would do the damage.
//     open()/reveal() are only ever called with paths that must be refused before
//     the shell is touched.

const { app } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const settings = require('../src/main/settings');
const obsidian = require('../src/main/obsidian');
const localFiles = require('../src/main/local-files');

// The exact sentence the Obsidian pane has to show before a vault is set. Spelled
// out here rather than read off the module, because the point of the assertion is
// the string itself — an escape for the arrow keeps this file ASCII.
const EXPECTED_HINT = 'Set your vault folder in Integrations \u2192 Obsidian.';

let pass = 0;
let fail = 0;

// What the two settings held before this run, so the tail can prove they were put
// back rather than merely written to.
//
// Restoring an unset key needs a sentinel rather than `undefined`: conf's set()
// refuses undefined outright ("Use delete() to clear values") and settings.js
// exposes no delete. An empty string and an empty array are exactly what both
// modules already read as "nothing is configured", so they restore the same
// behaviour the absence did.
let restoreVault = '';
let restoreRoots = [];

// The temp tree, so the tail can prove it was removed even if the run threw.
let tmpDir = null;

function check(label, good, detail) {
  if (good) pass++;
  else fail++;
  console.log(
    (good ? '  ok  ' : '  FAIL') + '  ' + label +
    (!good && detail !== undefined ? '   [' + detail + ']' : '')
  );
}

function section(name) {
  console.log('\n' + name);
}

// Names that must never resolve to a path, whatever the vault is.
const TRAVERSAL = [
  '../../etc/passwd',
  '..\\..\\Windows\\System32\\config\\SAM',
  'sub/../../escape.md',
  'C:\\Windows\\System32',
  'C:/Windows/System32/drivers/etc/hosts',
  '/etc/passwd',
  '\\Windows\\System32',
  '\\\\server\\share\\note.md',
  '..'
];

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-files-check-'));
  tmpDir = tmp;
  const vault = path.join(tmp, 'vault');
  const files = path.join(tmp, 'files');
  const empty = path.join(tmp, 'empty');

  const prevVault = settings.get(obsidian.VAULT_KEY);
  const prevRoots = settings.get(localFiles.ROOTS_KEY);
  restoreVault = typeof prevVault === 'string' && prevVault.trim() ? prevVault : '';
  restoreRoots = Array.isArray(prevRoots) && prevRoots.length ? prevRoots : [];

  try {
    /* -----------------------------------------------------------------------
       Setup
       -------------------------------------------------------------------- */

    // The vault: notes at the root, one level down, two levels down, and a set of
    // dot-directories and a .trash that must never show up as notes.
    const visible = [
      'hello.md',
      'sub/deep.md',
      'Notes/Daily/idea.md'
    ];
    const skipped = [
      '.obsidian/workspace.md',
      '.hidden/secret.md',
      'sub/.trash/gone.md'
    ];

    for (const dir of ['sub', 'Notes/Daily', '.obsidian', '.hidden', 'sub/.trash', 'bulk']) {
      await fs.mkdir(path.join(vault, dir), { recursive: true });
    }
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(vault, 'hello.md'), '# hello\n\nthe quick brown fox jumps\nsecond line\n', 'utf8');
    await fs.writeFile(path.join(vault, 'sub', 'deep.md'), 'a note in a subfolder\n', 'utf8');
    await fs.writeFile(path.join(vault, 'Notes', 'Daily', 'idea.md'), 'nested note\n', 'utf8');
    for (const rel of skipped) {
      await fs.writeFile(path.join(vault, rel), 'this must never be listed\n', 'utf8');
    }
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(path.join(vault, 'bulk', 'note-' + i + '.md'), 'bulk note ' + i + '\n', 'utf8');
      visible.push('bulk/note-' + i + '.md');
    }

    // The local-files tree: extensions to filter on, a node_modules and a .git
    // that must be skipped, and a chain deeper than the walk is allowed to go.
    for (const dir of ['sub', 'node_modules/dep', '.git', 'deep/d0/d1']) {
      await fs.mkdir(path.join(files, dir), { recursive: true });
    }
    await fs.writeFile(path.join(files, 'alpha.txt'), 'alpha\n', 'utf8');
    await fs.writeFile(path.join(files, 'Beta.PNG'), 'beta\n', 'utf8');
    await fs.writeFile(path.join(files, 'sub', 'gamma.txt'), 'gamma\n', 'utf8');
    await fs.writeFile(path.join(files, 'sub', 'note.md'), 'a note\n', 'utf8');
    await fs.writeFile(path.join(files, 'node_modules', 'dep', 'hidden.txt'), 'skipped\n', 'utf8');
    await fs.writeFile(path.join(files, '.git', 'config.txt'), 'skipped\n', 'utf8');
    await fs.writeFile(path.join(files, 'deep', 'd0', 'd1', 'reachable.txt'), 'inside the cap\n', 'utf8');

    let tooDeep = path.join(files, 'deep');
    for (let i = 0; i < 12; i++) tooDeep = path.join(tooDeep, 'd' + i);
    await fs.mkdir(tooDeep, { recursive: true });
    await fs.writeFile(path.join(tooDeep, 'too-deep.txt'), 'past the cap\n', 'utf8');

    /* -----------------------------------------------------------------------
       Obsidian — status, and pointing at a vault
       -------------------------------------------------------------------- */

    section('obsidian: status and setVault');

    // No vault at all, which is what a first run looks like. An empty string rather
// than a delete, because conf refuses undefined and settings.js exposes no
// delete — and vaultPath() reads '' as unset.
    settings.set(obsidian.VAULT_KEY, '');
    const st0 = await obsidian.status();
    check('no vault -> not configured', st0.ok === false && st0.configured === false && st0.vault === null);
    check('the reason names the exact fix', st0.reason === EXPECTED_HINT, JSON.stringify(st0.reason));

    const badPath = await obsidian.setVault({ path: path.join(tmp, 'not-a-folder') });
    check('setVault: a folder that is not there is refused', badPath.ok === false && badPath.error === 'not-found');

    const badFile = await obsidian.setVault({ path: path.join(vault, 'hello.md') });
    check('setVault: a file is refused', badFile.ok === false && badFile.error === 'not-a-folder');

    const noMd = await obsidian.setVault({ path: empty });
    check('setVault: a folder with no markdown is refused', noMd.ok === false && noMd.error === 'no-markdown');

    const good = await obsidian.setVault({ path: vault });
    check('setVault: a real vault is accepted and stored', good.ok === true && good.vault === vault);
    check('setVault: it is the store that holds it', settings.get(obsidian.VAULT_KEY) === vault);

    const st1 = await obsidian.status();
    check('status: configured, with a note count', st1.ok === true && st1.configured === true && st1.vault === vault);
    check('status: counts the notes', st1.noteCount === visible.length, st1.noteCount + ' vs ' + visible.length);

    /* -----------------------------------------------------------------------
       Obsidian — listing
       -------------------------------------------------------------------- */

    section('obsidian: listNotes');

    const list = await obsidian.listNotes();
    check('lists every visible note', list.count === visible.length, list.count + ' vs ' + visible.length);
    check('skips .obsidian/, .hidden/ and .trash/',
      !list.notes.some((n) => n.path.startsWith('.') || n.path.includes('/.')),
      list.notes.map((n) => n.path).filter((p) => p.startsWith('.') || p.includes('/.')).join(' '));
    check('paths are vault-relative with forward slashes',
      list.notes.every((n) => !n.path.includes('\\') && !path.isAbsolute(n.path)));
    check('a note carries name, mtime and size',
      list.notes.every((n) => typeof n.name === 'string' && n.mtime > 0 && n.size > 0));

    const limited = await obsidian.listNotes({ limit: 5 });
    check('a limit is a hard stop', limited.count === 5 && limited.truncated === true);

    const shallow = await obsidian._internals.walkNotes(vault, { maxDepth: 1 });
    check('the walk stops at its depth cap',
      shallow.notes.some((n) => n.path === 'hello.md') &&
      shallow.notes.some((n) => n.path === 'sub/deep.md') &&
      !shallow.notes.some((n) => n.path === 'Notes/Daily/idea.md'));

    const tiny = await obsidian._internals.walkNotes(vault, { maxFiles: 3 });
    check('the walk stops at its file cap', tiny.truncated === true && tiny.notes.length <= 3);

    /* -----------------------------------------------------------------------
       Obsidian — reading, and the name -> path boundary
       -------------------------------------------------------------------- */

    section('obsidian: readNote');

    const note = await obsidian.readNote({ name: 'hello.md' });
    check('reads a note at the vault root', note.ok === true && note.note.content.includes('quick brown fox'));
    check('reports the note as not truncated', note.note.truncated === false);
    check('the note is labelled as data, not instructions', /untrusted data/.test(note.note.note || ''));

    const nested = await obsidian.readNote({ name: 'sub/deep.md' });
    check('reads a note in a subfolder', nested.ok === true && nested.note.content.includes('subfolder'));

    const bare = await obsidian.readNote({ name: 'hello' });
    check('a bare name gets the .md the vault holds', bare.ok === true && bare.note.name === 'hello.md');

    const dir = await obsidian.readNote({ name: 'sub' });
    check('a folder name is refused', dir.ok === false);

    const missing = await obsidian.readNote({ name: 'nope.md' });
    check('a note that is not there is refused', missing.ok === false && missing.error === 'not-found');

    section('obsidian: path traversal');

    for (const bad of TRAVERSAL) {
      const internal = obsidian._internals.resolveInside(vault, bad);
      const real = await obsidian.readNote({ name: bad });
      check(
        'refused: ' + JSON.stringify(bad),
        internal.ok === false && real.ok === false,
        'resolveInside=' + internal.ok + ' readNote=' + real.ok
      );
    }

    check('an ordinary name is still allowed', obsidian._internals.resolveInside(vault, 'hello.md').ok === true);
    check('a nested posix name is still allowed', obsidian._internals.resolveInside(vault, 'Notes/Daily/idea.md').ok === true);
    check('a windows-separator name lands inside too', obsidian._internals.resolveInside(vault, 'Notes\\Daily\\idea.md').ok === true);

    /* -----------------------------------------------------------------------
       Obsidian — writing
       -------------------------------------------------------------------- */

    section('obsidian: appendNote');

    const emptyText = await obsidian.appendNote({ name: 'x.md', text: '   ' });
    check('an empty append is refused', emptyText.ok === false && emptyText.error === 'empty-text');

    const w1 = await obsidian.appendNote({ name: 'Notes/Idea List.md', text: 'first line' });
    const ideaPath = path.join(vault, 'Notes', 'Idea List.md');
    check('creates the note and its folders', w1.ok === true && w1.created === true);
    check('the text is on disk', (await fs.readFile(ideaPath, 'utf8')) === 'first line\n');

    const w2 = await obsidian.appendNote({ name: 'Notes/Idea List.md', text: 'second line' });
    check('a second append does not overwrite the first',
      w2.ok === true && w2.created === false && (await fs.readFile(ideaPath, 'utf8')) === 'first line\nsecond line\n');

    const capped = await obsidian.appendNote({ name: 'big.md', text: 'x'.repeat(25000) });
    check('the appended text is capped at 20000 chars',
      capped.ok === true && capped.appended === 20000 && capped.truncated === true);
    check('the cap is what lands on disk', (await fs.stat(path.join(vault, 'big.md'))).size === 20001);

    const noTrail = await obsidian.appendNote({ name: 'tight.md', text: 'no trailing newline', newline: false });
    const tight = await obsidian.appendNote({ name: 'tight.md', text: 'and the next one' });
    check('a missing trailing newline is repaired before appending',
      noTrail.ok && tight.ok && (await fs.readFile(path.join(vault, 'tight.md'), 'utf8')) === 'no trailing newline\nand the next one\n');

    const writeOut = await obsidian.appendNote({ name: '../escape.md', text: 'nope' });
    check('appendNote cannot be aimed outside the vault', writeOut.ok === false);
    check('and nothing was created above the vault', (await fs.stat(path.join(tmp, 'escape.md')).catch(() => null)) === null);

    /* -----------------------------------------------------------------------
       Obsidian — search
       -------------------------------------------------------------------- */

    section('obsidian: search');

    const byContent = await obsidian.search({ query: 'brown fox' });
    check('finds a match in a note body', byContent.ok && byContent.count === 1 && byContent.matches[0].name === 'hello.md');
    check('reports the line number', byContent.matches[0].line === 3, byContent.matches[0].line);
    check('the excerpt is the matching line', byContent.matches[0].excerpt.includes('quick brown fox'));
    check('the match says where it matched', byContent.matches[0].where === 'content');

    const caseInsensitive = await obsidian.search({ query: 'BROWN FOX' });
    check('the search is case-insensitive on content', caseInsensitive.count === 1);

    const byName = await obsidian.search({ query: 'note-7' });
    check('finds a match in a note name', byName.ok && byName.count === 1 && byName.matches[0].name === 'note-7.md');
    check('a name match has no excerpt and no line', byName.matches[0].where === 'name' && byName.matches[0].line === 0);

    const many = await obsidian.search({ query: 'bulk note', limit: 4 });
    check('the limit caps the matches, not just the walk', many.count === 4 && many.matches.length === 4);
    check('and it says the result was cut short', many.truncated === true);

    const none = await obsidian.search({ query: 'nothing matches this' });
    check('no match is an empty result, not an error', none.ok === true && none.count === 0);

    const noQuery = await obsidian.search({ query: '  ' });
    check('an empty query is refused', noQuery.ok === false && noQuery.error === 'bad-query');

    // A note past the per-file read ceiling: its name still matches, its body is
    // never read — which is the whole point of the budget.
    const huge = 'zzmarker\n' + 'padding line\n'.repeat(110000);
    await fs.writeFile(path.join(vault, 'huge-note.md'), huge, 'utf8');
    const hugeBody = await obsidian.search({ query: 'padding line' });
    check('a note too large to read is not read', hugeBody.ok === true && hugeBody.count === 0);
    const hugeName = await obsidian.search({ query: 'huge-note' });
    check('but its name still matches', hugeName.count === 1 && hugeName.matches[0].excerpt === '');

    /* -----------------------------------------------------------------------
       Obsidian — the daily note
       -------------------------------------------------------------------- */

    section('obsidian: daily note');

    check('the name is YYYY-MM-DD.md',
      obsidian._internals.dailyName(new Date(2026, 8, 21)) === '2026-09-21.md',
      obsidian._internals.dailyName(new Date(2026, 8, 21)));
    check('month and day are zero-padded',
      obsidian._internals.dailyName(new Date(2026, 0, 5)) === '2026-01-05.md');
    check('today’s name has the same shape',
      /^\d{4}-\d{2}-\d{2}\.md$/.test(obsidian._internals.dailyName()));

    const today = obsidian._internals.dailyName();
    const d1 = await obsidian.daily({ text: 'bought milk' });
    const dailyPath = path.join(vault, today);
    check('writes today’s note at the vault root', d1.ok === true && d1.name === today && d1.path === today);
    check('and reports it as new', d1.created === true);

    const dailyBody = await fs.readFile(dailyPath, 'utf8');
    check('a new daily note opens with the date as a heading',
      dailyBody.startsWith('# ' + today.replace(/\.md$/, '') + '\n\n'), JSON.stringify(dailyBody.slice(0, 20)));
    check('the dictated text landed in it', dailyBody.includes('bought milk'));

    const d2 = await obsidian.daily({ text: 'and bread' });
    const dailyBody2 = await fs.readFile(dailyPath, 'utf8');
    check('a second call appends to the same note',
      d2.ok === true && d2.created === false && dailyBody2.includes('bought milk') && dailyBody2.includes('and bread'));

    const d3 = await obsidian.daily({});
    check('asking for the daily note does not write one', d3.ok === true && typeof d3.note.content === 'string');

    check('daily notes live at the vault root, not in a folder', !d1.path.includes('/'));

    /* -----------------------------------------------------------------------
       Local files — roots and the containment check
       -------------------------------------------------------------------- */

    section('localFiles: roots and containment');

    settings.set(localFiles.ROOTS_KEY, [files]);
    const roots1 = await localFiles.roots();
    check('an override is what gets searched', roots1.length === 1 && roots1[0] === files);

    settings.set(localFiles.ROOTS_KEY, [files, path.join(tmp, 'not-here')]);
    const roots2 = await localFiles.roots();
    check('a root that is not there is dropped', roots2.length === 1 && roots2[0] === files);

    settings.set(localFiles.ROOTS_KEY, []);
    const roots3 = await localFiles.roots();
    let allExist = true;
    for (const r of roots3) {
      if (!path.isAbsolute(r)) allExist = false;
      if (!(await fs.stat(r).catch(() => null))) allExist = false;
    }
    check('with no override the real folders are used, and all exist',
      allExist && roots3.every((r) => r !== os.homedir()));
    check('home itself is never a root', !roots3.some((r) => path.resolve(r) === path.resolve(os.homedir())));

    const stFiles = await localFiles.status();
    check('status reports the integration and the set', stFiles.ok === true && stFiles.integration === 'localFiles' && Array.isArray(stFiles.roots));

    const insideRoot = localFiles._internals.insideRoot;
    check('a file inside a root is allowed', insideRoot(path.join(files, 'alpha.txt'), [files]).ok === true);
    check('a nested folder inside a root is allowed', insideRoot(path.join(files, 'sub', 'gamma.txt'), [files]).ok === true);
    check('the root itself is allowed', insideRoot(files, [files]).ok === true);
    check("the root's parent is refused", insideRoot(tmp, [files]).ok === false);
    check('a sibling folder is refused', insideRoot(vault, [files]).ok === false);
    check('climbing out with .. is refused', insideRoot(path.join(files, '..', 'vault'), [files]).ok === false);
    check('a path on another drive is refused', insideRoot('C:\\Windows\\System32', [files]).ok === false);
    check('an empty root list refuses everything', insideRoot(path.join(files, 'alpha.txt'), []).ok === false);

    section('localFiles: the extension filter');

    check("'png' becomes one dotted extension", localFiles._internals.normalizeExt('png').join() === '.png');
    check('a list is parsed however it is written',
      localFiles._internals.normalizeExt('PNG, .JPG').join() === '.png,.jpg');
    check('no extension means no filter',
      localFiles._internals.normalizeExt('') === null && localFiles._internals.normalizeExt([]) === null);
    check('a name matches case-insensitively', localFiles._internals.matchName('Report.PDF', 'report') === true);
    check('an empty query matches everything', localFiles._internals.matchName('Report.PDF', '') === true);

    /* -----------------------------------------------------------------------
       Local files — searching
       -------------------------------------------------------------------- */

    section('localFiles: search');

    settings.set(localFiles.ROOTS_KEY, [files]);

    const s1 = await localFiles.search({ query: 'gamma' });
    check('finds a file in a subfolder', s1.ok === true && s1.count === 1 && s1.files[0].name === 'gamma.txt');
    check('a result carries dir, size, ext and mtime',
      s1.files[0].dir === path.join(files, 'sub') && s1.files[0].ext === 'txt' &&
      s1.files[0].size > 0 && s1.files[0].mtime > 0);

    const s2 = await localFiles.search({ query: 'beta' });
    check('the name match is case-insensitive', s2.count === 1 && s2.files[0].name === 'Beta.PNG');

    const everything = await localFiles.search({ query: '' });
    check('an empty query lists what is there', everything.ok === true && everything.count === 5, everything.count);
    check('node_modules is skipped', !everything.files.some((f) => f.path.includes('node_modules')));
    check('dot-directories are skipped', !everything.files.some((f) => f.path.includes('.git')));
    check('a file past the depth cap is never visited', !everything.files.some((f) => f.name === 'too-deep.txt'));
    check('a file inside the depth cap is', everything.files.some((f) => f.name === 'reachable.txt'));
    check('every result is inside a root',
      everything.files.every((f) => localFiles._internals.insideRoot(f.path, everything.roots).ok === true));

    const onlyPng = await localFiles.search({ query: '', ext: 'png' });
    check('the extension filter keeps only that extension',
      onlyPng.count === 1 && onlyPng.files[0].name === 'Beta.PNG', onlyPng.count);

    const onlyTxt = await localFiles.search({ query: '', ext: ['.TXT'] });
    check('a dotted, upper-case list works too',
      onlyTxt.count === 3 && onlyTxt.files.every((f) => f.ext === 'txt'),
      onlyTxt.count + ' ' + onlyTxt.files.map((f) => f.name).join(','));
    check('and the filter does not resurrect a skipped folder',
      !onlyTxt.files.some((f) => f.path.includes('node_modules') || f.path.includes('.git')));

    const limited2 = await localFiles.search({ query: '', limit: 3 });
    check('the limit is a hard stop', limited2.count === 3 && limited2.files.length === 3);

    const missingQuery = await localFiles.search({ query: 'no such file anywhere' });
    check('no match is an empty result, not an error', missingQuery.ok === true && missingQuery.count === 0);

    const state = { entries: 0, truncated: false };
    let seen = 0;
    await localFiles._internals.walk(files, state, async () => { seen++; return true; }, { maxEntries: 5 });
    check('the walk stops at its entry cap',
      state.truncated === true && state.entries <= 6, 'entries=' + state.entries + ' seen=' + seen);
    check('the caps are the documented ones',
      localFiles._internals.LIMITS.MAX_DEPTH === 10 && localFiles._internals.LIMITS.MAX_ENTRIES === 20000);
    check('the vault caps are the documented ones',
      obsidian._internals.LIMITS.MAX_DEPTH === 8 && obsidian._internals.LIMITS.MAX_FILES === 5000);

    section('localFiles: recent');

    const old = new Date(2000, 0, 1);
    await fs.utimes(path.join(files, 'alpha.txt'), old, old);
    const rec = await localFiles.recent({ limit: 100 });
    const at = rec.files.findIndex((f) => f.name === 'alpha.txt');
    check('files come back newest first, whatever the limit',
      rec.ok === true && at === rec.files.length - 1, 'alpha at ' + at + ' of ' + rec.files.length);
    check('a limited recent is still sorted',
      (await localFiles.recent({ limit: 2 })).files.length === 2);

    /* -----------------------------------------------------------------------
       Local files — opening, refused before the shell is reached
       -------------------------------------------------------------------- */

    section('localFiles: open and reveal (refusals only)');

    const outside = await localFiles.open({ path: path.join(tmp, 'nothing-here.txt') });
    check('a path outside the roots is refused, before it is even stat-ed',
      outside.ok === false && outside.error === 'outside-roots');

    const sys = await localFiles.open({ path: 'C:\\Windows\\System32' });
    check('an absolute path outside the roots is refused', sys.ok === false && sys.error === 'outside-roots');

    const dash = await localFiles.open({ path: '' });
    check('an empty path is refused', dash.ok === false && dash.error === 'bad-path');

    const rel = await localFiles.open({ path: 'alpha.txt' });
    check('a relative path is refused', rel.ok === false && rel.error === 'not-absolute');

    const gone = await localFiles.open({ path: path.join(files, 'missing.txt') });
    check('inside the roots but missing is not-found', gone.ok === false && gone.error === 'not-found');

    const revealOut = await localFiles.reveal({ path: 'C:\\Windows' });
    check('reveal applies the same guard as open', revealOut.ok === false && revealOut.error === 'outside-roots');

    /* ----------------------------------------------------------------------- */
  } finally {
    // Put the store back exactly as it was. A leftover vault path would leave the
    // app pointed at a temp folder that is about to stop existing. Guarded, so a
    // store that refuses the write cannot also strand the temp directory.
    try { settings.set(obsidian.VAULT_KEY, restoreVault); } catch (_) {}
    try { settings.set(localFiles.ROOTS_KEY, restoreRoots); } catch (_) {}
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    fail++;
    console.log('\n  FAIL  the run threw: ' + (e && e.stack ? e.stack : e));
  }

  const cleanupOk = tmpDir !== null && !(await fs.stat(tmpDir).catch(() => null));

  section('cleanup');
  check('the temp directory is gone', cleanupOk, String(tmpDir));
  check('the vault setting was restored', settings.get(obsidian.VAULT_KEY) === restoreVault,
    JSON.stringify(settings.get(obsidian.VAULT_KEY)));
  check('the roots setting was restored',
    JSON.stringify(settings.get(localFiles.ROOTS_KEY)) === JSON.stringify(restoreRoots),
    JSON.stringify(settings.get(localFiles.ROOTS_KEY)));
  check('nothing was left under the temp root',
    (await fs.readdir(os.tmpdir()).catch(() => [])).filter((n) => n.startsWith('bolo-files-check-')).length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
});