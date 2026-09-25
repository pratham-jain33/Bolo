// Bolo Doctor renderer — the boring, reliable dictation window.
//
// One mic button, one status line, one transcript box. Dictation toggles
// through main's voice pipeline with the doctor flag set, so the transcript
// comes back on `bolo:doctor-result` instead of being routed or injected.
// Phase 3 fills the #template mount with the patient-note fields.

const $ = (id) => document.getElementById(id);

const micBtn = $('micBtn');
const statusEl = $('status');
const transcriptEl = $('transcript');
const saveBtn = $('saveBtn');
const printBtn = $('printBtn');
const copyBtn = $('copyBtn');
const sarvamKey = $('sarvamKey');
const keyState = $('keyState');

let busy = false;
let structuring = false;

// The patient-note template, in paste order. complaints/vitals/prescription
// get textareas (multi-line), the rest single-line inputs.
const TEMPLATE = [
  { key: 'name', label: 'Name', multiline: false },
  { key: 'ageSex', label: 'Age/Sex', multiline: false },
  { key: 'complaints', label: 'Complaints', multiline: true },
  { key: 'vitals', label: 'Vitals', multiline: true },
  { key: 'diagnosis', label: 'Diagnosis', multiline: false },
  { key: 'prescription', label: 'Prescription', multiline: true }
];
const fieldEls = {};

function buildTemplate() {
  const mount = $('template');
  mount.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'label';
  title.textContent = 'Patient note (editable)';
  mount.appendChild(title);
  for (const f of TEMPLATE) {
    const lab = document.createElement('div');
    lab.className = 'tlabel';
    lab.textContent = f.label;
    const input = f.multiline ? document.createElement('textarea') : document.createElement('input');
    input.className = 'tfield' + (f.multiline ? ' tarea' : '');
    input.placeholder = '—';
    // Typing by hand also unlocks the three output buttons.
    input.addEventListener('input', refreshButtons);
    mount.appendChild(lab);
    mount.appendChild(input);
    fieldEls[f.key] = input;
  }
}

// The note shape: fixed labels, fixed order, every field present even when
// empty, so the saved file always looks the same.
function formattedNote() {
  return TEMPLATE.map((f) => {
    const el = fieldEls[f.key];
    return f.label + ': ' + (el ? el.value.trim() : '');
  }).join('\n');
}

// The three output buttons unlock on the note, not on the raw transcript:
// once any field has content, Copy/Save/Print are all live.
function noteHasContent() {
  return TEMPLATE.some((f) => fieldEls[f.key] && fieldEls[f.key].value.trim());
}

function refreshButtons() {
  const has = noteHasContent();
  copyBtn.disabled = !has;
  saveBtn.disabled = !has;
  printBtn.disabled = !has;
}

function clearTemplate() {
  for (const f of TEMPLATE) if (fieldEls[f.key]) fieldEls[f.key].value = '';
}

function setStatus(text, live) {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', !!live);
  micBtn.classList.toggle('live', !!live);
}

function setTranscript(text) {
  transcriptEl.value = text || '';
  const has = !!(text && text.trim());
  copyBtn.disabled = !has;
  // Save/Print unlock once the template has fields, not on the raw transcript.
  if (!has) { saveBtn.disabled = true; printBtn.disabled = true; }
}

async function structureIntoTemplate(text) {
  structuring = true;
  saveBtn.disabled = true;
  printBtn.disabled = true;
  setStatus('Organizing into the patient note…', false);
  try {
    const r = await bolo.doctorStructure(text);
    const fields = (r && r.fields) || {};
    for (const f of TEMPLATE) {
      if (fieldEls[f.key]) fieldEls[f.key].value = fields[f.key] || '';
    }
    refreshButtons();
    setStatus('Ready. Check the note, fix anything, then copy, save, or print.', false);
  } catch (e) {
    // The transcript box still holds the words; the note just did not split.
    setStatus('Ready. The note did not split into fields — copy from the transcript box.', false);
  } finally {
    structuring = false;
  }
}

