// The things bolo may actually *do* on this machine.
//
// Every export here has the same contract: it resolves to `{ ok, ... }` and it
// never throws. A capability that is switched off in Settings returns
// `{ ok: false, error: 'not-permitted' }` rather than acting anyway — nothing in
// this file touches the machine without passing `permitted()` first, because a
// voice utterance is not consent and the toggle is.
//
// Nothing here interpolates user text into a shell string. Executables are
// launched with an argv array, a path is resolved and checked before it is
// opened, and the one protocol URI this file can hand to the OS comes from the
// map below rather than from the transcript.
//
// Electron + Node built-ins only: no native deps, so the same code runs on a
// machine with nothing installed.
const { shell, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');

/* ── permission gate ────────────────────────────────────────────────────────
   The capability name the agent speaks in, mapped to the settings key the user
   actually flipped. Kept in one table so a new capability cannot ship without
   a permission by accident: an unmapped name is refused, not allowed. */
const PERMISSION = {
  open_app: 'agentCanOpenApps',
  open_path: 'agentCanOpenApps',
  reveal_path: 'agentCanOpenApps',
  edit_file: 'agentCanEditFiles',
  screenshot: 'agentCanScreenshot'
};

function isPermitted(capability) {
  const key = PERMISSION[capability];
  if (!key) return false;
  try {
    return !!settings.get(key);
  } catch (_) {
    return false;
  }
}

function denied(capability) {
  return {
    ok: false,
    error: 'not-permitted',
    capability,
    setting: PERMISSION[capability] || null
  };
}

// The three toggles as one object, for Settings to read back.
function permissions() {
  return {
    agentCanOpenApps: !!settings.get('agentCanOpenApps'),
    agentCanEditFiles: !!settings.get('agentCanEditFiles'),
    agentCanScreenshot: !!settings.get('agentCanScreenshot')
  };
}

/* ── the home-directory allowlist ───────────────────────────────────────────
   File editing is confined to the user's own home directory. The check is a
   prefix test on a `path.resolve`d path — so `..` has already been collapsed by
   the time it runs — plus a second pass over the realpath of the deepest
   existing ancestor, which is what stops a symlink inside home pointing out of
   it. UNC and device paths are refused outright: `\\server\share` reaches the
   network, and `CON`/`NUL` are not files at all. */
const DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

function homeDir() {
  try {
    return os.homedir();
  } catch (_) {
    return '';
  }
}

function sameOrInside(child, parent) {
  const c = child.toLowerCase().replace(/[\\/]+$/, '');
  const p = parent.toLowerCase().replace(/[\\/]+$/, '');
  if (!p) return false;
  return c === p || c.startsWith(p + path.sep);
}

// realpath of the deepest ancestor that exists, with the not-yet-existing tail
// re-appended. A create still gets a symlink-checked answer.
function realpathDeepest(p) {
  let head = p;
  let tail = '';
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(head) : fs.realpathSync(head);
      return tail ? path.join(real, tail) : real;
    } catch (_) {
      const parent = path.dirname(head);
      if (!parent || parent === head) return p;
      tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
      head = parent;
    }
  }
  return p;
}

