// Bolo Doctor renderer — the one screen.
//
// Views: record -> review (mandatory) -> done; plus history, detail, settings.
// Nothing is saved or printed until the doctor approves in review.

const $ = (id) => document.getElementById(id);

const VIEWS = ['record', 'review', 'done', 'history', 'detail', 'settings'];

// Where the header back button (top-left) goes from each view.
const BACK_OF = {
  review: 'record',
  done: 'record',
  history: 'record',
  detail: 'history',
  settings: 'record'
};

function showView(name) {
  for (const v of VIEWS) $('view-' + v).classList.toggle('active', v === name);
  const back = $('backBtn');
  const target = BACK_OF[name] || null;
  back.hidden = !target;
  back.dataset.target = target || '';
}

$('backBtn').onclick = () => {
  const t = $('backBtn').dataset.target;
  if (!t) return;
  if (t === 'history') loadHistory($('historySearch').value);
  showView(t);
};

// The note being worked on: { transcript, patient_name, age, symptoms,
// diagnosis, prescription: [{medicine, dose, timing, duration, uncertain, uncertain_reason}] }
let current = null;
// The last approved + saved note.
let approved = null;

let busy = false;

function setStatus(text, live) {
  $('status').textContent = text;
  $('status').classList.toggle('live', !!live);
  $('micBtn').classList.toggle('live', !!live);
  // The mic button keeps its icon; only the label text changes.
  const label = $('micLabel');
  const html = live ? 'Tap to<br>stop' : 'Tap to<br>dictate';
  if (label) label.innerHTML = html;
  else $('micBtn').innerHTML = html;
}

// ── Recording ────────────────────────────────────────────────────────────

async function toggle() {
  if (busy) return;
  busy = true;
  $('micBtn').disabled = true;
  try {
    const r = await bolo.doctorToggle();
    if (r && r.state === 'listening') setStatus('Listening… tap the mic to stop.', true);
    else if (r && r.error) setStatus('Could not start: ' + r.error, false);
  } catch (e) {
    setStatus('Could not start dictation.', false);
  } finally {
    busy = false;
    $('micBtn').disabled = false;
  }
}

$('micBtn').onclick = toggle;

bolo.on('bolo:voice-state', (s) => {
  if (!s) return;
  if (s.state === 'listening') {
    setStatus('Listening… tap the mic to stop.', true);
  } else {
    if (s.state === 'routing') setStatus('Writing down what you said…', false);
    else if (current === null) setStatus('Ready. Tap the mic after the patient leaves.', false);
  }
});

