// Proves the streaming path: the first audio byte must arrive long before the
// last one, or "it starts playing as soon as the first word is generated" is
// just a claim. Times onBegin against total, and reports how many chunks landed.
//   electron tools/tts-stream-check.js "some sentence"
const { app } = require('electron');
const tts = require('../src/main/tts');

const TEXT =
  process.argv[2] ||
  'Here is a slightly longer answer, so that the stream has time to show itself: ' +
    'the reply begins playing while the rest of it is still being generated.';

app.whenReady().then(async () => {
  const t0 = Date.now();
  let first = 0;
  let chunks = 0;
  let bytes = 0;

  const r = await tts.synthesizeStream(
    TEXT,
    {
      voice: 'aura-2-delia-en',
      onBegin: () => { if (!first) first = Date.now() - t0; }
    },
    (b) => { chunks++; bytes += b.length; }
  );

  const total = Date.now() - t0;
  console.log(JSON.stringify({ ...r, firstByteMs: first, totalMs: total, chunks, bytes }, null, 2));
  app.exit(r && r.ok ? 0 : 1);
});
