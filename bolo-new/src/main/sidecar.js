const { desktopCapturer } = require('electron');

// Original screenshot stub using Electron desktopCapturer (no sidecar binary).
async function capture() {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 360 } });
    const first = sources && sources[0];
    if (!first) return { ok: false, error: 'no-screen-source' };
    const dataUrl = first.thumbnail.toDataURL();
    return { ok: true, name: first.name, bytes: dataUrl.length, dataUrl: dataUrl.slice(0, 200) + '…' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { capture };