async function toggle() {
  if (busy) return;
  busy = true;
  micBtn.disabled = true;
  try {
    const r = await bolo.doctorToggle();
    // The window learns the real state from bolo:voice-state below; this is
    // just immediate feedback for the tap.
    if (r && r.state === 'listening') setStatus('Listening… tap the mic to stop.', true);
  } catch (e) {
    setStatus('Could not start dictation.', false);
  } finally {
    busy = false;
    micBtn.disabled = false;
  }
}

micBtn.onclick = toggle;

copyBtn.onclick = async () => {
  const text = formattedNote();
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied.', false);
  } catch (_) {
    setStatus('Copy failed — select the note and copy it by hand.', false);
  }
};

saveBtn.onclick = async () => {
  if (!noteHasContent()) { setStatus('The note is empty — dictate first.', false); return; }
  saveBtn.disabled = true;
  setStatus('Saving…', false);
  try {
    const r = await bolo.doctorSave(currentFields());
    if (r && r.ok) setStatus('Saved: ' + r.filename, false);
    else setStatus('Save failed: ' + ((r && r.error) || 'unknown'), false);
  } catch (e) {
    setStatus('Save failed.', false);
  } finally {
    refreshButtons();
  }
};

printBtn.onclick = async () => {
  if (!noteHasContent()) { setStatus('The note is empty — dictate first.', false); return; }
  printBtn.disabled = true;
  setStatus('Opening the print dialog…', false);
  try {
    const r = await bolo.doctorPrint(currentFields());
    if (r && r.ok) setStatus('Sent to the printer.', false);
    else if (r && r.error === 'cancelled') setStatus('Print cancelled.', false);
    else setStatus('Print failed: ' + ((r && r.error) || 'unknown'), false);
  } catch (e) {
    setStatus('Print failed.', false);
  } finally {
    refreshButtons();
  }
};

// The note fields: fixed labels, fixed order — Copy/Save/Print all use these,
// so the reviewed values are what leave the window.
function currentFields() {
  const out = {};
  for (const f of TEMPLATE) out[f.key] = fieldEls[f.key] ? fieldEls[f.key].value.trim() : '';
  return out;
}

$('keySave').onclick = async () => {
  const k = sarvamKey.value.trim();
  if (!k) return;
  try {
    const r = await bolo.keysAdd(k, 'sarvam');
    if (r && r.ok) {
      sarvamKey.value = '';
      await refreshKeyState();
      setStatus('Sarvam key saved.', false);
    } else {
      setStatus('Could not save the key.', false);
    }
  } catch (e) {
    setStatus('Could not save the key.', false);
  }
};

async function refreshKeyState() {
  try {
    const r = await bolo.keysList();
    const info = r && r.providers && r.providers.sarvam;
    const n = info ? info.count : 0;
    keyState.textContent = n
      ? n + (n === 1 ? ' Sarvam key' : ' Sarvam keys') + ' saved — Hindi/Hinglish dictation is on.'
      : 'No Sarvam key saved — English dictation still works via Groq.';
  } catch (_) {}
}

// Voice state drives the mic button and the status line. The transcript itself
// arrives on bolo:doctor-result.
bolo.on('bolo:voice-state', (s) => {
  if (!s) return;
  if (s.state === 'listening') setStatus('Listening… tap the mic to stop.', true);
  else if (s.state === 'routing') setStatus('Writing down what you said…', false);
  else if (!transcriptEl.value) setStatus('Ready. Tap the mic or press Ctrl+Shift+D.', false);
});

bolo.on('bolo:doctor-result', (r) => {
  if (!r) return;
  if (r.text) {
    setTranscript(r.text);
    structureIntoTemplate(r.text);
  } else {
    setStatus(r.message || 'Heard nothing — try again, a little louder.', false);
  }
});

buildTemplate();
clearTemplate();
refreshKeyState();
