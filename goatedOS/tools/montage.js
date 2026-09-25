// Contact-sheet builder: renders grids of JPEGs to single montage images.
// Run: electron montage.js <inDir> <outDir> <prefix> <cols> <rows> <thumbW> <startIndex> <count>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [, , inDir, outDir, prefix, colsS, rowsS, thumbWS, startS, countS] = process.argv;
const cols = parseInt(colsS, 10);
const rows = parseInt(rowsS, 10);
const thumbW = parseInt(thumbWS, 10);
const start = parseInt(startS, 10);
const count = parseInt(countS, 10);

const files = fs.readdirSync(inDir).filter(f => /\.jpe?g$/i.test(f)).sort();
const slice = files.slice(start, start + count);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1600, height: 1000,
    webPreferences: { backgroundThrottling: false, offscreen: false },
  });
  await win.loadURL('data:text/html,<html><body style="margin:0"><canvas id=c></canvas></body></html>');

  const perSheet = cols * rows;
  const sheets = Math.ceil(slice.length / perSheet);

  for (let s = 0; s < sheets; s++) {
    const group = slice.slice(s * perSheet, (s + 1) * perSheet);
    const payload = group.map(f => {
      const b = fs.readFileSync(path.join(inDir, f));
      return { name: f, data: 'data:image/jpeg;base64,' + b.toString('base64') };
    });

    const out = await win.webContents.executeJavaScript(`(async () => {
      const items = ${JSON.stringify(payload)};
      const cols = ${cols}, rows = ${rows}, thumbW = ${thumbW};
      const imgs = await Promise.all(items.map(it => new Promise((res) => {
        const im = new Image();
        im.onload = () => res({ im, label: it.name });
        im.onerror = () => res(null);
        im.src = it.data;
      })));
      const first = imgs.find(Boolean);
      const ar = first ? first.im.height / first.im.width : 0.5647;
      const thumbH = Math.round(thumbW * ar);
      const pad = 4, labelH = 16;
      const c = document.getElementById('c');
      c.width = cols * (thumbW + pad) + pad;
      c.height = rows * (thumbH + labelH + pad) + pad;
      const g = c.getContext('2d');
      g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
      imgs.forEach((entry, i) => {
        const cx = (i % cols) * (thumbW + pad) + pad;
        const cy = Math.floor(i / cols) * (thumbH + labelH + pad) + pad;
        if (!entry) { g.fillStyle = '#f00'; g.fillRect(cx, cy, thumbW, thumbH); return; }
        g.drawImage(entry.im, cx, cy, thumbW, thumbH);
        g.fillStyle = '#0f0';
        g.font = 'bold 11px monospace';
        g.fillText(entry.label, cx + 2, cy + thumbH + 12);
      });
      return c.toDataURL('image/jpeg', 0.82);
    })()`);

    const base64 = out.replace(/^data:image\/jpeg;base64,/, '');
    const outPath = path.join(outDir, `${prefix}-sheet${String(s).padStart(2, '0')}.jpg`);
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    console.log('wrote', outPath);
  }

  app.quit();
});
