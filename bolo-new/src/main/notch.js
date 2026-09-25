const { BrowserWindow, screen } = require('electron');
const path = require('path');
const settings = require('./settings');
const trace = require('./trace');

// The agent notch: a small always-on-top capsule pinned to an edge of the
// display that shows what the agent is doing and speaks its replies. bolo
// hangs the equivalent off the physical MacBook notch; on a machine without one
// this is a free-floating capsule, so every aspect of where it sits and how it
// behaves is a setting rather than a constant.
//
// The window is sized to the capsule plus a shadow gutter and resized by the
// renderer as content changes height, so the transparent margin never grows
// into a large invisible click target.

const GUTTER = 16;

// The two capsule widths, measured off the reference: a 286px tab when idle and
// a 442px panel when it has something to say. The renderer measures itself and
// corrects these every frame while it morphs, so they are starting guesses
// rather than limits.
const COLLAPSED_W = 104;
const EXPANDED_W = 442;

// "Expands a bit" while the agent is actually working. The reference keeps the
// listening capsule at its collapsed width and only swaps the orb for a
// waveform; the user asked for a visible step up from the resting tab instead,
// so listening/thinking get a third width between the two.
const MID_W = 240;

// Collapsed / thinking / reply heights for the capsule itself. The renderer
// sends its measured size back over bolo:notch-resize when it needs
// something outside these, so these are defaults rather than limits.
//
// `idle` is the resting tab: the smallest form, the one that stays on screen.
const PHASE_HEIGHT = {
  hidden: 0,
  idle: 32,
  welcome: 32,
  listening: 32,
  thinking: 32,
  hint: 86,
  reply: 150,
  error: 200,
  media: 348,
  compose: 512
};

const OPEN_PHASES = ['hint', 'reply', 'error', 'media', 'compose'];
const MID_PHASES = ['listening', 'thinking'];

// The phase the capsule falls back to. See rest().
const REST_PHASE = 'idle';

// The two axes the reference exposes for the capsule, independently of where it
// sits: which edge it hangs from, and what it is made of.
//
//   variant   'top'   flush with the top edge, horizontally placed by position
//             'side'  flush with a vertical edge, vertically centred
//   material  'solid' opaque black — what the reference recording actually shows
//             'glass' translucent, edge-lit; the reference gates this to macOS 26
const VARIANTS = ['top', 'side'];
const MATERIALS = ['solid', 'glass'];

let win = null;
let preloadPath = null;
let rendererDir = null;
let currentPhase = 'hidden';
let currentWidth = COLLAPSED_W;
let currentHeight = PHASE_HEIGHT.idle;
let hideTimer = null;
let hovered = false;
// While the cinematic intro owns the screen the notch must stay above its
// fullscreen window: on Windows always-on-top levels are a single band, so
// activating the intro (clicking the trial box) would otherwise bury the
// capsule behind opaque glass exactly when a trial needs it. Set by intro.js
// for the beats, cleared on finish/abort.
let aboveIntro = false;
// The intro's narration lines run far longer than the auto-hide delay, so the
// intro holds this open for the length of the sequence rather than racing it.
let autoHideSuppressed = false;
// The real capsule is live the whole time the app is open — including over the
// intro — so setIntroHidden() no longer gates anything. The one thing the intro
// still owns is window stacking: while the sequence is up the capsule outranks
// the fullscreen intro even with always-on-top off, and finish()/abort() clear
// the pin.
let introHidden = false;

function variant() {
  const v = settings.get('notchVariant');
  return VARIANTS.includes(v) ? v : 'top';
}

function material() {
  const m = settings.get('notchMaterial');
  return MATERIALS.includes(m) ? m : 'solid';
}

function isRightSide() {
  return (settings.get('notchSide') || 'right') === 'right';
}

// The two Visibility switches are per-variant, not global: someone who wants a
// top notch and no side notch is describing the normal case, not an edge one.
function hiddenByVariant() {
  return variant() === 'top'
    ? !!settings.get('hideTopNotch')
    : !!settings.get('hideSideNotch');
}

// Everything the renderer needs to draw the right shape in the right material.
// Sent with every phase change as well as on every appearance change, because a
// material swap while the capsule is on screen is a Settings interaction.
function skin() {
  return {
    variant: variant(),
    material: material(),
    side: isRightSide() ? 'right' : 'left',
    position: settings.get('notchPosition') || 'top-center',
    // The renderer prints the hint line's keycaps from this, so the capsule
    // names the key that is really bound rather than a hard-coded one.
    shortcut: settings.voiceShortcut()
  };
}

