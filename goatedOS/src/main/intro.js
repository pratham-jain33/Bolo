const { BrowserWindow, screen } = require('electron');
const path = require('path');
const settings = require('./settings');
const notch = require('./notch');
const onboarding = require('./onboarding');

// The cinematic intro.
//
// This runs in its own full-display window, before the dashboard onboarding
// steps, and it is where the user actually meets the product: a short animated
// opening, a get-started gate, then two spoken exchanges — the agent asks for a
// name, then for a language, and answers both out loud through the notch.
//
// The original ships this as a rendered video with a music score. There is no
// video here: the sequence is driven by CSS and canvas in intro.js, and the
// narration is the platform speech synthesiser (see the renderer). That keeps
// the beats — which are the part that matters — without shipping someone else's
// media.
//
// Because it covers the screen and floats, this window has to be trivially
// escapable. Three things guarantee that: it is sized to the work area rather
// than the full display, so the taskbar stays reachable; it keeps its taskbar
// button; and the renderer closes it on Escape. An always-on-top window with
// none of those is a window the user cannot get out of.

let win = null;
let preloadPath = null;
let rendererDir = null;
let active = false;

// Mirrors the exchange phases the notch renders, so an external observer (and
// the renderer itself) can tell what the intro is waiting on.
let phase = 'idle'; // idle | glow | get-started | name | language | handoff

function create(preload, dir) {
  preloadPath = preload;
  rendererDir = dir;

  // workArea, not bounds: `bounds` includes the taskbar, so a window at those
  // coordinates covers it and takes away the one control the user can always
  // reach. `bounds` is kept as a fallback for platforms that report a degenerate
  // work area.
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const area = wa && wa.width > 0 ? wa : display.bounds;

  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    // Transparent on purpose: the opening is an overlay on the user's own
    // desktop, dimmed by the renderer's scrim, not a full-screen canvas with its
    // own backdrop. An opaque window here would hide the desktop entirely and
    // the handoff would read as a cut rather than as something lifting away.
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    // Visible in the taskbar on purpose — it doubles as an escape hatch.
    skipTaskbar: false,
    resizable: false,
    movable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    title: 'Welcome to bolo',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // The first narration line lands before any click, so the intro has to be
      // allowed to speak without a gesture.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.loadFile(path.join(rendererDir, 'intro.html'));
  // 'floating' rather than 'screen-saver': still above ordinary windows, but it
  // sits below system dialogs and the taskbar's own menus, so the shell can
  // always draw on top of it.
  win.setAlwaysOnTop(true, 'floating');
  win.on('closed', () => { win = null; active = false; });
  return win;
}

function start() {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no-intro-window' };
  active = true;
  phase = 'glow';
  // The intro draws its own capsule over the scrim, and narration lines far
  // outlast the auto-hide delay, so the real notch window is held down for the
  // whole sequence. setIntroHidden is a gate, not a hide(): the narrator, the
  // voice machine and the boot-time appearance pass all reach the notch while
  // this is on screen, and any of them would put it back.
  notch.setIntroHidden(true);
  win.show();
  win.focus();
  // `sounds` rides along so the renderer can start with the narrator already
  // silenced if the user has turned interaction sounds off.
  win.webContents.send('bolo:intro-phase', {
    phase,
    sounds: settings.get('interactionSounds') !== false
  });
  return { ok: true };
}

function send(phaseName, payload) {
  phase = phaseName;
  if (win && !win.isDestroyed()) {
    win.webContents.send('bolo:intro-phase', { phase: phaseName, ...(payload || {}) });
  }
}

// Called by the renderer as it moves through the sequence, so the notch can
// narrate in step with what is on screen.
function onPhase(phaseName, payload) {
  phase = phaseName;
  // The intro window has no console of its own, so its progress is echoed here.
  console.log('[bolo intro] phase → ' + phaseName);

  switch (phaseName) {
    // The intro owns the screen and the notch window is held down by
    // setIntroHidden() for the whole sequence, so no phase here reveals it. The
    // name and language beats narrate through intro-narrate, which is likewise
    // gated while the intro is active.
    case 'welcome':
    case 'name':
    case 'language':
      break;
    case 'handoff':
      notch.hide();
      break;
    default:
      break;
  }
  return { ok: true, phase };
}

// The renderer persisted name/language as the user went; fold them into the
// onboarding store and jump the dashboard past the two steps the intro already
// covered, so the user isn't asked their name twice.
function finish(outcome) {
  const ob = onboarding.get();
  const d = ob.data || {};

  onboarding.set({
    introSeen: true,
    firstName: d.firstName || '',
    lastName: d.lastName || '',
    defaultLanguage: d.defaultLanguage || 'en',
    enabledLanguages: d.enabledLanguages || ['en']
  });

  active = false;
  // Release the gate and hand the surface back to normal operation — the
  // resting tab, which is where the app keeps it outside the intro.
  notch.setIntroHidden(false);

  if (win && !win.isDestroyed()) {
    win.hide();
  }

  // The intro now hosts the ENTIRE first-run flow — permissions, keys, the
  // dictation/edit demos, email, the lot — so reaching finish means setup is
  // done, not that it should resume on the dashboard. Complete the onboarding so
  // the dashboard comes up clean, with no overlay. 'skipped' completes it too:
  // the user chose to leave setup, and a half-open overlay behind the dashboard
  // is exactly the seam this rework removes.
  //
  // Replaying the intro from Settings must not re-complete an already-finished
  // setup differently, so this only runs while onboarding is still open.
  if (!ob.completed) onboarding.complete();

  return { ok: true, outcome: outcome || 'completed', onboarding: onboarding.get() };
}

// Tear the intro down without touching onboarding state. Used when the renderer
// never came up — the user still needs to reach the dashboard.
function abort() {
  active = false;
  // The intro is gone either way, so the notch goes back to its normal
  // behaviour rather than staying suppressed.
  notch.setIntroHidden(false);
  if (win && !win.isDestroyed()) win.hide();
  return { ok: true };
}

function isActive() {
  return active;
}

function getWindow() {
  return win;
}

function getState() {
  return { active, phase, hasWindow: !!win && !win.isDestroyed() };
}

module.exports = { create, start, send, onPhase, finish, abort, isActive, getWindow, getState };