// ── Demo mode: a canned dictation that plays with a typing animation ────
// and fills a sample note. Makes ZERO API calls (no Sarvam, no Groq), needs
// no mic and no keys — it bypasses voice entirely and goes straight to the
// mandatory review screen.
const DEMO_TRANSCRIPT = 'Patient ka naam Ramesh Gupta, age 52 saal. Teen din se bukhar hai, gala dard aur halki khansi. Koi allergy nahi hai. Diagnosis viral fever. Dolo 650, ek goli subah shaam khane ke baad, teen din tak. Azithral 500, ek goli roz, teen din tak.';
const DEMO_NOTE = {
  patient_name: 'Ramesh Gupta',
  age: '52',
  symptoms: 'Fever for 3 days, sore throat, mild cough. No known allergies.',
  diagnosis: 'Viral fever',
  prescription: [
    { medicine: 'Dolo 650', dose: '1 tablet', timing: 'twice daily after food', duration: '3 days' },
    { medicine: 'Azithral 500', dose: '1 tablet', timing: 'once daily', duration: '3 days' }
  ]
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function typeInto(el, text, perCharMs) {
  return new Promise((resolve) => {
    el.value = '';
    let i = 0;
    const tick = () => {
      i++;
      el.value = text.slice(0, i);
      if (i < text.length) setTimeout(tick, perCharMs);
      else resolve();
    };
    tick();
  });
}

let demoRunning = false;
$('demoBtn').onclick = async () => {
  if (demoRunning || busy) return;
  demoRunning = true;
  $('demoBtn').disabled = true;
  $('micBtn').disabled = true;
  try {
    showView('record');
    $('transcript').value = '';
    setStatus('Demo — no keys needed, no mic needed.', true);
    await typeInto($('transcript'), DEMO_TRANSCRIPT, 16);
    current = { transcript: DEMO_TRANSCRIPT, ...DEMO_NOTE };
    fillReview({ patient_name: '', age: '', symptoms: '', diagnosis: '', prescription: [] });
    $('rxList').innerHTML = '';
    showView('review');
    setStatus('Demo note — review every field, then approve it like a real one.', false);
    await typeInto($('fName'), DEMO_NOTE.patient_name, 40);
    await typeInto($('fAge'), DEMO_NOTE.age, 60);
    await typeInto($('fSymptoms'), DEMO_NOTE.symptoms, 14);
    await typeInto($('fDiagnosis'), DEMO_NOTE.diagnosis, 40);
    for (const it of DEMO_NOTE.prescription) {
      const row = addRxRow({}, $('rxList').children.length);
      await sleep(300);
      const inputs = row.querySelectorAll('input[data-key]');
      const vals = [it.medicine, it.dose, it.timing, it.duration];
      for (let i = 0; i < inputs.length; i++) {
        await typeInto(inputs[i], vals[i] || '', 28);
      }
    }
  } finally {
    demoRunning = false;
    $('demoBtn').disabled = false;
    $('micBtn').disabled = false;
  }
};

// Transcription failures say exactly what went wrong — a generic "failed"
// message is what turns a bad key into an hour of guessing.
function sttErrorMessage(r) {
  const e = String((r && r.error) || '');
  if (r && r.mode === 'no-audio') return 'Heard nothing — try again, a little louder.';
  if (e === 'no-keys') return 'No transcription key saved — add a Sarvam or Groq key in Settings.';
  if (/^http-40[13]/.test(e)) return 'The key was rejected (' + e + ') — check it in Settings, or delete it and paste a fresh one.';
  if (/^http-429/.test(e)) return 'Rate limited (' + e + ') — wait a minute and try again.';
  if (/^http-/.test(e)) return 'Transcription service error (' + e + ') — try again.';
  if (e === 'timeout') return 'Transcription timed out — check your internet and try again.';
  if (e === 'empty-audio') return 'The recording came back empty — check the microphone in Settings.';
  return 'Transcription failed' + (e ? ' (' + e + ')' : '') + ' — check Settings, then try again.';
}

bolo.on('bolo:doctor-result', (r) => {
  if (!r) return;
  if (r.text) {
    $('transcript').value = r.text;
    structureIntoReview(r.text);
  } else {
    setStatus(sttErrorMessage(r), false);
  }
});

// ── Review ───────────────────────────────────────────────────────────────

async function structureIntoReview(text) {
  setStatus('Organizing into the patient note…', false);
  let note;
  try {
    const r = await bolo.doctorStructure(text);
    note = (r && r.note) || { patient_name: '', age: '', symptoms: text, diagnosis: '', prescription: [] };
    if (!r || !r.ok) {
      // The dictation survived in symptoms; the doctor still reviews it all.
      setStatus('Ready. The note did not split cleanly — check every field.', false);
    }
  } catch (e) {
    note = { patient_name: '', age: '', symptoms: text, diagnosis: '', prescription: [] };
  }
  current = { transcript: text, ...note };
  fillReview(current);
  showView('review');
  setStatus('Ready. Tap the mic after the patient leaves.', false);
}

function fillReview(note) {
  $('fName').value = note.patient_name || '';
  $('fAge').value = note.age || '';
  $('fSymptoms').value = note.symptoms || '';
  $('fDiagnosis').value = note.diagnosis || '';
  renderRxRows(note.prescription || []);
}

function renderRxRows(items) {
  const list = $('rxList');
  list.innerHTML = '';
  items.forEach((it, idx) => addRxRow(it, idx));
  if (items.length === 0) addRxRow({}, 0);
}

function addRxRow(it, idx) {
  const row = document.createElement('div');
  row.className = 'rx-row' + (it.uncertain ? ' needs-check' : '');
  row.dataset.idx = idx;
  const grid = document.createElement('div');
  grid.className = 'rx-grid';
  const fields = [
    ['medicine', 'Medicine'],
    ['dose', 'Dose'],
    ['timing', 'Timing'],
    ['duration', 'Duration']
  ];
  for (const [key, label] of fields) {
    const input = document.createElement('input');
    input.placeholder = label;
    input.value = it[key] || '';
    input.dataset.key = key;
    grid.appendChild(input);
  }
  row.appendChild(grid);
  if (it.uncertain) {
    const flag = document.createElement('div');
    flag.className = 'rx-flag';
    flag.textContent = 'Needs check: ' + (it.uncertain_reason || 'uncertain');
    row.appendChild(flag);
    const verify = document.createElement('button');
    verify.textContent = 'Verified — looks right';
    verify.style.cssText = 'font-size:12px;margin-top:6px;';
    verify.onclick = () => { row.classList.remove('needs-check'); flag.remove(); verify.remove(); };
    row.appendChild(verify);
  }
  const actions = document.createElement('div');
  actions.className = 'rx-actions';
  const del = document.createElement('button');
  del.textContent = 'Remove';
  del.onclick = () => row.remove();
  actions.appendChild(del);
  row.appendChild(actions);
  $('rxList').appendChild(row);
  return row;
}

$('rxAdd').onclick = () => addRxRow({}, $('rxList').children.length);

// Read the review form back into a note. Rows the doctor left fully empty
// are dropped; a row the doctor verified keeps uncertain:false.
function readReview() {
  const prescription = [];
  for (const row of $('rxList').children) {
    const it = { uncertain: false, uncertain_reason: '' };
    for (const input of row.querySelectorAll('input[data-key]')) {
      it[input.dataset.key] = input.value.trim();
    }
    // A row the doctor verified keeps uncertain:false; a row still flagged
    // keeps the flag into the saved note.
    if (row.classList.contains('needs-check')) {
      const flagEl = row.querySelector('.rx-flag');
      it.uncertain = true;
      it.uncertain_reason = flagEl ? flagEl.textContent.replace(/^Needs check:\s*/, '') : 'uncertain';
    }
    if (it.medicine || it.dose || it.timing || it.duration) prescription.push(it);
  }
  return {
    transcript: current ? current.transcript : '',
    patient_name: $('fName').value.trim(),
    age: $('fAge').value.trim(),
    symptoms: $('fSymptoms').value.trim(),
    diagnosis: $('fDiagnosis').value.trim(),
    prescription
  };
}

// P2: editing a note that was already approved. editingId is null for a
// fresh dictation; set when the doctor taps "Edit note" on a saved note.
let editingId = null;

$('approveBtn').onclick = async () => {
  const note = readReview();
  $('approveBtn').disabled = true;
  try {
    if (editingId) {
      const r = await bolo.historyUpdate(editingId, note);
      if (r && r.ok) {
        approved = { ...note, id: editingId, createdAt: (detailNote && detailNote.createdAt) || new Date().toLocaleString() };
        editingId = null;
        showDone(approved);
      } else {
        alert('Update failed: ' + ((r && r.error) || 'unknown'));
      }
    } else {
      const r = await bolo.historySave(note);
      if (r && r.ok) {
        approved = { ...note, id: r.id, createdAt: new Date().toLocaleString() };
        showDone(approved);
      } else {
        alert('Save failed: ' + ((r && r.error) || 'unknown'));
      }
    }
  } catch (e) {
    alert(editingId ? 'Update failed.' : 'Save failed.');
  } finally {
    $('approveBtn').disabled = false;
  }
};

$('discardBtn').onclick = () => {
  current = null;
  editingId = null;
  $('transcript').value = '';
  showView('record');
  setStatus('Ready. Tap the mic after the patient leaves.', false);
};

// P2: editing a note that was already approved — from the detail view or the
// history row menu. Returns the note to the review form; approving updates it
// in place (id, createdAt, transcript and recording are preserved).
function startEdit(note) {
  if (!note) return;
  editingId = note.id;
  current = {
    transcript: note.transcript || '',
    patient_name: note.patient_name || '',
    age: note.age || '',
    symptoms: note.symptoms || '',
    diagnosis: note.diagnosis || '',
    prescription: note.prescription || []
  };
  fillReview(current);
  showView('review');
  setStatus('Editing a saved note — change anything, then approve to save.', false);
}

$('detailEdit').onclick = () => startEdit(detailNote);
$('detailDelete').onclick = () => detailNote && deleteNote(detailNote.id);

// ── Done ─────────────────────────────────────────────────────────────────

function noteCardHtml(note) {
  const rx = (note.prescription || []).map((it, i) => {
    const parts = [it.medicine, it.dose, it.timing, it.duration].filter(Boolean).join(' ');
    return (i + 1) + '. ' + escapeHtml(parts) +
      (it.uncertain ? ' <span class="flag-inline">(needs check)</span>' : '');
  }).join('<br>');
  return '<div class="nm">' + escapeHtml(note.patient_name || 'Patient') + '</div>' +
    '<div class="meta">' + escapeHtml(note.createdAt || '') + '</div>' +
    '<div style="margin-top:8px;font-size:14px;">' + rx + '</div>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showDone(note) {
  $('doneSub').textContent = 'Approved and saved to patient history. Tap the note to see full details.';
  $('doneCard').innerHTML = noteCardHtml(note);
  $('doneCard').style.cursor = 'pointer';
  $('doneCard').onclick = () => showDetail(approved.id);
  showView('done');
}

$('doneNew').onclick = () => {
  current = null;
  approved = null;
  editingId = null;
  $('transcript').value = '';
  showView('record');
  setStatus('Ready. Tap the mic after the patient leaves.', false);
};

// Print the note through the system dialog on the LIVE window: the renderer
// injects the note HTML into a print-only container and calls window.print().
// This is what makes the dialog reliable on Windows — the old dedicated
// print window left the dialog hanging and Print looked dead.
async function printNote(note) {
  try {
    const r = await bolo.printHtml(note);
    if (!r || !r.ok) {
      alert('Print failed: ' + ((r && r.error) || 'unknown'));
      return;
    }
    $('printRoot').innerHTML = '<style>' + (r.css || '') + '</style>' + (r.body || '');
    document.body.classList.add('printing');
    window.print();
  } catch (e) {
    alert('Print failed.');
  }
}

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing');
  $('printRoot').innerHTML = '';
});

