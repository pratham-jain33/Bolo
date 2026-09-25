# bolo

A voice-first desktop assistant for Windows and macOS, built as an original
Electron application. The dashboard's visual language, window chrome, and
floating pill follow the conventions of a modern dictation assistant; all code
here is written for this project.

## What it does

Press a global shortcut and speak; press it again and the transcript is pasted
into whatever app has focus. Four entry points share one state machine:

| Mode | Default shortcut | Task |
|---|---|---|
| Dictation | `Ctrl+Space` | Insert the cleaned-up transcript |
| Ask Mode | `Ctrl+Shift+Space` | Answer a question about what's on screen |
| Agent Mode | `Ctrl+Shift+A` | Take a spoken instruction and act on it |
| Hands-Free | `Ctrl+Shift+H` | Same as Dictation, press-to-start / press-to-stop |
| Paste last | `Ctrl+Shift+V` | Re-insert the previous transcript |

On macOS `CommandOrControl` resolves to `Cmd`. Every shortcut is rebindable in
Settings.

- **Pill** — frameless transparent capsule that resizes per state
- **Notch** — always-on-top agent capsule: mic meter, thinking spinner, and the
  answer itself, with insert-again / copy / dismiss actions
- **Wake word** — optional mic gate so you can start without touching a key
- **Cinematic intro** — a four-beat opening that asks your name and language
- **Onboarding** — the setup flow that follows it
- **History** — every session, stored locally
- **Customize** — dictionary and private mode
- **Integrations Studio** — searchable adapter catalog by category
- **Agents** — intent router plus Claude Code / Codex CLI handoff
- **Settings** — shortcuts, audio, wake word, notch appearance, model backend

## Architecture

```
src/
  main/        Electron main process
    main.js        app lifecycle, IPC surface, shortcut wiring
    shell.js       window management (dashboard, pill, tray)
    modes.js       the four dictation modes and their defaults
    shortcuts.js   named-accelerator registry
    voice.js       mode-aware dictation state machine
    audio.js       mic capture + level metering
    notch.js       agent notch window + appearance
    wake.js        wake-word energy gate + pluggable matcher
    intro.js       cinematic intro window and phase machine
    onboarding.js  14-step setup sequence
    injector.js    system-wide text paste
    keys.js        API key store + rotation
    groq.js        model backend client
    agent.js       intent router
    integrations.js adapter registry
    ...
  preload/
    preload.js   contextBridge surface exposed as window.bolo
  renderer/
    boot.js      early theme application (runs before first paint)
    theme.css    design tokens, glass materials, motion
    styles.css   app shell + components
    index.html   dashboard markup
    app.js       dashboard logic, onboarding, Integrations Studio
    pill.html    pill window markup
    pill.js      pill window logic
    notch.html   notch window markup
    notch.js     notch window logic
    intro.html   intro window markup
    intro.js     intro sequence + narration
```

## Window model

| Window | Size | Options |
|---|---|---|
| Dashboard | 1080x710 | `frame: false`, custom titlebar, vibrancy on macOS |
| Pill | 76x76 idle, 148x68 listening | `transparent`, `alwaysOnTop`, `focusable: false` |
| Notch | width setting + 16px gutter | `transparent`, `focusable: false`, `screen-saver` level optional |
| Intro | full display | `frame: false`, opaque, `alwaysOnTop` at `screen-saver` |

The pill and notch windows are resized to bound their capsule plus a shadow
gutter on each state change, so their transparent margins never grow into large
invisible click targets.

## Shortcuts

`globalShortcut` fires on key press only — there is no key-up event — so every
mode is press-to-start / press-to-stop rather than true hold-to-talk. A genuine
hold-to-talk feel needs a native key hook (`uiohook-napi`), which is not a
dependency here. The UI says "press", not "hold", for that reason.

Registering a mode whose accelerator another app already owns fails cleanly: the
binding is left unchanged and Settings reports which mode holds it.

## Onboarding

The setup flow runs after the intro covers your name and language, so it starts
at permissions. Steps in order:

```
name_collection        language_selection     system_permissions
test_agent_trigger_key agent_mode_ask         agent_mode_connect
agent_mode_try         import_keywords        two_modes_explanation
test_trigger_key       dictation_messages     dictation_email
typing_speed_comparison                       refer_a_friend
```

