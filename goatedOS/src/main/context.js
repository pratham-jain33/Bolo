const { clipboard } = require('electron');
const { spawn } = require('node:child_process');
const capabilities = require('./capabilities');

// What bolo knows about the screen the user is looking at: the window in front,
// whatever text is selected in it, and the clipboard.
//
// The selection is the interesting one. There is no Electron API for "what is
// selected in the other application" — that lives in Windows UI Automation, and
// the only ways to it are a native module or a subprocess. This is the
// subprocess: a persistent PowerShell child holding a compiled wrapper around
// UIAutomationClient's TextPattern, because Add-Type compiles C# and a fresh
// process per call would cost about a second on the dictation path.
//
// The alternative every dictation app tries first is to send Ctrl+C and read
// the clipboard back. It is rejected here: it fires a keystroke into whatever
// has focus (which can do real damage in an app that binds Ctrl+C to something
// else) and it destroys whatever the user had copied. Reading is worth a
// subprocess; writing to somebody else's application is not.

const CALL_TIMEOUT_MS = 8000;
// Long enough for a paragraph, short enough that a "select all" in a huge
// document cannot hand the router a megabyte of text.
const MAX_CHARS = 8000;

/* ---------------------------------------------------------------------------
   The UI Automation backend
   ------------------------------------------------------------------------ */

