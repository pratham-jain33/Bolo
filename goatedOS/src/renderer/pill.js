/* ============================================================================
   bolo — pill renderer
   Runs in the small transparent always-on-top window. Drives the vertical
   mic-level meter: a blue fill that rises from the floor of the track, a white
   peak band resting on top of it, and the level as a number underneath.

   The geometry lives in pill.html's CSS custom properties; this file reads
   them rather than repeating the numbers, so the tile can be resized in one
   place.

   Note: this window is contextIsolated, so it reaches the main process through
   the preload's `window.bolo` bridge — never `require('electron')`.
   ========================================================================== */

const pill = document.getElementById('pill');
const fillEl = document.getElementById('fill');
const peakEl = document.getElementById('peak');
const countEl = document.getElementById('count');

const css = getComputedStyle(document.documentElement);
const TRACK_H = parseFloat(css.getPropertyValue('--track-h')) || 78;
const PEAK_H = parseFloat(css.getPropertyValue('--peak-h')) || 10;

/* The peak band is 10px tall inside a 78px track, so its floor can never go
   above 68px without the band's top edge escaping the track's rounded cap. */
const PEAK_MAX = (TRACK_H - PEAK_H) / TRACK_H;

const STATES = ['idle', 'listening', 'processing', 'error'];

let state = 'idle';

// `level` is the smoothed value the fill draws; `peak` is the high-water mark
// the white band sits at. They are separate so a transient still reads for a
// moment after the sound that caused it has gone.
let level = 0;
let peak = 0;
let target = 0;

/* ---------------------------------------------------------------------------
   Meter
   ------------------------------------------------------------------------ */
function tick() {
  const listening = state === 'listening';

  if (listening) {
    // Rise fast, fall slow — a meter that tracks the quiet parts instead of
    // only the loud ones is unreadable.
    const k = target > level ? 0.45 : 0.14;
    level += (target - level) * k;
    if (level < 0.002) level = 0;

    // The peak falls at a constant rate rather than proportionally, so its
    // return is a steady glide instead of an exponential crawl.
    peak = Math.max(level, peak - 0.006);
  } else {
    level += (0 - level) * 0.25;
    peak += (0 - peak) * 0.18;
    if (level < 0.002) level = 0;
    if (peak < 0.002) peak = 0;
  }

  fillEl.style.height = (level * 100).toFixed(1) + '%';
  peakEl.style.bottom = (Math.min(peak, PEAK_MAX) * 100).toFixed(1) + '%';
  countEl.textContent = String(Math.round(level * 100));

  requestAnimationFrame(tick);
}
tick();

/* ---------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------ */
window.bolo.on('bolo:pill-state', (next) => {
  state = STATES.includes(next) ? next : 'idle';
  pill.className = 'pill ' + state;
  if (state !== 'listening') target = 0;
});

window.bolo.on('bolo:voice-level', (payload) => {
  // Main sends { level }, normalised 0..1.
  target = Math.max(0, Math.min(1, (payload && payload.level) || 0));
});
