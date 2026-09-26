// Bolo Doctor v0.1 — the whole app.
//
// One window, one button. After the patient leaves, the doctor taps, speaks
// for ~30 seconds in Hinglish, reviews the structured note, approves it, and
// saves / prints / shares it. Patient data stays on this machine.
//
// One global shortcut exists: the dictation chord (default Control+Shift+D),
// which starts/stops a dictation from anywhere and is editable in Settings.
// Everything else removed lives on the archive/bolo-full branch and is
// described in VISION.md.

const { app, ipcMain, session, shell, globalShortcut } = require('electron');
const path = require('path');

const capture = require('./capture');
const audio = require('./audio');
const voice = require('./voice');
const doctor = require('./doctor');
const keys = require('./keys');
const settings = require('./settings');

const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');
const rendererDir = path.join(__dirname, '..', 'renderer');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    doctor.show();
  });

  app.whenReady().then(() => {
    // The hidden capture window owns the microphone; the doctor window is the
    // only visible surface.
    capture.installPermissions(session.defaultSession);
    capture.installIpc(ipcMain);
    capture.create(preloadPath, rendererDir);
    audio.attach((channel, payload) => capture.send(channel, payload));

    doctor.create(preloadPath, rendererDir);
    doctor.show();

    // The one global shortcut: the dictation chord. Works from anywhere, so
    // the doctor can start/stop a dictation without finding the window.
    bindDictationShortcut(settings.voiceShortcut());

    registerIpc();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// The dictation chord is a single binding tracked here so a rebind in
// Settings unregisters exactly the old one and never leaks accelerators.
let dictationAccelerator = null;

function onDictationShortcut() {
  doctor.show();
  voice.toggle({ broadcast: (ch, p) => doctor.send(ch, p) }).catch(() => {});
}

function bindDictationShortcut(accelerator) {
  if (dictationAccelerator) {
    globalShortcut.unregister(dictationAccelerator);
    dictationAccelerator = null;
  }
  if (!accelerator) return false;
  if (globalShortcut.register(accelerator, onDictationShortcut)) {
    dictationAccelerator = accelerator;
    return true;
  }
  return false;
}

function registerIpc() {
  // ── Voice ──────────────────────────────────────────────────────────────
  // The doctor window is the only consumer, so it receives every voice event.
  ipcMain.handle('bolo:doctor-toggle', async () => {
    try {
      return await voice.toggle({ broadcast: (ch, p) => doctor.send(ch, p) });
    } catch (e) {
      return { state: 'idle', error: (e && e.message) || String(e) };
    }
  });

  // ── Structuring: transcript in, structured note JSON out ────────────────
  ipcMain.handle('bolo:doctor-structure', async (_e, text) => {
    try {
      return await doctor.structureNote(text);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  // ── Patient history: local JSON file, searchable by patient name ────────
  ipcMain.handle('bolo:history-list', async () => doctor.listNotes());
  ipcMain.handle('bolo:history-search', async (_e, q) => doctor.searchNotes(q));
  ipcMain.handle('bolo:history-get', async (_e, id) => doctor.getNote(id));
  ipcMain.handle('bolo:history-save', async (_e, note) => {
    try {
      return doctor.saveNoteToHistory(note);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  // ── Outputs: print, share ───────────────────────────────────────────────
  ipcMain.handle('bolo:doctor-print', async (_e, note) => doctor.printNote(note));
  ipcMain.handle('bolo:share-prescription', async (_e, note) => {
    try {
      const url = 'https://wa.me/?text=' + encodeURIComponent(doctor.shareText(note));
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  // ── Keys: Groq structures the note, Sarvam transcribes Hinglish ─────────
  ipcMain.handle('bolo:keys-list', async () => {
    const providers = {};
    for (const p of ['groq', 'sarvam']) {
      providers[p] = { count: keys.count(p) };
    }
    return { providers };
  });
  ipcMain.handle('bolo:keys-add', async (_e, k, provider) => keys.add(k, provider));
  ipcMain.handle('bolo:keys-remove', async (_e, i, provider) => keys.removeAt(i, provider));

  // ── Dictation shortcut: the one global chord ──────────────────────────
  ipcMain.handle('bolo:shortcut-get', async () => ({
    accelerator: settings.voiceShortcut()
  }));
  ipcMain.handle('bolo:shortcut-set', async (_e, accelerator) => {
    const next = String(accelerator || '').trim();
    if (!next) return { ok: false, error: 'empty' };
    const previous = dictationAccelerator || settings.voiceShortcut();
    if (!bindDictationShortcut(next)) {
      // The new chord is taken by another app — put the old one back so the
      // doctor is never left with no shortcut at all.
      bindDictationShortcut(previous);
      return { ok: false, error: 'could-not-bind' };
    }
    settings.setVoiceShortcut(next);
    return { ok: true, accelerator: next };
  });

  // ── Microphones, listed through the capture window ──────────────────────
  ipcMain.handle('bolo:mic-devices', async () => capture.listDevices());
}
