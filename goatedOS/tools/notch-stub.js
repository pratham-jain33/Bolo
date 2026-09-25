// Stands in for the preload bridge so the notch can be photographed outside the
// app, the way ob-stub.js does for onboarding. It answers the handful of calls
// notch.js and speak.js make at load, and exposes `fireMode` so a shot can drive
// the mode chip to a beat. Ships nothing.
const { contextBridge } = require('electron');

let modeCb = null;
const noop = () => Promise.resolve({});

const bridge = {
  on: () => {},
  onMode: (fn) => { modeCb = fn; },
  getPlatform: () => Promise.resolve('win32'),
  notchResize: noop,
  notchHover: noop,
  notchSpeaking: noop,
  notchDismiss: noop,
  notchAction: noop,
  notchCopy: noop,
  notchSet: noop,
  notchGet: () =>
    Promise.resolve({
      enabled: true,
      variant: 'top',
      side: 'right',
      material: 'solid',
      width: 286,
      opacity: 1
    }),
  getSettings: () => Promise.resolve({ notchMaterial: 'solid', notchVariant: 'top' }),
  voiceInfo: () => Promise.resolve({ shortcut: 'Fn', bindings: {} }),
  getStatus: () => Promise.resolve({}),
  setView: noop,
  speak: () => Promise.resolve({ ok: false, error: 'muted' })
};

// shot.js injects this with `contextIsolation: false`, where the page and the
// preload share one `window` and `contextBridge` is not even defined — which is
// why the first attempt photographed a notch with no chip and an
// "window.fireMode is not a function" in the diag box. Assign directly; keep the
// bridge for the isolated case.
function publish() {
  window.bolo = bridge;
  window.fireMode = (m) => { if (modeCb) modeCb({ mode: m }); };
}

if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
  try {
    contextBridge.exposeInMainWorld('bolo', bridge);
    contextBridge.exposeInMainWorld('fireMode', (m) => { if (modeCb) modeCb({ mode: m }); });
  } catch (_) { publish(); }
} else {
  publish();
}
