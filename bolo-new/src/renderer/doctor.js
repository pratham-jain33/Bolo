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
const pasteBtn = $('pasteBtn');
const copyBtn = $('copyBtn');
const sarvamKey = $('sarvamKey');
const keyState = $('keyState');

let busy = false;

function setStatus(text, live) {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', !!live);
  micBtn.classList.toggle('live', !!live);
}

function setTranscript(text) {
  transcriptEl.value = text || '';
  const has = !!(text && text.trim());
  pasteBtn.disabled = !has;
  copyBtn.disabled = !has;
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

pasteBtn.onclick = async () => {
  const text = transcriptEl.value.trim();
  if (!text) return;
  pasteBtn.disabled = true;
  setStatus('Pasting…', false);
  try {
    const r = await bolo.doctorPaste(text);
    if (r && r.ok) {
      setStatus(r.systemWide === false
        ? 'On your clipboard — press Ctrl+V in your clinic software.'
        : 'Pasted.', false);
    } else {
      setStatus('Paste failed: ' + ((r && r.error) || 'unknown'), false);
    }
  } catch (e) {
    setStatus('Paste failed.', false);
  } finally {
    pasteBtn.disabled = false;
  }
};

copyBtn.onclick = async () => {
  const text = transcriptEl.value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch (_) {}
  setStatus('Copied to clipboard.', false);
};

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
    setStatus('Ready. Review it, then paste.', false);
  } else {
    setStatus('Heard nothing — try again, a little louder.', false);
  }
});

refreshKeyState();
