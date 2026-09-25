const { BrowserWindow } = require('electron');
const path = require('path');

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

module.exports = { create, getWindow, isOpen, show, send };
