// Bolo Doctor renderer — the one screen.
//
// Views: record -> review (mandatory) -> done; plus history, detail, settings.
// Nothing is saved or printed until the doctor approves in review.

const $ = (id) => document.getElementById(id);

const VIEWS = ['record', 'review', 'done', 'history', 'detail', 'settings'];

function showView(name) {
  for (const v of VIEWS) $('view-' + v).classList.toggle('active', v === name);
}

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
  if (s.state === 'listening') setStatus('Listening… tap the mic to stop.', true);
  else if (s.state === 'routing') setStatus('Writing down what you said…', false);
  else if (current === null) setStatus('Ready. Tap the mic after the patient leaves.', false);
});

bolo.on('bolo:doctor-result', (r) => {
  if (!r) return;
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

$('approveBtn').onclick = async () => {
  const note = readReview();
  $('approveBtn').disabled = true;
  try {
    const r = await bolo.historySave(note);
    if (r && r.ok) {
      approved = { ...note, id: r.id, createdAt: new Date().toLocaleString() };
      showDone(approved);
    } else {
      alert('Save failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) {
    alert('Save failed.');
  } finally {
    $('approveBtn').disabled = false;
  }
};

$('discardBtn').onclick = () => {
  current = null;
  $('transcript').value = '';
  showView('record');
  setStatus('Ready. Tap the mic after the patient leaves.', false);
};

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
  $('transcript').value = '';
  showView('record');
  setStatus('Ready. Tap the mic after the patient leaves.', false);
};

async function printNote(note) {
  try {
    const r = await bolo.doctorPrint(note);
    if (!(r && r.ok) && (!r || r.error !== 'cancelled')) {
      alert('Print failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) {
    alert('Print failed.');
  }
}

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
      el.innerHTML = '<div class="nm">' + escapeHtml(n.patient_name || 'Patient') + '</div>' +
        '<div class="meta">' + escapeHtml(n.createdAt || '') +
        (rxCount ? ' · ' + rxCount + ' medicine' + (rxCount > 1 ? 's' : '') : '') + '</div>';
      el.onclick = () => showDetail(n.id);
      list.appendChild(el);
    }
  } catch (e) {
    list.innerHTML = '<div class="empty">Could not load history.</div>';
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
    // The original recording, when this note has one. Notes saved before
    // recordings existed simply show the transcript without a player.
    if (n.recording) {
      const wrap = document.createElement('div');
      wrap.className = 'detail-row';
      const label = document.createElement('div');
      label.className = 'dl';
      label.textContent = 'Original recording';
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'none';
      player.style.width = '100%';
      player.style.marginTop = '4px';
      wrap.appendChild(label);
      wrap.appendChild(player);
      $('detailBody').appendChild(wrap);
      const markUnavailable = () => { label.textContent = 'Original recording (unavailable)'; };
      try {
        const r = await bolo.historyAudio(n.id);
        if (r && r.ok && r.data) {
          player.src = 'data:' + (r.mime || 'audio/webm') + ';base64,' + r.data;
        } else {
          markUnavailable();
        }
      } catch (_) {
        markUnavailable();
      }
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

$('detailBack').onclick = () => { loadHistory($('historySearch').value); showView('history'); };
$('detailPrint').onclick = () => detailNote && printNote(detailNote);
$('detailShare').onclick = () => detailNote && shareNote(detailNote);
$('detailCopy').onclick = () => detailNote && copyNote(detailNote);

// ── Settings: keys + the dictation shortcut ──────────────────────────────

$('navSettings').onclick = () => { refreshKeyStates(); loadShortcut(); showView('settings'); };
$('settingsBack').onclick = () => showView('record');
$('historyBack').onclick = () => showView('record');

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
