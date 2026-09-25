/* Stands in for the preload bridge so intro.html can be photographed outside the
   real app. Not part of the app; nothing here ships.

   Answers the phase listener with `sounds: false` — puts the intro in its muted
   path (~60ms/word) instead of waiting on audio (3.5s Deepgram timeout per shot). */

let phaseFn = null;

const ok = async () => ({ ok: true });

window.bolo = {
  introError: () => {},
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