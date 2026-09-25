const { clipboard } = require('electron');
const { spawn } = require('node:child_process');

// System-wide text injection: how a dictated sentence or a rewritten selection
// actually lands in the app the user was in.
//
// The mechanism is clipboard + a synthesized Ctrl+V. bolo writes the text to the
// clipboard (system-wide, no focus needed) and then sends a real Ctrl+V to
// whatever window has keyboard focus — which is the user's app, because bolo's
// own surfaces (notch, pill) are `focusable: false` and only ever `showInactive`,
// so they never steal focus. The paste lands where the caret is.
//
// Why PowerShell rather than a native module: this used to depend on `nut.js`,
// which is an optional native build that was never installed — so every inject
// silently fell through to "clipboard only" and NOTHING was ever typed. That is
// exactly why Dictation and Edit "did nothing" while Agent (which never injects)
// worked. PowerShell's `keybd_event` needs no build step and is the same
// subprocess pattern context.js and duck.js already rely on, so it works on the
// machine as it actually is.
//
// Reading someone else's selection is done with UI Automation (context.js) and
// is read-only. Writing is the opposite direction and genuinely needs to drive
// the keyboard, so a synthesized keystroke here is deliberate, not the Ctrl+C
// hack context.js refuses — that one fires INTO an app to read it; this pastes
// text the user asked to be typed.
//
// The prior clipboard is saved and put back after the paste, so dictating does
// not quietly eat whatever the user had copied. The restore is delayed (the
// paste has to consume the clipboard first) and guarded (if the user copied
// something new in the gap, that wins and we do not clobber it).

const READY_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 5000;
// How long to wait after the paste before restoring the user's old clipboard.
// Long enough that the target app has consumed the paste; short enough that the
// user's clipboard is theirs again almost immediately.
const RESTORE_DELAY_MS = 600;

// keybd_event is the small, dependency-free way to synthesize Ctrl+V. It posts
// to the foreground window's focus, which is the user's app. SendInput would be
// marginally more modern, but keybd_event is simpler and works identically for a
// modifier+key chord, and this is not a hot path.
const PS_SOURCE = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
public class Inj {
  [DllImport("user32.dll")]
  static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  const byte VK_CONTROL = 0x11;
  const byte VK_V = 0x56;
  const uint KEYEVENTF_KEYUP = 0x0002;
  public static void Paste() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -eq 'quit') { break }
    elseif ($line -eq 'paste') { [Inj]::Paste(); [Console]::Out.WriteLine('ok') }
    else { [Console]::Out.WriteLine('err unknown-command') }
  } catch {
    [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  }
}
`;

function encodedCommand(src) {
  return Buffer.from(src, 'utf16le').toString('base64');
}

function psArgs() {
  return ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(PS_SOURCE)];
}

let child = null;
let childReady = null;
let unsupported = null;

function available() {
  return process.platform === 'win32';
}

// Mirrors context.js: a persistent child so the dictation path does not pay a
// ~300ms PowerShell spawn on every sentence. The exit/error handlers capture
// the process and check `child !== proc` before clearing, so a child killed by
// dispose() cannot clear the field out from under its replacement.
function startPs() {
  if (child) return childReady;
  childReady = new Promise((resolve) => {
    let out = '';
    let settled = false;
    let proc;
    try {
      proc = spawn('powershell.exe', psArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      child = null;
      unsupported = e.message;
      resolve(null);
      return;
    }
    child = proc;
    proc.on('error', (e) => {
      unsupported = e.message;
      if (child !== proc) return;
      child = null;
      if (!settled) { settled = true; resolve(null); }
    });
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      childReady = null;
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const nl = out.indexOf('\n');
      if (nl < 0 || settled) return;
      const line = out.slice(0, nl).trim();
      settled = true;
      resolve(line === 'ready' ? proc : null);
    });
    setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, READY_TIMEOUT_MS);
  });
  return childReady;
}

let callSeq = Promise.resolve();

function psCall(line) {
  const run = async () => {
    const proc = await startPs();
    if (!proc) return { ok: false, error: 'no-powershell' };
    return await new Promise((resolve) => {
      let buf = '';
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        proc.stdout.removeListener('data', onData);
        clearTimeout(timer);
        resolve(r);
      };
      const onData = (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl).trim();
        if (line === 'ok') finish({ ok: true });
        else if (line.startsWith('err')) finish({ ok: false, error: line.slice(3).trim() });
        else finish({ ok: false, error: line || 'unexpected-reply' });
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), CALL_TIMEOUT_MS);
      proc.stdout.on('data', onData);
      try {
        proc.stdin.write(line + '\n');
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
    });
  };
  callSeq = callSeq.then(run, run);
  return callSeq;
}

// Put the user's old clipboard back, but only if it is still the text we pasted
// — if they copied something new in the meantime, that is theirs and wins.
function scheduleRestore(previous, mine) {
  setTimeout(() => {
    try {
      if (clipboard.readText() === mine) clipboard.writeText(previous);
    } catch (_) {}
  }, RESTORE_DELAY_MS);
}

// Inject `text` into the focused app. Returns a shape the caller already expects:
//   { ok, systemWide, paste, chars }         it was pasted
//   { ok:true, systemWide:false, paste, ... } clipboard set but not pasted (no PS)
async function inject(text) {
  const value = String(text == null ? '' : text);
  if (!value) return { ok: false, error: 'empty-text' };

  let previous = '';
  try { previous = clipboard.readText() || ''; } catch (_) {}

  clipboard.writeText(value);

  if (!available()) {
    return { ok: true, systemWide: false, paste: 'clipboard-only (paste is Windows-only for now)', chars: value.length };
  }

  const r = await psCall('paste');
  if (!r.ok) {
    // The text is on the clipboard, so the user can still paste it by hand — say
    // so rather than pretending it was typed.
    return {
      ok: true,
      systemWide: false,
      paste: 'clipboard-only (' + (r.error || unsupported || 'paste-failed') + ')',
      chars: value.length
    };
  }

  scheduleRestore(previous, value);
  return { ok: true, systemWide: true, paste: 'ctrl+v-sent', chars: value.length };
}

async function dispose() {
  if (!child) return;
  const proc = child;
  child = null;
  childReady = null;
  try { proc.stdin.write('quit\n'); } catch (_) {}
  try { proc.kill(); } catch (_) {}
}

module.exports = { inject, dispose, available, _internals: { psArgs, PS_SOURCE } };
