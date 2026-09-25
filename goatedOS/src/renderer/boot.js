/* ============================================================================
   bolo — early theme bootstrap
   Loaded synchronously from <head>, before the body paints, so a stored theme
   is applied on the very first frame instead of flashing the OS default and
   then correcting itself. app.js re-applies the same value on boot and keeps
   the segmented control in sync.

   "auto" deliberately stamps no class: theme.css treats an unclassed root as
   "follow the OS" and lets the prefers-color-scheme block take over.
   ========================================================================== */
(function () {
  try {
    var mode = localStorage.getItem('bolo.theme') || 'auto';
    if (mode === 'light' || mode === 'dark') {
      document.documentElement.classList.add(mode);
    }
  } catch (_) {
    /* storage unavailable — fall through to the OS preference */
  }
})();
