/* Throwaway: run real speech through the real stt.js module. Proves multipart
   upload, the model id, key rotation and JSON parsing all work together — a 200
   response alone would not prove the audio was understood.

   Usage: ./node_modules/.bin/electron tools/stt-check.js [path-to-audio]   */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// See keys-check.js: without this electron-store reads %APPDATA%\Electron.
app.setName('bolo');
app.disableHardwareAcceleration();

const file = process.argv[2] || path.join(process.env.TEMP || '', 'shots', 'speech-probe.wav');

app.whenReady().then(async () => {
  const stt = require('../src/main/stt');
  const keys = require('../src/main/keys');
  keys.init();

  console.log('keys        :', keys.count());
  console.log('file        :', file);

  if (!fs.existsSync(file)) {
    console.log('MISSING FILE');
    return app.exit(1);
  }

  const buf = fs.readFileSync(file);
  const mime = file.endsWith('.webm') ? 'audio/webm' : 'audio/wav';
  console.log('bytes       :', buf.byteLength, ' mime:', mime, ' ext:', stt.extFor(mime));
  console.log('');

  const t0 = Date.now();
  const r = await stt.transcribe(buf, { mime, language: 'en' });
  console.log('elapsed     :', Date.now() - t0, 'ms');
  console.log('ok          :', r.ok);
  console.log('model       :', r.model);
  console.log('error       :', r.error || '(none)');
  console.log('text        :', JSON.stringify(r.text));

  // Round-robin check: a second call should land on the other key.
  const r2 = await stt.transcribe(buf, { mime, language: 'en' });
  console.log('');
  console.log('2nd call ok :', r2.ok, ' text:', JSON.stringify(r2.text));

  app.exit(r.ok && r.text ? 0 : 1);
});

setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 90000);
