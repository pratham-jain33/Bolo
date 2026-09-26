// Trial-mode checks. Run with: npx electron tools/trial-check.js
// Only meaningful in a trial build (trial-config.json baked in); the
// build-trial workflow runs this after baking the keys and config.
//
// What it proves: trial mode is on, the machine ID is stable, the cap and
// exhaustion logic work, and usage accumulates.
// What it does not prove: a real doctor's computer (the Windows runner is a
// throwaway VM) or that the cap survives a hostile user deleting files.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond || !extra ? '' : ' :: ' + extra));
  if (!cond) failures++;
}

async function main() {
  // Point usage bookkeeping at a temp dir so the check never touches real state.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bolo-trial-check-'));
  const origGetPath = app.getPath.bind(app);
  app.getPath = (n) => (n === 'userData' ? tmp : origGetPath(n));

  const trial = require('../src/main/trial');

  check('trial mode is on in this build', trial.isTrial() === true);
  const id1 = trial.machineId();
  const id2 = trial.machineId();
  check('machine id is stable and non-empty', !!id1 && id1 === id2, String(id1));

  const expectedCap = trial.capMs();
  const s0 = trial.status();
  check('status reports the trial cap',
    s0.trial === true && s0.capMs === expectedCap && s0.usedMs === 0 &&
    s0.remainingMs === expectedCap && s0.exhausted === false,
    JSON.stringify(s0));
  check('a fresh trial can start dictation', trial.canStart() === true);

  trial.addUsage(60 * 1000);
  const s1 = trial.status();
  check('one minute of dictation accumulates',
    s1.usedMs === 60 * 1000 && s1.remainingMs === expectedCap - 60 * 1000 && trial.canStart(),
    JSON.stringify(s1));

  trial.addUsage(expectedCap);
  const s2 = trial.status();
  check('the cap exhausts and blocks new dictations',
    s2.exhausted === true && s2.remainingMs === 0 && !trial.canStart(),
    JSON.stringify(s2));

  trial.addUsage(-5000);
  check('negative usage is ignored', trial.status().usedMs === expectedCap + 60 * 1000);

  console.log(failures === 0 ? 'ALL TRIAL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500);
}

main().catch((e) => {
  console.log('FAIL - uncaught in trial check suite :: ' + (e && e.stack || e));
  setTimeout(() => process.exit(1), 500);
});
