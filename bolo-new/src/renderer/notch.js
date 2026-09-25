/* ============================================================================
   bolo — agent notch renderer.

   One capsule, many phases. It renders whatever main sends, measures itself and
   asks main to resize the window to match — every frame while the capsule is
   morphing, because the window has to follow the width transition too. A window
   that only resized at the end of the animation would clip the growing capsule
   and leave dead space behind the shrinking one.

   Context-isolated: everything goes through the preload's `window.bolo`.
   ========================================================================== */

const notch = document.getElementById('notch');
const capLogoEl = document.getElementById('capLogo');
const meterEl = document.getElementById('meter');
const xEl = document.getElementById('x');
/* ---------------------------------------------------------------------------
   The mark in the capsule's centre

   The logotype is the one thing on this surface that is *injected* rather than
   rendered from the payload, so it is the one thing that can fail without the
   capsule looking broken — a capsule with an empty centre still draws, still
   animates and still reports the right size. That is why every failure path here
   speaks up instead of quietly leaving the slot empty.
   ------------------------------------------------------------------------ */

// Deliberately not reportError(): that one touches #diag, which is declared
// further down, so calling it from module top level would die in the temporal
// dead zone and be swallowed by the catch that was meant to report.
function reportLogoFailure(detail) {
  try {
    window.bolo.rendererError({
      message: 'notch logo failed to paint',
      detail: String(detail || '')
    });
  } catch (_) {}
}

// Idempotent: safe to call on every render, on load, and on a retry tick.
function paintLogo() {
  if (!capLogoEl || !window.boloWordmark) return false;
  // Look for the mark itself — not for "any child". `hasChildNodes()` counts a
  // whitespace text node, so a single stray newline inside #capLogo used to
  // disable the logo for the life of the window with no way to tell why.
  try {
    if (capLogoEl.querySelector('svg')) return true;
    capLogoEl.innerHTML = window.boloWordmark.svg({ label: null });
    return !!capLogoEl.querySelector('svg');
  } catch (e) {
    // Loud on purpose. The bare `catch (_) {}` that used to sit here is the
    // reason an empty centre was a mystery rather than a stack trace: the one
    // failure mode the guard existed for was also the one thing it refused to
    // report.
    reportLogoFailure((e && e.message) || e);
    return false;
  }
}

try {
  if (!paintLogo() && !window.boloWordmark) {
    // The wordmark script never defined itself — most likely it never ran. Say
    // so, because the symptom is a blank tab and nothing else.
    reportLogoFailure('wordmark.js did not define window.boloWordmark');
  }
} catch (_) {}

// Belt as well as braces: paint again once the document has settled, in case the
// slot was replaced by a re-render between the call above and first paint.
try {
  document.addEventListener('DOMContentLoaded', () => { paintLogo(); });
  window.addEventListener('load', () => { paintLogo(); });
} catch (_) {}
const headlineEl = document.getElementById('headline');
const slotEl = document.getElementById('slot');
const actionsEl = document.getElementById('actions');
const diagEl = document.getElementById('diag');
const hintKeysEl = document.getElementById('hintKeys');
// Same shared formatter the dashboard uses; see src/shared/keylabel.js. Loaded
// as a plain script so it works without nodeIntegration.
const Keys = window.BoloKeys;

function reportError(message, detail) {
  if (window.__boloDiag) { window.__boloDiag(message, detail); return; }
  try { window.bolo.rendererError({ message: String(message), detail: String(detail || '') }); } catch (_) {}
  if (diagEl) {
    diagEl.hidden = false;
    diagEl.textContent = String(message) + (detail ? '  (' + detail + ')' : '');
  }
}

// `var`, not `const` — and the keyword is load-bearing. `contextBridge`
// .exposeInMainWorld defines `bolo` on `window` as a NON-CONFIGURABLE
// property, and per the spec's GlobalDeclarationInstantiation →
// HasRestrictedGlobalProperty a top-level `let`/`const` of that name is a
// SyntaxError *at parse time*. The whole file then dies before executing one
// statement: no listener registered, no render, no error — just a notch window
// that is visible, correctly sized, and completely blank. `var` is permitted to
// redeclare an existing global property. Do not "modernise" this back.
var bolo = window.bolo;
let lastTranscript = '';

/* ---------------------------------------------------------------------------
   Reply text
   Painted the moment it arrives — generation time, not voice time. The dwell
   collapse (main, REPLY_DWELL_MS after speaking end) is what clears it, so no
   staging, spinner, or letter-by-letter reveal here.
   ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
   Icons
   ------------------------------------------------------------------------ */
const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"/><path d="M12 17v4"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14"/></svg>',
  insert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 19.5h15"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.6"/><path d="M3.5 7.5l8.5 6 8.5-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>'
};