async function shareNote(note) {
  try {
    const r = await bolo.sharePrescription(note);
    if (!(r && r.ok)) alert('Share failed: ' + ((r && r.error) || 'unknown'));
  } catch (e) {
    alert('Share failed.');
  }
}

async function copyNote(note) {
  const lines = [
    'Patient: ' + (note.patient_name || ''),
    'Age: ' + (note.age || ''),
    'Date: ' + (note.createdAt || ''),
    '',
    'Symptoms: ' + (note.symptoms || ''),
    'Diagnosis: ' + (note.diagnosis || ''),
    '',
    'Prescription:'
  ];
  (note.prescription || []).forEach((it, i) => {
    lines.push((i + 1) + '. ' + [it.medicine, it.dose, it.timing, it.duration].filter(Boolean).join(' '));
  });
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
  } catch (_) {
    alert('Copy failed — select the text by hand.');
  }
}

$('donePrint').onclick = () => approved && printNote(approved);
$('doneShare').onclick = () => approved && shareNote(approved);
$('doneCopy').onclick = () => approved && copyNote(approved);

// ── History ──────────────────────────────────────────────────────────────

$('navHistory').onclick = () => { loadHistory(''); showView('history'); };

let historyTimer = null;
$('historySearch').addEventListener('input', () => {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => loadHistory($('historySearch').value), 200);
});

