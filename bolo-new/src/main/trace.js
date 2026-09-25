const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// One place for the "why did nothing happen?" lines.
//
// Everything the first-run flow touches crosses a boundary that has no UI of its
// own: the native key hook, the shortcut registrar, the microphone inside a
// hidden window, the always-on-top capsule, the clipboard paste that types the
// words. When one of those quietly answers "no", the user sees a key that does
// nothing, and there is no way to tell which stage refused — which is exactly how
// a trial that could never run stayed unfindable for a whole session. Every one
// of those refusals goes through here, so a report is a log line rather than a
// guess.
//
// Deliberately tiny and it never throws. A logger that can break the thing it is
// logging is worse than no logger, so every call is wrapped and every failure is
// swallowed.
//
// Terminal AND file, because the two audiences differ: `npm run dev` shows the
// terminal, and someone launching from the desktop shortcut has only the file.

const MAX_BYTES = 256 * 1024;

let filePath = null;
let resolved = false;
let writeFailed = false;

function file() {
  if (resolved) return filePath;
  resolved = true;
  try {
    filePath = path.join(app.getPath('userData'), 'bolo-trace.log');
  } catch (_) {
    filePath = null;
  }
  return filePath;
}

// Called once at boot so a trace from an earlier run cannot grow without bound.
// Keeps the file when it is small; starts a fresh one when it is not.
function init() {
  const p = file();
  if (!p) return null;
  try {
    if (fs.existsSync(p) && fs.statSync(p).size > MAX_BYTES) fs.writeFileSync(p, '');
  } catch (_) { /* read-only or locked: the terminal still gets every line */ }
  return p;
}

function format(scope, message, detail) {
  const stamp = new Date().toISOString().slice(11, 23);
  const bits = [stamp, '[' + scope + ']', message];
  if (detail !== undefined && detail !== null && detail !== '') {
    bits.push(typeof detail === 'string' ? detail : safe(detail));
  }
  return bits.join(' ');
}

function safe(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function log(scope, message, detail) {
  const line = format(String(scope || 'bolo'), String(message == null ? '' : message), detail);
  try { console.log('[bolo trace] ' + line); } catch (_) {}
  if (writeFailed) return;
  const p = file();
  if (!p) return;
  try {
    fs.appendFileSync(p, line + '\n');
  } catch (_) {
    // One failure is enough; retrying every line would make a locked file a
    // performance problem as well as a silent one.
    writeFailed = true;
  }
}

module.exports = { init, log, file };
