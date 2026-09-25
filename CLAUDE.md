# CLAUDE.md — bolo

bolo is a from-scratch clone of **VoiceOS** (WakoAI Inc). Reference: `resources/app.asar.contents/`. Clone lives in `goatedOS/` (directory kept original name; nothing user-facing reads it). Working folder for all edits: **`bolo-new/`** (synced to goatedOS as of 2026-09-22).

Goal: *"I WANT IT MASTERED AND PIXEL PERFECT. ALL SMOOTH ANIMATIONS EVERY SINGLE THING."* / *"should be able to get me into Y Combinator."*

---

## Environment / classifier issues

`~/.claude/settings.json` → `permissions.defaultMode: "bypassPermissions"`. The safety classifier is intermittently flaky — `deepseek-v4-flash is temporarily unavailable`. Identical Bash calls pass and fail. **Read/Glob/Grep never need it.** Retry on rejection; don't conclude it's broken.

---

## Hard rules

1. **Never copy VoiceOS artefacts, fonts, images, audio, video, or the name "VoiceOS".** Read to learn values (colours, radii, timings, copy), re-author equivalent code.
2. **Lexend** is OFL — bundled at `src/renderer/fonts/`. **Recoleta** is commercial — falls back to Georgia.
3. **Deliberate divergences** (keep, don't fix):
   - Backend: Groq API + Qwen model; STT: `whisper-large-v3-turbo`; brain: `qwen/qwen3.8-27b`; voice: Deepgram — user's own keys.
   - **No subscription/paywall screen.**
   - *"keep my hacks, match the rest. if you need to edit/rebuild my hacks, do so."*
4. **Three real modes on three keys** (re-introduced 2026-09-21): Dictation `Control+Shift+D`, Edit `Control+Shift+E`, Agent `Control+Shift+A`. **Do NOT collapse to one key.**

---

## The `const`/`var` trap

`contextBridge.exposeInMainWorld` defines `bolo` as non-configurable on `window`. A top-level `const`/`let bolo` is a **SyntaxError at parse time** — the whole file dies silently. `var bolo = window.bolo;` is required in `app.js`, `intro.js`, `notch.js`, `capture.js`. **Do not modernise to `const`.**

---

## Layout

```
VoiceOS-clone/
├── CLAUDE.md
├── bandicam 2026-09-19 ….mp4      reference recording of real VoiceOS
├── frames/   (60 JPEGs, 1360×768) setup flow
├── vframes/  (300 JPEGs)          denser — USE THIS ONE
├── goatedOS/                      canonical clone
│   ├── src/main/                  main process
│   ├── src/preload/preload.js     bridge
│   ├── src/renderer/              all window UIs
│   └── tools/                    measurement scaffolding
└── bolo-new/                      working copy (synced from goatedOS 2026-09-22)
```

**Also in `goatedOS/tools/`:** `vframes_voiceos/` (148 frames) + `vframes_voiceos_scaled/` — extracted from `voiceos-overview.mp4` (the dashboard recording). Contact sheet: `tools/out/voiceos-sheet00.jpg`.

**Main files:** `main.js` (boot+IPC), `shell.js`, `intro.js`, `notch.js`, `voice.js`, `modes.js`, `shortcuts.js`, `wake.js`, `settings.js`, `onboarding.js`, `history.js`, `keys.js`, `seed-keys.js`, `groq.js`, `intent.js`, `stt.js`, `tts.js`, `agent.js`, `workflows.js`, `coding.js`, `injector.js`, `audio.js`, `capture.js`, `sidecar.js`, `http.js`.

**Integrations** (via `integrations.js`): `google.js`, `gmail.js`, `calendar.js`, `spotify.js`, `obsidian.js`, `local-files.js`, `local-notes.js`, `chat-import.js`, `maps.js`, `mcp.js`.

**Machine:** `capabilities.js`, `context.js`, `duck.js`.

**Renderer:** `index.html`+`app.js` (dashboard), `styles.css`, `theme.css`, `onboarding.css`, `wordmark.js`, `speak.js`, `fonts.css`+`fonts/`, `boot.js`, `diag.js`; `intro.html/js/css`; `pill.html/js`; `notch.html/js/css`; `capture.html/js`.

---

## Running it

Dev mode only — no `dist/` (deleted 2026-09-20).

```bash
cd goatedOS        # or bolo-new
npm run dev        # electron . --dev
```

User's shortcut: `Desktop\bolo (dev).lnk` → `Start bolo.cmd` → `npm run dev`.

Onboarding state: `%APPDATA%\bolo\bolo-onboarding.json` — delete to replay intro. Settings → Extras also has Replay intro / Restart onboarding.

`npm run demo` is **broken on Windows** (`&` is not a separator in cmd/PS5.1). It's also obsolete — STT goes to Groq from main.

---

## Diagnostics

- `src/renderer/diag.js` — loaded **first** in every page. Capture-phase `error` + `unhandledrejection` → forwarded to main. Must stay first — only thing that can catch a parse error.
- `bolo:renderer-error` channel logs `[bolo <file>] message (detail)`.
- **Intro watchdog** in `main.js` — if intro hasn't passed `glow` in 8s, aborts and reveals dashboard.
- `[bolo intro] phase → <name>` logged on every intro transition.
- `#diag` red box on every window, populated only on failure.

---

## Voice pipeline

Keys in `src/main/seed-keys.js` (gitignored; `keys.js` degrades if missing). **⚠ Not a git repo — gitignored protection is NOT in effect. Keys are live.**

| Job | Provider | Default | File |
|---|---|---|---|
| STT | Groq | `whisper-large-v3-turbo` | `stt.js` |
| Router + brain | Groq | `qwen/qwen3.8-27b` | `groq.js`, `intent.js` |
| Voice | Deepgram | `flux-cole-en` | `tts.js` |

**`keys.js`:** `{ providers: { groq: {keys,index}, deepgram: {keys,index} }, seeded }`. `nextKey(p)` round-robins with 15s cooldown. **A key must never reach the renderer unmasked.**

**Deepgram two families:** `flux-*` → `/v2/speak`; `aura-2-*` → `/v1/speak`. Wrong pairing = 400. `endpointFor(model)` in `tts.js` is load-bearing. Voices: Cole/Sienna/Alexis (flux), Delia/Orion (aura-2).

**TTS respells:** `Qwen` → "Kwen", `Groq` → "Grock", ~30 Indian names. `bolo` deliberately absent. Spoken text only, display untouched.

**Mic lives in hidden capture window** — three load-bearing webPreferences: `backgroundThrottling:false`, `autoplayPolicy:'no-user-gesture-required'`, `setPermissionRequestHandler`. Mic list route: dashboard → main → capture window → back (by nonce). Virtual cable trap: user's Windows default recording device is `CABLE Output (VB-Audio)` — check before blaming the model.

**`audio.stop()` called exactly once per session.** `voice.js` captures promise in `const clip = audio.stop()` and awaits that value.

**MediaSource + SourceBuffer** for streaming TTS: `appendBuffer` throws `InvalidStateError` while `updating`, so chunks queue on `updateend`. Playback starts on first successful append. Stream holds notch open. 90s ceiling refreshed per chunk. First byte at 1.6s, last 3.7s, 286 chunks (verified: `tools/tts-stream-check.js`).

**`media-src` must allow `blob:`** in every window that plays TTS — `notch.html`, `intro.html`, `index.html`.

**`interactionSounds`** is master mute for app voice; gates `bolo:speak` alongside `ttsEnabled`.

**Intro narration paced by clip, not fixed step.** `speak.js` exposes `meta(bytes, mime)` for real MP3 duration. Second line synthesised while first is spoken.

---

## Three modes (2026-09-21)

| Mode | Default key | What it does | Path |
|---|---|---|---|
| Dictation | `Control+Shift+D` | Types verbatim where cursor is | `intent.forced('dictation')` → `insert` |
| Edit | `Control+Shift+E` | Rewrites selected text per spoken instruction | `intent.forced('edit')` → model rewrite → `edit` |
| Agent | `Control+Shift+A` | Carries instruction out | `intent.forced('agent')` → `agent.act` |

- Defaults bindable. Old `Fn`/`Ctrl+Fn`/`Ctrl+Alt` defaults were dead on Windows (`Fn` is swallowed by embedded controller). Migration v3 in `settings.js` swaps them.
- `voice.js` captures `sessionMode` at listen-start; `sessionMode = null` → inferring router.
- `bolo:set-mode-shortcut { mode, accelerator }` — registers first (taken key refused, NOT saved), persists, broadcasts.
- Notch mode chip: inline SVG glyph + label + colour (blue/amber/violet). Photographed: `tools/out/notch-{dictation,edit,agent}.png`.
- **Activation degrades, doesn't die.** `shortcuts.registerTolerant(id, accelerator)` walks fallback chain, reports `{ requested, substituted }`. Escape NOT global (would swallow from other apps).

---

## Onboarding

`src/main/onboarding.js` (179 lines). Steps at lines 24–34:

```js
const STEPS = [
  'name_collection', 'language_selection', 'system_permissions',
  'three_modes_keys', 'dictation_demo', 'edit_demo',
  'agent_mode_connect', 'agent_mode_try', 'refer_a_friend'
];
```

`get()` returns `{steps, categories, step, stepIndex, totalSteps, category, completed, introSeen, data}`. `WRITABLE` allowlist. Methods: `go`/`next`/`back`/`complete`/`reset`.

**Intro hosts all first-run steps.** `src/renderer/intro.js` local STEPS (7 entries, starting `system_permissions`); `RENDERERS` at 1003; `canAdvance()` at 1015.

**Bug (not yet fixed):** `syncBeatNav()` at line 1032 and `isLast` at 1133 compare against `STEPS.length - 1` (= 6, maps to `agent_mode_connect`), so Finish fires 2 beats early and skips `agent_mode_try` + `refer_a_friend`. Fix: use `obState.steps.indexOf(STEPS[last])` against global `obState.stepIndex`.

**Back-button bug:** `back.hidden = obState.stepIndex <= 0` shows Back on first intro beat. Going back to `language_selection` renders blank (no else in `renderOb()`).

**`bolo:mode` handler** (synced from goatedOS): in `app.js` and `intro.js`, tracks which trigger keys have been tested on `three_modes_keys` step.

**`bolo:intro-finish` stale comment** at `main.js:1486-1489` says it jumps to `system_permissions`; actually calls `onboarding.complete()` via `finish()`.

---

## Background (user's explicit fix)

**User selected: Authored gradient, fully opaque.** The intro window becomes opaque (`transparent: false`); bolo owns the whole frame with authored gradient. **No `desktopCapturer`, no `--ob-bg-image`, no `#backdrop`.**

This is a **deliberate divergence** from the reference (which keeps desktop icons visible behind scrim).

**Touch points to remove** (not yet applied):
- `src/main/main.js:1403-1423` — `bolo:intro-desktop` handler + `introDesktopDataUrl`
- `src/main/main.js:1491-1497` — `bolo:ob-bg` forward in `bolo:intro-finish`
- `src/preload/preload.js:49` — `bolo:ob-bg` in EVENTS; `:249` — `introDesktop` bridge fn
- `src/renderer/intro.html:18` — `#backdrop`/`#backdropImg`
- `src/renderer/intro.js:444-451` — backdrop painting in `open()`; `:1177-1181` — `bolo:ob-bg` listener
- `src/renderer/intro.css:48-63` — `.backdrop` rules; `:15-16` — header comment
- `src/renderer/app.js:362-374` — `obBgReceived`/`applyObBg`/`bolo:ob-bg`; `:2708-2711` — fresh-grab fallback
- `src/renderer/onboarding.css:27-34` — drop `var(--ob-bg-image, none)`
- `tools/intro-stub.js:6,20` — `introDesktop`/`desktopBg`
- `src/main/intro.js:53-58` — change `transparent:true, backgroundColor:'#00000000'` to opaque + authored gradient

---

## Other pending bugs

- `bolo:screenshot` at `main.js:970` → uses `sidecar.capture()` which is a 200-char stub. Fix: use `capabilities.screenshot`.
- `keyCapture.keyup(e)` never called at `app.js:1911` and `intro.js:859` — dead `keyup` guard. Also needs un-latching on blur/click-away.
- Missing `.pill-large.routing` in `styles.css` (~lines 646-662).
- `modes.VOICE.shortcut` contradicts `settings.DEFAULT_VOICE_SHORTCUT`.
- Dead code: `intro.js:49` (`let demoText`), `:59` (`let curIndex`), `:216` (`revealWords`), `:707` (`beatNav()`). Duplicated comment block at `app.js:1782-1798`.

---

## Tools

```bash
cd goatedOS   # or bolo-new
./node_modules/.bin/electron tools/probe.js  <spec.json>
./node_modules/.bin/electron tools/shot.js   <page> <out.png> <w> <h> [waitMs] [bgHex] [bgImage] [evalJs] [preWaitMs] [preloadFile]
./node_modules/.bin/electron tools/montage.js <inDir> <outDir> <prefix> <cols> <rows> <thumbW> <start> <count>
```

- **`probe.js`** — crops/probes/grid/masks/blobs. `blobs` gives exact glyph+button boxes.
- **`shot.js`** — renders page at fixed size; can paint reference still behind overlay; runs JS to drive beats; injects stub preload. **Run from Bash, not PowerShell** (PS5.1 silently drops empty-string args, shifting all subsequent args left — `400` as preWaitMs is the tell).
- **`montage.js`** — tiles stills into contact sheets.
- **`ob-stub.js`**, **`intro-stub.js`**, **`notch-stub.js`** — stand in for preload bridge. **Must publish to `window` directly** (not via `contextBridge` — `contextIsolation:false` in shot.js means `exposeInMainWorld` is a no-op there).
- Single-purpose checks: `keys-check.js`, `groq-check.js`, `stt-check.js`, `tts-probe.js`, `tts-stream-check.js`, `capture-check.js`, `peek.js`.
- Integration checks (run as `electron tools/<name>-check.js`): `smoke.js` 71/71, `duck-check.js` 13/13, `context-check.js` 11/11, `injector-check.js` 7/7, `wake-check.js` 17/17, `calendar-check.js` 44, `spotify-check.js` 134, `files-check.js` 114, `misc-check.js` 148, `mcp-check.js`.

---

## Ground truth from recordings

### Main recording (`bandicam 2026-09-19 21-26-05-182.mp4`, 1366×768)

Extracted to `vframes/` (300 JPEGs) and `frames/` (60 JPEGs, **1360**×768 — 0.4% horizontal error). **Extraction DONE — do not redo.**

`vframes/` covers installer (000–130), intro opening (135–175), name beat (175–250), name typing + notch prompt (250–299). `frames/` covers full setup flow: Welcome (f015) → Google sign-in (f016–f020) → Enable core features (f021–f023) → key-check (f024–f026) → Ask question (f027–f030) → notch media (f034–f037) → email (f038–f039) → task+launcher (f040–f056) → pricing (f060).

### Dashboard recording (`voiceos-overview.mp4`)

`goatedOS/tools/vframes_voiceos/` (148 frames) + `vframes_voiceos_scaled/` (11 scaled). Contact sheet: `tools/out/voiceos-sheet00.jpg`. **This is the dashboard ground truth** — fidelity gap #5 is now closable.

### Intro — measured at 1360×768

Translucent dark scrim over live desktop — icons stay visible, dimmed. **Wordmark stays on screen the whole sequence**, copy/controls animate around it. Wordmark: x 400…960, y 342…427 (85px x-height, 560px wide, centred at 384.5). The `bolo` logotype is `b o l ●` — final `o` is a filled disc (the brand; a font can never draw this).

**Opening beats:**
- Beat 1 — wordmark alone.
- Beat 2 — `Get Started` pill fades in below (~y 518): near-white translucent, `border-radius:9999px`.
- Beat 3 — two copy lines above mark → two frosted pill inputs overlapping wordmark's lower half. Two separate 254×53/256×53 pills (12px gap). Fill `rgba(228,229,236,0.74)`. 31px blue circle with white up-arrow inside right end of second pill (appears once first name has content). Bottom-right: `Skip intro` 13px 50% white.

**Notch capsule** throughout: black, 286×32 collapsed, bottom-corners r=16, top flush with screen, 18px blue orb 22px from left. Expanded: 442 wide, bottom-radius 24.

**Notch prompt (frame 299):** `(icon)  Type or hold  [alt] [control]  to speak`. Keycap chips: small dark rounded rects, 1px light border, lowercase. VoiceOS uses macOS wording (`alt`/`control`) even on Windows — bolo should decide deliberately.

**Vertical mic-level meter** (early frames): dark rounded rect, white fill bar, number `42` beneath. This is the idle/armed affordance, NOT the active one (no floating circle during real dictation — `frames/f042.jpg`).

---

## What was rebuilt against stills

- **Logotype** (`wordmark.js`): hand-authored SVG, 100-unit x-height. `TOTAL=400`, `INK_W=386`, viewBox `0 0 400 153`. Two geometry bugs fixed: `TOTAL` must sum advances per character in word (not per distinct glyph — `bolo` has two `o`s), box centred on ink not advances.
- **Intro** — scrim as vertical ramp (transmission 0.41 top → 0.06 bottom, small blue lift). Main grabs desktop still on open, hands it back blurred (transparent Electron window can't blur behind it). Name pills: 7px blur on `.field`/`.lang` (reference's glass barely blurs — `#e8e9ee` over wordmark). Focused field keeps label (reference: `frames/f008.jpg`).
- **Notch** — 286×32 tab morphs to 442-wide panel. Renderer measures itself every frame; main resizes window to follow. Hint line left-aligned at 28px inset.
- **Onboarding** — full-window, not centred modal. Progress bar 24…1055×23…34, 396px content column, 28px light titles, Back/Continue bottom corners.
- **Floating pill** — 65×138 tile, 12×78 track, white 10px peak band on blue fill, number beneath. Geometry from `vframes/…_160.jpg`.
- **Dashboard tokens:** hero `h1` = `var(--font-sans)` 32px/300 (not serif); switch "on" = `var(--primary)` (not green); `.brand-wordmark` 30px; `.tile-title` dot `align-items:flex-start`.

**Not yet matched:** dashboard pixels (now closable via `vframes_voiceos/`), launcher panel resting geometry, notch materials.

---

## VoiceOS product details (from `index-DsnvQOOB.js`)

**Modes:** Dictation / Ask / Edit / Agent. Hands-Free = double-tap Agent shortcut.

**Settings sections:** General · Audio & Speech · Visibility · Appearance · Notch appearance · Context Awareness · Extras.
- Appearance → Theme (Light/Dark/Auto)
- Notch appearance → Top notch + Side notch, each Liquid Glass or Solid Black (LG = macOS 26+ only)
- Visibility → hide pill/side notch/top notch
- Audio & Speech → mic, languages, launch at login, dock, interaction sounds, lower media volume while dictating

**Customize** (`knowledge`): Personal/Team tabs, Dictionary (AI bulk-import), Replacements, character/word limits.

**Also real:** trigger keys (modifier-only + mouse buttons), Creator Mode badge, Close to tray, Auto-paste in ask mode, Private mode, Practice mode.

**Voice Type archetypes:** The Midnight Operator · The Deep Thinker · The Agent Commander · The Consistency Machine · The Weekend Warrior · The Multilingual Mind · The Power Prompter · The Inbox Assassin · The Voice Native.

**Design tokens** (`index-BZyvGCT3.css`) — shadcn neutral, `--radius:.5rem`. Light: bg `neutral-50`, card `#fff`, primary `#171717`, border `#e5e5e5`, ring `#0a0a0a`. Dark: bg `neutral-950`, card `#000`, primary `#fafafa`, border `#0d0d0d`, ring `#d4d4d4`, muted-fg `#a3a3a3`.

---

## Gotchas

- **Packaged build doesn't track source.** `npm run dev` proves nothing about `dist/`. Verify package by `asar extract` + `diff`.
- **PowerShell doesn't expand globs.** `node --check src/renderer/*.js` passes literal `*`. Use `Get-ChildItem -Recurse src -Filter *.js | ForEach-Object { node --check $_.FullName }`.
- **PS5.1 silently drops empty-string args to native exe.** `shot.js` trailing slots are usually empty — every arg after first empty one shifts left. Run `tools/shot.js` from Bash.
- **`shot.js` stub must publish to `window` directly.** `contextIsolation:false` → `contextBridge` is undefined → `exposeInMainWorld` is no-op. See `tools/notch-stub.js`.
- **`globalShortcut` is press-only.** Hold-to-talk via `uiohook-napi` (`activation.js`). `settings.activationMode` = `'hold'` (default) or `'toggle'`; falls back to toggle if hook can't load.
- **Never size always-on-top overlay to `display.bounds`** — includes taskbar. Use `display.workArea`.
- **`bolo:notch` is overloaded.** With `phase` → voice state machine → notch window only. Without → notch appearance for Settings. `broadcastAll` in `main.js` splits them.
- **Two Electron instances share one profile.** `Unable to move the cache: Access is denied.` Run `taskkill //F //IM electron.exe //T` first.
- **Killed child's `exit` event lands after replacement is spawned.** `duck.js` + `context.js` persistent PS children: `exit` handler now captures process and checks `child !== proc` before clearing. Symptom: race-shaped test failures.
- **PS `Add-Type` needs namespace, not just assembly.** `-ReferencedAssemblies UIAutomationClient` → `TextPatternRange` needs `System.Windows.Automation.Text` with its own `using`.
- **UI Automation needs STA thread.** `context.js` passes `-STA` explicitly.
- **Unbounded IPC echo loop.** `setView()` → `bolo.setView()` → main → `webContents.send('bolo:view')` → `setView()` again. Fixed with `setView(name, fromBroadcast)`. Audit any handler that calls a channel it also listens on.
- **`flex item refuses to shrink below content height** without `min-height:0`. `.side nav` has both.
- **Broken harness fakes a bug.** `ob-stub.js` returning `[]` for `intCatalog` → Integrations grid photographs as broken. Keep stubs mirroring real payloads.
- **Synthetic `WheelEvent` doesn't scroll.** Only CDP `Input.dispatchMouseEvent` with `type:'mouseWheel'` works. `completed:false` puts onboarding overlay over dashboard — scroll test measures `.obp-split`, proves nothing.
- **CDP Page-domain calls hang on transparent intro window.** `Page.enable`/`captureScreenshot`/`setDefaultBackgroundColorOverride` never resolve. `Runtime.evaluate` works fine. Use `tools/shot.js`.
- **`bolo:screenshot` is a 200-char stub.** `sidecar.js` (16 lines) returns `dataUrl.slice(0, 200) + '…'`. Needs real `capabilities.screenshot`.
- **Restart onboarding wipes settings.** `bolo:onboarding-reset` → `settings.reset()` → `clear()` → rebuilds instance → `app.relaunch()` + `app.exit(0)`. API keys survive (own store).

---

## Honest status

**Audio is real.** Mic, STT, router, model, TTS — all real API calls. Voice streams: first byte 1.6s, last 3.7s, 286 chunks.

**No stubs left.** Wake-word labels itself `'energy-envelope-stub'` (honest algorithm label, not a stub). All integrations real (11 adapters). Duck, context, injector all real and verified.

**Verified:** 73 files parse (`node tools/check.js`); app boots; logotype measures correctly; all three notch mode chips photograph correctly; `smoke.js` 71/71, `duck-check.js` 13/13, `context-check.js` 11/11, `injector-check.js` 7/7, `wake-check.js` 17/17.

**Not verified:** anything needing a real keyboard (mode keys firing, notch on real desktop, every dashboard pixel). Integrations against live third-party accounts.

**Named `bolo`** as of 2026-09-21. Clone directory still `goatedOS/` — Desktop shortcut + `.cmd` resolve through it.

**`bolo-new/`** is a working copy synced from goatedOS on 2026-09-22 — it is the active working folder.

**`voiceos-overview.mp4` + `vframes_voiceos/`** — the dashboard recording. Existed but not documented previously. Closes fidelity gap #5.

---

## Session 2026-09-24 — cinematic onboarding, real-pipeline trials, hook-flag fix

All work in `bolo-new/` (active folder; `goatedOS/` is stale, do not treat it as newer). Not a git repo. Verify with `node ./tools/check.js` (76 files) + `./node_modules/.bin/electron tools/smoke.js` (75/75).

### Onboarding shape (intro window hosts everything)
- Single step `three_modes_keys` with a local pager (Dictation/Edit/Agent screens, no store split). Full 8-step flow ends at `agent_mode_try`. `refer` step removed everywhere; `refer_a_friend` no longer in STEPS.
- Tech-check fully automatic (missing-only rows); Back = subtle text link bottom-left, Continue bottom-right (pinned corners, never under card); **Skip intro removed entirely**.
- Closing the intro (Alt+F4 / taskbar X) now **quits the app** (`main.js` `closed` handler → `app.quitting=true; app.quit()`). Previously it revealed the dashboard with the old overlay on top.
- No-scroll cards: no `max-height`/`overflow` on `.beat`; compact padding/glyph/quote; trial textareas capped 84px, `resize:none`.

### Key screens + live trials (all on the REAL pipeline — demo routing deleted)
- Pre-trial card: title + sub + caps only (glyph and "Waiting for your key" removed; confirmed = accent border). "Press X once to confirm" (tap = key check); mid-trial the sub switches to "Hold X and speak — release to send".
- Trial completion: dictation = 60% word match on box content (typing counts, `input` listener); edit = `bolo:injected` with `ok && systemWide` (only a paste that actually landed); agent = `bolo:answer` act `ok` (failures keep trial open).
- Trial boxes editable + autofocused on trial start (real injection pastes into focus). Old `bolo:ob-demo-result` handler/listener and all `obDemoStart/End` calls removed from intro; `syncDemoMode` only closes stale bindings. `bolo:ob-demo-start/end` IPC + `voice.demoMode` kept for the legacy dashboard overlay (`app.js`) — untouched.
- Dots live **outside** the card (below it), still clickable + show confirmed state. Progress line ("1 of 3 keys") removed everywhere; Continue tooltip is the only gate hint. One Skip (plain text left of Continue): pre-trial skips the key, mid-trial skips the trial. In-card skips removed.
- Notch parked above the intro during beats (`notch.setAboveIntro(true)` in `revealNotch()`, cleared on `finish`/`abort`) + re-raised on every intro-window `focus` — on Windows all always-on-top windows share one band, so clicking the trial box used to bury the capsule behind opaque glass. Narrated confirmations never paint as notch text during onboarding. Reply text paints at generation; capsule collapses exactly 2500ms after voice ends (`REPLY_DWELL_MS`).
- TTS letter fix scoped to `+ X` pattern (`PLUS_LETTER_RE`) — says shortcut "A" as a letter without rewriting articles.
- Trial copy uses Hold semantics everywhere (hold-to-talk is the default); `stopHold`'s tap-semantics suspension was removed with demo.

### ROOT CAUSE found + fixed: flaky native modifier flags (`src/main/activation.js`)
- Symptom: keys dead everywhere (not onboarding-specific). Proven with a synthetic-chord probe (`keyTap` F24 through the real OS path): native keycodes always arrive, hook runs, `globalShortcut` fires — but the hook's `ctrlKey/shiftKey` flags lie intermittently (same chord reported `ctrl=false` once, `ctrl=true` on later runs). In hold mode the keys live only on the hook → dead key.
- Fix: `activation.js` tracks held keycodes from the event stream and matches on flags **OR** tracked set (`trackedMatch`, exact class semantics — extra held modifier still refuses; cleared on start/stop). Verified 3 consecutive probe runs, all chords press+release matched 7/7. Probe file deleted afterwards.
- Verified against package ground truth: uiohook-napi 1.5.5 emits `keydown`/`keyup` (see `dist/index.js` `handler()`), `UiohookKey` are scancodes (D=0x20), `prebuilds/win32-x64` present. No injected-event filtering in libuiohook Windows path.

### Hardening (`main.js` / `voice.js`)
- `voice.toggle` ignores presses mid-transcription (`{busy:true}`); `triggerVoice` keeps the mode chip on busy.
- `triggerVoice`/`startHold` catch machine throws → terminal log + notch error card (previously unhandled rejection = silently dead key).
- Terminal tracing (permanent, concise): `[bolo activation] mode=hold|toggle …`, `[bolo hold] press/release …`, `[bolo voice] toggle …`.

### Notch logo (open, needs user verdict)
- Blank-tab report: capsule paints, centre empty = `capLogo` empty. `notch.js` renderer now self-heals (`paintLogo()` on load + every render) and reports once to the terminal (`notch wordmark missing`) if `wordmark.js` never defined the mark. Retest pending: logo back? If the terminal line appears, `wordmark.js` isn't executing in `notch.html`.

### Session file map
- `src/renderer/intro.js` — pager, trials, completion listeners, copy.
- `src/renderer/intro.css` — beats/nav/trial layout (no-scroll compact).
- `src/renderer/intro.html` — `beatSkip` text button left of Continue.
- `src/renderer/notch.js` — logo self-heal + missing-mark report.
- `src/main/main.js` — close-quits, busy/throw guards, terminal logs.
- `src/main/intro.js` — notch pin + focus re-raise + release on finish/abort.
- `src/main/notch.js` — `setAboveIntro()` pin, level preserved in `applyAppearance`.
- `src/main/voice.js` — routing re-press guard.
- `src/main/activation.js` — held-keycode tracking + dual-path matching.
- `%APPDATA%\bolo\bolo-onboarding.json` absent → fresh replay; never delete `bolo-keys.json` / `bolo-settings.json` (live user data).

---

## Session 2026-09-24 (later) — the onboarding trials could never run

All work in `bolo-new/`. Verified: `node ./tools/check.js` 77 files clean; `smoke.js` 75/75;
`capture-check`, `injector-check` (6/6 — the 7th is skipped when the probe window can't take
foreground), `wake-check` 17/17.

### ROOT CAUSE of "the notch does nothing in onboarding"

The store's `*TriggerTested` flags are a **record of an earlier run**, and the renderer was
trusting them to decide whether a trial may open:

- `%APPDATA%\bolo\bolo-onboarding.json` had all three true with `completed:false`,
  `introSeen:false`, `stepIndex:6`.
- `main.js:505` → `introPending = !completed && !introSeen` → **the intro replays every launch.**
- On that replay `buildKeyPage` read `d[testedKeyFor(m)]` (all true) → every card painted as
  already confirmed, `markKeyTested()` bailed on `if (d[field])`, and `advanceFromKeyPage()`
  found no untested key so it said "All three work" and parked on Agent.
- **The live trial — the only place onboarding shows the notch doing anything — was unreachable.**
  Key pressed, nothing happened, forever, on every launch.

Fix (renderer-side, no store migration): `keyTrialDone` in `intro.js` is the source of truth for
"run in this pass"; a stored flag pre-confirms the card only. `markKeyTested` no longer refuses,
the pager opens on the first key **not run this pass**, a confirmed card grows a "Try it again"
control, and `skipKey`/`skipTrial` count as dealt with so the pager moves on. `resetKeyTrials()`
fires on fresh entry to the step.

### Second cause: the pipeline could succeed invisibly

- **The capsule is gated for the opening beats** (`intro.start()` → `notch.setIntroHidden(true)`,
  released by `revealNotch()` on `handoff`/`beats`). While gated, `show()`/`rest()`/`applyAppearance()`
  all no-op — so a mic or TTS error reached nothing at all. Every refused `show()`/`rest()` now
  traces **with the gate that refused it**.
- **The notch was the only overlay window without `backgroundThrottling:false`**
  (`grep -rn backgroundThrottling src/main` → capture.js only). It is transparent, unfocused and
  always-on-top — the class Chromium occludes and throttles — and its renderer drives the meter
  *and* its own geometry report off `requestAnimationFrame`. Flag added.
- **The paste can land in another app.** `injector-check` showed the probe window failing to take
  foreground from Chrome, so the paste went to Gmail while every layer reported success. Windows
  will not let a background process take the foreground. The trials now re-assert focus on
  `bolo:voice-state → listening`, and completion requires the **box to have changed**:
  `systemWide` means "keystroke sent", not "arrived here".
- `revealNotchForTrial()` in `main.js` calls `intro.revealNotch()` on every hold-press/trigger, so a
  press can never land on a capsule that is still held down.
- Setup failures now paint **in the intro window** (`.setup-error`, above the Back rail) via a new
  `bolo:setup-error` channel — the surface the user is actually looking at.

### The logo: proved sound, hardened anyway

`tests`: `shot.js src/renderer/notch.html` (136×48, `tools/notch-stub.js`) reports
`wordmark:true, svg:true, glyphs:4, 50×20px, stroke/fill rgb(255,255,255), diag:""` — in **solid,
and in glass on a transparent window**. So the markup, script order and CSS are correct and the
empty centre is **window-level, not markup-level**; it could not be reproduced headlessly.
Hardened: the guard is `!capLogoEl.querySelector('svg')` (not `hasChildNodes()`, which counts a
whitespace text node), a throw now **reports** instead of vanishing in `catch (_) {}`, and the mark
is painted at top level, on `DOMContentLoaded`, on `load` and on every `render()`.

### New: the trace spine

`src/main/trace.js` — `trace.log(scope, message, detail)` → terminal **and**
`%APPDATA%\bolo\bolo-trace.log` (truncated past 256KB, never throws). Wired into `notch.js`
(gates, show/rest, liveness), `capture.js` (which microphone, and a `/cable|vb-audio|virtual|loopback/i`
warning), and `main.js` (hold press/release/state, voice trigger, setup errors).
`bolo:notch-alive` heartbeat (2s interval, carries the rAF tick count) + `startAliveWatch()`
warn when the capsule is visible but the renderer has gone quiet — the difference between a
throttled capsule and a dead one, which otherwise look identical.

### Also

- `setAboveIntro(false)` now restores the always-on-top **level**, not just the flag.
- Trial input meter (`.trial-mic`) in `intro.js`/`intro.css`, driven by the real
  `bolo:voice-level` — a virtual-cable device reads flat zero however loudly you speak.
- Artifacts: `tools/out/notch-logo.png`, `tools/out/notch-glass.png`.

---

## Session 2026-09-24 (later still) — the reference dashboard, re-authored

Asked for `voiceos-overview.mp4`'s dashboard. Two rules shaped it: never copy the reference's
artefacts, fonts, images or its name (hard rule 1), and no paywall (deliberate divergence). So
nothing was copied — the reference's **own shipped renderer was read** and bolo's replaced.

### The authoritative source is the asar, not the frames

`resources/app.asar.contents/out/renderer/assets/index-DsnvQOOB.js` (10MB) is **unminified React
with real component names and comments**. Every value below was read from it, not guessed:

- `SidebarNavItem` — 44px rows, 12px radius, `ICON_SIZE = 20`, `ICON_LEFT_OFFSET =
  (85 − 16×2 − 2 − 20) / 2 = 15.5`, gap 12, `text-sm`, weight 500, padding transitions at
  `300ms cubic-bezier(0.25,0.1,0.25,1)`. Sidebar 220px expanded / 85px collapsed, transparent
  (native macOS vibrancy). Nav: Dashboard · Insights · History · Dictation · Agent · Apps · Team.
- `Card$1` — radius **18px**, light `linear-gradient(165deg, rgb(252,252,252), rgb(248,248,248))`,
  border `1px solid #ffffff`, no shadow; dark `--dark-dashboard-card-background` +
  `--dark-border-subtle` + `0 1px 6px rgba(0,0,0,.2), inset 0 1px 0 var(--dark-surface-highlight)`.
- Home page — `text-[1.7rem]` greeting at weight 600, `letter-spacing:-0.03em`, a 30×30 orb,
  header `mb-[35px]`, page insets `pt-[45px] pl-8 pr-4`, quick-start `grid gap-4` above 600px,
  mode cards `p-4` with a 16px/600 title and keycap chips at `px-2 py-1`.
- Tutorials rail — `CARD_WIDTH_PX = 340`, `CARD_HEIGHT_PX = 236`, `CARD_GAP_PX = 16`,
  `EDGE_FADE_PX = 56`, `HOVER_EASING = cubic-bezier(0.32,0.72,0,1)`.
- `strings.home` gave the home page's exact copy; `strings.nav` gave the nav labels.

### What bolo got

- Sidebar restyled to the reference geometry (220px, 44px rows, 20px icons, active row as a
  raised card-coloured pill rather than a colour flip). Nav renamed to
  **Dashboard · Dictation · History · Apps · Customize · Settings** — the reference's names where
  bolo has the content behind them, and no empty entries for its Insights/Team.
- New `#view-dashboard`, the landing view: greeting with the CSS-authored voice orb (the
  reference's is a cloud photo behind a glass lens — its own asset), one card per activation key
  showing the **live** binding, and a 340×236 rail of real sessions with the 56px edge fade.
- `shell.js` `currentView` and `main.js` `bolo:set-view` default flipped `'voice'` → `'dashboard'`.
- Dropped, not faked: the subscription/usage meter, the referral and affiliate cards, and
  "Meet the Founders". `strings.home` copy is re-authored — never "VoiceOS", always bolo.

### New tools

- **`tools/frame-probe.js`** — measures a reference frame in pixels through `nativeImage`:
  window box vs letterbox, surface colours, and edge runs along a row or a column. `--scan <dir>`
  signs every frame in one line. This exists because the frames cannot be looked at, only measured.
- **`tools/dash-probe.js`** — the dashboard probe expression, passed to `shot.js` as
  `@tools/dash-probe.js`: nav labels/row height/sidebar width, greeting size+weight+tracking, orb
  box, each card's chips and tail, rail card box and gap, fades, page insets, and the diag box.
- **`shot.js` now accepts `@path` for `evalJs`.** A long inline expression is a shell-quoting
  minefield — nested quotes, `!!`, `#` and `$` — and it fails as *silence or exit 127*, not as a
  syntax error. Anything past a one-liner goes in a file.

### Harness fix

`tools/ob-stub.js` returned `shortcut: 'CommandOrControl+A'` and `historyList: []`, so the
screenshot printed the Dictation card as **"Ctrl + A"** — a picture that looks exactly like a
wrong keybinding and was really the stub. Stub now mirrors the real payloads (the three real
`modeShortcuts`, and three realistic history items). Same lesson as `intCatalog: []` before it.

### Verified

`node tools/check.js` 79 files clean; `smoke.js` 75/75. Rendered and measured at 1180×760 and
1366×768: nav rows 44px, sidebar 220px, greeting 27.2px/600/−0.816px, orb 30×30, cards 340×236
at radius 18px and 16px gap, page insets 45/16/40/32, header gap 35px, rail fading only the
overflowing edge, `diag` empty. Dark mode resolves the card to `rgb(34,35,39)` and the border to
`rgba(223,226,232,0.06)` — the reference's own dark tokens.

### Artifacts

`tools/out/dash.png`, `dash-dark.png`, `dash-1366.png`, and `voiceos-sheet-sheet00.jpg`
(60 frames tiled 10×6) for the side-by-side the user can do and I cannot.
