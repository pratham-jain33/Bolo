/* Throwaway: boot the real capture window and record through it.

   This is the only test that covers the whole dictation path — the permission
   handlers, getUserMedia, the MediaRecorder, the codec MediaRecorder actually
   chose, and the Groq round trip. stt-check.js starts one step further down the
   chain, with bytes already in hand, so it cannot catch a microphone that never
   opened.

   Pass a WAV to feed Chromium's fake audio device and the transcript becomes
   checkable word-for-word:

     ./node_modules/.bin/electron tools/capture-check.js [speech.wav] [ms]

   With no WAV it records the real microphone, where the assertion is weaker but
   the path is the real one — permission, device, and a non-empty clip. */

const { app, session, ipcMain } = require('electron');
const path = require('path');

// See keys-check.js: without this electron-store reads %APPDATA%\Electron.
app.setName('bolo');
app.disableHardwareAcceleration();

const wav = process.argv[2] && process.argv[2].endsWith('.wav') ? process.argv[2] : null;
const ms = Math.max(1000, Math.min(15000, Number(process.argv[3]) || 4000));

// Chromium's fake device. Deliberately NOT paired with
// --use-fake-ui-for-media-stream: that flag auto-grants the microphone, which
// would hide a broken permission handler behind a passing test.
if (wav) {
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
}

const preloadPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const rendererDir = path.join(__dirname, '..', 'src', 'renderer');

// A hidden window that is not the capture window, asking for the microphone. It
// loads the same capture.html — same origin, same CSP, same secure-context
// status — so the only variable between it and the real one is the webContents
// id the permission handler scopes on. (A data: URL will not do: it is not a
// secure context, so navigator.mediaDevices is undefined there and the probe
// fails for a reason that has nothing to do with permissions.)
async function probeForeignWindow() {
  const { BrowserWindow } = require('electron');
  const w = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  try {
    await w.loadFile(path.join(rendererDir, 'capture.html'));
    return await w.webContents.executeJavaScript(`
      (function () {
        try {
          if (!navigator.mediaDevices) return 'no-mediaDevices (' + location.protocol + ')';
          return navigator.mediaDevices.getUserMedia({ audio: true })
            .then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); return 'GRANTED'; })
            .catch(function (e) { return 'refused:' + e.name; });
        } catch (e) { return 'threw:' + e.message; }
      })()
    `);
  } catch (e) {
    return 'error:' + e.message;
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

app.whenReady().then(async () => {
  const capture = require('../src/main/capture');
  const audio = require('../src/main/audio');
  const stt = require('../src/main/stt');
  const keys = require('../src/main/keys');
  keys.init();

  console.log('source      :', wav ? 'fake device <- ' + wav : 'REAL microphone');
  console.log('groq keys   :', keys.count('groq'));
  console.log('stt model   :', require('../src/main/settings').get('sttModel'));
  console.log('');

  // Exactly what main.js does, in the same order.
  capture.installPermissions(session.defaultSession);
  capture.installIpc(ipcMain);
  capture.create(preloadPath, rendererDir);
  audio.attach((channel, payload) => capture.send(channel, payload));

  // The other half of the scoping: a window that is NOT the capture window must
  // be refused. Granting the microphone to the right window is only half a
  // guarantee if every other window gets it too.
  const intruder = await probeForeignWindow();
  const scoped = intruder.indexOf('refused') === 0;
  console.log('scoping     :', intruder, scoped ? '(a non-capture window was refused)' : '  <-- NOT EXCLUSIVE, every window can open the microphone');
  console.log('');

  let levels = 0;
  let peak = 0;
  audio.setLevelListener((l) => { levels++; if (l > peak) peak = l; });

  const win = capture.getWindow();
  console.log('window      :', win ? 'created (id ' + win.webContents.id + ')' : 'MISSING');
  if (!win) return app.exit(1);

  // Wait for capture.js to have run. audio.start() queues until then, so this is
  // only to keep the log readable.
  await new Promise((r) => {
    if (!win.webContents.isLoading()) return r();
    win.webContents.once('did-finish-load', r);
  });
  await new Promise((r) => setTimeout(r, 300));

  const started = await audio.start();
  console.log('audio.start :', JSON.stringify(started));
  if (!started.ok) {
    console.log('');
    console.log('FAIL — the microphone never opened.');
    console.log('state       :', JSON.stringify(audio.getState()));
    return app.exit(1);
  }

  await new Promise((r) => setTimeout(r, ms));

  const clip = await audio.stop();
  console.log('audio.stop  :', JSON.stringify({
    ok: clip.ok, bytes: clip.bytes, mime: clip.mime, ms: clip.ms, error: clip.error || null
  }));
  console.log('levels      :', levels, 'updates, peak', peak.toFixed(3));

  if (!clip.ok || !clip.bytes) {
    console.log('');
    console.log('FAIL — no audio came back.');
    console.log('state       :', JSON.stringify(audio.getState()));
    return app.exit(1);
  }

  console.log('');
  const t0 = Date.now();
  const r = await stt.transcribe(clip.buffer, { mime: clip.mime, language: 'en' });
  console.log('transcribe  :', Date.now() - t0, 'ms');
  console.log('ok          :', r.ok);
  console.log('model       :', r.model);
  console.log('error       :', r.error || '(none)');
  console.log('text        :', JSON.stringify(r.text));

  // A live meter is the other half of this: the pill and the notch both read the
  // level stream, and a flat one means they are animating nothing.
  const meterOk = levels > 5 && peak > 0.02;
  console.log('');
  console.log('meter       :', meterOk ? 'live' : 'FLAT — levels are not reaching main');

  app.exit(r.ok && meterOk && scoped ? 0 : 1);
});

setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 120000);
