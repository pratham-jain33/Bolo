// Bolo Doctor main process: the window, the structuring, the local patient
// history, and the print/share outputs.
//
// The safety contract (non-negotiable): drug names and dosages are NEVER
// silently autocorrected. If the transcription is uncertain, the note carries
// an explicit flag for the doctor to check in review. Nothing saves or prints
// before the doctor approves.

const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const groq = require('./groq');

// ── Window ────────────────────────────────────────────────────────────────

let win = null;

function create(preloadPath, rendererDir) {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 440,
    minHeight: 600,
    show: false,
    title: 'Bolo Doctor',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(rendererDir, 'doctor.html'));
  win.on('closed', () => { win = null; });
  return win;
}

function getWindow() {
  return win && !win.isDestroyed() ? win : null;
}

function isOpen() {
  return !!getWindow();
}

function show() {
  const w = getWindow();
  if (!w) return false;
  if (!w.isVisible()) w.show();
  w.focus();
  return true;
}

function send(channel, payload) {
  const w = getWindow();
  if (!w) return;
  try { w.webContents.send(channel, payload); } catch (_) {}
}

// ── Structuring ───────────────────────────────────────────────────────────

const NOTE_FIELDS = ['patient_name', 'age', 'symptoms', 'diagnosis', 'prescription'];

// The structuring prompt. The safety rules at the top are the whole point:
// a guessed drug name in a prescription is a patient-safety failure, so the
// model flags doubt instead of fixing it.
const STRUCTURE_SYSTEM = [
  'You structure a doctor\'s dictated patient note. The dictation is in Hinglish',
  '(Hindi-English mix as spoken in India) and may include medical terms.',
  'Output ONLY a JSON object, no other text.',
  '',
  'SAFETY RULES (non-negotiable):',
  '- NEVER silently correct, normalize, or "fix" a drug name, dose, timing, or duration.',
  '  If the transcript says "paracitamol", keep "paracitamol" exactly as written.',
  '- If a drug name, dose, timing, or duration is unclear, ambiguous, or you are',
  '  not fully certain, keep it EXACTLY as transcribed and set "uncertain": true',
  '  with a short "uncertain_reason", e.g. "drug name unclear in audio".',
  '- Never invent information. A field you did not hear is "" (empty string);',
  '  the prescription list is [] when no medicine was mentioned.',
  '',
  'JSON shape:',
  '{',
  '  "patient_name": "",',
  '  "age": "",',
  '  "symptoms": "",',
  '  "diagnosis": "",',
  '  "prescription": [',
  '    {"medicine": "", "dose": "", "timing": "", "duration": "",',
  '     "uncertain": false, "uncertain_reason": ""}',
  '  ]',
  '}',
  '',
  'Field rules:',
  'OUTPUT LANGUAGE — English, Latin script only. Indian doctors write their notes',
  'in English, so the finished note must read like one.',
  '- Transliterate and translate the Hinglish naturally: "3 din se bukhar hai"',
  '  becomes "Fever for 3 days"; "raat ko sone se pehle" becomes "at bedtime".',
  '- Medicine names, doses, timings, and durations are NOT translated or',
  '  normalized — they stay EXACTLY as transcribed, per the safety rules above.',
  '- "symptoms": what the patient reported, and any history mentioned.',
  '- "diagnosis": the doctor\'s assessment.',
  '- "prescription": one object per medicine mentioned. Split dose ("650 mg"),',
  '  timing ("twice daily after food"), and duration ("3 days") when stated.',
  '  Keep each part exactly as dictated; never add units that were not said.',
  '- "age": as said ("45", "45 years").'
].join('\n');

function blankNote() {
  return { patient_name: '', age: '', symptoms: '', diagnosis: '', prescription: [] };
}

function str(v) {
  return String(v == null ? '' : v).trim();
}

function coerceItem(it) {
  const o = (it && typeof it === 'object') ? it : {};
  return {
    medicine: str(o.medicine),
    dose: str(o.dose),
    timing: str(o.timing),
    duration: str(o.duration),
    uncertain: o.uncertain === true,
    uncertain_reason: str(o.uncertain_reason)
  };
}