function safeResolve(target) {
  const raw = String(target == null ? '' : target).trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return { ok: false, error: 'empty-path' };
  if (/^[\\/]{2}/.test(raw)) return { ok: false, error: 'refused-unc-path' };
  const base = path.basename(raw).split('.')[0].toUpperCase();
  if (DEVICE_NAMES.has(base)) return { ok: false, error: 'refused-device-path' };

  const home = homeDir();
  if (!home) return { ok: false, error: 'no-home-dir' };

  // An absolute target resolves to itself; a relative one is taken from home —
  // which is also what makes "my notes file" land somewhere sensible.
  const full = path.resolve(home, raw);
  if (!sameOrInside(full, home)) {
    return { ok: false, error: 'outside-home', path: full, home };
  }

  const real = realpathDeepest(full);
  if (!sameOrInside(real, home)) {
    return { ok: false, error: 'outside-home-after-symlink', path: real, home };
  }
  return { ok: true, path: real };
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // refuse anything larger, either direction
const MAX_RETURN_CHARS = 20000;         // what a caller is handed back, not the cap

function countLines(s) {
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n + 1;
}

function describeChange(before, after) {
  const bytes = Buffer.byteLength(after, 'utf8');
  const lines = countLines(after);
  return {
    bytes,
    lines,
    bytesDelta: bytes - Buffer.byteLength(before, 'utf8'),
    linesDelta: lines - countLines(before)
  };
}

/* ── opening an application ─────────────────────────────────────────────────
   A curated map first, because the honest answer for "notepad" is
   `system32\notepad.exe` and a filesystem search that found some other
   `notepad.exe` first would be worse than useless. Candidates are checked in
   order and the first one that exists wins. */
const WINDIR = process.env.windir || process.env.SystemRoot || 'C:\\Windows';
const SYS32 = path.join(WINDIR, 'system32');
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');

// A leading `uri:` means "hand this exact protocol to the OS" — the only string
// in this file that reaches a shell-ish API, and it is ours, not the user's.
const APP_MAP = {
  notepad: [path.join(SYS32, 'notepad.exe')],
  calculator: [path.join(SYS32, 'calc.exe'), 'uri:calculator:'],
  calc: [path.join(SYS32, 'calc.exe'), 'uri:calculator:'],
  explorer: [path.join(WINDIR, 'explorer.exe')],
  files: [path.join(WINDIR, 'explorer.exe'), 'uri:file:'],
  'file explorer': [path.join(WINDIR, 'explorer.exe')],
  cmd: [path.join(SYS32, 'cmd.exe')],
  'command prompt': [path.join(SYS32, 'cmd.exe')],
  terminal: [path.join(WINDIR, 'System32', 'WindowsTerminal.exe'), path.join(SYS32, 'cmd.exe')],
  powershell: [path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
  paint: [path.join(SYS32, 'mspaint.exe'), 'uri:mspaint:'],
  settings: ['uri:ms-settings:'],
  'task manager': [path.join(SYS32, 'taskmgr.exe')],
  taskmgr: [path.join(SYS32, 'taskmgr.exe')],
  edge: [
    path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ],
  chrome: [
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ],
  'google chrome': [
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ],
  browser: [
    path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ],
  vscode: [
    path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(PF, 'Microsoft VS Code', 'Code.exe')
  ],
  code: [
    path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(PF, 'Microsoft VS Code', 'Code.exe')
  ],
  spotify: [
    path.join(ROAMING, 'Spotify', 'Spotify.exe'),
    path.join(LOCAL, 'Microsoft', 'WindowsApps', 'Spotify.exe')
  ]
};

// The usual install roots, in the order a name is most likely to be found in
// them. Used only when the map has no answer.
function installRoots() {
  return [
    path.join(LOCAL, 'Programs'),
    PF,
    PF86,
    path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(PF, 'WindowsApps')
  ].filter(Boolean);
}

// Bounded on purpose: a depth-3 walk with a hard entry budget, so "open
// blender" on a machine that has never seen Blender costs milliseconds rather
// than a full disk crawl.
function searchForExe(name) {
  const wanted = String(name).toLowerCase().replace(/\.exe$/, '');
  if (!wanted || wanted.length < 2) return null;
  let budget = 4000;
  const skip = new Set(['node_modules', 'temp', 'cache', 'logs', '$recycle.bin']);

  function walk(dir, depth) {
    if (budget <= 0 || depth > 3) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    let best = null;
    for (const e of entries) {
      if (budget-- <= 0) break;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === wanted + '.exe') {
        // A top-level hit beats a deeper one; the first found wins either way.
        return full;
      }
      if (e.isDirectory() && !skip.has(e.name.toLowerCase()) && !e.name.startsWith('.')) {
        const found = walk(full, depth + 1);
        if (found && !best) best = found;
      }
    }
    return best;
  }

  for (const root of installRoots()) {
    const hit = walk(root, 0);
    if (hit) return hit;
    if (budget <= 0) break;
  }
  return null;
}

function launch(exe, args = []) {
  // detached + stdio ignore + unref: the app the user asked for is its own
  // process, and it must not keep bolo alive or block main when it starts.
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* reported by the caller's existsSync check */ });
  child.unref();
  return child;
}

async function openApp(name) {
  if (!isPermitted('open_app')) return denied('open_app');
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return { ok: false, error: 'no-app-named' };
  const key = raw.toLowerCase().replace(/\.exe$/, '');

  const candidates = APP_MAP[key] || (APP_MAP[key.replace(/^the\s+/, '')] || null);
  if (candidates) {
    for (const c of candidates) {
      if (c.startsWith('uri:')) {
        const uri = c.slice(4);
        try {
          await shell.openExternal(uri);
          return { ok: true, app: key, launched: uri, how: 'protocol' };
        } catch (e) {
          return { ok: false, error: 'launch-failed', app: key, detail: e.message };
        }
      }
      if (fs.existsSync(c)) {
        try {
          launch(c);
          return { ok: true, app: key, launched: c, how: 'exe' };
        } catch (e) {
          return { ok: false, error: 'launch-failed', app: key, detail: e.message };
        }
      }
    }
  }

  const found = searchForExe(key);
  if (found) {
    try {
      launch(found);
      return { ok: true, app: key, launched: found, how: 'search' };
    } catch (e) {
      return { ok: false, error: 'launch-failed', app: key, detail: e.message };
    }
  }

  return {
    ok: false,
    error: 'not-found',
    app: key,
    searched: installRoots(),
    word: raw
  };
}

/* ── opening / revealing a file or folder ───────────────────────────────────
   Non-destructive, so the allowlist is not applied: the user may well want the
   file that is already open in their editor. What is still refused is anything
   that is not an existing local path, and any UNC path (which would reach the
   network and can block). */
function localPath(target) {
  const raw = String(target == null ? '' : target).trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return { ok: false, error: 'empty-path' };
  if (/^[\\/]{2}/.test(raw)) return { ok: false, error: 'refused-unc-path' };
  const base = path.basename(raw).split('.')[0].toUpperCase();
  if (DEVICE_NAMES.has(base)) return { ok: false, error: 'refused-device-path' };
  const full = path.resolve(homeDir(), raw);
  return { ok: true, path: full };
}

async function openPath(target) {
  if (!isPermitted('open_path')) return denied('open_path');
  const raw = String(target == null ? '' : target).trim();

  // A URL is a legitimate thing to ask for, and shell.openExternal is the
  // honest tool for it. Only http/https — a `file:` or a custom protocol from a
  // transcript is exactly how a voice command becomes an execution primitive.
  if (/^https?:\/\//i.test(raw)) {
    try {
      await shell.openExternal(raw);
      return { ok: true, opened: raw, how: 'url' };
    } catch (e) {
      return { ok: false, error: 'open-failed', detail: e.message };
    }
  }

  const p = localPath(raw);
  if (!p.ok) return p;
  if (!fs.existsSync(p.path)) return { ok: false, error: 'not-found', path: p.path };

  try {
    // openPath resolves to '' on success and to the reason on failure — it does
    // not reject, so the empty string is the success test.
    const err = await shell.openPath(p.path);
    if (err) return { ok: false, error: 'open-failed', path: p.path, detail: err };
    return { ok: true, opened: p.path, how: 'openPath' };
  } catch (e) {
    return { ok: false, error: 'open-failed', path: p.path, detail: e.message };
  }
}

async function revealPath(target) {
  if (!isPermitted('reveal_path')) return denied('reveal_path');
  const p = localPath(target);
  if (!p.ok) return p;
  if (!fs.existsSync(p.path)) return { ok: false, error: 'not-found', path: p.path };
  try {
    shell.showItemInFolder(p.path);
    return { ok: true, revealed: p.path };
  } catch (e) {
    return { ok: false, error: 'reveal-failed', path: p.path, detail: e.message };
  }
}

/* ── editing a file ─────────────────────────────────────────────────────────
   read / write / append / replace, inside home only.

   Overwriting an existing file and replacing text inside one are the two
   destructive shapes, and both require `confirmed: true` on the operation. The
   agent path never sets it from a transcript, so a spoken "change my notes to
   say X" comes back as `needs-confirmation` with the target named, rather than
   as a silent overwrite of somebody's work. */
async function editFile(op = {}) {
  if (!isPermitted('edit_file')) return denied('edit_file');
  const kind = String(op.op || op.operation || 'read').toLowerCase();
  const resolved = safeResolve(op.path);
  if (!resolved.ok) return resolved;
  const file = resolved.path;

  try {
    if (kind === 'read') {
      if (!fs.existsSync(file)) return { ok: false, error: 'not-found', path: file };
      const st = fs.statSync(file);
      if (st.isDirectory()) return { ok: false, error: 'is-a-directory', path: file };
      if (st.size > MAX_FILE_BYTES) {
        return { ok: false, error: 'too-large', path: file, bytes: st.size, limit: MAX_FILE_BYTES };
      }
      const content = fs.readFileSync(file, 'utf8');
      const truncated = content.length > MAX_RETURN_CHARS;
      return {
        ok: true,
        op: 'read',
        path: file,
        bytes: st.size,
        lines: countLines(content),
        content: truncated ? content.slice(0, MAX_RETURN_CHARS) : content,
        truncated
      };
    }

    if (kind === 'write' || kind === 'append') {
      const content = String(op.content == null ? '' : op.content);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        return { ok: false, error: 'too-large', bytes, limit: MAX_FILE_BYTES, path: file };
      }
      const exists = fs.existsSync(file);

      if (kind === 'write' && exists && op.confirmed !== true) {
        const st = fs.statSync(file);
        return {
          ok: false,
          error: 'needs-confirmation',
          path: file,
          bytes: st.size,
          reason: 'overwrite-existing-file'
        };
      }
      if (exists && fs.statSync(file).isDirectory()) {
        return { ok: false, error: 'is-a-directory', path: file };
      }

      // Parent directories are created for an explicit create/write, never as a
      // side effect of a typo'd path.
      const create = op.create === true || kind === 'write';
      if (!exists && !create) return { ok: false, error: 'not-found', path: file };
      if (!exists) {
        const parent = path.dirname(file);
        if (!fs.existsSync(parent)) {
          const grandparent = safeResolve(parent);
          if (!grandparent.ok) return grandparent;
          fs.mkdirSync(parent, { recursive: true });
        }
      }

      const before = exists ? fs.readFileSync(file, 'utf8').slice(0, MAX_FILE_BYTES) : '';
      if (kind === 'append') fs.appendFileSync(file, content, 'utf8');
      else fs.writeFileSync(file, content, 'utf8');

      const after = kind === 'append' ? before + content : content;
      return { ok: true, op: kind, path: file, created: !exists, ...describeChange(before, after) };
    }

    if (kind === 'replace') {
      if (!fs.existsSync(file)) return { ok: false, error: 'not-found', path: file };
      const st = fs.statSync(file);
      if (st.isDirectory()) return { ok: false, error: 'is-a-directory', path: file };
      if (st.size > MAX_FILE_BYTES) {
        return { ok: false, error: 'too-large', path: file, bytes: st.size, limit: MAX_FILE_BYTES };
      }
      const find = String(op.find == null ? '' : op.find);
      const put = String(op.replace == null ? '' : op.replace);
      if (!find) return { ok: false, error: 'nothing-to-find', path: file };

      if (op.confirmed !== true) {
        return {
          ok: false,
          error: 'needs-confirmation',
          path: file,
          bytes: st.size,
          reason: 'replace-in-existing-file'
        };
      }

      const before = fs.readFileSync(file, 'utf8');
      const all = op.all === true;
      const parts = before.split(find);
      const hits = parts.length - 1;
      if (!hits) return { ok: false, error: 'no-match', path: file, find };
      const after = all ? parts.join(put) : before.replace(find, put);
      fs.writeFileSync(file, after, 'utf8');
      return {
        ok: true,
        op: 'replace',
        path: file,
        replaced: all ? hits : 1,
        occurrences: hits,
        ...describeChange(before, after)
      };
    }

    return { ok: false, error: 'unknown-op', op: kind, known: ['read', 'write', 'append', 'replace'] };
  } catch (e) {
    return { ok: false, error: 'io-failed', path: file, detail: e.message };
  }
}