/* ---------------------------------------------------------------------------
   Level meter. Five bars; while thinking they pulse on their own, while
   listening they follow the reported input level.
   ------------------------------------------------------------------------ */
const BAR_COUNT = 5;
const heights = new Array(BAR_COUNT).fill(4);
let level = 0;
let wavePhase = 0;

for (let i = 0; i < BAR_COUNT; i++) meterEl.append(document.createElement('i'));

// Incremented by both animation loops below. main watches this counter through
// the heartbeat: a tick that stops advancing while the capsule is on screen is
// the one piece of evidence that separates a throttled renderer from a dead one,
// and both look exactly like "the notch doesn't work".
let aliveTick = 0;

function tickMeter() {
  aliveTick++;
  wavePhase += 0.22;
  const listening = notch.dataset.phase === 'listening';
  for (let i = 0; i < BAR_COUNT; i++) {
    const wave = Math.sin(wavePhase + i * 0.7) * 0.5 + 0.5;
    const centreBias = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT;
    const want = listening ? 4 + wave * centreBias * level * 13 : 4;
    heights[i] += (want - heights[i]) * 0.35;
    meterEl.children[i].style.height = heights[i].toFixed(1) + 'px';
  }
  requestAnimationFrame(tickMeter);
}
requestAnimationFrame(tickMeter);

/* ---------------------------------------------------------------------------
   Size
   The window is the capsule plus a transparent gutter: 16 either side, 16
   below, none above. Measured continuously and pushed only on a real change, so
   the window tracks the width transition frame by frame without flooding IPC
   once the capsule is settled.
   ------------------------------------------------------------------------ */
const GUTTER = 16;
let lastW = 0;
let lastH = 0;

function reportSize() {
  const r = notch.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)) + GUTTER * 2;
  const h = Math.max(1, Math.round(r.height)) + GUTTER;
  if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
  lastW = w;
  lastH = h;
  try { bolo.notchResize({ width: w, height: h }); } catch (_) {}
}

function sizeLoop() {
  aliveTick++;
  reportSize();
  requestAnimationFrame(sizeLoop);
}
requestAnimationFrame(sizeLoop);

// The heartbeat runs on an interval rather than on animation frames, on purpose:
// if the frame loop is throttled away the interval keeps reporting the frozen
// tick count, which is the whole diagnosis. A heartbeat driven by rAF would stop
// with it and say nothing. Main only complains when the capsule is visible.
try {
  setInterval(() => {
    try { bolo.notchAlive({ tick: aliveTick, throttled: document.hidden }); } catch (_) {}
  }, 2000);
} catch (_) {}

/* ---------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------ */
const OPEN = ['reply', 'error', 'hint', 'media', 'compose'];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setHeadline(main, sub) {
  headlineEl.textContent = '';
  if (!main) return;
  headlineEl.append(document.createTextNode(main));
  if (sub) {
    const s = el('span', 'sub', sub);
    headlineEl.append(s);
  }
}

function setActions(list) {
  actionsEl.textContent = '';
  for (const a of list || []) {
    if (!a || !a.label) continue;
    const b = el('button', 'ctl');
    b.type = 'button';
    if (a.icon && ICON[a.icon]) b.insertAdjacentHTML('beforeend', ICON[a.icon]);
    b.append(document.createTextNode(a.label));
    b.addEventListener('click', () => {
      if (a.id === 'dismiss') return void bolo.notchDismiss();
      try { bolo.notchAction({ id: a.id, value: a.value }); } catch (e) { reportError('notch action failed', e.message); }
    });
    actionsEl.append(b);
  }
}

// The hint line names the voice key. Rebuilt only when the binding actually
// changes: main sends the skin with every payload, and re-creating three nodes
// on each one would restart their transitions mid-morph.
function setHintKeys(accelerator) {
  if (!hintKeysEl) return;
  const parts = Keys ? Keys.parts(accelerator) : String(accelerator || '').split('+');
  const signature = parts.join('|');
  if (hintKeysEl.dataset.sig === signature) return;
  hintKeysEl.dataset.sig = signature;
  hintKeysEl.textContent = '';
  parts.forEach((p, i) => {
    if (i) hintKeysEl.append(el('span', 'hint-plus', '+'));
    hintKeysEl.append(el('kbd', 'key', p));
  });
}

// Shape and material belong to the surface rather than to the phase, so they
// are re-applied on every payload instead of only when they change: a value
// that goes missing must not leave the previous one painted on.
//
// Mirrored onto <body> as well, because the gutter has to move to the inward
// side for the side variant and that is a property of the page box, not of
// the capsule.
function applySkin(payload) {
  if (payload.variant) {
    notch.dataset.variant = payload.variant;
    document.body.dataset.variant = payload.variant;
  }
  if (payload.material) notch.dataset.material = payload.material;
  if (payload.side) {
    notch.dataset.side = payload.side;
    document.body.dataset.side = payload.side;
  }
  if (payload.shortcut) setHintKeys(payload.shortcut);
}