// The window is the capsule plus a transparent gutter. Everything here is
// expressed in terms of where the *capsule* should sit, and the gutter is then
// hung around it — so anchoring the capsule flush with the top of the work area
// does not get pushed down by the shadow's breathing room.
function capsuleBox() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const ox = settings.get('notchOffsetX') || 0;
  const oy = settings.get('notchOffsetY') || 0;
  const w = currentWidth;
  const h = Math.max(32, currentHeight);

  // Side notch: flush with a vertical edge and vertically centred. The offsets
  // still apply, so a side notch can be nudged along its edge like a top one.
  if (variant() === 'side') {
    return {
      x: (isRightSide() ? wa.x + wa.width - w : wa.x) + ox,
      y: Math.round(wa.y + (wa.height - h) / 2) + oy,
      width: w,
      height: h
    };
  }

  switch (settings.get('notchPosition') || 'top-center') {
    case 'top-left':
      return { x: wa.x + ox, y: wa.y + oy, width: w, height: h };
    case 'top-right':
      return { x: wa.x + wa.width - w + ox, y: wa.y + oy, width: w, height: h };
    case 'bottom-center':
      return {
        x: Math.round(wa.x + (wa.width - w) / 2) + ox,
        y: wa.y + wa.height - h + oy,
        width: w,
        height: h
      };
    case 'center':
      return {
        x: Math.round(wa.x + (wa.width - w) / 2) + ox,
        y: Math.round(wa.y + (wa.height - h) / 2) + oy,
        width: w,
        height: h
      };
    case 'top-center':
    default:
      return {
        x: Math.round(wa.x + (wa.width - w) / 2) + ox,
        y: wa.y + oy,
        width: w,
        height: h
      };
  }
}

function bounds() {
  const c = capsuleBox();
  // Gutter on the sides the capsule does not touch. A top notch meets the top
  // edge of the screen, so it gets none above it; a side notch meets its
  // vertical edge, so it gets none outside — only inner, above and below.
  if (variant() === 'side') {
    return {
      x: isRightSide() ? c.x - GUTTER : c.x,
      y: c.y - GUTTER,
      width: c.width + GUTTER,
      height: c.height + GUTTER * 2
    };
  }
  return {
    x: c.x - GUTTER,
    y: c.y,
    width: c.width + GUTTER * 2,
    height: c.height + GUTTER
  };
}

function create(preload, dir) {
  preloadPath = preload;
  rendererDir = dir;

  if (!settings.get('notchEnabled')) return null;

  const b = bounds();
  win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Load-bearing, and the same flag the hidden capture window carries.
      //
      // This surface is transparent, never focused and always on top, which is
      // precisely the window class Chromium marks occluded — and an occluded
      // window gets its requestAnimationFrame loop and its timers throttled or
      // stopped. The capsule draws its level meter AND reports its own geometry
      // to main from rAF, so a throttled renderer is a capsule that stops
      // responding and stops resizing, with nothing on screen to say why. This
      // window must keep running whether or not the user is looking at it.
      backgroundThrottling: false,
      // The notch is never focused and never clicked (it floats over whatever
      // app you are in), so without this its replies would be silenced by the
      // autoplay policy — which reads as "the voice is broken" rather than as a
      // policy decision.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.loadFile(path.join(rendererDir, 'notch.html'));
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(!!settings.get('notchAlwaysOnTop'), 'floating');
  win.setOpacity(clamp01(settings.get('notchOpacity')));

  // The resting tab goes up as soon as the page can receive it. Waiting on
  // did-finish-load is not optional: a send before the renderer has registered
  // its listener is dropped, and the capsule would then sit blank until the
  // first voice action.
  win.webContents.once('did-finish-load', () => {
    trace.log('notch', 'window ready', { bounds: bounds() });
    startAliveWatch();
    rest();
  });

  // Track hover so "only show on hover" and "stay while hovered" can work.
  win.on('blur', () => { /* never focused; nothing to do */ });
  return win;
}

function clamp01(v) {
  const n = typeof v === 'number' ? v : 1;
  return Math.max(0.15, Math.min(1, n));
}

