// Screenshot harness. Usage:
//   electron shot.js <fileOrUrl> <out.png> <width> <height> [waitMs] [bgHex] \
//                    [bgImage] [evalJs] [preWaitMs] [preloadFile]
// bgHex:      "transparent" keeps alpha, otherwise a CSS colour painted under the page.
// bgImage:    absolute path to a JPEG/PNG painted behind the page.
// evalJs:     JS expression run after preWaitMs, to drive the page to a beat.
// preloadFile: JS file injected at document-start — the only way to stand in for
//              the preload bridge before the page's own scripts run.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [, , target, out, wS, hS, waitS, bg, bgImage, evalJs, preWaitS, preloadFile] = process.argv;
const width = parseInt(wS, 10);
const height = parseInt(hS, 10);
const waitMs = parseInt(waitS || '900', 10);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const transparent = bg === 'transparent';
  const win = new BrowserWindow({
    show: false,
    width, height,
    useContentSize: true,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : (bg || '#ffffff'),
    webPreferences: {
      backgroundThrottling: false,
      offscreen: false,
      // Injected as a real preload with isolation off, so the stub shares the
      // page's `window` exactly the way a contextBridge bridge would be seen.
      ...(preloadFile ? { preload: path.resolve(preloadFile), contextIsolation: false } : {}),
    },
  });

  const url = /^https?:|^file:|^data:/.test(target)
    ? target
    : 'file:///' + path.resolve(target).replace(/\\/g, '/');

  const query = process.env.SHOT_QUERY || '';
  await win.loadURL(url + query);

  // A window that is never shown can go without a compositor frame, and
  // capturePage() then never resolves — it hangs forever with no error, which is
  // how this tool used to fail silently. Showing it without focus makes it paint
  // while leaving the desktop's focus alone.
  win.showInactive();

  if (bgImage) {
    const u = 'file:///' + path.resolve(bgImage).replace(/\\/g, '/').replace(/'/g, '%27');
    await win.webContents.insertCSS(
      `html{background-image:url('${u}')!important;background-size:cover!important;` +
      `background-position:center!important;background-repeat:no-repeat!important;}`
    );
  }

  await new Promise((r) => setTimeout(r, parseInt(preWaitS || '900', 10)));

  if (evalJs) {
    try {
      const res = await win.webContents.executeJavaScript(evalJs, true);
      if (res !== undefined) console.log('eval ->', JSON.stringify(res));
    } catch (e) {
      console.log('eval failed:', e.message);
    }
  }

  await new Promise((r) => setTimeout(r, waitMs));

  // A hard deadline, so a capture that never resolves fails loudly instead of
  // hanging the run with no output at all.
  let img;
  try {
    img = await Promise.race([
      win.webContents.capturePage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage timed out after 15s')), 15000))
    ]);
  } catch (e) {
    console.log('capture failed:', e.message);
    app.exit(1);
    return;
  }

  fs.writeFileSync(out, img.toPNG());
  console.log('shot ->', out, width + 'x' + height);
  app.quit();
});
