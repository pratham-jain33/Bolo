const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const groq = require('./groq');
const medvocab = require('./medvocab');

// The patient-note template fields, in the order they paste.
const TEMPLATE_FIELDS = ['name', 'ageSex', 'complaints', 'vitals', 'diagnosis', 'prescription'];

const FIELD_LABELS = {
  name: 'Name',
  ageSex: 'Age/Sex',
  complaints: 'Complaints',
  vitals: 'Vitals',
  diagnosis: 'Diagnosis',
  prescription: 'Prescription'
};

// The Doctor Mode window: deliberately boring. A plain framed window, a big
// microphone button, a transcript box, and the patient-note template. No
// aurora, no animated onboarding, no notch choreography — it launches
// directly (via --doctor or the tray) and its only job is dictation that
// becomes one clean patient note, ready to copy, save, or print.
//
// It is intentionally separate from the consumer onboarding path: intro.js and
// everything around it are untouched by this file.

let win = null;

function create(preloadPath, rendererDir) {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: 460,
    height: 660,
    minWidth: 400,
    minHeight: 560,
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

// Turn a raw dictation into the fixed patient-note template via the model.
// The transcript keeps its language (Hindi/Hinglish/English) — this only
// organizes it into fields. Never throws: on any failure the whole text
// lands in Complaints, still editable, so a structuring failure can never
// lose the dictation.
async function structureNote(transcript) {
  const rawText = String(transcript || '').trim();
  // The vocabulary correction runs before the model sees the words: STT
  // mangles drug names ("paracitamol", "amlo de pine") and the template must
  // carry the canonical spellings. Conservative by design — see medvocab.js.
  const text = medvocab.correct(rawText);
  const fallback = () => ({
    ok: false,
    fields: { name: '', ageSex: '', complaints: text, vitals: '', diagnosis: '', prescription: '' }
  });
  if (!text) return fallback();

  const prompt = 'You are formatting a doctor\'s dictated patient note. Extract the fields below from the dictation. Reply with ONLY a JSON object, no other text, with exactly these keys: "name", "ageSex", "complaints", "vitals", "diagnosis", "prescription".\n' +
    '\n' +
    'Rules:\n' +
    '- Keep the original language (Hindi, Hinglish, Kannada, or English). Do not translate.\n' +
    '- "complaints": symptoms and history the patient reported.\n' +
    '- "vitals": BP, pulse, temperature, SpO2, weight, etc.\n' +
    '- "diagnosis": the doctor\'s assessment.\n' +
    '- "prescription": medicines with dosage and instructions, one per line.\n' +
    '- Spell drug names canonically: ' + medvocab.drugList().join(', ') + '.\n' +
    '- Leave a field as "" when the dictation does not mention it. Do not invent information.\n' +
    '\n' +
    'Dictation:\n---\n' + text + '\n---';

  let raw = '';
  try {
    const r = await groq.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, maxTokens: 1024 }
    );
    if (!r.ok) return fallback();
    raw = r.text || '';
  } catch (_) {
    return fallback();
  }

  try {
    // Tolerate preamble: take the first {...} block.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return fallback();
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const fields = {};
    for (const k of TEMPLATE_FIELDS) {
      const v = parsed[k];
      fields[k] = typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
    }
    // If the model returned nothing usable, the dictation still survives.
    if (!TEMPLATE_FIELDS.some((k) => fields[k])) return fallback();
    return { ok: true, fields };
  } catch (_) {
    return fallback();
  }
}

// Render the fields as the pasted note: fixed labels, fixed order, every
// field present even when empty, so the clinic software always sees the same
// shape.
function formatNote(fields) {
  const f = fields || {};
  return TEMPLATE_FIELDS
    .map((k) => FIELD_LABELS[k] + ': ' + String(f[k] == null ? '' : f[k]).trim())
    .join('\n');
}

// Local date stamp for filenames and headers: 2026-09-25 21:35.
function stampOf(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// A filename the OS will accept: no reserved characters, no trailing dots,
// bounded length, readable.
function safeName(name) {
  const s = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '')
    .replace(/\.+$/g, '')
    .replace(/^\.+/g, '')
    .slice(0, 40);
  return s || 'Patient';
}

// Save the reviewed note as a dated text file, one per patient:
//   Documents/BoloNotes/BoloNote_2026-09-25_2135_RaviKumar.txt
// A .txt opens everywhere — Word, Notepad, phones — with zero dependencies and
// zero integrations, which is the whole point of this output target.
// `opts.dir` exists for tests; the app always uses the default.
function saveNote(fields, opts = {}) {
  const f = fields || {};
  const dir = opts.dir || path.join(app.getPath('documents'), 'BoloNotes');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = stampOf(new Date()).replace(' ', '_').replace(':', '');
  const filename = 'BoloNote_' + stamp + '_' + safeName(f.name) + '.txt';
  const filePath = path.join(dir, filename);
  const content = 'Patient Note — ' + stampOf(new Date()) + '\n\n' + formatNote(f) + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath, filename };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The printable note as standalone HTML. Pure function, so the automated
// check can verify the layout without opening a real print dialog.
function buildPrintHtml(fields, when) {
  const f = fields || {};
  const rows = TEMPLATE_FIELDS.map((k) => {
    const v = escapeHtml(f[k]).replace(/\n/g, '<br>');
    return '<div class="row"><div class="label">' + FIELD_LABELS[k] + '</div>' +
      '<div class="value">' + (v.trim() ? v : '&nbsp;') + '</div></div>';
  }).join('\n');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Patient Note</title>' +
    '<style>' +
    'body{font-family:Georgia,serif;color:#111;max-width:640px;margin:40px auto;padding:0 24px}' +
    'h1{font-size:22px;margin:0 0 4px}.when{color:#666;font-size:13px;margin-bottom:24px}' +
    '.row{margin:0 0 14px}.label{font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#444;margin-bottom:2px}' +
    '.value{font-size:16px;line-height:1.55;border-bottom:1px solid #ddd;padding-bottom:8px;min-height:20px}' +
    '</style></head><body>' +
    '<h1>Patient Note</h1><div class="when">' + escapeHtml(when || '') + '</div>' +
    rows + '</body></html>';
}

// Print the reviewed note through the system print dialog, from a hidden
// window carrying only the clean note — not the app UI. A cancelled dialog
// is 'cancelled', not a failure.
async function printNote(fields) {
  const html = buildPrintHtml(fields, stampOf(new Date()));
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

module.exports = { create, getWindow, isOpen, show, send, structureNote, formatNote, saveNote, printNote, buildPrintHtml, TEMPLATE_FIELDS, FIELD_LABELS };
