// Reports what the dashboard actually rendered. Passed to shot.js as
// `@tools/dash-probe.js`, so the expression never has to survive a shell.
(() => {
  const nav = [...document.querySelectorAll('.nav')];
  const first = nav[0];
  const side = document.querySelector('.side');
  const rail = document.getElementById('homeRail');
  const greet = document.getElementById('homeGreeting');
  const diag = document.getElementById('diag');
  return {
    // Nav: how many rows, which one is lit, and the two numbers the reference
    // fixes — 220px sidebar, 44px rows.
    nav: nav.map((b) => b.textContent.trim()),
    navActive: (nav.find((b) => b.classList.contains('active')) || {}).textContent,
    navRowHeight: first ? first.offsetHeight : null,
    sidebarWidth: side ? side.offsetWidth : null,

    // The greeting and its orb.
    greeting: greet ? greet.textContent : null,
    greetSize: greet ? getComputedStyle(greet).fontSize : null,
    greetWeight: greet ? getComputedStyle(greet).fontWeight : null,
    greetTrack: greet ? getComputedStyle(greet).letterSpacing : null,
    orb: (() => {
      const o = document.querySelector('.home-orb');
      return o ? { w: o.offsetWidth, h: o.offsetHeight, r: getComputedStyle(o).borderRadius } : null;
    })(),

    // One card per key, with the key that is actually bound.
    cards: [...document.querySelectorAll('.mcard')].map((c) => ({
      title: (c.querySelector('h4') || {}).textContent,
      chips: [...c.querySelectorAll('.kcap')].map((k) => k.textContent),
      tail: [...c.querySelectorAll('.txt')].map((t) => t.textContent).join(' ')
    })),

    // The rail: card geometry is the reference's 340x236 at 16px gap.
    railCards: document.querySelectorAll('.scard').length,
    railEmpty: Boolean(document.querySelector('.rail-empty')),
    railH: rail ? rail.offsetHeight : null,
    railGap: rail ? getComputedStyle(rail).gap : null,
    cardBox: (() => {
      const c = document.querySelector('.scard');
      return c ? { w: c.offsetWidth, h: c.offsetHeight, r: getComputedStyle(c).borderRadius } : null;
    })(),
    railFades: rail ? rail.className : null,

    // Geometry of the page itself, against the reference's own insets.
    viewActive: [...document.querySelectorAll('.view.active')].map((v) => v.id),
    dashPad: (() => {
      const v = document.getElementById('view-dashboard');
      if (!v) return null;
      const s = getComputedStyle(v);
      return { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft };
    })(),
    headGap: (() => {
      const h = document.querySelector('.home-head');
      return h ? getComputedStyle(h).marginBottom : null;
    })(),

    // Anything the renderer reported on itself.
    diag: diag ? diag.textContent : null,
    diagHidden: diag ? diag.hidden : null
  };
})()
