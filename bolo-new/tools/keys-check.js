/* Throwaway: exercise the real keys.js round-robin under Electron (electron-store
   needs Electron's app paths, so plain node cannot load it). Prints the key
   ORDER only — never a key's value. Not part of the app. */

const { app } = require('electron');

// Must run BEFORE whenReady: without it `electron <script>` uses Electron's own
// default app name, so electron-store reads %APPDATA%\Electron instead of the
// real %APPDATA%\bolo store and every key looks missing.
app.setName('bolo');
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const keys = require('../src/main/keys');
  keys.init();

  const seq = [];
  for (let i = 0; i < 6; i++) {
    const k = keys.nextKey();
    seq.push(k ? k.slice(0, 7) : '(null)');
  }
  console.log('count         :', keys.count());
  console.log('6x nextKey    :', seq.join('  ->  '));
  console.log('  expect alternating A,B,A,B,A,B');

  // Fail the key that was just used, then confirm it is stepped over.
  const failed = keys.nextKey();
  keys.markFailure();
  const afterFail = [];
  for (let i = 0; i < 3; i++) afterFail.push(keys.nextKey().slice(0, 7));
  console.log('');
  console.log('used+failed   :', failed.slice(0, 7));
  console.log('next 3        :', afterFail.join('  ->  '));
  console.log('  expect the failed key to be skipped while cooling down');

  keys.markSuccess();
  app.quit();
});

setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 15000);
