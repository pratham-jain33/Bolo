/* ============================================================================
   bolo — renderer crash reporter
   Loaded FIRST, in its own file, before any application script.

   This file exists because of one specific, expensive failure. A SyntaxError
   raised while *parsing* app.js or intro.js kills that entire file — including
   any error handler it was going to install. So the app died with a blank
   window, no on-screen message and nothing in the terminal, and the only
   symptom was "stuck on the first screen".

   A parse error can only ever be observed from a script that is not the one
   that failed. That is the whole reason this is a separate file loaded first,
   and why it does not depend on app.js, intro.js, or anything they define.
   ========================================================================== */
(function () {
  var box = null;

  function send(message, detail) {
    var line = String(message) + (detail ? '  (' + detail + ')' : '');

    // Written to the renderer console, which the main process echoes to the
    // terminal running `npm run dev`.
    try { console.error('[bolo] ' + line); } catch (_) {}

    // And pushed over the bridge, because the intro window has no terminal
    // attached to it at all.
    try {
      if (window.bolo && window.bolo.rendererError) {
        window.bolo.rendererError({ message: String(message), detail: String(detail || '') });
      }
    } catch (_) {}

    if (!box) box = document.getElementById('diag');
    if (box) {
      box.hidden = false;
      box.textContent = line;
    }
  }

  // Capture phase, so this also sees resource failures — a script or stylesheet
  // that never loaded fires an `error` event on the element itself, which does
  // not bubble. Without capture, a blocked script is silent.
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && t.tagName) {
      send('failed to load ' + t.tagName.toLowerCase(), t.src || t.href || '');
      return;
    }
    send((e && e.message) || 'script error',
      e && e.filename ? e.filename + ':' + e.lineno : '');
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    send('unhandled rejection', (r && r.message) || String(r));
  });

  // For explicit, non-exceptional reporting from the app scripts.
  window.__boloDiag = send;
})();
