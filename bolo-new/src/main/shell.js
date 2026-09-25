const { BrowserWindow, Tray, Menu, nativeImage, app, screen } = require('electron');
const path = require('path');
const settings = require('./settings');

let mainWindow = null;
let pillWindow = null;
let tray = null;
// The dashboard is the landing view now, so it is also the default main
// reports before the renderer has said anything.
let currentView = 'dashboard';

function createMain(preloadPath, rendererFile, isDev, opts) {
  const isMac = process.platform === 'darwin';
  const deferShow = !!(opts && opts.deferShow);

  mainWindow = new BrowserWindow({
    // bolo dashboard geometry.
    width: 1080,
    height: 710,
    minWidth: 720,
    minHeight: 520,
    show: false,
    // Frameless with a custom titlebar; the sheet itself is rounded to 20px.
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    // Only macOS gets a transparent window — native vibrancy needs it. On
    // Windows/Linux an opaque background lets the CSS radius clip cleanly.
    transparent: isMac,
    roundedCorners: true,
    hasShadow: true,
    maximizable: true,
    resizable: true,
    autoHideMenuBar: true,
    title: 'bolo',
    ...(isMac
      ? {
          vibrancy: 'sidebar',
          visualEffectState: 'active',
          backgroundColor: '#00000000'
        }
      : { backgroundColor: '#f5f6f7' }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(rendererFile);
  // The cinematic intro covers the whole display, so when it's due the
  // dashboard stays hidden until the intro hands off — otherwise the app
  // flashes behind the overlay and lands in the taskbar early.
  if (!deferShow) mainWindow.once('ready-to-show', () => mainWindow.show());
  // A detached DevTools window is focusable and grabs focus the moment it opens.
  // When the dashboard is deferred behind the intro, that pulls focus off the
  // always-on-top intro and the user has to click back to it every beat. Only
  // open DevTools once the dashboard is actually the thing on screen.
  if (isDev && !deferShow) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('close', (e) => {
    // Close to tray: keep app alive like voice assistants do.
    if (!app.quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  return mainWindow;
}

// Mini always-on-top dictation pill: a frameless transparent window over the
// near-black level tile.
//
// The tile is a FIXED 65x138 in every state — it is a meter, not a capsule that
// morphs — so unlike the old capsule there is nothing to resize between states.
// The window is still larger than the tile: the 16px gutter is what lets the
// tile's drop shadow render, since a window cropped exactly to the tile would
// clip it at the edges.
const PILL_TILE = { width: 65, height: 138 };
const PILL_GUTTER = 16;
const PILL_DIMS = {
  idle: { width: PILL_TILE.width + PILL_GUTTER * 2, height: PILL_TILE.height + PILL_GUTTER * 2 },
  listening: { width: PILL_TILE.width + PILL_GUTTER * 2, height: PILL_TILE.height + PILL_GUTTER * 2 },
  processing: { width: PILL_TILE.width + PILL_GUTTER * 2, height: PILL_TILE.height + PILL_GUTTER * 2 },
  error: { width: PILL_TILE.width + PILL_GUTTER * 2, height: PILL_TILE.height + PILL_GUTTER * 2 }
};

// Where the tile sits, measured off the reference stills: 48px in from the left
// edge of the screen and 60px down. The offset is to the TILE, so the window's
// own origin has the gutter backed out of it.
const PILL_INSET = { x: 48, y: 60 };

function createPill(preloadPath, rendererDir) {
  const { width, height } = PILL_DIMS.idle;

  // Anchor it top-left, which is the corner the reference hangs it from.
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + PILL_INSET.x - PILL_GUTTER);
  const y = Math.round(workArea.y + PILL_INSET.y - PILL_GUTTER);

  pillWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    // Hidden until the voice machine asks for it. Without this the capsule is
    // visible the moment it is created and simply stays there — an always-on-top
    // blob over the desktop, the intro, and the setup pages alike.
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  pillWindow.loadFile(path.join(rendererDir, 'pill.html'));
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Float above full-screen apps without stealing focus from them.
  pillWindow.setAlwaysOnTop(true, 'floating');
  return pillWindow;
}

// Visibility -> "Hide the dictation pill".
//
// Read on every state change rather than cached: the settings pane writes
// straight through, and there is no other moment at which a cached copy would
// be refreshed. Re-calling setPillState after the setting changes is therefore
// all the Visibility switch needs to do to take effect immediately.
function pillSuppressed() {
  try {
    return !!settings.get('hidePill');
  } catch (_) {
    return false;
  }
}

function setPillState(state) {
  const s = PILL_DIMS[state] ? state : 'idle';

  if (pillWindow && !pillWindow.isDestroyed()) {
    // No setBounds here any more. The tile is one fixed size in every state, so
    // resizing the window on each transition would be pure churn — and churn on
    // an always-on-top window is a visible flicker.
    //
    // The tile exists only while there is something to show. Idle means nothing
    // is happening, so it goes away rather than hovering over whatever the user
    // is actually doing.
    //
    // Visibility -> "Hide the dictation pill" suppresses it entirely, including
    // while listening: with the notch also on screen, the pill is a second
    // indicator saying the same thing, and some people want only one.
    if (s === 'idle' || pillSuppressed()) {
      if (pillWindow.isVisible()) pillWindow.hide();
    } else if (!pillWindow.isVisible()) {
      // showInactive, never show: taking focus would pull it away from the app
      // the user is dictating into, which is the entire point of the feature.
      pillWindow.showInactive();
    }

    pillWindow.webContents.send('bolo:pill-state', s);
  }

  if (tray) {
    tray.setToolTip(
      s === 'listening'
        ? 'bolo — listening'
        : s === 'processing'
          ? 'bolo — processing'
          : 'bolo — idle'
    );
  }
}

// A tray icon has to be real pixels — an empty image gives an invisible tray
// entry and, with close-to-tray, no way back to the window. Drawing one here
// keeps the app icon-free without shipping binary art.
function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - c, y - c) <= r;
      const a = inside ? 255 : 0;
      // createFromBitmap expects premultiplied BGRA.
      buf[i] = Math.round(0xc4 * (a / 255));     // B
      buf[i + 1] = Math.round(0x85 * (a / 255)); // G
      buf[i + 2] = Math.round(0x29 * (a / 255)); // R
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray(onShow, onQuit) {
  try {
    tray = new Tray(makeTrayIcon());
    tray.setToolTip('bolo — idle');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show bolo', click: onShow },
      { type: 'separator' },
      { label: 'Quit', click: onQuit }
    ]));
    tray.on('click', onShow);
  } catch (_) {
    tray = null;
  }
  return tray;
}

function showMain() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

// The window is frameless, so the renderer's titlebar drives these directly.
function minimizeMain() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
}

function toggleMaximizeMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
}

function closeMain() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
}

function isMainMaximized() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMaximized();
}

function setView(view) {
  currentView = view;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bolo:view', view);
  }
  return currentView;
}

module.exports = {
  createMain, createPill, createTray, showMain,
  setPillState, setView,
  minimizeMain, toggleMaximizeMain, closeMain, isMainMaximized,
  getMain: () => mainWindow, getPill: () => pillWindow,
  getView: () => currentView
};
