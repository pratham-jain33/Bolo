// Capture the primary screen to a PNG. Used to see what bolo actually puts
// on screen — the overlay windows are separate from the dashboard, so nothing
// else can show them together.
// Usage: electron tools/peek.js <out.png> [delayMs]
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || 'peek.png';
const delay = parseInt(process.argv[3] || '500', 10);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, delay));
  const d = screen.getPrimaryDisplay();
  const { width, height } = d.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
  if (!src) { console.log('no screen source'); app.quit(); return; }
  fs.writeFileSync(path.resolve(out), src.thumbnail.toPNG());
  console.log('peek ->', out, width + 'x' + height);
  app.quit();
});
