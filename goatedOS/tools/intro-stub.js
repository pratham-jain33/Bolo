/* Stands in for the preload bridge so intro.html can be photographed outside the
   real app. Not part of the app; nothing here ships.

   Two things it does that a naive stub would not:

   * `introDesktop()` fails, because the blurred desktop capture belongs to main.
     The page falls back to dimming whatever is behind it, which is what the
     screenshot background is for.
   * It answers the phase listener with `sounds: false`. That is how the intro is
     put into its muted path, where a line is revealed in ~60ms/word instead of
     waiting on audio — otherwise every shot of a later beat would cost a 3.5s
     Deepgram timeout plus a 12s speech-synthesiser ceiling. */

let phaseFn = null;

const ok = async () => ({ ok: true });

window.bolo = {
  introError: () => {},
  introDesktop: async () => ({ ok: false, error: 'stub' }),
  introFinish: ok,
  introNarrate: ok,
  introPhase: ok,
  introSubmitName: ok,
  introSubmitLanguage: ok,
  speak: async () => ({ ok: false, error: 'stub' }),
  settings: async () => ({}),
  on: (channel, fn) => {
    if (channel !== 'bolo:intro-phase') return;
    phaseFn = fn;
    // Same payload `start()` sends, with the narrator pre-silenced.
    setTimeout(() => { try { fn({ phase: 'glow', sounds: false }); } catch (_) {} }, 0);
  }
};
window.__introStubPhase = (p) => { if (phaseFn) phaseFn(p); };