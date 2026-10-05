// A code check with no dependencies.
//
//   npm run check
//
// Walks src/ and tools/ and runs `node --check` over every .js it finds, one
// child process per file. It exists because the obvious one-liner does not work
// here: PowerShell does not expand globs, so `node --check src/renderer/*.js`
// hands node a literal `*` and fails with MODULE_NOT_FOUND — a check that looks
// like it passed while checking nothing. (This is written down in CLAUDE.md. It
// has bitten the project before.)
//
// Two static checks ride along, because `node --check` cannot see either:
//
//   1. The `const`/`var` trap. `contextBridge.exposeInMainWorld` defines `bolo`
//      on `window` as non-configurable, so a top-level `const bolo =` in a
//      renderer script is a SyntaxError at parse time that kills the whole file —
//      including any error handler inside it, which is why it was silent. `var`
//      may redeclare a global property; `const` and `let` may not. `node --check`
//      cannot catch it: `bolo` is not a Node global, so the collision only
//      exists in a browser classic-script global scope. Cost: three sessions.
//
//   2. A `require('./x')` whose file is not there — a typo, or a rename that
//      missed a caller. Only literal relative specifiers are resolved; anything
//      computed is left alone rather than guessed at.
//
// Synchronous on purpose: no concurrency to get wrong, and ~40 small node
// processes is a couple of seconds.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out; // a directory that is not there is not a failure
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

// `resolve('./x')` the way Node does, without executing anything.
function resolves(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  return candidates.some((c) => {
    try { return fs.statSync(c).isFile(); } catch (_) { return false; }
  });
}

const REQUIRE_RE = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
const BOLO_RE = /^[ \t]*(?:const|let)[ \t]+bolo\b/m;

// `seed-keys.js` is the one legitimate absence: it holds live credentials, is
// gitignored, and keys.js requires it inside a try/catch with a documented
// "no bundled keys" fallback. The require scan cannot see the try/catch, so
// it is allowlisted here instead of failing every fresh clone.
const ALLOW_MISSING = new Set([
  'src/main/keys.js:./seed-keys'
]);

// Comments are stripped before the require scan, or this file would fail on its
// own documentation. Line comments are only stripped where `//` is not preceded
// by a quote or a colon, so a URL inside a string survives. Erring towards
// stripping can only make the scan miss something, never invent a failure.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);
files.sort();

const failures = [];
let checked = 0;

for (const file of files) {
  const name = rel(file);
  checked++;

  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    const why = String(r.stderr || r.stdout || 'node --check failed')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((l) => l.trim())
      // Drop the banner, the caret ruler and the stack: the source line and the
      // SyntaxError are the whole message.
      .filter((l) => l && !/^\^+$/.test(l) && !l.includes(ROOT) && !/^at /.test(l) && !/^Node\.js v/.test(l))
      .slice(0, 3)
      .join('\n    ');
    failures.push('FAIL ' + name + ' — parse error\n    ' + why);
    continue; // a file that does not parse has nothing else worth reading
  }

  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    failures.push('FAIL ' + name + ' — unreadable: ' + e.message);
    continue;
  }

  const code = stripComments(src);

  // Renderers only: in the main process `bolo` is an ordinary name, and the
  // collision only exists in a browser classic-script global scope.
  if (name.startsWith('src/renderer/') && BOLO_RE.test(code)) {
    failures.push(
      'FAIL ' + name + ' — top-level `const/let bolo` in a renderer script.\n' +
      '    window.bolo is non-configurable (contextBridge), so this is a SyntaxError at\n' +
      '    parse time and the entire file dies silently. Use `var bolo = window.bolo;`.'
    );
    continue;
  }

  REQUIRE_RE.lastIndex = 0;
  let m;
  const missing = [];
  while ((m = REQUIRE_RE.exec(code))) {
    if (!resolves(file, m[1]) && !ALLOW_MISSING.has(name + ':' + m[1])) missing.push(m[1]);
  }
  if (missing.length) {
    failures.push('FAIL ' + name + ' — require() of a file that is not there: ' + missing.join(', '));
  }
}

console.log('node --check  ' + checked + ' file' + (checked === 1 ? '' : 's') +
  ' in ' + DIRS.join('/') + (failures.length ? '' : ' — ok'));

for (const f of failures) console.log(f);

if (failures.length) {
  console.log('\n' + failures.length + ' of ' + checked + ' failed.');
  process.exit(1);
}
console.log('all clean.');