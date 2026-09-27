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
  $('micBtn').innerHTML = live ? 'Tap to<br>stop' : 'Tap to<br>dictate';
}

// ── Recording ────────────────────────────────────────────────────────────

async function toggle() {
  if (busy) return;
  busy = true;
  $('micBtn').disabled = true;
  try {
    const r = await bolo.doctorToggle();
    if (r && r.state === 'listening') setStatus('Listening… tap the mic to stop.', true);
    else if (r && r.error === 'trial-ended') setStatus('This trial ended on ' + trialExpiryLabel + '. Thanks for trying Bolo Doctor.', false);
    else if (r && r.error === 'trial-exhausted') setStatus('Trial dictation time is used up on this computer.', false);
    else if (r && r.error) setStatus('Could not start: ' + r.error, false);
  } catch (e) {
    setStatus('Could not start dictation.', false);
  } finally {
    busy = false;
    $('micBtn').disabled = false;
  }
}

$('micBtn').onclick = toggle;

// ── Trial hard stop ──────────────────────────────────────────────────────
// The trial cap is 15 minutes per computer, full stop. Without this, a
// recording started with 0:05 left could run for minutes — usage is only
// recorded after the clip ends. So when a trial recording starts, arm a
// timer for the remaining allowance that stops the recording for real.
let isRecording = false;
let trialStopTimer = null;
function clearTrialStop() {
  if (trialStopTimer) { clearTimeout(trialStopTimer); trialStopTimer = null; }
}
async function armTrialStop() {
  clearTrialStop();
  try {
    const t = await bolo.trialStatus();
    if (t && t.trial && !t.expired && !t.exhausted && t.remainingMs > 0) {
      trialStopTimer = setTimeout(async () => {
        trialStopTimer = null;
        if (isRecording) {
          try { await bolo.doctorToggle(); } catch (_) {}
          setStatus('Trial dictation time ran out — recording stopped automatically.', false);
        }
      }, t.remainingMs);
    }
  } catch (_) { /* keyless dev builds: no cap, no timer */ }
}

bolo.on('bolo:voice-state', (s) => {
  if (!s) return;
  if (s.state === 'listening') {
    isRecording = true;
    setStatus('Listening… tap the mic to stop.', true);
    armTrialStop();
  } else {
    isRecording = false;
    clearTrialStop();
    // A dictation just banked its minutes against the trial cap (usage is
    // written before the 'idle' state lands) — refresh the trial countdown
    // so the banner shows the new remaining time immediately.
    if (s.state === 'idle') refreshTrial();
    if (s.state === 'routing') setStatus('Writing down what you said…', false);
    else if (current === null) setStatus('Ready. Tap the mic after the patient leaves.', false);
  }
});

// ── Trial mode: per-computer dictation banner ────────────────────────────
function fmtTrialMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// The baked expiry label (e.g. "31 Oct 2026"), for the trial-ended message.
let trialExpiryLabel = '';
async function refreshTrial() {
  try {
    const t = await bolo.trialStatus();
    const el = $('trialLine');
    if (t && t.trial) {
      trialExpiryLabel = t.expiryLabel || '';
      el.style.display = '';
      el.style.color = '';
      el.style.fontWeight = '';
      if (t.expired) {
        el.textContent = 'This trial ended on ' + trialExpiryLabel + '. Thanks for trying Bolo Doctor.';
      } else if (t.exhausted) {
        el.textContent = 'Trial version — dictation time is used up on this computer.';
      } else {
        // Visible countdown: remaining minutes, the expiry date, and a red
        // bold emphasis when under 3 minutes remain.
        el.textContent = 'Trial version — ' + fmtTrialMs(t.remainingMs) + ' of ' + fmtTrialMs(t.capMs) +
          ' dictation left on this computer.' +
          (trialExpiryLabel ? ' Trial valid till ' + trialExpiryLabel + '.' : '');
        if (t.remainingMs < 3 * 60 * 1000) {
          el.style.color = '#c00000';
          el.style.fontWeight = 'bold';
        }
      }
      // Keys are baked into the trial: nothing to paste, nothing to clear.
      $('keyFields').style.display = 'none';
      $('trialKeyNote').style.display = '';
      // The demo button lives only in trial builds, and retires with the trial.
      $('demoBtn').style.display = t.expired ? 'none' : '';
    } else {
      el.style.display = 'none';
      $('demoBtn').style.display = 'none';
    }
  } catch (_) { /* keyless dev builds: stay silent */ }
}

// ── Demo mode (trial only): a canned dictation that plays with a typing ──
// animation and fills a sample note. Makes ZERO API calls (no Sarvam, no
// Groq), needs no mic, and never touches the trial minute allowance — it
// bypasses voice entirely and goes straight to the mandatory review screen.
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
    setStatus('Demo — no trial minutes used, no mic needed.', true);
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

bolo.on('bolo:doctor-result', (r) => {
  if (!r) return;
  refreshTrial();
  if (r.text) {
    $('transcript').value = r.text;
    structureIntoReview(r.text);
  } else {
    setStatus(r.message || 'Heard nothing — try again, a little louder.', false);
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

$('navSettings').onclick = () => { refreshKeyStates(); loadShortcut(); showView('settings'); };

$('sarvamSave').onclick = () => saveKey('sarvam', $('sarvamKey'));
$('groqSave').onclick = () => saveKey('groq', $('groqKey'));

async function saveKey(provider, input) {
  const k = input.value.trim();
  if (!k) return;
  try {
    const r = await bolo.keysAdd(k, provider);
    if (r && r.ok) {
      input.value = '';
      await refreshKeyStates();
    } else {
      alert('Could not save the key: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) {
    alert('Could not save the key.');
  }
}

async function refreshKeyStates() {
  try {
    const r = await bolo.keysList();
    const p = (r && r.providers) || {};
    $('sarvamState').textContent = keyLine(p.sarvam, 'Sarvam');
    $('groqState').textContent = keyLine(p.groq, 'Groq');
  } catch (_) {}
}

function keyLine(info, name) {
  const n = info ? info.count : 0;
  return n ? n + ' ' + name + ' key' + (n > 1 ? 's' : '') + ' saved.'
           : 'No ' + name + ' key saved.';
}

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
refreshTrial();