async function loadHistory(q) {
  const list = $('historyList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const notes = q ? await bolo.historySearch(q) : await bolo.historyList();
    if (!notes || notes.length === 0) {
      list.innerHTML = '<div class="empty">No saved notes yet.</div>';
      return;
    }
    list.innerHTML = '';
    for (const n of notes) {
      const el = document.createElement('div');
      el.className = 'hist-item';
      const rxCount = (n.prescription || []).length;
      const main = document.createElement('div');
      main.className = 'hist-main';
      main.innerHTML = '<div class="nm">' + escapeHtml(n.patient_name || 'Patient') + '</div>' +
        '<div class="meta">' + escapeHtml(n.createdAt || '') +
        (rxCount ? ' · ' + rxCount + ' medicine' + (rxCount > 1 ? 's' : '') : '') + '</div>';
      main.onclick = () => showDetail(n.id);
      el.appendChild(main);
      el.appendChild(menuButton(n));
      list.appendChild(el);
    }
  } catch (e) {
    list.innerHTML = '<div class="empty">Could not load history.</div>';
  }
}

// The three-dot menu on each history row: view, edit, print, share, delete.
// One menu open at a time; tapping anywhere else closes it.
function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}
document.addEventListener('click', closeMenus);

function menuButton(note) {
  const btn = document.createElement('button');
  btn.className = 'menu-btn';
  btn.textContent = '⋮';
  btn.setAttribute('aria-label', 'Note actions');
  btn.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = btn.parentElement.querySelector('.menu');
    closeMenus();
    if (wasOpen) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    const items = [
      ['View note', () => showDetail(note.id), false],
      ['Edit note', () => startEdit(note), false],
      ['Print', () => printNote(note), false],
      ['Share on WhatsApp', () => shareNote(note), false],
      ['Delete note', () => deleteNote(note.id), true]
    ];
    for (const [label, fn, danger] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      if (danger) b.className = 'danger';
      b.onclick = (ev) => { ev.stopPropagation(); closeMenus(); fn(); };
      menu.appendChild(b);
    }
    btn.parentElement.appendChild(menu);
  };
  return btn;
}