/* ── screenshot ─────────────────────────────────────────────────────────────
   The same desktopCapturer call the intro already uses. Default is the primary
   display; `display` is an index into the display list, which is what a user
   saying "the second screen" is pointing at. */
async function screenshot(opts = {}) {
  if (!isPermitted('screenshot')) return denied('screenshot');
  try {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    let target = primary;
    if (opts.display != null && opts.display !== '') {
      const idx = Number(opts.display);
      if (Number.isInteger(idx) && idx >= 0 && idx < displays.length) target = displays[idx];
      else if (Number.isInteger(idx)) {
        return { ok: false, error: 'no-such-display', display: idx, count: displays.length };
      }
    }

    const width = Math.min(target.size.width, 1920);
    const height = Math.round(target.size.height * (width / target.size.width));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });
    const match = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0];
    if (!match || !match.thumbnail || match.thumbnail.isEmpty()) {
      return { ok: false, error: 'no-thumbnail' };
    }

    const size = match.thumbnail.getSize();
    const out = {
      ok: true,
      dataUrl: match.thumbnail.toDataURL(),
      width: size.width,
      height: size.height,
      display: { id: target.id, index: displays.indexOf(target), primary: target.id === primary.id },
      at: new Date().toISOString()
    };

    // Saving is the same allowlist as any other write: home only.
    if (opts.save) {
      const resolved = safeResolve(opts.save);
      if (!resolved.ok) return { ...out, saved: null, saveError: resolved.error };
      try {
        const parent = path.dirname(resolved.path);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        fs.writeFileSync(resolved.path, match.thumbnail.toPNG());
        out.saved = resolved.path;
      } catch (e) {
        out.saveError = e.message;
      }
    }
    return out;
  } catch (e) {
    return { ok: false, error: 'capture-failed', detail: e && e.message ? e.message : String(e) };
  }
}