// `-STA` is not optional and is not the default in every PowerShell build: UI
// Automation is a COM apartment-threaded API and calling it from an MTA thread
// fails with an unhelpful COM error rather than returning nothing. powershell.exe
// is STA by default, so it is passed explicitly anyway — this is the kind of
// default that changes between versions and hosts.
const PS_SOURCE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$code = @'
using System;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;
public class Sel {
  static TextPattern Pattern() {
    var el = AutomationElement.FocusedElement;
    if (el == null) return null;
    object p;
    // TryGetCurrentPattern, not GetCurrentPattern: an element that does not
    // support TextPattern is the normal case (a dialog, a canvas, a game) and
    // must be an empty answer rather than an exception.
    if (!el.TryGetCurrentPattern(TextPattern.Pattern, out p)) return null;
    return p as TextPattern;
  }
  public static string Selected() {
    var tp = Pattern();
    if (tp == null) return "";
    var sb = new StringBuilder();
    foreach (TextPatternRange r in tp.GetSelection()) sb.Append(r.GetText(-1));
    return sb.ToString();
  }
  public static string All() {
    var tp = Pattern();
    if (tp == null) return "";
    return tp.DocumentRange.GetText(-1);
  }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies UIAutomationClient, UIAutomationTypes -ErrorAction Stop
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -eq 'quit') { break }
    elseif ($line -eq 'sel') {
      # Base64, because selected text contains newlines and the protocol here is
      # one reply per line. The length is prefixed so an empty answer ('ok 0 ')
      # is distinguishable from a missing one.
      $t = [Sel]::Selected()
      [Console]::Out.WriteLine('ok ' + $t.Length + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))
    } elseif ($line -eq 'all') {
      $t = [Sel]::All()
      [Console]::Out.WriteLine('ok ' + $t.Length + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))
    } else {
      [Console]::Out.WriteLine('err unknown-command')
    }
  } catch {
    [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  }
}
`;

// -EncodedCommand takes base64 of UTF-16LE and sidesteps every quoting and
// line-ending question a script this size would otherwise raise.
function encodedCommand(src) {
  return Buffer.from(src, 'utf16le').toString('base64');
}

function psArgs() {
  return ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(PS_SOURCE)];
}

let child = null;
let childReady = null;
let unsupported = null;

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
    // Both handlers check that this process is still the current one before
    // clearing it. A process killed by dispose() fires `exit` a moment later,
    // and by then a replacement may already be running — clearing the field
    // unconditionally would orphan the new child and leave every later read
    // reporting "no powershell" against a child that is alive and answering.
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
    setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, CALL_TIMEOUT_MS);
  });
  return childReady;
}

// One line in, one line out, matched by ordering. Every caller goes through the
// same serial queue, so there is never more than one request outstanding.
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
        const out = buf.slice(0, nl).trim();
        if (out.startsWith('ok ')) {
          const parts = out.split(' ');
          let text = '';
          try {
            text = Buffer.from(parts[2] || '', 'base64').toString('utf8');
          } catch (_) {
            text = '';
          }
          finish({ ok: true, chars: Number(parts[1]) || 0, text });
        } else if (out.startsWith('err')) {
          finish({ ok: false, error: out.slice(3).trim() });
        } else {
          finish({ ok: false, error: out || 'unexpected-reply' });
        }
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

function available() {
  return process.platform === 'win32';
}

/* ---------------------------------------------------------------------------
   Providers
   ------------------------------------------------------------------------ */

async function getActiveWindow() {
  // Best available without native deps. Electron does not expose the foreground
  // window in main, so capabilities.js asks Windows for it through PowerShell —
  // with a short timeout and a cache, which is what keeps a slow shell off the
  // dictation path. active-win is still preferred when it happens to be
  // installed, because it is a real API rather than a subprocess.
  try {
    const activeWin = require('active-win');
    const w = await activeWin();
    if (w) return { title: w.title, owner: w.owner && w.owner.name, url: null, source: 'active-win' };
  } catch (_) {}
  // Same shape either way: { title, owner, url, source }.
  return capabilities.activeWindow();
}

// The text selected in whatever application has focus, read through UI
// Automation. Read-only by construction: the only thing this can do to another
// application is ask it what is selected.
//
// `source` names which answer this is, and the two failures are kept apart on
// purpose — `uia-unsupported` means the focused control has no text model (a
// dialog, an image, a game), which is a normal thing to find; `uia-unavailable`
// means the reader itself did not start, which is not the user's fault and is
// worth saying differently.
async function getSelection() {
  if (!available()) {
    return { text: '', chars: 0, source: 'uia-unsupported', note: 'Reading another window\'s selection is Windows-only for now.' };
  }
  const r = await psCall('sel');
  if (!r.ok) {
    return { text: '', chars: 0, source: 'uia-unavailable', error: r.error, note: unsupported || r.error };
  }
  if (!r.text) return { text: '', chars: 0, source: 'uia-unsupported' };
  return { text: r.text.slice(0, MAX_CHARS), chars: r.chars, source: 'uia' };
}

// The focused window's whole document, which is what "summarise this page" and
// "rewrite this" need. Kept separate from getSelection because it is the far
// more expensive read and the far larger payload.
async function getFocusedText() {
  if (!available()) return { text: '', chars: 0, source: 'uia-unsupported' };
  const r = await psCall('all');
  if (!r.ok) return { text: '', chars: 0, source: 'uia-unavailable', error: r.error };
  if (!r.text) return { text: '', chars: 0, source: 'uia-unsupported' };
  return { text: r.text.slice(0, MAX_CHARS), chars: r.chars, source: 'uia' };
}

function readClipboard() {
  try {
    const text = clipboard.readText() || '';
    return { text: text.slice(0, 4000), chars: text.length };
  } catch (e) {
    return { text: '', chars: 0, error: e.message };
  }
}

async function getContext() {
  const [win, sel] = await Promise.all([getActiveWindow(), getSelection()]);
  return {
    at: new Date().toISOString(),
    window: win,
    selection: sel,
    clipboard: readClipboard()
  };
}

// Called on quit, so the compiled child is released rather than left holding a
// UIA connection to the desktop.
async function dispose() {
  if (!child) return;
  const proc = child;
  child = null;
  childReady = null;
  try { proc.stdin.write('quit\n'); } catch (_) {}
  try { proc.kill(); } catch (_) {}
}

module.exports = { getActiveWindow, getSelection, getFocusedText, readClipboard, getContext, dispose, _internals: { psArgs, PS_SOURCE, MAX_CHARS } };