// Delete a note for good: the history entry and its recording file go away.
async function deleteNote(id) {
  if (!confirm('Delete this note? This cannot be undone.')) return;
  try {
    const r = await bolo.historyDelete(id);
    if (r && r.ok) {
      if (detailNote && detailNote.id === id) detailNote = null;
      loadHistory($('historySearch').value);
      showView('history');
    } else {
      alert('Could not delete: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) {
    alert('Could not delete the note.');
  }
}

let detailNote = null;

async function showDetail(id) {
  try {
    const n = await bolo.historyGet(id);
    if (!n) return;
    detailNote = n;
    $('detailTitle').textContent = n.patient_name || 'Patient';
    $('detailSub').textContent = n.createdAt || '';
    const rxRows = (n.prescription || []).map((it, i) =>
      '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(it.medicine) + '</td>' +
      '<td>' + escapeHtml(it.dose) + '</td><td>' + escapeHtml(it.timing) + '</td>' +
      '<td>' + escapeHtml(it.duration) +
      (it.uncertain ? ' <span class="flag-inline">(needs check)</span>' : '') + '</td></tr>'
    ).join('');
    $('detailBody').innerHTML =
      detailRow('Age', n.age) +
      detailRow('Symptoms', n.symptoms) +
      detailRow('Diagnosis', n.diagnosis) +
      '<div class="detail-row"><div class="dl">Prescription</div>' +
      '<table class="rx"><tr><th>#</th><th>Medicine</th><th>Dose</th><th>Timing</th><th>Duration</th></tr>' +
      rxRows + '</table></div>' +
      detailRow('What was heard', n.transcript);
    // The original recording, when this note has one. The player says WHY when
    // something is wrong (missing file, blocked load) instead of a silent 0:00.
    if (n.recording) {
      const wrap = document.createElement('div');
      wrap.className = 'detail-row';
      const label = document.createElement('div');
      label.className = 'dl';
      label.textContent = 'Original recording';
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'metadata';
      player.style.width = '100%';
      player.style.marginTop = '4px';
      const showWhy = (why) => { label.textContent = 'Original recording (' + why + ')'; };
      player.addEventListener('error', () => {
        const e = player.error;
        showWhy('could not play' + (e && e.message ? ': ' + e.message : ''));
      });
      wrap.appendChild(label);
      wrap.appendChild(player);
      $('detailBody').appendChild(wrap);
      try {
        const r = await bolo.historyAudio(n.id);
        if (r && r.ok && r.data) {
          // Blob URL: more reliable than a giant data: URL inside <audio>.
          const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
          player.src = URL.createObjectURL(new Blob([bytes], { type: r.mime || 'audio/webm' }));
        } else {
          showWhy((r && r.error) || 'unavailable');
        }
      } catch (_) {
        showWhy('unavailable');
      }
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'detail-row';
      wrap.innerHTML = '<div class="dl">Original recording</div>' +
        '<div class="dv" style="color:#888">No recording was kept for this note.</div>';
      $('detailBody').appendChild(wrap);
    }
    showView('detail');
  } catch (e) {
    alert('Could not open the note.');
  }
}

function detailRow(label, value) {
  return '<div class="detail-row"><div class="dl">' + label + '</div>' +
    '<div class="dv">' + escapeHtml(value || '—') + '</div></div>';
}

$('detailPrint').onclick = () => detailNote && printNote(detailNote);
$('detailShare').onclick = () => detailNote && shareNote(detailNote);
$('detailCopy').onclick = () => detailNote && copyNote(detailNote);

$('navSettings').onclick = () => { refreshKeyStates(); loadMicList(); loadShortcut(); showView('settings'); };

$('sarvamSave').onclick = () => saveKey('sarvam', $('sarvamKey'), 'sarvamState', 'Sarvam');
$('groqSave').onclick = () => saveKey('groq', $('groqKey'), 'groqState', 'Groq');

async function saveKey(provider, input, stateId, name) {
  const k = input.value.trim();
  if (!k) return;
  const stateEl = $(stateId);
  const fail = (msg) => {
    if (stateEl) { stateEl.textContent = msg; stateEl.classList.remove('ok'); }
    else alert(msg);
  };
  try {
    const r = await bolo.keysAdd(k, provider);
    if (r && r.ok) {
      input.value = '';
      await refreshKeyStates();
    } else if (r && r.error === 'duplicate-key') {
      fail('That ' + name + ' key is already saved below.');
    } else if (r && r.error === 'key-too-short') {
      fail('That key looks too short — make sure you pasted the whole ' + name + ' key.');
    } else {
      fail('Could not save the ' + name + ' key. Try again.');
    }
  } catch (e) {
    fail('Could not save the ' + name + ' key. Try again.');
  }
}

async function refreshKeyStates() {
  try {
    const r = await bolo.keysList();
    const p = (r && r.providers) || {};
    renderKeyList('sarvam', 'Sarvam', p.sarvam);
    renderKeyList('groq', 'Groq', p.groq);
  } catch (_) {}
}

// Each saved key, masked, with its own delete button — so a bad key can be
// spotted and removed without guessing which one failed.
function renderKeyList(provider, name, info) {
  const stateEl = $(provider + 'State');
  const listEl = $(provider + 'Keys');
  const keys = (info && info.keys) || [];
  if (stateEl) {
    const n = keys.length;
    stateEl.textContent = n ? n + ' ' + name + ' key' + (n > 1 ? 's' : '') + ' saved.'
                            : 'No ' + name + ' key saved.';
    stateEl.classList.toggle('ok', n > 0);
  }
  if (!listEl) return;
  listEl.innerHTML = '';
  keys.forEach((k) => {
    const row = document.createElement('div');
    row.className = 'key-item';
    const code = document.createElement('code');
    code.textContent = k.masked || '••••';
    row.appendChild(code);
    if (k.active && keys.length > 1) {
      const tag = document.createElement('span');
      tag.className = 'in-use';
      tag.textContent = 'in use';
      row.appendChild(tag);
    }
    const del = document.createElement('button');
    del.className = 'key-del';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete this ' + name + ' key?')) return;
      try { await bolo.keysRemove(k.index, provider); } catch (_) {}
      await refreshKeyStates();
    };
    row.appendChild(del);
    listEl.appendChild(row);
  });
}

// Microphone picker. Lists every input the OS reports; the choice is saved
// to settings and used for every recording from then on.
async function loadMicList() {
  const sel = $('micSelect');
  const state = $('micState');
  if (!sel) return;
  sel.innerHTML = '';
  const loading = document.createElement('option');
  loading.value = '';
  loading.textContent = 'Loading microphones…';
  sel.appendChild(loading);
  try {
    const r = await bolo.micDevices();
    const devices = (r && r.devices) || [];
    const saved = (r && r.selected) || '';
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'System default';
    sel.appendChild(auto);
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.id || d.deviceId || '';
      o.textContent = d.label || ('Microphone ' + (i + 1));
      sel.appendChild(o);
    });
    sel.value = saved;
    if (sel.value !== saved) sel.value = ''; // saved mic is gone: back to default
    if (state) {
      state.textContent = devices.length ? '' : 'No microphones found.';
      state.classList.remove('ok');
    }
  } catch (_) {
    if (state) state.textContent = 'Could not list microphones.';
  }
}