Each step is grouped into a category (`about-you`, `setup`, `agent-mode`,
`dictation-mode`) shown above the step body. Steps that are real actions — the
two trigger-key tests, the app connection, the keyword import, the typing-speed
comparison — perform that action rather than only describing it.

## Design system

`theme.css` carries the whole visual language:

- An **oklch neutral ramp** (`--color-neutral-50` … `--color-neutral-950`)
- A **semantic layer** (`--background`, `--card`, `--border`, …) that flips
  between light and dark via a class on `<html>`, with a `prefers-color-scheme`
  fallback when no class is set
- **Glass materials** — `.glass-card`, `.glass-border`, and the caustic-bordered
  `.glassmorphic-button` used by the pill
- **Motion** — one long soft easing curve (`--ease-glass`) and a shared keyframe
  set (fade/slide/shimmer/float/spin)

Theme selection is Light / Dark / Auto. `boot.js` applies a stored choice from
`<head>` so a non-default theme never flashes the OS default first; **Auto**
deliberately stamps no class and lets the media query decide.

Typography pairs **Lexend** with a display serif. To enable Lexend, drop the
woff2 into `src/renderer/fonts/` (it is OFL-licensed, so bundling it is fine)
and uncomment the `@font-face` block at the top of `theme.css`; until then it
falls back to the system UI font. The display serif in the original is a
commercial face, so this falls back to Georgia.

## Model backend

Bring your own keys. Everything is held in the main process and only ever
crosses to the renderer masked; rotation is automatic when a key is rate
limited, on a 15-second cooldown per key.

| Job | Provider | Default |
|---|---|---|
| Speech-to-text | Groq | `whisper-large-v3-turbo` |
| The brain — routing and answers | Groq | `qwen/qwen3.8-27b` |
| The voice | Deepgram | `flux-cole-en` |

Two Groq keys rotate round-robin. The Deepgram key is separate and is only used
for speech. Add or replace either in **Settings → Extras → API keys**, where the
provider selector chooses which store Add, Rotate and Clear act on. Both stores
are listed, always, so a missing key cannot hide behind a pane you did not open.

**The five voices**, grouped in the picker exactly as Deepgram publishes them:

| Family | Voice | Gender |
|---|---|---|
| Flux | Cole | male |
| Flux | Sienna | female |
| Flux | Alexis | female |
| Aura 2 | Delia | female |
| Aura 2 | Orion | male |

Flux is served from `/v2/speak` and Aura 2 from `/v1/speak`; the pairing is not
interchangeable and the wrong one is a 400. Test buttons live in
**Settings → Audio & Speech**: *Test mic* records three seconds from the real
microphone and transcribes it, and *Test voice* speaks through the same path a
reply takes — so a pass there means dictation and replies both work.

## Run

```
npm install
npm start          # or: npm run dev  (opens DevTools)
npm run dist       # package to dist/win-unpacked
```

`server/stub.js` and `npm run demo` are **leftovers and no longer used** —
transcription goes to Groq directly from the main process. `npm run server`
still starts the echo server if you want it, but nothing dials it, and
`npm run demo` does not work on Windows at all (`&` is not a command separator
in `cmd`, and a parse error in PowerShell).

## Status

Honest about what is real and what is not.

Real: the microphone, speech-to-text, the intent router, the model, the voice,
context gathering, history, injection. **Settings → Audio & Speech** has a live
test for each half of the audio path, so this is checkable in the app rather
than only in this file.

Still not real:

- **Wake word** detection is a sustained-energy gate with a swappable matcher
  (`recogniser: 'energy-envelope-stub'`). It reliably detects *a* voice, not the
  phrase — wiring a real keyword spotter means replacing one function.
- **Integrations** can be connected, which enables routing, but each adapter
  reports why it cannot act yet until its provider is configured. There is no
  OAuth.
- **The intro does not listen** for the language answer. The list of languages
  is the only way to answer that beat; the microphone lives in the capture
  window, not the intro's.

The dictionary and private-mode toggles persist in the renderer's
`localStorage`; everything else is in the main-process store.