// Send a phase + text to the notch and reveal it. This is the main entry point:
// the voice state machine, the onboarding flow and the wake-word detector all
// talk to the notch through here.
function show(phase, payload) {
  if (!win || win.isDestroyed()) {
    trace.log('notch', 'show refused: no window', { phase });
    return;
  }
  // Visibility is a hard gate, not a one-shot: the voice machine, the intro and
  // the wake detector all reach the notch through here, and any of them would
  // otherwise be able to bring back a surface the user switched off.
  //
  // Both gates are traced. A refused show() is invisible by construction — the
  // capsule simply does not change — so a silent no here reads to the user as
  // "the notch is broken" rather than "the notch was told to stay hidden".
  if (hiddenByVariant()) {
    trace.log('notch', 'show refused: hidden by variant', { phase, variant: variant() });
    return;
  }
  trace.log('notch', 'show', { phase, width: currentWidth });

  currentPhase = PHASE_HEIGHT[phase] !== undefined ? phase : 'reply';
  currentHeight = PHASE_HEIGHT[currentPhase];
  currentWidth = OPEN_PHASES.includes(currentPhase) ? EXPANDED_W
    : MID_PHASES.includes(currentPhase) ? MID_W
      : COLLAPSED_W;

  win.webContents.send('bolo:notch-state', {
    phase: currentPhase,
    ...skin(),
    ...(payload || {})
  });
  win.setBounds(bounds());
  if (!win.isVisible()) win.showInactive();

  // Auto-collapse only applies to terminal phases; while the agent is thinking
  // or the user is mid-exchange, the capsule stays open. It collapses to the
  // resting tab rather than hiding — see rest().
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const delay = settings.get('notchAutoHideMs');
  if ((currentPhase === 'reply' || currentPhase === 'error') && delay > 0 && !hovered && !autoHideSuppressed) {
    hideTimer = setTimeout(() => { if (!hovered) rest(); }, delay);
  }
}

// Collapse back to the smallest tab, still on screen.
//
// The notch does not disappear when a reply ends. It is the app's one permanent
// affordance — the thing that says the agent is there and which key calls it —
// so it shrinks back to its resting form and stays pinned to the edge. The
// reference behaves this way too, and the user asked for it in as many words:
// "let the smallest notch stay up there and not disappear".
//
// This is deliberately not hide(). A real hide belongs to the user switching the
// surface off (applyAppearance) or to the intro, which draws its own capsule and
// must not have two on screen at once.
function rest() {
  if (!win || win.isDestroyed()) return;
  if (!settings.get('notchEnabled') || hiddenByVariant()) {
    trace.log('notch', 'rest refused: switched off', { enabled: !!settings.get('notchEnabled') });
    return;
  }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  currentPhase = REST_PHASE;
  currentHeight = PHASE_HEIGHT[REST_PHASE];
  currentWidth = COLLAPSED_W;

  win.webContents.send('bolo:notch-state', { phase: REST_PHASE, ...skin() });
  win.setBounds(bounds());
  if (!win.isVisible()) win.showInactive();
}

function suppressAutoHide(on) {
  autoHideSuppressed = !!on;
  if (autoHideSuppressed && hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

// Hold the stacking pin for the length of the cinematic intro. The capsule is
// not suppressed while the intro is up — see the note on `introHidden` above —
// it simply outranks the intro's own window. Clearing it returns the knob to
// normal always-on-top behaviour.
function setIntroHidden(on) {
  introHidden = !!on;
  trace.log('notch', introHidden ? 'held down for the intro' : 'handed back by the intro');
  rest();
}

// Pin the capsule above the intro's fullscreen window for the onboarding
// beats; see aboveIntro. No-op safe to call any time.
function setAboveIntro(on) {
  aboveIntro = !!on;
  trace.log('notch', 'intro pin', aboveIntro ? 'on' : 'off');
  if (!win || win.isDestroyed()) return;
  if (aboveIntro) {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    } catch (_) {}
    return;
  }
  // Clearing the pin has to put the level back, not just forget it. Without
  // this the capsule stays parked at 'screen-saver' after the intro and floats
  // over things the user's own always-on-top setting would have kept it under.
  try {
    win.setAlwaysOnTop(true, 'floating');
  } catch (_) {}
  try { applyAppearance(); } catch (_) {}
}

/* ---------------------------------------------------------------------------
   Liveness

   The renderer is the only thing that knows the capsule is still drawing: it
   drives the meter from requestAnimationFrame and reports its own size from the
   same loop. If that loop is throttled away — an occluded transparent overlay is
   the classic case — the window still exists, still reports isVisible(), and
   simply stops. That is indistinguishable from "the notch is broken" unless
   something notices the silence, so the renderer pings and main times the gap.
   ------------------------------------------------------------------------ */
const ALIVE_MAX_GAP_MS = 6000;
let lastAliveAt = 0;
let aliveTimer = null;
let aliveWarned = false;

// The renderer's ping. It carries its requestAnimationFrame tick count, which is
// the thing that actually stops when Chromium throttles the window — the counter
// freezing is the evidence, the timestamp alone would also freeze if the renderer
// died outright.
function noteAlive(info) {
  lastAliveAt = Date.now();
  if (aliveWarned) {
    aliveWarned = false;
    trace.log('notch', 'renderer responsive again', info);
  }
  return { ok: true };
}

function startAliveWatch() {
  lastAliveAt = Date.now();
  aliveWarned = false;
  if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
  aliveTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    // Only a capsule that is supposed to be on screen owes us anything; a
    // hidden one is allowed to stop drawing.
    if (!win.isVisible()) return;
    const gap = Date.now() - lastAliveAt;
    if (gap > ALIVE_MAX_GAP_MS && !aliveWarned) {
      aliveWarned = true;
      trace.log('notch', 'renderer silent while visible — the capsule is up but not drawing', { gapMs: gap });
    }
  }, 2000);
}

