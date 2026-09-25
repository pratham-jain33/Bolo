// Measures a reference video frame in pixels.
//
//   electron tools/frame-probe.js <frame.jpg> [rows]
//   electron tools/frame-probe.js --scan <dir> [stride]
//
// The frames are the ground truth for the dashboard's layout, and they are
// images: they have to be measured rather than admired. This reads them through
// nativeImage (no decode library, no browser) and reports the numbers a layout
// is actually made of — where the sidebar ends, where each card starts and
// stops, how tall each block is, and what colour the surfaces are.
//
// Two modes:
//
//   frame  a full report on one image: surface colours, column edges through a
//          vertical scan, and row edges through a horizontal one. An "edge" is
//          a place where neighbouring pixels differ by more than the threshold,
//          which is what a card border, a divider or a background change is.
//   --scan a one-line signature per frame, so the frames that show a given
//          screen can be found without looking at all of them.
//
// Coordinates are printed in the frame's own pixels. The recording is 1920×1248
// while the app window inside it is smaller, so the window's own box is reported
// separately by looking for the first and last rows/columns that are not the
// letterbox colour.

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const EDGE_THRESHOLD = 12;

function load(file) {
  const img = nativeImage.createFromPath(file);
  const size = img.getSize();
  if (!size.width) return null;
  return { img, w: size.width, h: size.height, bmp: img.getBitmap() };
}

// nativeImage hands back BGRA.
function px(f, x, y) {
  const xi = Math.max(0, Math.min(f.w - 1, x | 0));
  const yi = Math.max(0, Math.min(f.h - 1, y | 0));
  const i = (yi * f.w + xi) * 4;
  return { b: f.bmp[i], g: f.bmp[i + 1], r: f.bmp[i + 2], a: f.bmp[i + 3] };
}

const hex = (c) =>
  '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');

const dist = (a, b) =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

const luma = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;

// Average a small patch so JPEG noise cannot masquerade as an edge.
function patch(f, x, y, n = 2) {
  let r = 0, g = 0, b = 0, count = 0;
  for (let dy = -n; dy <= n; dy++) {
    for (let dx = -n; dx <= n; dx++) {
      const c = px(f, x + dx, y + dy);
      r += c.r; g += c.g; b += c.b; count++;
    }
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

// Where the pixel value changes along a line, as runs of the same surface.
// Returned as the x (or y) at which each new run begins, with its colour.
function runs(f, axis, fixed, from, to) {
  const out = [];
  let cur = null;
  const at = (v) => (axis === 'x' ? patch(f, v, fixed) : patch(f, fixed, v));
  for (let v = from; v < to; v++) {
    const c = at(v);
    if (!cur || dist(cur, c) > EDGE_THRESHOLD) {
      // Ignore one- or two-pixel excursions: a card's 1px border is a real
      // edge, a stray JPEG artefact is not.
      if (cur && v - out[out.length - 1].at < 3) {
        out.pop();
      }
      out.push({ at: v, color: c });
      cur = c;
    } else {
      cur = c;
    }
  }
  // Runs shorter than 4px are noise.
  return out.filter((r, i) => i === out.length - 1 || out[i + 1].at - r.at >= 4);
}

function windowBox(f) {
  const corner = patch(f, 3, 3, 1);
  let left = 0, right = f.w - 1, top = 0, bottom = f.h - 1;
  const rowIsLetterbox = (y) => dist(patch(f, 3, y, 1), corner) <= EDGE_THRESHOLD * 2;
  const colIsLetterbox = (x) => dist(patch(f, x, 3, 1), corner) <= EDGE_THRESHOLD * 2;
  while (top < f.h - 1 && rowIsLetterbox(top)) top++;
  while (bottom > top && rowIsLetterbox(bottom)) bottom--;
  while (left < f.w - 1 && colIsLetterbox(left)) left++;
  while (right > left && colIsLetterbox(right)) right--;
  return { left, top, right, bottom, corner: hex(corner), cornerLuma: luma(corner).toFixed(3) };
}

// A card is a light (or dark) rounded rectangle on the page background. Its top
// and bottom edges are the strongest horizontal changes down a column, so a
// vertical scan through the content area finds the block stack.
function report(file) {
  const f = load(file);
  if (!f) { console.log('could not read', file); return; }
  const box = windowBox(f);
  console.log('frame      ', path.basename(file));
  console.log('size       ', f.w + 'x' + f.h);
  console.log('window box ', JSON.stringify(box));
  console.log('letterbox  ', box.corner, 'luma', box.cornerLuma);

  const winH = box.bottom - box.top + 1;
  const winW = box.right - box.left + 1;
  console.log('window size', winW + 'x' + winH);

  // Surfaces: page background, sidebar background, card background.
  const sample = (label, x, y) => {
    const c = patch(f, x, y);
    console.log(('  ' + label).padEnd(18), hex(c), 'luma', luma(c).toFixed(3), '(' + x + ',' + y + ')');
  };
  console.log('surfaces');
  sample('window top-left', box.left + 8, box.top + 8);
  sample('sidebar mid', box.left + 40, box.top + Math.round(winH * 0.5));
  sample('content top', box.left + Math.round(winW * 0.55), box.top + 12);
  sample('content mid', box.left + Math.round(winW * 0.55), box.top + Math.round(winH * 0.5));
  sample('content bottom', box.left + Math.round(winW * 0.55), box.bottom - 10);

  // Vertical split: the sidebar meets the content somewhere in the left third.
  console.log('column edges across row y=' + (box.top + Math.round(winH * 0.5)));
  const rowY = box.top + Math.round(winH * 0.5);
  for (const r of runs(f, 'x', rowY, box.left, box.left + Math.round(winW * 0.4))) {
    console.log('  x=' + String(r.at).padEnd(5), hex(r.color), 'luma', luma(r.color).toFixed(3));
  }

  // Horizontal block stack down a column in the content area.
  const colX = box.left + Math.round(winW * 0.32);
  console.log('row edges down column x=' + colX);
  for (const r of runs(f, 'y', colX, box.top, box.bottom)) {
    console.log('  y=' + String(r.at).padEnd(5), hex(r.color), 'luma', luma(r.color).toFixed(3));
  }
  return { f, box };
}

function scan(dir, stride) {
  const files = fs.readdirSync(dir).filter((n) => /\.jpe?g$/i.test(n)).sort();
  for (let i = 0; i < files.length; i += stride) {
    const file = path.join(dir, files[i]);
    const f = load(file);
    if (!f) { console.log(files[i], 'unreadable'); continue; }
    const box = windowBox(f);
    const midY = box.top + Math.round((box.bottom - box.top) / 2);
    const sidebar = patch(f, box.left + 40, midY);
    const content = patch(f, box.left + Math.round((box.right - box.left) * 0.55), midY);
    // How many distinct surfaces down the content column: a screen with cards
    // has several, a blank or transitional screen has one or two.
    const colX = box.left + Math.round((box.right - box.left) * 0.32);
    const stack = runs(f, 'y', colX, box.top, box.bottom).length;
    console.log(
      files[i].padEnd(20),
      'bg=' + hex(box.corner),
      'sidebar=' + hex(sidebar),
      'content=' + hex(content),
      'luma=' + luma(content).toFixed(2),
      'blocks=' + stack
    );
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const [, , first, second] = process.argv;
  if (!first) {
    console.log('usage: frame-probe.js <frame.jpg> [rows]  |  frame-probe.js --scan <dir> [stride]');
    app.exit(0);
    return;
  }
  if (first === '--scan') {
    scan(second, parseInt(process.argv[5] || '4', 10));
  } else {
    report(first);
  }
  app.exit(0);
});
