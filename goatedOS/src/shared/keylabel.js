/* Canonical accelerator labels.
 *
 * One formatter for every surface that names a key: the dashboard, the
 * onboarding key-check caps, the notch hint line and the main process's status
 * strings. It exists because Electron accelerators are written for a parser
 * ("CommandOrControl+Shift+A") and never for a human, and because the label has
 * to be *platform-correct* — showing "⌘ + A" or "command + a" on Windows is the
 * single most obvious way to look like a port that was never tested there.
 *
 * Loaded two ways, which is why it is wrapped:
 *   - main process: require('../shared/keylabel')
 *   - renderer:     <script src="../shared/keylabel.js">  ->  window.BoloKeys
 *
 * The renderer needs its own copy because it cannot require(), and duplicating
 * the table would let the two drift — the exact bug this file exists to stop.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoloKeys = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Per-platform spelling of the four modifier families.
  const MODIFIERS = {
    darwin: { mod: '⌘', command: '⌘', control: '⌃', alt: '⌥', shift: '⇧' },
    win32: { mod: 'Ctrl', command: 'Win', control: 'Ctrl', alt: 'Alt', shift: 'Shift' },
    linux: { mod: 'Ctrl', command: 'Super', control: 'Ctrl', alt: 'Alt', shift: 'Shift' }
  };

  // Named keys that are not single characters. Electron's own names are the
  // keys here, lowercased.
  const NAMED = {
    space: 'Space',
    spacebar: 'Space',
    tab: 'Tab',
    enter: 'Enter',
    return: 'Enter',
    backspace: 'Backspace',
    delete: 'Delete',
    escape: 'Esc',
    esc: 'Esc',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'Page Up',
    pagedown: 'Page Down',
    plus: '+',
    comma: ',',
    period: '.',
    slash: '/',
    backslash: '\\',
    semicolon: ';',
    quote: "'",
    minus: '-',
    equal: '=',
    grave: '`',
    bracketleft: '[',
    bracketright: ']'
  };

  // Mouse buttons are legal accelerators in Electron and the reference product
  // allows them, so they get labels too rather than falling through as raw text.
  const MOUSE = {
    mouseleft: 'Left click',
    mousemiddle: 'Middle click',
    mouseright: 'Right click'
  };

  // Electron accepts several spellings of the same modifier; they all have to
  // collapse to one label or the same key would print two different ways.
  function modifierFamily(token) {
    switch (token) {
      case 'commandorcontrol':
      case 'cmdorctrl':
      case 'commandorctrl':
      case 'cmdorcontrol':
        return 'mod';
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        return 'command';
      case 'control':
      case 'ctrl':
        return 'control';
      case 'alt':
      case 'option':
      case 'altgr':
        return 'alt';
      case 'shift':
        return 'shift';
      default:
        return null;
    }
  }

  function platform() {
    // Main process has the real answer. The renderer is told at boot what the
    // main process reported (`documentElement.dataset.platform`), so both halves
    // of the app agree even if a future build ever runs them apart.
    try {
      if (typeof process !== 'undefined' && process.platform) return process.platform;
    } catch (_) { /* renderer without nodeIntegration */ }
    try {
      const fromDoc = typeof document !== 'undefined' &&
        document.documentElement && document.documentElement.dataset.platform;
      if (fromDoc) return fromDoc;
    } catch (_) { /* no document */ }
    return 'win32';
  }

  // Tokens -> labels, in the order written. Modifiers are re-ordered into the
  // conventional Ctrl/Alt/Shift/key order so "Shift+Ctrl+A" and "Ctrl+Shift+A"
  // print identically.
  function tokens(accelerator, plat) {
    const p = MODIFIERS[plat] ? plat : platform();
    const names = MODIFIERS[p];
    const mods = [];
    const rest = [];

    for (const raw of String(accelerator || '').split('+')) {
      const token = raw.trim();
      if (!token) continue;
      const lower = token.toLowerCase();
      const family = modifierFamily(lower);

      if (family) {
        const label = names[family];
        // Dedupe: "Command+CommandOrControl" is one physical key on macOS.
        if (!mods.includes(label)) mods.push(label);
        continue;
      }
      if (MOUSE[lower]) { rest.push(MOUSE[lower]); continue; }
      if (NAMED[lower]) { rest.push(NAMED[lower]); continue; }
      // F1..F24 keep their name; a bare letter is uppercased.
      rest.push(token.length === 1 ? token.toUpperCase() : token);
    }

    // Conventional order: Command, Control, Alt, Shift — then the key itself.
    const order = p === 'darwin' ? ['⌘', '⌃', '⌥', '⇧'] : [names.command, 'Ctrl', 'Alt', 'Shift'];
    const ordered = order.filter((m) => mods.includes(m))
      .concat(mods.filter((m) => !order.includes(m)));

    return ordered.concat(rest);
  }

  // "Ctrl + A" — for prose and inline chips.
  function label(accelerator, plat) {
    return tokens(accelerator, plat).join(' + ');
  }

  // ["Ctrl", "A"] — for the keycap cards, which draw one cap per token.
  function parts(accelerator, plat) {
    return tokens(accelerator, plat);
  }

  // The keycap subtitle: which physical instance of the key to press. The
  // reference prints "(left)" under a modifier and nothing under a normal key,
  // because a modifier exists twice on the keyboard and a letter does not.
  function isModifierLabel(text, plat) {
    const p = MODIFIERS[plat] ? plat : platform();
    return Object.values(MODIFIERS[p]).includes(text);
  }

  function sideHint(text, plat) {
    return isModifierLabel(text, plat) ? '(left)' : '';
  }

  // What to tell the user to do with the key, given how the binding behaves.
  // globalShortcut is press-only, so nothing in this app is really "hold".
  function verb(kind) {
    return kind === 'hold' ? 'Hold' : 'Press';
  }

  return { label, parts, tokens, sideHint, isModifierLabel, platform, verb };
});