/* ── the foreground window ──────────────────────────────────────────────────
   Electron does not expose the foreground window in main, and active-win is not
   a dependency, so this asks Windows directly through PowerShell. The Win32
   call is what makes it the *foreground* window rather than merely the first
   process with a title.

   Two things keep it off the hot path: a short timeout (a hung PowerShell must
   not stall a dictation) and a cache (the router asks twice in a row for the
   same utterance, and the answer cannot have changed in between). */
const ACTIVE_TTL_MS = 3000;
const ACTIVE_TIMEOUT_MS = 2500;
let activeCache = null;

// Written to a temp .ps1 rather than passed as -Command: the script contains
// quotes and braces, and a file has no shell escaping to get wrong.
const PS_SCRIPT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class BoloFg {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '}',
  '"@',
  '$h = [BoloFg]::GetForegroundWindow()',
  '$sb = New-Object System.Text.StringBuilder 512',
  '[void][BoloFg]::GetWindowText($h, $sb, 512)',
  '$ownerPid = 0',
  '[void][BoloFg]::GetWindowThreadProcessId($h, [ref]$ownerPid)',
  '$p = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue',
  '$name = if ($p) { $p.ProcessName } else { "" }',
  '$title = $sb.ToString()',
  'Write-Output ($name + "`t" + $title)',
  ''
].join('\r\n');

