// Bolo Doctor slice checks. Run with: npx electron tools/doctor-check.js
//
// What it proves: the modules load, the voice state machine starts idle, the
// structuring has the no-autocorrect safety contract, the local history
// round-trips (save/list/search/get), the print HTML and share text render,
// and the doctor window boots without renderer console errors.
//
// What it does not prove: a real microphone, live Sarvam/Groq keys, Hinglish
// transcription quality, a real printer, or WhatsApp on the doctor's machine.
// Those need a human with hardware.

const path = require('path');
const fs = require('fs');
const os = require('os');

// The history file goes to a temp dir for the duration of the suite, so the
// checks never touch the doctor's real patient data.
process.env.BOLO_DOCTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bolo-doctor-check-'));

const { app } = require('electron');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('ok - ' + name);
  else {
    failures++;
    console.log('FAIL - ' + name + (extra ? ' :: ' + String(extra).slice(0, 300) : ''));
  }
}

async function main() {
  await app.whenReady();

  // ── Modules load ──────────────────────────────────────────────────────
  let doctor, voice, keys, settings, sttSarvam;
  try {
    doctor = require('../src/main/doctor');
    voice = require('../src/main/voice');
    keys = require('../src/main/keys');
    settings = require('../src/main/settings');
    sttSarvam = require('../src/main/stt_sarvam');
    require('../src/main/groq');
    require('../src/main/stt');
    check('doctor slice modules load', true);
  } catch (e) {
    check('doctor slice modules load', false, e.message);
    return done();
  }

  // ── Voice state machine ───────────────────────────────────────────────
  check('voice starts idle', voice.getState().state === 'idle');

  // ── Dictation shortcut: one global chord, stored and rebindable ─────────
  const prevAccel = settings.voiceShortcut();
  check('dictation shortcut has a default',
    typeof prevAccel === 'string' && prevAccel.length > 0);
  settings.setVoiceShortcut('Control+Shift+Z');
  check('dictation shortcut round-trips through the settings store',
    settings.voiceShortcut() === 'Control+Shift+Z');
  settings.setVoiceShortcut(prevAccel);
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  check('main binds the dictation chord on globalShortcut',
    /globalShortcut\.register/.test(mainSrc));
  check('main exposes shortcut get/set IPC',
    /bolo:shortcut-get/.test(mainSrc) && /bolo:shortcut-set/.test(mainSrc));
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  check('preload bridges shortcutGet/shortcutSet',
    /shortcutGet/.test(preloadSrc) && /shortcutSet/.test(preloadSrc));
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'doctor.html'), 'utf8');
  check('settings view holds the keys and the shortcut editor',
    /view-settings/.test(htmlSrc) && /shortcutInput/.test(htmlSrc) && /sarvamKey/.test(htmlSrc));
  check('history and settings views have a back button',
    /historyBack/.test(htmlSrc) && /settingsBack/.test(htmlSrc));
  check('record view shows the shortcut on the main screen',
    /shortcutHint/.test(htmlSrc));

  // ── Structuring: the safety contract ──────────────────────────────────
  const sys = doctor.STRUCTURE_SYSTEM || '';
  check('structuring prompt forbids silent drug correction',
    /NEVER silently correct/i.test(sys));
  check('structuring prompt requires uncertainty flags',
    /uncertain.*true/i.test(sys));
  check('structuring prompt forbids inventing information',
    /Never invent information/i.test(sys));

  // ── validateNote: shape coercion ──────────────────────────────────────
  const good = doctor.validateNote({
    patient_name: 'Ramesh Gupta',
    age: '45',
    symptoms: 'fever 3 din se, throat pain',
    diagnosis: 'viral pharyngitis',
    prescription: [
      { medicine: 'paracetamol', dose: '650', timing: 'twice daily', duration: '3 days', uncertain: false, uncertain_reason: '' },
      { medicine: '', dose: '', timing: '', duration: '' }
    ]
  }, 'ignored');
  check('validateNote keeps the five fields',
    good.patient_name === 'Ramesh Gupta' && good.age === '45' &&
    good.diagnosis === 'viral pharyngitis');
  check('validateNote keeps prescription as a list of items',
    Array.isArray(good.prescription) && good.prescription.length === 1 &&
    good.prescription[0].medicine === 'paracetamol' &&
    good.prescription[0].dose === '650' &&
    good.prescription[0].timing === 'twice daily' &&
    good.prescription[0].duration === '3 days');
  check('validateNote drops fully-empty prescription rows',
    good.prescription.length === 1);

  // Drug names pass through untouched: no silent correction at this layer.
  const untouched = doctor.validateNote({
    prescription: [{ medicine: 'paracitamol', dose: '650', uncertain: false }]
  }, '');
  check('validateNote never rewrites a drug name',
    untouched.prescription[0].medicine === 'paracitamol');

  // An uncertain item keeps its flag and reason.
  const flagged = doctor.validateNote({
    prescription: [{ medicine: 'amlo de pine', dose: '5', uncertain: true, uncertain_reason: 'drug name unclear in audio' }]
  }, '');
  check('validateNote preserves uncertainty flags',
    flagged.prescription[0].uncertain === true &&
    /unclear/.test(flagged.prescription[0].uncertain_reason));

  // ── validateNote: fallback never loses the dictation ──────────────────
  const fallback = doctor.validateNote(null, 'Ramesh Gupta, 45, fever 3 din se');
  check('structuring fallback keeps the dictation in symptoms',
    fallback.symptoms === 'Ramesh Gupta, 45, fever 3 din se');
  const emptyFallback = doctor.validateNote({ patient_name: '' }, 'kuch sunai nahi diya');
  check('empty model output falls back to the raw dictation',
    emptyFallback.symptoms === 'kuch sunai nahi diya');

  // ── structureNote without keys: transcript survives ───────────────────
  if (keys.count('groq') === 0) {
    const r = await doctor.structureNote('Ramesh Gupta, 45, fever 3 din se');
    check('structureNote without keys returns ok:false with the transcript intact',
      r && r.ok === false && r.note && r.note.symptoms === 'Ramesh Gupta, 45, fever 3 din se');
  } else {
    console.log('skip - structureNote no-keys path (Groq keys present in this environment)');
  }

  // ── History: save / list / search / get ───────────────────────────────
  const noteA = {
    transcript: 't1', patient_name: 'Ramesh Gupta', age: '45',
    symptoms: 'fever', diagnosis: 'viral', prescription: [{ medicine: 'paracetamol', dose: '650', timing: 'twice daily', duration: '3 days' }]
  };
  const noteB = {
    transcript: 't2', patient_name: 'Sunita Devi', age: '62',
    symptoms: 'knee pain', diagnosis: 'arthritis', prescription: []
  };
  const sA = doctor.saveNoteToHistory(noteA);
  const sB = doctor.saveNoteToHistory(noteB);
  check('history save returns ok with an id', sA.ok && !!sA.id && sB.ok && !!sB.id && sA.id !== sB.id);
  const listed = doctor.listNotes();
  check('history list returns newest first',
    listed.length === 2 && listed[0].patient_name === 'Sunita Devi' && listed[1].patient_name === 'Ramesh Gupta');
  const found = doctor.searchNotes('ramesh');
  check('history search by name is case-insensitive',
    found.length === 1 && found[0].patient_name === 'Ramesh Gupta');
  check('history search with empty query lists everything',
    doctor.searchNotes('').length === 2);
  const got = doctor.getNote(sA.id);
  check('history get returns the saved note',
    got && got.patient_name === 'Ramesh Gupta' && got.prescription.length === 1 &&
    got.prescription[0].timing === 'twice daily');
  check('history get with unknown id returns null', doctor.getNote('nope') === null);
  // The file is one local JSON file.
  const raw = fs.readFileSync(doctor.historyFile(), 'utf8');
  check('history persists as one local JSON file', (() => {
    try { return Array.isArray(JSON.parse(raw)) && JSON.parse(raw).length === 2; }
    catch (_) { return false; }
  })());

  // ── Outputs ───────────────────────────────────────────────────────────
  const html = doctor.buildPrintHtml({ ...noteA, createdAt: '2026-09-26 17:00' });
  check('print HTML carries the prescription as a table',
    /<table>/.test(html) && /paracetamol/.test(html) && /twice daily/.test(html));
  const evil = doctor.buildPrintHtml({ ...noteA, patient_name: '<img src=x onerror=alert(1)>', createdAt: '' });
  check('print HTML escapes patient input', !/<img src=x/.test(evil) && /&lt;img/.test(evil));
  const flaggedHtml = doctor.buildPrintHtml({
    createdAt: '', prescription: [{ medicine: 'x', dose: '', timing: '', duration: '', uncertain: true, uncertain_reason: 'unclear in audio' }]
  });
  check('print HTML shows uncertainty flags', /needs check/.test(flaggedHtml));
  const share = doctor.shareText({ ...noteA, createdAt: '2026-09-26 17:00' });
  check('share text lists the prescription for WhatsApp',
    /paracetamol/.test(share) && /650/.test(share));
  const formatted = doctor.formatNote({ ...noteA, createdAt: '2026-09-26 17:00' });
  check('formatNote keeps the fixed labels',
    /Patient:/.test(formatted) && /Prescription:/.test(formatted));

  // ── The doctor window boots clean ─────────────────────────────────────
  const errors = [];
  const preloadPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const w = doctor.create(preloadPath, rendererDir);
  check('doctor window is created', !!w && doctor.isOpen());
  w.webContents.on('console-message', (_e, level, message) => {
    errors.push('[' + level + '] ' + message);
  });
  await new Promise((resolve) => {
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', resolve);
    else resolve();
    setTimeout(resolve, 10000);
  });
  await new Promise((r) => setTimeout(r, 2000)); // let the renderer settle
  check('doctor window boots with no renderer console messages', errors.length === 0, errors.join(' | '));
  try { w.destroy(); } catch (_) {}

  // ── Sarvam STT module is intact (Hinglish path) ────────────────────────
  check('sarvam module exposes transcribe', typeof sttSarvam.transcribe === 'function');

  done();
}

function done() {
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  // Let any stray handles settle, then exit with the real verdict.
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500);
}

main().catch((e) => {
  console.log('FAIL - uncaught in check suite :: ' + (e && e.stack || e));
  setTimeout(() => process.exit(1), 500);
});
