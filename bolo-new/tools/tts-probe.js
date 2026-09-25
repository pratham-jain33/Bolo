// Live check of the speech pipeline through the real key store.
//
// Run with:  ./node_modules/.bin/electron tools/tts-probe.js
//
// It exists because the two voice families are served from different endpoints
// and the wrong pairing is a 400 that looks like a dead feature. This makes a
// real request per voice, through the same keys.js -> tts.js path the app uses,
// and prints what came back.
//
// Not part of the app: nothing here ships (tools/ is outside build.files).

const { app } = require('electron');

app.whenReady().then(async () => {
  const keys = require('../src/main/keys');
  const tts = require('../src/main/tts');

  console.log('--- key store ---');
  console.log('groq keys    :', keys.count('groq'), keys.listMasked('groq').map((k) => k.masked).join(', '));
  console.log('deepgram keys:', keys.count('deepgram'), keys.listMasked('deepgram').map((k) => k.masked).join(', '));

  console.log('\n--- speech, one real request per voice ---');
  let failures = 0;
  for (const v of tts.voices) {
    const endpoint = tts.endpointFor(v.id);
    const r = await tts.synthesize('bolo online and ready.', { voice: v.id });
    if (!r.ok) failures++;
    console.log(
      v.id.padEnd(18),
      (v.gender || '?').padEnd(7),
      r.ok ? 'ok  ' + String(r.bytes).padStart(7) + ' bytes' : 'FAIL ' + r.error,
      ' ' + endpoint.replace('https://api.deepgram.com', '')
    );
  }

  console.log('\n--- cache ---');
  const before = Date.now();
  const again = await tts.synthesize('bolo online and ready.', { voice: tts.voices[0].id });
  console.log('second identical request:', again.cached ? 'served from cache' : 'MISSED cache', Date.now() - before + 'ms');

  console.log('\nfailures:', failures);
  app.exit(failures ? 1 : 0);
}).catch((e) => {
  console.error('probe crashed:', e && e.stack || e);
  app.exit(2);
});