const { BrowserWindow } = require('electron');
const path = require('path');
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
// lands in the clinic's software every time.
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
    '- Keep the original language (Hindi, Hinglish, or English). Do not translate.\n' +
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

module.exports = { create, getWindow, isOpen, show, send, structureNote, formatNote, TEMPLATE_FIELDS, FIELD_LABELS };