$('micSelect').onchange = async () => {
  const sel = $('micSelect');
  const state = $('micState');
  try {
    await bolo.micSet(sel.value);
    if (state) {
      state.textContent = 'Microphone saved.';
      state.classList.add('ok');
    }
  } catch (_) {
    if (state) state.textContent = 'Could not save the microphone.';
  }
};

// The dictation shortcut, shown on the main screen and editable in Settings.
async function loadShortcut() {
  try {
    const r = await bolo.shortcutGet();
    const accel = (r && r.accelerator) || '';
    $('shortcutInput').value = accel;
    updateShortcutHint(accel);
  } catch (_) {
    updateShortcutHint('');
  }
}

function updateShortcutHint(accel) {
  $('shortcutHint').textContent = accel
    ? 'Shortcut: ' + accel + ' — press it anywhere to start or stop dictation.'
    : 'No dictation shortcut set — open Settings to add one.';
}

$('shortcutSave').onclick = async () => {
  const v = $('shortcutInput').value.trim();
  if (!v) return;
  try {
    const r = await bolo.shortcutSet(v);
    if (r && r.ok) {
      updateShortcutHint(r.accelerator);
      $('shortcutState').textContent = 'Saved.';
    } else {
      $('shortcutState').textContent =
        'Could not bind that shortcut — it may be taken by another app. Try another.';
      await loadShortcut();
    }
  } catch (e) {
    $('shortcutState').textContent = 'Could not save the shortcut.';
  }
};

refreshKeyStates();
loadShortcut();
