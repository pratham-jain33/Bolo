const { contextBridge, ipcRenderer } = require('electron');

// Channels the renderer may subscribe to. An allowlist rather than a raw
// `ipcRenderer.on` passthrough, so a renderer compromise can't sit on arbitrary
// main-process traffic.
const EVENTS = [
  // Voice state for the mic button, and the finished dictation transcript.
  'bolo:voice-state',
  'bolo:voice-level',
  'bolo:doctor-result',
  // Commands into the hidden capture window. Only capture.html subscribes.
  'bolo:capture-start',
  'bolo:capture-stop',
  'bolo:capture-monitor',
  'bolo:capture-clip',
  'bolo:capture-devices',
  'bolo:capture-device'
];

contextBridge.exposeInMainWorld('bolo', {
  /* ── The one button: start/stop a dictation ─────────────────────────── */
  doctorToggle: () => ipcRenderer.invoke('bolo:doctor-toggle'),

  /* ── Structuring: transcript in, structured note out ────────────────── */
  doctorStructure: (text) => ipcRenderer.invoke('bolo:doctor-structure', text),

  /* ── Patient history ────────────────────────────────────────────────── */
  historyList: () => ipcRenderer.invoke('bolo:history-list'),
  historySearch: (q) => ipcRenderer.invoke('bolo:history-search', q),
  historyGet: (id) => ipcRenderer.invoke('bolo:history-get', id),
  historySave: (note) => ipcRenderer.invoke('bolo:history-save', note),
  historyAudio: (id) => ipcRenderer.invoke('bolo:history-audio', id),

  /* ── Outputs ────────────────────────────────────────────────────────── */
  doctorPrint: (note) => ipcRenderer.invoke('bolo:doctor-print', note),
  sharePrescription: (note) => ipcRenderer.invoke('bolo:share-prescription', note),

  /* ── Keys: Groq (structuring) + Sarvam (Hinglish transcription) ──────── */
  keysList: () => ipcRenderer.invoke('bolo:keys-list'),
  keysAdd: (k, provider) => ipcRenderer.invoke('bolo:keys-add', k, provider),
  keysRemove: (i, provider) => ipcRenderer.invoke('bolo:keys-remove', i, provider),

  /* ── Dictation shortcut: the one global chord ─────────────────────────── */
  shortcutGet: () => ipcRenderer.invoke('bolo:shortcut-get'),
  shortcutSet: (accelerator) => ipcRenderer.invoke('bolo:shortcut-set', accelerator),

  /* ── Microphones, listed through the capture window ──────────────────── */
  micDevices: () => ipcRenderer.invoke('bolo:mic-devices'),

  /* ── Microphone (capture window only) ─────────────────────────────────── */
  captureLevel: (level) => ipcRenderer.send('bolo:capture-level', level),
  captureState: (payload) => ipcRenderer.send('bolo:capture-state', payload),
  captureDone: (payload) => ipcRenderer.send('bolo:capture-done', payload),
  captureDevices: (payload) => ipcRenderer.send('bolo:capture-devices-result', payload),
  captureDevicesChanged: (payload) => ipcRenderer.send('bolo:capture-devices-changed', payload),
  captureClip: (payload) => ipcRenderer.send('bolo:capture-clip-result', payload),

  /* ── Events ─────────────────────────────────────────────────────────── */
  on: (channel, fn) => {
    if (!EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
