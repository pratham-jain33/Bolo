'use strict';

// Audio ducking: lower what everything else is playing while the microphone is
// open, so music or a video cannot bleed into the transcript.
//
// This replaces a stub that set a boolean and did nothing with it. The boolean
// was the whole problem — the setting said "lower media volume while dictating",
// the switch turned on, and the volume never moved.
//
// There is no dependency-free *per-application* volume API on Windows, so this
// lowers the default output device — which is what the user hears and therefore
// what the microphone hears. Per-app control would need a native module
// (node-audio, or a WASAPI session enumerator); the seam for it is `backend`,
// and nothing above cares which one is in use.
//
// The three platforms, in the order they were chosen:
//   win32   — one persistent PowerShell child holding a compiled COM wrapper
//             around IAudioEndpointVolume. Persistent because Add-Type compiles
//             C# and costs ~700ms; a fresh process per duck would land the
//             volume change a second after the user stopped talking.
//   darwin  — `osascript`, which is fast enough to spawn per call.
//   linux   — `pactl`, best effort; without PulseAudio there is no backend and
//             the state says so rather than pretending.
//
// The volume is restored *only if nobody else has touched it*. If the user
// reached for the volume key while dictating, they meant it, and undoing that
// would be the app fighting the person using it.

const { spawn } = require('node:child_process');
const settings = require('./settings');

// How loud the ducked volume is, as a fraction of what it was.
const DEFAULT_DUCK = 0.25;
// Below this there is nothing worth ducking, and multiplying by 0.25 would
// round-trip to silence rather than to "quieter".
const MIN_GAP = 0.02;
const CALL_TIMEOUT_MS = 8000;

let ducked = false;
let saved = null;      // the volume before we lowered it, or null if nothing to restore
let backend = null;    // the resolved controller, or null when the platform has none
let probed = false;
let applied = null;    // did the last real operation land? null until it is tried
let reason = null;
let queue = Promise.resolve();

/* ---------------------------------------------------------------------------
   The PowerShell backend
   ------------------------------------------------------------------------ */