function render(payload) {
  const p = payload.phase || 'welcome';

  // A keepText re-render (hover / appearance change) must not wipe a reply that
  // is on screen. Re-apply the skin so a material swap still lands, then bail
  // before the slot is cleared.
  if (payload.keepText && slotEl.querySelector('p.text')) {
    applySkin(payload);
    return;
  }

  notch.classList.remove('awaiting');
  notch.dataset.phase = p;
  notch.classList.toggle('open', OPEN.includes(p));

  applySkin(payload);

  // Self-heal a missed logo injection (slow script, sleepy disk): the capsule
  // paints with an empty centre otherwise, and nothing else retries it.
  paintLogo();

  // The close affordance is present whenever the capsule is expanded, except
  // for the pure hint state, which is informational and dismisses itself.
  xEl.hidden = !(OPEN.includes(p) && p !== 'hint');

  setHeadline(payload.headline, payload.sub);

  slotEl.textContent = '';
  actionsEl.textContent = '';

  if (payload.transcript) {
    slotEl.append(el('p', 'echo', payload.transcript));
  }

  // Only when the payload actually carries prose. An error phase with no body
  // is a heading and controls, which is what the reference's error panel is.
  //
  // Painted at once, the moment it is generated — never staged behind the
  // voice. A reply carrying its own actions is a confirmation card and paints
  // the same way.
  if (payload.text) {
    const textEl = el('p', 'text');
    textEl.textContent = payload.text;
    slotEl.append(textEl);
  }

  if (p === 'media' && payload.media && payload.media.src) {
    const box = el('div', 'media');
    if (payload.media.type === 'video') {
      const v = document.createElement('video');
      v.src = payload.media.src;
      v.autoplay = true;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      box.append(v);
    } else {
      const img = document.createElement('img');
      img.src = payload.media.src;
      img.alt = payload.media.alt || '';
      box.append(img);
    }
    slotEl.append(box);
  }

  if (p === 'compose') {
    if (payload.bubble) slotEl.append(el('p', 'bubble', payload.bubble));

    if (payload.card) {
      const card = el('div', 'compose');

      const head = el('div', 'chead');
      head.insertAdjacentHTML('beforeend', ICON.mail);
      head.append(el('span', 'ctitle', payload.card.title || 'New Message'));
      card.append(head);

      for (const f of payload.card.fields || []) {
        const row = el('div', 'crow' + (f.subject ? ' subject' : ''));
        row.append(el('span', 'clabel', f.label));

        // A recipient renders as the chip the reference shows, not as plain
        // text — it is the one field that reads as a pill in the real panel.
        if (f.chip) {
          const host = el('span', 'cvalue');
          host.append(el('span', 'cpill', f.value));
          row.append(host);
        } else {
          row.append(el('span', 'cvalue', f.value));
        }

        if (f.copy !== false) {
          const c = el('button', 'ccopy');
          c.type = 'button';
          c.setAttribute('aria-label', 'Copy ' + f.label);
          c.insertAdjacentHTML('beforeend', ICON.copy);
          c.addEventListener('click', () => {
            try { bolo.notchCopy(f.value); } catch (_) {}
          });
          row.append(c);
        }
        card.append(row);
      }
      slotEl.append(card);
    }
  }

  setActions(payload.actions);
}

/* ---------------------------------------------------------------------------
   Incoming
   ------------------------------------------------------------------------ */
// Set only by the design harness below. Lets a screenshot run pose the capsule
// from the query string rather than from a JS payload, which is the one part of
// driving this window that is awkward to pass through a shell.
let harnessInitial = null;

// A reply's text has to stay on screen until its voice has finished. The audio
// arrives seconds after the text does, and main's auto-hide timer started when
// the text appeared, so this window — the one holding the playback promise —
// reports when speaking starts and stops and main holds the capsule open for the
// duration. `speakToken` is the guard: an older clip's promise can settle long
// after a newer reply has taken over (a clip that was cut off only resolves on
// speak.js's own ceiling), and releasing then would collapse the new reply.
let speakToken = 0;

function reportSpeaking(on) {
  if (!bolo || !bolo.notchSpeaking) return;
  try { bolo.notchSpeaking(!!on); } catch (_) {}
}

