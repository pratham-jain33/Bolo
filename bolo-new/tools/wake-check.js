// Exercises the wake word's matcher — the part that decides whether what was
// heard is the phrase. No microphone, no API: the transcripts below are the ones
// whisper actually returns for this phrase in a quiet room, a noisy one, and for
// ordinary speech that must NOT fire.
//   electron tools/wake-check.js
const { app } = require('electron');
const wake = require('../src/main/wake');

const PHRASE = 'hey bolo';

// [transcript, should match]
const CASES = [
  ['hey bolo', true],
  ['Hey, Bolo.', true],
  ['hey bollo', true],
  ['Hey bolo,', true],
  ['hey bola', true],
  ['Hey Bolo can you tell me the weather', true],
  ['okay bolo what time is it', true],
  ['a bolo', true],
  // Must not fire: ordinary sentences, and a different assistant's name.
  ['hey there', false],
  ['hello', false],
  ['hey Alexa what is the weather', false],
  ['hey Google', false],
  ['can you tell me the weather tomorrow', false],
  ['thank you very much', false],
  ['', false],
  ['   ', false],
  ['polio vaccine', false]
];

app.whenReady().then(() => {
  let pass = 0;
  let fail = 0;
  console.log('phrase: "' + PHRASE + '"  threshold: ' +
    wake._internals.bestMatch('').threshold.toFixed(3) + '\n');

  for (const [heard, want] of CASES) {
    const m = wake._internals.bestMatch(heard);
    const got = !!m.matched;
    const ok = got === want;
    if (ok) pass++; else fail++;
    console.log(
      (ok ? '  ok  ' : '  FAIL') +
      '  ' + String(got).padEnd(5) +
      ' score ' + m.score.toFixed(3).padEnd(6) +
      ' ' + JSON.stringify(heard)
    );
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
});