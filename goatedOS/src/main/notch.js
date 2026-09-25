const { BrowserWindow, screen } = require('electron');
const path = require('path');
const settings = require('./settings');

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
// The intro's narration lines run far longer than the auto-hide delay, so the
// intro holds this open for the length of the sequence rather than racing it.
let autoHideSuppressed = false;
// The cinematic intro draws its own capsule over a translucent scrim and must
// not have a second one on screen. This is a gate rather than a hide(): the
// voice machine, a narrated reply and the boot-time applyAppearance() all reach
// the notch while the intro is up, and any of them would bring the window back.
// See setIntroHidden().
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
  win.webContents.once('did-finish-load', () => rest());

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
  if (!win || win.isDestroyed()) return;
  // Visibility is a hard gate, not a one-shot: the voice machine, the intro and
  // the wake detector all reach the notch through here, and any of them would
  // otherwise be able to bring back a surface the user switched off.
  if (hiddenByVariant()) return;
  if (introHidden) return;

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
  // rest() is the intro's other way back in: it ends with showInactive(), so the
  // intro's own auto-hide timer expiring would surface the tab mid-sequence.
  if (introHidden) return;
  if (!settings.get('notchEnabled') || hiddenByVariant()) return;
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

// Hold the whole notch surface down for the duration of the cinematic intro.
// Unlike hide(), which a later show() simply undoes, this is a gate: show(),
// rest() and applyAppearance() all no-op while it is on, so nothing — a narrated
// reply, a pending resize, the appearance pass main runs at boot — can put the
// capsule up behind the intro's own. Clearing it returns the knob to normal
// operation by putting the resting tab back, which is where everything else
// expects to find it.
function setIntroHidden(on) {
  introHidden = !!on;
  if (introHidden) hide();
  else rest();
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
  // The intro holds the surface down; a pass here would put it back.
  if (introHidden) return;

  if (!settings.get('notchEnabled') || hiddenByVariant()) {
    hide();
    // Belt as well as braces: hide() is a no-op when the window already thinks
    // it is hidden, and switching visibility off should not depend on that.
    if (win.isVisible()) win.hide();
    return;
  }

  win.setOpacity(clamp01(settings.get('notchOpacity')));
  win.setAlwaysOnTop(!!settings.get('notchAlwaysOnTop'), 'floating');

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
    showOnHover: !!settings.get('notchShowOnHover'),
    hidePill: !!settings.get('hidePill'),
    hideTopNotch: !!settings.get('hideTopNotch'),
    hideSideNotch: !!settings.get('hideSideNotch'),
    bounds: win && !win.isDestroyed() ? win.getBounds() : null
  };
}

module.exports = {
  create, show, hide, rest, setHovered, resizeContent, applyAppearance, getState,
  suppressAutoHide, setIntroHidden,
  skin, variant, material,
  getWindow: () => win,
  PHASE_HEIGHT,
  VARIANTS,
  MATERIALS
};