// Pure: coerce a parsed structuring result into the note shape. Never throws.
// If nothing usable came back, the dictation survives whole in symptoms —
// a structuring failure can never lose the doctor's words.
function validateNote(parsed, transcript) {
  const note = blankNote();
  if (parsed && typeof parsed === 'object') {
    note.patient_name = str(parsed.patient_name);
    note.age = str(parsed.age);
    note.symptoms = str(parsed.symptoms);
    note.diagnosis = str(parsed.diagnosis);
    if (Array.isArray(parsed.prescription)) {
      note.prescription = parsed.prescription
        .map(coerceItem)
        .filter((it) => it.medicine || it.dose || it.timing || it.duration);
    }
  }
  const hasAny = note.patient_name || note.age || note.symptoms ||
    note.diagnosis || note.prescription.length > 0;
  if (!hasAny) note.symptoms = str(transcript);
  return note;
}

// Transcript -> structured note via the model. Never throws: on any failure
// the note falls back to the raw dictation in symptoms, still editable.
async function structureNote(transcript) {
  const text = str(transcript);
  if (!text) return { ok: false, note: blankNote(), error: 'empty-transcript' };
  let raw = '';
  try {
    const r = await groq.chat(
      [
        { role: 'system', content: STRUCTURE_SYSTEM },
        { role: 'user', content: 'Dictation:\n---\n' + text + '\n---' }
      ],
      { temperature: 0.1, maxTokens: 1024 }
    );
    if (!r.ok) return { ok: false, note: validateNote(null, text), error: r.error };
    raw = r.text || '';
  } catch (e) {
    return { ok: false, note: validateNote(null, text), error: String((e && e.message) || e) };
  }
  try {
    // Tolerate preamble: take the first {...} block.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { ok: false, note: validateNote(null, text), error: 'no-json' };
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return { ok: true, note: validateNote(parsed, text) };
  } catch (_) {
    return { ok: false, note: validateNote(null, text), error: 'bad-json' };
  }
}

// ── Patient history: one local JSON file, minimal stored ──────────────────

function historyFile() {
  if (process.env.BOLO_DOCTOR_DATA_DIR) {
    return path.join(process.env.BOLO_DOCTOR_DATA_DIR, 'patients.json');
  }
  return path.join(app.getPath('documents'), 'BoloDoctor', 'patients.json');
}