function hide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  currentPhase = 'hidden';
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

function setHovered(on) {
  hovered = !!on;
  if (hovered && hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (!hovered && settings.get('notchShowOnHover')) hide();
  else if (!hovered && currentPhase !== 'hidden') show(currentPhase, { keepText: true });
}

// The renderer measures its own content and asks for the size it needs. It
// sends { width, height } every frame while the capsule is morphing, so the
// window tracks the width transition rather than snapping at the end of it.
// A bare number is still accepted for older callers that only sent a height.
function resizeContent(size) {
  if (!win || win.isDestroyed()) return;

  let w = currentWidth;
  let h = currentHeight;
  if (typeof size === 'number') {
    h = size;
  } else if (size && typeof size === 'object') {
    if (Number.isFinite(size.width)) w = size.width;
    if (Number.isFinite(size.height)) h = size.height;
  }

  // The height ceiling follows the display so a long reply can grow the capsule
  // to most of the screen before the renderer's own overflow takes over, rather
  // than being clipped at a fixed 560. Width stays capped — the capsule only
  // ever grows downward.
  let hCeil = 560;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    hCeil = Math.max(200, Math.round(wa.height * 0.72));
  } catch (_) {}
  w = Math.max(180, Math.min(720, Number(w) || COLLAPSED_W));
  h = Math.max(32, Math.min(hCeil, Number(h) || PHASE_HEIGHT.reply));

  if (w === currentWidth && h === currentHeight) return;
  currentWidth = w;
  currentHeight = h;
  win.setBounds(bounds());
}

// Re-apply every appearance setting. Called when Settings changes any of them.
function applyAppearance() {
  if (!win || win.isDestroyed()) return;

  if (!settings.get('notchEnabled') || hiddenByVariant()) {
    hide();
    // Belt as well as braces: hide() is a no-op when the window already thinks
    // it is hidden, and switching visibility off should not depend on that.
    if (win.isVisible()) win.hide();
    return;
  }

  win.setOpacity(clamp01(settings.get('notchOpacity')));
  // During the intro beats the capsule outranks the fullscreen intro window,
  // even if the user switched always-on-top off — visibility beats the setting
  // while setup is unfinished, and finish()/abort() clear the pin.
  // The intro pin (aboveIntro) and the normal always-on-top setting both land
  // at 'floating' — the same level as the intro window itself. Promoting to
  // 'screen-saver' was what desynced the task-switcher focus model: a
  // non-focusable, skipTaskbar overlay one level above the focused intro made
  // Windows' "last active switchable window" record point at a stale entry, so
  // Alt+Tab back to the app re-focused the *other* window instead of the
  // intro. One band, not two.
  win.setAlwaysOnTop(aboveIntro || !!settings.get('notchAlwaysOnTop'), 'floating');

  // Switching the surface back on should put the resting tab up. Without this
  // the window would be re-bounded while still in its 'hidden' phase, i.e.
  // switched on and invisible — indistinguishable from the setting not working.
  if (currentPhase === 'hidden') { rest(); return; }

  win.setBounds(bounds());
  // A variant or material swap has to reach the renderer, which is what draws
  // the shape — the window geometry alone would leave a top notch styled as a
  // side one until the next phase change.
  win.webContents.send('bolo:notch-state', {
    phase: currentPhase,
    keepText: true,
    ...skin()
  });
}

function getState() {
  return {
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    phase: currentPhase,
    enabled: !!settings.get('notchEnabled'),
    variant: variant(),
    side: isRightSide() ? 'right' : 'left',
    material: material(),
    position: settings.get('notchPosition'),
    width: settings.get('notchWidth'),
    offsetX: settings.get('notchOffsetX'),
    offsetY: settings.get('notchOffsetY'),
    opacity: settings.get('notchOpacity'),
    autoHideMs: settings.get('notchAutoHideMs'),
    alwaysOnTop: !!settings.get('notchAlwaysOnTop'),
    hovered,
    showOnHover: !!settings.get('notchShowOnHover'),
    hidePill: !!settings.get('hidePill'),
    hideTopNotch: !!settings.get('hideTopNotch'),
    hideSideNotch: !!settings.get('hideSideNotch'),
    bounds: win && !win.isDestroyed() ? win.getBounds() : null
  };
}

module.exports = {
  create, show, hide, rest, setHovered, resizeContent, applyAppearance, getState,
  suppressAutoHide, setIntroHidden, setAboveIntro, noteAlive,
  skin, variant, material,
  getWindow: () => win,
  PHASE_HEIGHT,
  VARIANTS,
  MATERIALS
};
