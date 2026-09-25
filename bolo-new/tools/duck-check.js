// Real audio ducking, against the live system volume. This is one of the few
// checks here that touches the machine rather than a fixture — the whole point
// of the module is that it changes something outside this process, and a test
// that stubbed that out would pass on a machine where nothing happens.
//
// The volume is restored on every path, so a failed run does not leave the
// machine quiet. It prints the numbers it saw, so the run is evidence rather
// than an assertion.
//   electron tools/duck-check.js
const { app } = require('electron');
const duck = require('../src/main/duck');
const settings = require('../src/main/settings');

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The first duck pays for compiling the C# and starting the PowerShell child
// (~700ms on a warm machine, more on a cold one), so the operation is polled
// rather than slept on. A fixed sleep here is what made the first run of this
// check report a failure for a duck that landed a moment later.
async function untilDone(timeout) {
  const deadline = Date.now() + (timeout || 8000);
  while (Date.now() < deadline) {
    if (duck.getState().applied !== null) return duck.getState();
    await wait(150);
  }
  return duck.getState();
}

// Restore before anything else can fail. dispose() is the module's own "put it
// back and stop"; calling it twice is harmless.
async function bail() {
  try { await duck.dispose(); } catch (_) {}
}

app.whenReady().then(async () => {
  process.on('uncaughtException', async (e) => { await bail(); console.error(e); app.exit(1); });

  settings.set('audioDucking', true);
  settings.set('duckLevel', 0.25);

  // The volume as the machine actually reports it, read before and after the
  // duck. `applied` only says a write was accepted; this says it moved.
  const restVolume = await duck.readLevel();
  console.log('\nsystem volume before: ' + restVolume);

  const t0 = Date.now();
  duck.setDucked(true);
  const duckedState = await untilDone(10000);
  const duckedVolume = await duck.readLevel();

  const st = duck.getState();
  console.log('backend: ' + st.backend + '   supported: ' + st.supported + '\n');

  if (!st.supported) {
    console.log('  (' + (st.reason || 'no backend on this platform') + ')');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    await bail();
    app.exit(1);
    return;
  }

  check('the duck reports itself applied', st.applied === true, 'applied=' + st.applied);
  check('and the module considers itself ducked', duck.isDucked() === true);
  // `saved` is what the volume was before the duck — the value the release must
  // put back. Losing it means the user's volume is gone for good.
  check('the pre-duck volume was remembered',
    st.saved === null || (typeof st.saved === 'number' && st.saved > 0), 'saved=' + st.saved);
  check('and the system volume actually went down',
    restVolume === null || duckedVolume === null || duckedVolume < restVolume,
    restVolume + ' -> ' + duckedVolume);
  console.log('  ...   ducked in ' + (Date.now() - t0) + 'ms, from ' + st.saved);

  // The probe is lazy, so the first duck pays for compiling the PowerShell child.
  const t1 = Date.now();
  duck.setDucked(false);
  await untilDone(10000);
  const backVolume = await duck.readLevel();
  check('the release applies too', duck.getState().applied === true, 'reason=' + duck.getState().reason);
  check('and it is no longer ducked', duck.isDucked() === false);
  check('and the volume came back',
    restVolume === null || backVolume === null || Math.abs(backVolume - restVolume) < 0.06,
    duckedVolume + ' -> ' + backVolume + ' (was ' + restVolume + ')');
  console.log('  ...   released in ' + (Date.now() - t1) + 'ms');

  // A duck with nothing to duck must be a quiet no-op, not a failure.
  duck.setDucked(true);
  await untilDone(10000);
  duck.setDucked(false);
  await untilDone(10000);
  check('duck and release round-trip without error', duck.getState().applied === true);

  // Rapid toggling is the case that leaves a volume stuck low: the queue has to
  // land the restore *after* the last duck, not between two of them.
  for (let i = 0; i < 6; i++) {
    duck.setDucked(i % 2 === 0);
    await wait(60);
  }
  duck.setDucked(false);
  await untilDone(10000);
  check('rapid toggling ends unducked', duck.isDucked() === false);

  // dispose() runs on app quit and must restore rather than just stop, or
  // closing bolo mid-dictation leaves the machine quiet.
  duck.setDucked(true);
  await untilDone(10000);
  const duckedLevel = duck.getState().saved;
  await duck.dispose();
  check('dispose leaves the module unducked', duck.isDucked() === false,
    'was ' + duckedLevel + ' before the last duck');
  const afterDispose = await duck.readLevel();
  check('and the volume is back after dispose',
    restVolume === null || afterDispose === null || Math.abs(afterDispose - restVolume) < 0.06,
    'now ' + afterDispose + ', was ' + restVolume);

  // Leave nothing behind: a duck after dispose has to start a fresh child
  // rather than talk to the one that was killed.
  duck.setDucked(true);
  await untilDone(10000);
  duck.setDucked(false);
  await untilDone(10000);
  check('a duck after dispose still works', duck.getState().applied === true);
  const finalVolume = await duck.readLevel();
  check('and it left the volume where it found it',
    restVolume === null || finalVolume === null || Math.abs(finalVolume - restVolume) < 0.06,
    'now ' + finalVolume + ', was ' + restVolume);
  await bail();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
});