// The COM glue, exactly as verified against the live audio endpoint. The vtable
// order in IAudioEndpointVolume is load-bearing: three methods come before
// SetMasterVolumeLevel, and getting the count wrong does not fail to compile —
// it returns "Value does not fall within the expected range" from a getter that
// looks correct.
const PS_SOURCE = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h();
  int SetMasterVolumeLevel(float f, Guid g);
  int SetMasterVolumeLevelScalar(float f, Guid g);
  int GetMasterVolumeLevel(out float f);
  int GetMasterVolumeLevelScalar(out float f);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice ep); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class Vol {
  static IAudioEndpointVolume Endpoint() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float Read() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Write(float v) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  try {
    if ($p[0] -eq 'read') {
      [Console]::Out.WriteLine('ok ' + [Vol]::Read().ToString([Globalization.CultureInfo]::InvariantCulture))
    } elseif ($p[0] -eq 'write') {
      [Vol]::Write([float]::Parse($p[1], [Globalization.CultureInfo]::InvariantCulture))
      [Console]::Out.WriteLine('ok')
    } elseif ($p[0] -eq 'quit') { break }
  } catch {
    [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  }
}
`;

// -EncodedCommand takes base64 of UTF-16LE, which sidesteps every quoting and
// line-ending question a script this size would otherwise raise.
function encodedCommand(src) {
  return Buffer.from(src, 'utf16le').toString('base64');
}

function psArgs() {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(PS_SOURCE)];
}

let child = null;
let childReady = null;

function startPs() {
  if (child) return childReady;
  childReady = new Promise((resolve) => {
    let out = '';
    let settled = false;
    let proc;
    try {
      proc = spawn('powershell.exe', psArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      child = null;
      resolve(null);
      return;
    }
    child = proc;
    // Both handlers check that this process is still the current one before
    // clearing it. dispose() kills the child, and its `exit` lands a moment
    // later — by which time a replacement may already be running, and clearing
    // the field unconditionally would orphan the new child and leave every
    // later duck reporting "no powershell" against one that is alive.
    proc.on('error', () => {
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

// One line in, one line out. The reply is matched to the request by ordering,
// which is safe because every caller goes through the same serial queue below.
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
        if (out.startsWith('ok')) {
          const parts = out.split(' ');
          finish({ ok: true, value: parts.length > 1 ? Number(parts[1]) : null });
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

function psBackend() {
  return {
    name: 'powershell:IAudioEndpointVolume',
    read: async () => {
      const r = await psCall('read');
      return r.ok && Number.isFinite(r.value) ? r.value : null;
    },
    write: async (v) => {
      const r = await psCall('write ' + Number(v).toFixed(4));
      return !!r.ok;
    }
  };
}

/* ---------------------------------------------------------------------------
   The other two platforms
   ------------------------------------------------------------------------ */

function exec(cmd, args, timeout) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      resolve({ ok: false, error: 'spawn-failed' });
      return;
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} resolve({ ok: false, error: 'timeout' }); }, timeout || CALL_TIMEOUT_MS);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('error', () => { clearTimeout(timer); resolve({ ok: false, error: 'spawn-failed' }); });
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
  });
}

function macBackend() {
  return {
    name: 'osascript',
    read: async () => {
      const r = await exec('osascript', ['-e', 'output volume of (get volume settings)']);
      const n = Number(r.out);
      return r.ok && Number.isFinite(n) ? n / 100 : null;
    },
    write: async (v) => {
      const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
      const r = await exec('osascript', ['-e', 'set volume output volume ' + pct]);
      return !!r.ok;
    }
  };
}

function linuxBackend() {
  // pactl reports "[ 45%]" among other fields; the first percentage is the
  // overall sink volume rather than a per-channel one.
  const readLevel = async () => {
    const r = await exec('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    if (!r.ok) return null;
    const m = r.out.match(/(\d+)%/);
    return m ? Number(m[1]) / 100 : null;
  };
  return {
    name: 'pactl',
    read: readLevel,
    write: async (v) => {
      const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
      const r = await exec('pactl', ['set-sink-volume', '@DEFAULT_SINK@', pct + '%']);
      if (!r.ok) return false;
      // pactl accepts what it cannot do and says nothing, so the write is only
      // reported as landed when a re-read agrees with it.
      const back = await readLevel();
      return back !== null && Math.abs(back - v) < 0.05;
    }
  };
}

/* ---------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------ */

function duckTo() {
  const v = Number(settings.get('duckLevel'));
  return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_DUCK;
}

async function probe() {
  if (probed) return backend;
  probed = true;
  reason = null;
  if (process.platform === 'win32') backend = psBackend();
  else if (process.platform === 'darwin') backend = macBackend();
  else backend = linuxBackend();

  // A backend is only real if it can actually read the volume right now. The
  // check is the first duck's own read, done here so `supported` is never a
  // guess about the platform — it is a fact about this machine.
  const cur = await backend.read();
  if (cur === null) {
    reason = process.platform === 'linux'
      ? 'Could not read the system volume — PulseAudio (pactl) is not answering.'
      : 'Could not read the system volume on this machine.';
    backend = null;
    return null;
  }
  return backend;
}

async function apply() {
  if (!(await probe())) { applied = false; return; }
  const cur = await backend.read();
  if (cur === null) { applied = false; reason = 'Could not read the system volume.'; return; }

  if (cur <= MIN_GAP) {
    // Already quiet: nothing to lower, and nothing to restore afterwards. This
    // is the common case for anyone dictating in a quiet room.
    saved = null;
    applied = true;
    reason = 'The volume was already low.';
    return;
  }

  saved = cur;
  const target = Math.max(MIN_GAP, cur * duckTo());
  const ok = await backend.write(target);
  applied = !!ok;
  reason = ok ? null : 'The volume change was refused.';
  if (!ok) saved = null;
}

async function release() {
  if (saved === null) { applied = true; return; }
  const want = saved;
  saved = null;
  if (!backend) { applied = false; return; }

  const cur = await backend.read();
  if (cur !== null && Math.abs(cur - want * duckTo()) > 0.06 && Math.abs(cur - want) > 0.06) {
    // Somebody moved the volume while the microphone was open. Restoring the old
    // value would undo a deliberate act, so the value in place is left alone.
    applied = true;
    reason = 'The volume was changed by hand while dictating, so it was left as it is.';
    return;
  }
  const ok = await backend.write(want);
  applied = !!ok;
  reason = ok ? null : 'Could not restore the volume.';
}

function setDucked(on) {
  const want = !!on;
  if (want === ducked) return { ducked };
  ducked = want;
  // The last operation's outcome no longer describes anything once a new one is
  // in flight, so it goes back to "not yet known" rather than leaving the
  // previous answer standing while this one is still running.
  applied = null;
  // Serialised: a rapid stop/start must not land a restore after the next duck,
  // which would leave the volume lowered with nothing left to restore it.
  queue = queue.then(() => (want ? apply() : release())).catch(() => {});
  return { ducked };
}

function isDucked() {
  return ducked;
}

// The system volume right now, 0..1, or null when this machine has no backend.
// Exposed because it is the only way to prove a duck actually moved something —
// `applied` says the write was accepted, and a backend can accept a write it did
// not perform (pactl does exactly that). It is also what a Settings test button
// would show the user.
async function readLevel() {
  if (!(await probe())) return null;
  return await backend.read();
}

function getState() {
  return {
    ducked,
    supported: !!backend,
    backend: backend ? backend.name : null,
    applied,
    level: duckTo(),
    saved,
    reason
  };
}

// Called on quit. The ducked volume is restored first — leaving the machine
// quiet after the app exits would be the worst possible failure mode — and the
// compiled PowerShell child is then released rather than left running.
async function dispose() {
  if (ducked || saved !== null) {
    ducked = false;
    await release().catch(() => {});
  }
  if (child) {
    try { child.stdin.write('quit\n'); } catch (_) {}
    try { child.kill(); } catch (_) {}
    child = null;
    childReady = null;
  }
}

module.exports = { setDucked, isDucked, readLevel, getState, dispose, _internals: { psArgs, PS_SOURCE, DEFAULT_DUCK } };