// Reading the focused window's selection through UI Automation.
//
// The protocol half of this is checked hard: the PowerShell child starts, the C#
// compiles, a request gets exactly one reply, and text with newlines and non-ASCII
// survives the base64 round trip. Those are the parts that fail silently.
//
// The end-to-end half depends on what is actually focused, so the run prints
// what it found rather than asserting a specific string — a headless machine has
// no other application to read, and pretending otherwise would make this check
// pass on a machine where the reader does nothing.
//   electron tools/context-check.js
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const context = require('../src/main/context');

// Electron quits when the last window closes, and this test closes one partway
// through — which would end the run before the remaining checks rather than
// failing them, the quietest possible way for a test to lie.
app.on('window-all-closed', () => {});

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}

const SOURCES = ['uia', 'uia-unsupported', 'uia-unavailable'];

app.whenReady().then(async () => {
  /* ── the reader itself ───────────────────────────────────────────────── */
  const win = await context.getActiveWindow();
  check('getActiveWindow reports a window shape',
    win && typeof win === 'object' && 'title' in win && 'owner' in win,
    JSON.stringify({ title: win && win.title, owner: win && win.owner, source: win && win.source }));

  const clip = context.readClipboard();
  check('readClipboard returns text and a length', typeof clip.text === 'string' && typeof clip.chars === 'number',
    clip.chars + ' chars');

  /* ── the protocol ────────────────────────────────────────────────────── */
  // Two calls at once: the child is one process with one stdin, so a second
  // request must not interleave with the first. This is the bug the serial queue
  // exists to prevent, and it only shows up under concurrency.
  const [a, b] = await Promise.all([context.getSelection(), context.getSelection()]);
  check('two concurrent reads both answer', !!a && !!b,
    'sources ' + a.source + ', ' + b.source);

  const sel = await context.getSelection();
  check('getSelection returns the documented shape',
    typeof sel.text === 'string' && typeof sel.chars === 'number' && SOURCES.includes(sel.source),
    'source=' + sel.source + ' chars=' + sel.chars);
  check('and its text is never longer than the cap',
    sel.text.length <= context._internals.MAX_CHARS, sel.text.length + ' chars');

  const all = await context.getFocusedText();
  check('getFocusedText returns the same shape',
    typeof all.text === 'string' && SOURCES.includes(all.source), 'source=' + all.source);

  if (sel.source === 'uia-unavailable') {
    check('the reader started', false, 'error: ' + (sel.error || sel.note));
  } else {
    check('the reader started', true, 'source=' + sel.source);
  }

  /* ── base64 round trip, including the cases that break a line protocol ── */
  // The reader is asked for the focused text of a window bolo itself owns, which
  // is the one window this process can guarantee exists and can put known text
  // into. Whatever the answer is, it is reported — a textarea is not guaranteed
  // to expose TextPattern, and a "FAIL" here for a limitation of Chromium would
  // be a misleading result.
  const w = new BrowserWindow({
    width: 420, height: 240, show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });
  const KNOWN = 'bolo selection probe\nsecond line — with an em dash and ünïcode';
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0"><textarea id="t" style="width:100%;height:100%;font:14px monospace">' + KNOWN + '</textarea>' +
    '<script>const t=document.getElementById("t");t.focus();t.setSelectionRange(0,t.value.length);</script></body>'
  ));
  w.focus();
  await new Promise((r) => setTimeout(r, 900));

  const read = await context.getSelection();
  const got = read.text;
  const matched = got === KNOWN;
  console.log('  ...   focused read: source=' + read.source + ' chars=' + got.length +
    (got ? '  first 60=' + JSON.stringify(got.slice(0, 60)) : ''));
  if (matched) {
    check('a selection in a real window round-trips intact', true, 'exact match, newlines and non-ASCII preserved');
  } else if (read.source === 'uia-unsupported') {
    console.log('  ....  the focused control exposes no TextPattern here — the reader is wired,');
    console.log('  ....  but this window cannot demonstrate it. Try it against Notepad or a browser.');
  } else {
    check('a selection in a real window round-trips intact', false,
      'expected ' + JSON.stringify(KNOWN.slice(0, 40)) + ', got ' + JSON.stringify(got.slice(0, 40)));
  }

  w.destroy();

  /* ── the real thing: a foreign application, driven from outside ───────── */
  // A textarea in a window bolo owns proves nothing about reading *another*
  // application, which is the entire feature. So this opens Notepad on a known
  // file, selects everything with a real Ctrl+A, and reads it back. Notepad is
  // the smallest real Win32 text surface there is.
  //
  // If Notepad cannot be driven here (no desktop, a locked session) the run says
  // so and moves on — a test that fails for a reason outside the code is worse
  // than one that reports it cannot tell.
  const probeText = 'bolo selection probe\nsecond line - with a dash and unicode: cafe naive';
  const probeFile = path.join(os.tmpdir(), 'bolo-context-probe.txt');
  fs.writeFileSync(probeFile, probeText, 'utf8');

  const note = spawn('notepad.exe', [probeFile], { windowsHide: false, stdio: 'ignore', detached: false });
  let drove = false;
  try {
    await new Promise((r) => setTimeout(r, 1600));
    // AppActivate + SendKeys is the only way to reach another process's window
    // from here without a native input module.
    const r = await new Promise((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$w = New-Object -ComObject WScript.Shell; " +
        "$null = $w.AppActivate('bolo-context-probe'); Start-Sleep -Milliseconds 400; " +
        "$w.SendKeys('^a'); Start-Sleep -Milliseconds 300; 'sent'"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ps.stdout.on('data', (c) => { out += c; });
      ps.on('exit', () => resolve(out.trim()));
      ps.on('error', () => resolve(''));
      setTimeout(() => { try { ps.kill(); } catch (_) {} resolve(''); }, 8000);
    });
    drove = r === 'sent';
  } catch (_) {
    drove = false;
  }

  if (!drove) {
    console.log('  ....  could not drive Notepad from here, so the end-to-end read is untested.');
    console.log('  ....  The reader itself answered above; run this again on an interactive desktop.');
  } else {
    await new Promise((r) => setTimeout(r, 500));
    const fromNote = await context.getSelection();
    console.log('  ...   notepad read: source=' + fromNote.source + ' chars=' + fromNote.chars +
      '  ' + JSON.stringify(fromNote.text.slice(0, 70)));
    check('reads the selection out of a foreign application',
      fromNote.text === probeText,
      fromNote.text === probeText ? 'exact match' : 'got ' + JSON.stringify(fromNote.text.slice(0, 70)));
  }

  try { note.kill(); } catch (_) {}
  try { fs.unlinkSync(probeFile); } catch (_) {}

  /* ── the context bundle ──────────────────────────────────────────────── */
  const ctx = await context.getContext();
  check('getContext carries all four parts',
    !!(ctx.at && ctx.window && ctx.selection && ctx.clipboard), Object.keys(ctx).join(', '));

  /* ── dispose is safe to call, twice, from cold ───────────────────────── */
  await context.dispose();
  await context.dispose();
  check('dispose is safe twice', true);

  // And a read after dispose starts a fresh child rather than talking to a dead
  // one. `uia-unavailable` here means the replacement never started — which is
  // the race this asserts against: the killed child's `exit` lands after the new
  // one is spawned, and clearing the module's handle unconditionally on that
  // event orphans the child that is actually alive.
  const after = await context.getSelection();
  check('a read after dispose starts a fresh reader', after.source !== 'uia-unavailable',
    'source=' + after.source);
  await context.dispose();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
});