if (bolo) {
  bolo.on('bolo:notch-state', (payload) => {
    try { render(payload || {}); } catch (e) { reportError('notch render failed', e.message); }
  });

  bolo.on('bolo:voice-level', (p) => {
    level = Math.max(0, Math.min(1, (p && p.level) || 0));
  });

  bolo.on('bolo:transcript', (t) => {
    lastTranscript = (t && t.text) || '';
  });

  // Spoken replies. Main synthesises them (it holds the Deepgram key) and pushes
  // the finished audio here, because this window is the one that owns a reply —
  // and the only one that can play a sound. The text is already on screen (see
  // above); all this reports is speaking start/stop so main can time the dwell
  // collapse.
  bolo.on('bolo:say', (p) => {
    // No helper or no bytes: report at once, or the dwell main armed when the
    // text appeared would never start and the reply would sit there forever.
    if (!window.boloAudio || !p || !p.audio) { reportSpeaking(false); return; }
    const token = ++speakToken;
    reportSpeaking(true);
    window.boloAudio.play(p.audio, p.mime).then((r) => {
      if (token !== speakToken) return; // a newer reply owns the state now
      reportSpeaking(false);
      if (!r.ok && r.reason !== 'empty') {
        // Worth a line in the diagnostic box: a reply that shows but never speaks
        // is otherwise indistinguishable from the mute switch being on.
        reportError('reply not spoken', r.reason + (r.error ? ' — ' + r.error : ''));
      }
    });
  });

  // The streaming reply path: speaking start/end straight through. onSpeaking
  // (true) fires when the first audio chunk plays, (false) when it ends.
  if (window.boloAudio && window.boloAudio.onSpeaking) {
    window.boloAudio.onSpeaking((on) => reportSpeaking(!!on));
  }
} else {
  // No bridge: this is the design harness, not the app. expose the renderer so a
  // screenshot run can drive it to any phase. Never reachable inside bolo,
  // where the preload always installs the bridge.
  window.__boloNotch = { render: render };
  harnessInitial = () => {
    const q = new URLSearchParams(location.search);
    if (!q.get('phase')) return null;
    const out = {};
    for (const [k, v] of q) out[k] = v;
    return out;
  };
}

/* ---------------------------------------------------------------------------
   Interaction
   ------------------------------------------------------------------------ */
xEl.addEventListener('click', () => {
  // Cancel any in-flight speech before dismissing — stops the voice mid-sentence
  // and prevents the notch from re-opening on the speaking-hold keepalive.
  try { if (window.boloAudio) window.boloAudio.cancelStream('dismissed'); } catch (_) {}
  try { if (window.boloAudio) window.boloAudio.stop(); } catch (_) {}
  if (bolo) bolo.notchDismiss();
});

// Hover is reported so main can hold the capsule open while the pointer is over
// it and release it on a delay afterwards.
notch.addEventListener('mouseenter', () => { if (bolo) bolo.notchHover(true); });
notch.addEventListener('mouseleave', () => { if (bolo) bolo.notchHover(false); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && bolo) bolo.notchDismiss();
});

// Starts collapsed and idle; main decides when to reveal it. The design harness
// may pose it from the query string instead — see tools/shot.js SHOT_QUERY.
/* ── The mode chip ─────────────────────────────────────────────────────────
   Dictation, Edit or Agent, lit the instant its key is pressed. The intent
   router still decides what the words were for, so this is not a mode picker —
   it is the app saying which thumb it has on the scale, which is the only way
   the user can tell the three keys apart once they are in the capsule.

   Drawn as inline SVG rather than a glyph from a font: the capsule renders at 26
   px tall and a text glyph at that size is a blur. */
const MODE_GLYPHS = {
  dictation:
    'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM6 11a6 6 0 0 0 12 0M12 17.5V21',
  edit: 'M4 20h4L18 10a2.8 2.8 0 0 0-4-4L4 16v4ZM14.5 5.5l4 4',
  agent:
    'M12 3.5l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8L12 3.5ZM18 16l.6 1.6 1.6.6-1.6.6L18 20.4l-.6-1.6-1.6-.6 1.6-.6L18 16Z'
};

function applyMode(mode) {
  const el = document.getElementById('mode');
  if (!el) return;
  const path = mode && MODE_GLYPHS[mode];
  if (!path) {
    if (el.hidden) return;
    el.hidden = true;
    el.dataset.mode = '';
    return;
  }
  if (el.dataset.mode === mode) return;
  el.dataset.mode = mode;
  el.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="' +
    path +
    '"/></svg><span class="mode-label">' +
    (mode.charAt(0).toUpperCase() + mode.slice(1)) +
    '</span>';
  el.hidden = false;
}

if (bolo.onMode) bolo.onMode((p) => applyMode(p && p.mode));

render((harnessInitial && harnessInitial()) || { phase: 'welcome' });
reportSize();
