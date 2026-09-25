// Pixel probe + cropper + ASCII masker. Usage: electron probe.js <specfile.json>
// Job: { img, crops?:[{x,y,w,h,scale,out}], probes?:[[x,y]], grid?:{x,y,w,h,cols,rows},
//        masks?:[{x,y,w,h,cols,rows,t,mode:'light'|'dark',label}] }
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const specPath = process.argv[2];
const jobs = JSON.parse(fs.readFileSync(specPath, 'utf8'));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1600, height: 1000,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL('data:text/html,<html><body style="margin:0"><canvas id=c></canvas></body></html>');

  for (const job of jobs) {
    const buf = fs.readFileSync(job.img);
    const mime = /\.png$/i.test(job.img) ? 'image/png' : 'image/jpeg';
    const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    const ops = {
      crops: job.crops || [], probes: job.probes || [],
      grid: job.grid || null, masks: job.masks || [], blobs: job.blobs || [],
    };

    const result = await win.webContents.executeJavaScript(`(async () => {
      const ops = ${JSON.stringify(ops)};
      const im = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = ${JSON.stringify(dataUrl)};
      });
      const c = document.getElementById('c');
      const g = c.getContext('2d', { willReadFrequently: true });
      const out = { size: [im.width, im.height], crops: [], probes: [], grid: [], masks: [], blobs: [] };
      const hex = (r,gg,b) => '#' + [r,gg,b].map(v => v.toString(16).padStart(2,'0')).join('');

      c.width = im.width; c.height = im.height;
      g.drawImage(im, 0, 0);

      for (const p of ops.probes) {
        const d = g.getImageData(Math.round(p[0]), Math.round(p[1]), 1, 1).data;
        out.probes.push({ at: p, hex: hex(d[0],d[1],d[2]) });
      }

      if (ops.grid) {
        const { x, y, w, h, cols, rows } = ops.grid;
        for (let r = 0; r < rows; r++) {
          const row = [];
          for (let cc = 0; cc < cols; cc++) {
            const px = Math.round(x + (w * (cc + 0.5)) / cols);
            const py = Math.round(y + (h * (r + 0.5)) / rows);
            const d = g.getImageData(px, py, 1, 1).data;
            row.push(hex(d[0],d[1],d[2]));
          }
          out.grid.push(row);
        }
      }

      for (const m of ops.masks) {
        const img = g.getImageData(m.x, m.y, m.w, m.h);
        const rows = [];
        for (let r = 0; r < m.rows; r++) {
          let line = '';
          for (let cc = 0; cc < m.cols; cc++) {
            // average the block for a stable sample
            let sum = 0, n = 0;
            const x0 = Math.floor((cc * m.w) / m.cols), x1 = Math.max(x0 + 1, Math.floor(((cc + 1) * m.w) / m.cols));
            const y0 = Math.floor((r * m.h) / m.rows), y1 = Math.max(y0 + 1, Math.floor(((r + 1) * m.h) / m.rows));
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
              const i = (yy * m.w + xx) * 4;
              sum += 0.2126 * img.data[i] + 0.7152 * img.data[i+1] + 0.0722 * img.data[i+2];
              n++;
            }
            const lum = sum / Math.max(1, n);
            const on = m.mode === 'dark' ? lum < m.t : lum > m.t;
            line += on ? '#' : '.';
          }
          rows.push(line);
        }
        out.masks.push({ label: m.label || '', rows });
      }

      for (const m of ops.blobs) {
        const img = g.getImageData(m.x, m.y, m.w, m.h);
        const on = new Uint8Array(m.w * m.h);
        for (let i = 0; i < m.w * m.h; i++) {
          const j = i * 4;
          const lum = 0.2126 * img.data[j] + 0.7152 * img.data[j+1] + 0.0722 * img.data[j+2];
          on[i] = (m.mode === 'dark' ? lum < m.t : lum > m.t) ? 1 : 0;
        }
        const seen = new Uint8Array(m.w * m.h);
        const found = [];
        for (let start = 0; start < on.length; start++) {
          if (!on[start] || seen[start]) continue;
          let q = [start]; seen[start] = 1;
          let minx = m.w, maxx = -1, miny = m.h, maxy = -1, n = 0;
          while (q.length) {
            const p = q.pop(); n++;
            const px = p % m.w, py = (p / m.w) | 0;
            if (px < minx) minx = px; if (px > maxx) maxx = px;
            if (py < miny) miny = py; if (py > maxy) maxy = py;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx, ny = py + dy;
              if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
              const np = ny * m.w + nx;
              if (on[np] && !seen[np]) { seen[np] = 1; q.push(np); }
            }
          }
          if (n >= (m.minPx || 4)) {
            found.push({
              x: m.x + minx, y: m.y + miny, w: maxx - minx + 1, h: maxy - miny + 1, px: n,
            });
          }
        }
        found.sort((a, b) => a.x - b.x);
        out.blobs.push({ label: m.label || '', items: found });
      }

      for (const cr of ops.crops) {
        c.width = cr.w * cr.scale; c.height = cr.h * cr.scale;
        g.imageSmoothingEnabled = cr.smooth !== false;
        g.drawImage(im, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w * cr.scale, cr.h * cr.scale);
        out.crops.push({ out: cr.out, data: c.toDataURL('image/png') });
      }
      return out;
    })()`);

    console.log('=== ', path.basename(job.img), 'size', result.size.join('x'));
    for (const p of result.probes) console.log('  probe', p.at.join(','), p.hex);
    if (result.grid.length) {
      console.log('  grid (rows=y, cols=x):');
      for (const row of result.grid) console.log('    ' + row.join(' '));
    }
    for (const m of result.masks) {
      console.log('  mask ' + m.label + ' (' + m.rows[0].length + ' cols):');
      for (const r of m.rows) console.log('    |' + r + '|');
    }
    for (const b of result.blobs) {
      console.log('  blobs ' + b.label + ' (' + b.items.length + '):');
      for (const it of b.items) console.log(`    x=${it.x} y=${it.y} w=${it.w} h=${it.h} px=${it.px}`);
    }
    for (const cr of result.crops) {
      const b64 = cr.data.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(cr.out, Buffer.from(b64, 'base64'));
      console.log('  crop ->', cr.out);
    }
  }
  app.quit();
});