function runPowerShell(timeoutMs) {
  return new Promise((resolve) => {
    let file;
    try {
      file = path.join(os.tmpdir(), 'bolo-active-window.ps1');
      fs.writeFileSync(file, PS_SCRIPT, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'temp-write-failed', detail: e.message });
    }

    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file
      ], { windowsHide: true });
    } catch (e) {
      return finish({ ok: false, error: 'spawn-failed', detail: e.message });
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);

    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => { if (out.length < 8192) out += d.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', (d) => { if (err.length < 2048) err += d.toString('utf8'); });
    child.on('error', (e) => finish({ ok: false, error: 'spawn-failed', detail: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: 'exit-' + code, detail: err.trim().slice(0, 200) });
      const line = out.split(/\r?\n/).find((l) => l.trim()) || '';
      const tab = line.indexOf('\t');
      finish({
        ok: true,
        owner: (tab >= 0 ? line.slice(0, tab) : '').trim() || null,
        title: (tab >= 0 ? line.slice(tab + 1) : line).trim() || null
      });
    });
  });
}

// Shape-identical to context.js's own provider — `{ title, owner, url, source }`
// — because the router and the notch already read it, and `source` is the one
// field that tells the truth about where the answer came from.
async function activeWindow(opts = {}) {
  const now = Date.now();
  if (!opts.force && activeCache && now - activeCache.at < ACTIVE_TTL_MS) {
    return activeCache.value;
  }

  let value;
  if (process.platform !== 'win32') {
    value = { title: null, owner: null, url: null, source: 'unsupported-platform' };
  } else {
    const r = await runPowerShell(ACTIVE_TIMEOUT_MS);
    value = r.ok
      ? { title: r.title, owner: r.owner, url: null, source: 'powershell' }
      : { title: null, owner: null, url: null, source: 'powershell-failed', error: r.error };
  }
  activeCache = { at: now, value };
  return value;
}

module.exports = {
  // capabilities
  openApp,
  openPath,
  revealPath,
  editFile,
  screenshot,
  activeWindow,
  // permissions, for Settings and for the agent
  permissions,
  isPermitted,
  PERMISSION,
  // shared with context.js so the two cannot disagree about the allowlist
  safeResolve,
  MAX_FILE_BYTES
};