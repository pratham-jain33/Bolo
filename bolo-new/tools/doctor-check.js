// Doctor Mode, end to end as far as automation can reach.
//
// What this proves on a real Windows machine:
//   - every doctor module loads in the real main process
//   - the vocabulary correction fixes what it should and never what it shouldn't
//   - the note template keeps its fixed shape
//   - a structuring failure can never lose the dictation (it all lands in Complaints)
//   - the PowerShell sidecar compiles (a C# syntax error fails 'ready' here)
//   - foreground/focus round-trip through the real sidecar
//   - injectInto never drops a reviewed note, even when the refocus fails
//   - the doctor window builds and its renderer boots without console errors
//
// What it cannot prove (needs a human): a microphone, Hindi/Hinglish speech,
// and the note landing in real clinic software. That half stays manual.
//
//   electron tools/doctor-check.js
const { app, BrowserWindow, clipboard } = require('electron');
const path = require('path');

app.on('window-all-closed', () => {});

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}

app.whenReady().then(async () => {
  const isWin = process.platform === 'win32';

  /* ── modules load ──────────────────────────────────────────────────── */
  let doctor, medvocab, sttSarvam, injector, keys;
  for (const [name, req] of [
    ['doctor', '../src/main/doctor'],
    ['medvocab', '../src/main/medvocab'],
    ['stt_sarvam', '../src/main/stt_sarvam'],
    ['injector', '../src/main/injector'],
    ['keys', '../src/main/keys']
  ]) {
    try {
      const m = require(req);
      if (name === 'doctor') doctor = m;
      if (name === 'medvocab') medvocab = m;
      if (name === 'stt_sarvam') sttSarvam = m;
      if (name === 'injector') injector = m;
      if (name === 'keys') keys = m;
      check('require ' + name, true);
    } catch (e) {
      check('require ' + name, false, e.message);
    }
  }
  if (!doctor || !medvocab || !injector) {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\ncannot continue without the doctor modules');
    app.exit(1);
    return;
  }

  /* ── vocabulary correction ─────────────────────────────────────────── */
  const vocabCases = [
    ['paracitamol 500 mg twice a day', 'paracetamol 500 mg twice a day'],
    ['amlo de pine 5 mg', 'amlodipine 5 mg'],
    ['patient has bukhar and be pee is high', 'patient has fever and BP is high'],
    ['metphormin for diabeetus', 'metformin for diabetes'],
    ['azithromycin 500 mg', 'azithromycin 500 mg'],
    ['cetrizine for cold', 'cetirizine for cold'],
    ['never give up', 'never give up'],
    ['the sugar is high', 'the sugar is high'],
    ['omeprazol daily', 'omeprazole daily'],
    ['bp 120/80', 'BP 120/80']
  ];
  let vocabFails = 0;
  for (const [input, expected] of vocabCases) {
    const got = medvocab.correct(input);
    if (got !== expected) {
      vocabFails++;
      console.log('  ....  vocab: ' + JSON.stringify(input) + ' -> ' + JSON.stringify(got) +
        ' (want ' + JSON.stringify(expected) + ')');
    }
    // Idempotent: correcting twice changes nothing further.
    if (medvocab.correct(got) !== got) {
      vocabFails++;
      console.log('  ....  vocab not idempotent on ' + JSON.stringify(got));
    }
  }
  check('vocabulary correction (' + vocabCases.length + ' cases, idempotent)', vocabFails === 0);
  check('vocabulary handles empty input', medvocab.correct('') === '' && medvocab.correct(null) === '');
  check('drug list is expandable and non-empty',
    Array.isArray(medvocab.drugList()) && medvocab.drugList().length >= 7,
    medvocab.drugList().join(','));

  /* ── template shape ────────────────────────────────────────────────── */
  const fields = doctor.TEMPLATE_FIELDS || [];
  check('template has the six fixed fields in order',
    JSON.stringify(fields) === JSON.stringify(['name', 'ageSex', 'complaints', 'vitals', 'diagnosis', 'prescription']),
    fields.join(','));
  const note = doctor.formatNote({ name: 'Ravi', complaints: 'bukhar' });
  const expectedNote = 'Name: Ravi\nAge/Sex: \nComplaints: bukhar\nVitals: \nDiagnosis: \nPrescription: ';
  check('formatted note keeps fixed labels and order', note === expectedNote,
    JSON.stringify(note.slice(0, 60)));

  /* ── structuring never loses the dictation ─────────────────────────── */
  // Without Groq keys the model call cannot run, so the fallback must carry
  // the whole (vocabulary-corrected) transcript into Complaints.
  if (keys.count('groq') === 0) {
    const r = await doctor.structureNote('patient ko paracitamol diya');
    check('structuring without keys falls back, nothing lost',
      r && r.ok === false && r.fields && r.fields.complaints === 'patient ko paracetamol diya',
      JSON.stringify(r && r.fields));
  } else {
    console.log('  ....  Groq keys present here — skipping the no-keys fallback check.');
  }
  const emptyR = await doctor.structureNote('   ');
  check('structuring empty text is a safe no-op',
    emptyR && emptyR.ok === false && emptyR.fields.complaints === '');

  /* ── injector: availability and protocol ───────────────────────────── */
  check('injector reports Windows availability', injector.available() === isWin);

  const fg = await injector.foregroundHwnd();
  if (isWin) {
    check('foreground window captured through the sidecar',
      fg.ok === true && /^\d+$/.test(fg.hwnd || ''), JSON.stringify(fg));
  } else {
    check('foregroundHwnd declines off Windows', fg.ok === false, fg.error);
  }

  const badFocus = await injector.focusHwnd('0');
  check('focus refuses a null window instead of crashing', badFocus.ok === false,
    badFocus.error);

  const emptyInject = await injector.injectInto('', null);
  check('an empty injectInto is refused', emptyInject.ok === false && emptyInject.error === 'empty-text');

  // The refocus fails (there is no window 0) — the note must still land on the
  // clipboard, never vanish.
  const PROBE = 'bolo doctor probe ' + Date.now();
  const into = await injector.injectInto(PROBE, '0');
  const onClipboard = (() => { try { return clipboard.readText() === PROBE; } catch (_) { return false; } })();
  check('injectInto survives a failed refocus via the clipboard',
    into && into.ok === true && into.focusError && (onClipboard || !isWin),
    JSON.stringify({ ok: into.ok, focusError: into.focusError, systemWide: into.systemWide }));

  /* ── the doctor window builds and its renderer boots ───────────────── */
  const preloadPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const rendererErrors = [];
  let win = null;
  try {
    doctor.create(preloadPath, rendererDir);
    win = doctor.getWindow();
    check('doctor window creates', !!win && !win.isDestroyed());
    if (win) {
      win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) rendererErrors.push(String(message).slice(0, 160));
      });
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        win.webContents.once('did-finish-load', () => setTimeout(finish, 1200));
        setTimeout(finish, 8000);
      });
      check('doctor renderer boots without console errors', rendererErrors.length === 0,
        rendererErrors.slice(0, 3).join(' | '));
      const title = await win.webContents.executeJavaScript('document.title');
      check('doctor page has the expected title', /doctor/i.test(title || ''), JSON.stringify(title));
      win.destroy();
    }
  } catch (e) {
    check('doctor window creates', false, e.message);
  }
  check('doctor window reports closed after destroy', doctor.isOpen() === false);

  /* ── dispose is safe, twice ────────────────────────────────────────── */
  await injector.dispose();
  await injector.dispose();
  check('injector dispose is safe twice', true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('  FAIL  check harness threw: ' + (e && e.message));
  app.exit(1);
});