function readHistory() {
  try {
    const p = historyFile();
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeHistory(arr) {
  const p = historyFile();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
}

// Newest first.
function listNotes() {
  return readHistory().slice().reverse();
}

// Search by patient name, case-insensitive. Empty query lists everything.
function searchNotes(q) {
  const needle = str(q).toLowerCase();
  const all = listNotes();
  if (!needle) return all;
  return all.filter((n) => str(n.patient_name).toLowerCase().includes(needle));
}

function getNote(id) {
  return readHistory().find((n) => n && n.id === id) || null;
}

// Save an APPROVED note. The renderer only calls this after the doctor taps
// approve; there is no other path that writes to the history.
function saveNoteToHistory(note) {
  const n = (note && typeof note === 'object') ? note : {};
  const entry = {
    id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    createdAt: stampOf(new Date()),
    patient_name: str(n.patient_name),
    age: str(n.age),
    symptoms: str(n.symptoms),
    diagnosis: str(n.diagnosis),
    prescription: Array.isArray(n.prescription) ? n.prescription.map(coerceItem) : [],
    transcript: str(n.transcript)
  };
  const arr = readHistory();
  arr.push(entry);
  writeHistory(arr);
  return { ok: true, id: entry.id };
}

function stampOf(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ── Outputs ───────────────────────────────────────────────────────────────

// The approved note as plain text: copy, and the base of print/share.
function formatNote(note) {
  const n = note || {};
  const lines = [
    'Patient: ' + str(n.patient_name),
    'Age: ' + str(n.age),
    'Date: ' + str(n.createdAt),
    '',
    'Symptoms: ' + str(n.symptoms),
    'Diagnosis: ' + str(n.diagnosis),
    '',
    'Prescription:'
  ];
  (n.prescription || []).forEach((it, i) => {
    const parts = [it.medicine, it.dose, it.timing, it.duration].filter(Boolean).join('  ');
    lines.push((i + 1) + '. ' + parts +
      (it.uncertain ? '  [needs check: ' + (it.uncertain_reason || 'uncertain') + ']' : ''));
  });
  return lines.join('\n');
}

// The prescription as WhatsApp-friendly text (bold/italic markup).
function shareText(note) {
  const n = note || {};
  const lines = [
    '*' + (str(n.patient_name) || 'Patient') + '*',
    '_' + str(n.createdAt) + '_',
    '',
    '*Prescription*'
  ];
  (n.prescription || []).forEach((it, i) => {
    const parts = [it.medicine, it.dose, it.timing, it.duration].filter(Boolean).join(' ');
    lines.push((i + 1) + '. ' + parts);
  });
  if (str(n.diagnosis)) lines.push('', 'Diagnosis: ' + str(n.diagnosis));
  return lines.join('\n');
}

function escapeHtml(s) {
  return str(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The printable note as standalone HTML. Pure function, so the automated
// check can verify the layout without opening a real print dialog.
function buildPrintHtml(note) {
  const n = note || {};
  const rxRows = (n.prescription || []).map((it, i) => {
    const cells = [it.medicine, it.dose, it.timing, it.duration].map((v) =>
      '<td>' + (escapeHtml(v) || '&nbsp;') + '</td>').join('');
    const flag = it.uncertain
      ? '<div class="flag">needs check: ' + escapeHtml(it.uncertain_reason || 'uncertain') + '</div>'
      : '';
    return '<tr><td>' + (i + 1) + '</td>' + cells + '</tr>' +
      (flag ? '<tr><td></td><td colspan="4">' + flag + '</td></tr>' : '');
  }).join('\n');
  const field = (label, value) =>
    '<div class="row"><div class="label">' + label + '</div>' +
    '<div class="value">' + (escapeHtml(value).replace(/\n/g, '<br>') || '&nbsp;') + '</div></div>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Patient Note</title>' +
    '<style>' +
    'body{font-family:Georgia,serif;color:#111;max-width:640px;margin:40px auto;padding:0 24px}' +
    'h1{font-size:22px;margin:0 0 4px}.when{color:#666;font-size:13px;margin-bottom:24px}' +
    '.row{margin:0 0 14px}.label{font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#444;margin-bottom:2px}' +
    '.value{font-size:16px;line-height:1.55;border-bottom:1px solid #ddd;padding-bottom:8px;min-height:20px}' +
    'table{width:100%;border-collapse:collapse;margin:8px 0 14px}' +
    'th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#444;text-align:left;border-bottom:2px solid #444;padding:6px 8px}' +
    'td{font-size:15px;border-bottom:1px solid #ddd;padding:6px 8px;vertical-align:top}' +
    '.flag{color:#92400e;font-size:13px}' +
    '</style></head><body>' +
    '<h1>Patient Note</h1><div class="when">' + escapeHtml(n.createdAt || '') + '</div>' +
    field('Patient', n.patient_name) +
    field('Age', n.age) +
    field('Symptoms', n.symptoms) +
    field('Diagnosis', n.diagnosis) +
    '<div class="row"><div class="label">Prescription</div>' +
    '<table><tr><th>#</th><th>Medicine</th><th>Dose</th><th>Timing</th><th>Duration</th></tr>' +
    rxRows + '</table></div>' +
    '</body></html>';
}

// Print the approved note through the system print dialog, from a hidden
// window carrying only the clean note — not the app UI. A cancelled dialog
// is 'cancelled', not a failure.
async function printNote(note) {
  const html = buildPrintHtml(note);
  const w = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await w.webContents.print({ silent: false, printBackground: true });
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: /cancel/i.test(msg) ? 'cancelled' : msg };
  } finally {
    try { w.destroy(); } catch (_) {}
  }
}

module.exports = {
  create, getWindow, isOpen, show, send,
  structureNote, validateNote, blankNote, coerceItem, STRUCTURE_SYSTEM, NOTE_FIELDS,
  listNotes, searchNotes, getNote, saveNoteToHistory, historyFile,
  formatNote, shareText, buildPrintHtml, printNote, stampOf
};
