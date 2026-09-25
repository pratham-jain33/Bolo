/* ============================================================================
   The bolo logotype.

   Re-authored from scratch against the reference recording's wordmark: a heavy
   geometric sans, x-height 100 units, optically circular bowls with a 26-unit
   stem, and — the signature move — one "o" drawn as a solid disc rather than a
   ring. In the reference it was the "o" immediately before the trailing "s" of
   `voiceos`; in `bolo` it is the final "o". That disc is the whole brand, and a
   wordmark built from a font will never have it.

   The glyphs are plain primitives (circles, rects, short cubics) rather than
   font outlines, because the mark has to stay indistinguishable at 20px and at
   700px, and a webfont would drift with every fallback. Geometry does not.

   Everything lives inside an IIFE on purpose: a top-level `let`/`const` whose
   name collides with a non-configurable global property is a parse-time
   SyntaxError, and contextBridge creates exactly such properties on `window`.
   ========================================================================== */
window.boloWordmark = (function () {
  'use strict';

  // Metrics, in SVG user units. x-height 100 => stroke is 26% of the body,
  // which is what the reference measures out to.
  const X_HEIGHT = 100;
  const STROKE = 26;
  const RMID = 40;                 // mid-radius of a bowl (outer 53, inner 27)
  const OVER = RMID + STROKE / 2;  // 53 — outer radius, including optical overshoot
  const SR = 33;                   // the "s" is narrower than a bowl, as it is in any
  const SOVER = SR + STROKE / 2;   // 46   geometric sans
  const XTOP = 40;                 // top of the x-height band
  const BASE = 140;                // baseline
  const CY = 90;                   // vertical centre of a bowl
  const ASC = 10;                  // ascender top (b, d, l, t)

  // One gap for the whole word. Every advance is its glyph's ink width plus this,
  // so no pair is tighter than any other — which is the entire reason the stems
  // below sit at `+ RMID - STROKE / 2` rather than `+ RMID`.
  //
  // `+ RMID` centres a stem on the bowl's *path*, which puts its outer edge at
  // cx + 53 + 13 — half a stroke past the bowl's outer edge. That made a/d/g end
  // 1 unit from the next glyph while every other pair had 14.
  const GAP = 14;
  const BOWL = 2 * OVER + GAP;     // 120 — an o, and every glyph as wide as one
  const ELL = STROKE + GAP;        // 40 — "l" is a bare stem, so its ink is one
                                   //      stroke wide and the same gap flanks it
  const ADVANCE = {
    b: BOWL, o: BOWL, a: BOWL, e: BOWL, d: BOWL,
    l: ELL,
    t: 74 + GAP,                   // 88 — the crossbar is 74 wide
    s: 2 * SOVER + GAP             // 106
  };

  const WORD = 'bolo';

  // Sum of the advances *per character in the word*, not per distinct glyph.
  // `Object.values(ADVANCE)` looked equivalent and was not: "bolo" has two o's,
  // and the table can only contribute one advance for them, so the box came out
  // a bowl short of the word — the last glyph was drawn past the right edge of
  // the viewBox and fell off it entirely.
  const TOTAL = [...WORD].reduce((a, ch) => a + ADVANCE[ch], 0);   // 400

  // The ink's own width: the advances minus the trailing gap, which no glyph
  // fills. The viewBox is set to this and not to TOTAL, because a box that
  // carries a dead 14 units on the right is a box whose *centre* is 7 units
  // right of the ink's — and since every consumer centres the element, the whole
  // mark rendered right of true centre at intro size. That is the "lines and
  // spacing are a bit misaligned" this was fixing.
  const INK_W = TOTAL - GAP;       // 386

  // The ink's vertical extent, so the viewBox can be tight and symmetric.
  // `bolo` has no descender: the deepest ink in it is the bowls' optical
  // overshoot below the baseline. The old frame was built around a different
  // word's descender (BASE + 28 + STROKE / 2), which would have left 38 units of
  // dead footroom against 10 of headroom — and a box whose ink is not its centre
  // renders the mark above where it was placed.
  const INK_TOP = ASC;                    // 10  — b, d, l and t reach the ascender
  const INK_BOTTOM = CY + OVER;           // 143 — the bowls overshoot the baseline
  const PAD = 10;                         // symmetric headroom, top and bottom
  const HEIGHT = INK_BOTTOM - INK_TOP + PAD * 2;   // 153
  const Y_OFF = PAD - INK_TOP;                     // 0

  const ring = (cx) => `<circle cx="${cx}" cy="${CY}" r="${RMID}" fill="none"/>`;
  const box = (x, top, bot, w) =>
    `<rect x="${x}" y="${top}" width="${w}" height="${bot - top}" stroke="none"/>`;
  // A stem whose outer edge is flush with the bowl's outer edge. `stem` is the
  // right-hand one (a, d); `lstem` mirrors it for `b`, whose stem stands to the
  // left of the bowl — bone and bowl outer edge land on the same line either way.
  const stem = (cx, top) => box(cx + RMID - STROKE / 2, top, BASE, STROKE);
  const lstem = (cx, top) => box(cx - OVER, top, BASE, STROKE);

  const draw = {
    o: (cx) => ring(cx),

    // The signature: a filled disc where the ring would be.
    solid: (cx) => `<circle cx="${cx}" cy="${CY}" r="${OVER}" stroke="none"/>`,

    // "b": the bowl with its stem on the left, from the ascender to the flat
    // baseline — no spur, no tail. Mirrors "d" exactly.
    b: (cx) => ring(cx) + lstem(cx, ASC),

    // "l": a bare stem, ascender to baseline. It is drawn from its own ink
    // origin rather than from a bowl centre, which is why it carries offset 0.
    l: (x) => box(x, ASC, BASE, STROKE),

    g: (cx) => {
      // The descender is centred on the bowl's stroke, so its outer edge meets
      // the bowl's outer edge and its inner edge meets the counter.
      const s = cx + RMID;
      const r = 34;
      return ring(cx) +
        `<path d="M ${s},${CY} L ${s},${BASE + 28} A ${r},${r} 0 0 1 ${s - 2 * r},${BASE + 28}" fill="none"/>`;
    },

    a: (cx) => ring(cx) + stem(cx, XTOP),

    t: (x) => box(x + 18, ASC, BASE, STROKE) + box(x - 6, XTOP, XTOP + STROKE, 74),

    // "e": the bowl's arc runs from the lower-right terminal all the way round
    // through the bottom, the left and over the top to the right, and a bar
    // closes it at the middle. Sweeping one continuous arc is what keeps the
    // aperture identical on every render.
    e: (cx) => {
      const a = (40 * Math.PI) / 180;
      const tx = (cx + RMID * Math.cos(a)).toFixed(1);
      const ty = (CY + RMID * Math.sin(a)).toFixed(1);
      return `<path d="M ${tx},${ty} A ${RMID},${RMID} 0 0 1 ${cx - RMID},${CY} A ${RMID},${RMID} 0 0 1 ${cx + RMID},${CY}" fill="none"/>` +
        box(cx - OVER, CY - STROKE / 2, CY + STROKE / 2, 2 * OVER);
    },

    d: (cx) => ring(cx) + stem(cx, ASC),

    s: (cx) => {
      const L = cx - SR, R = cx + SR;
      const k = 12;                 // horizontal pull of the spine, scaled to SR
      const T = XTOP + 13, B = BASE - 13, M = CY;
      return `<path d="M ${R},${T + 13}
        C ${R},${T + 1} ${cx + k},${T - 4} ${cx},${T - 4}
        C ${cx - k},${T - 4} ${L},${T + 1} ${L},${T + 13}
        C ${L},${M - 1} ${cx - k},${M - 3} ${cx},${M}
        C ${cx + k},${M + 3} ${R},${M + 1} ${R},${B - 13}
        C ${R},${B - 1} ${cx + k},${B + 4} ${cx},${B + 4}
        C ${cx - k},${B + 4} ${L},${B - 1} ${L},${B - 13}" fill="none"/>`;
    }
  };

  // Which glyph draws as the solid disc: the "o" that closes the word — the
  // reference fills the one before the trailing "s", and the equivalent position
  // in `bolo` is the last letter. The glyph test is load-bearing: keyed on the
  // index alone, any word ending in a stem would draw a disc over its last
  // letter instead of that letter.
  function isSolid(index) {
    return WORD[index] === 'o' && index === WORD.length - 1;
  }

  // Per-glyph origin. A bowl (and the solid disc) is centred OVER units in, the
  // narrower "s" is centred SOVER in, "t" is drawn from 6 units before its own
  // left edge, and a bare "l" starts at its origin. Each origin is exactly the
  // glyph's ink start, so the GAP between any two neighbours is the same.
  const OFFSET = { s: SOVER, t: 6, l: 0 };

  /* Build the mark.
     opts.className  extra classes on the <svg>
     opts.ids        when true, each glyph <g> gets id="wm-<i>" so a sequence can
                     stagger them individually
     opts.label      accessible name; pass null to mark it decorative */
  function svg(opts) {
    const o = Object.assign({ className: '', ids: false, label: 'bolo' }, opts || {});
    let x = 0;
    let body = '';

    for (let i = 0; i < WORD.length; i++) {
      const ch = WORD[i];
      const fn = draw[ch];
      if (!fn) continue;

      const offset = ch in OFFSET ? OFFSET[ch] : OVER;
      const inner = isSolid(i) ? draw.solid(x + OVER) : fn(x + offset);

      // No inline `style` here: the windows run under a strict CSP that blocks
      // style attributes, so the per-glyph stagger is driven by :nth-child in
      // the stylesheet instead.
      body += `<g id="wm-${i}" class="wm-g">${inner}</g>`;

      x += ADVANCE[ch];
    }

    const a11y = o.label
      ? ` role="img" aria-label="${String(o.label).replace(/"/g, '&quot;')}"`
      : ' aria-hidden="true"';

    return `<svg class="wordmark ${o.className}" viewBox="0 ${-Y_OFF} ${INK_W} ${HEIGHT}" ` +
      `xmlns="http://www.w3.org/2000/svg"${a11y} ` +
      `fill="currentColor" stroke="currentColor" stroke-width="${STROKE}">${body}</svg>`;
  }

  return { svg: svg, TOTAL: INK_W, HEIGHT: HEIGHT, WORD: WORD };
})();