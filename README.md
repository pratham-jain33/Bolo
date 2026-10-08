# Bolo Doctor

Open source voice notes for small clinics. After the patient leaves, the doctor taps one button, speaks for about thirty seconds in Hindi, English, or Hinglish, and gets a clean structured patient note. No typing, no clinic software to integrate.

## How it works

1. **Dictate** — tap the mic (or press Ctrl+Shift+D) and speak after the patient leaves. Never during the consultation, so there is no ambient recording.
2. **Review** — the note appears with patient details, symptoms, diagnosis, and prescription. The doctor checks every field and edits anything.
3. **Approve** — nothing is saved, printed, or shared until the doctor approves.

Two AI models do the heavy lifting: Sarvam transcribes the speech (it understands Hinglish), Groq structures it into the note. One strict rule: the AI never guesses a drug name, never changes a dose, and never invents a detail. Anything uncertain is flagged for the doctor to check.

## Try it

**Windows, no setup:** download `BoloDoctor.exe` from [Releases](https://github.com/pratham-jain33/Bolo/releases) and double-click to run. Windows may show an Unknown publisher warning — click More info, then Run anyway.

**From source:** install Node.js 20+, then:

```
npm ci
npm start
```

Paste your own Sarvam and Groq API keys in Settings. Keys stay on your machine. The demo button needs no keys and no microphone — it plays a canned dictation so you can try the full review and approve flow in seconds.

## Privacy

Notes and recordings stay on the doctor's own computer (`Documents/BoloDoctor/`). No account, no cloud sync.

## Project layout

```
src/main/       Electron main process (windows, voice, keys, history)
src/preload/    Secure bridge between main and renderer
src/renderer/   The app UI (record, review, history, settings)
tools/          Automated checks (syntax, safety contract, boot)
server/         Local stub used for keyless development
```

`npm run check` runs the static checks. The `doctor-smoke` workflow runs the full check suite and boots the app on Windows.

## License

MIT — see [LICENSE](LICENSE).


## Tests
No test suite is defined in this repository.


## API reference
- **IPC channels**
  - `bolo:doctor-toggle` – toggles dictation, returns current voice state.
- **Main process modules**
  - `src/main/main.js` – application entry point, shortcut binding.
  - `src/main/voice.js` – handles transcription and broadcasting.
  - `src/main/capture.js` – hidden window managing microphone permissions.
  - `src/main/doctor.js` – creates the doctor UI window and sends IPC messages.
  - `src/main/audio.js` – audio level monitoring and control API (`setLevelListener`, `start`, `stop`).
- **Renderer UI**
  - `src/renderer/doctor.html` – main interface for review and approval.
- **Settings**
  - API keys for Sarvam and Groq are stored via `electron-store`.


## Code example
```javascript
// Start the app
npm start

// Global shortcut handling (main process)
globalShortcut.register('Control+Shift+D', () => {
  doctor.show();
  voice.toggle({ broadcast: (ch, p) => doctor.send(ch, p) });
});
```


## Screenshots
*No screenshots are provided in the repository.*


## Code style
The project follows standard JavaScript/Electron conventions. No explicit linting or formatting tools are configured in the repository.


## Build status
To build a Windows distribution:
```bash
npm run dist
```
The `dist` folder will contain the unpacked application (`.exe` and supporting files). No CI badge is defined in the repository.


## How to use
1. Launch the app (`npm start` or double‑click the exe).  
2. Tap the microphone button **or** press **Ctrl+Shift+D** to start dictation.  
3. Speak for ~30 seconds after the patient leaves.  
4. Review the generated note, edit any fields, and click **Approve**.  
5. Save, print, or share the approved note.


## Installation
```bash
npm ci
npm start
```
*For Windows users, a pre‑built `BoloDoctor.exe` can be downloaded from the Releases page.*


## Features
- Single‑button dictation with optional global shortcut (Ctrl+Shift+D)
- Real‑time audio level monitoring
- AI‑driven transcription (Sarvam) and structuring (Groq) into JSON notes
- Review, edit, and approve notes before any save/print/share
- Local storage of notes and recordings in `Documents/BoloDoctor/`
- No cloud sync; keys stay on the machine
- Demo mode with canned dictation (no API keys required)
- Hidden capture window isolates microphone access
- Cross‑platform Electron app (Windows focus)


## Tech/framework used
- **Language:** JavaScript (Node.js)
- **Runtime:** Electron ^33.0.0
- **Build tool:** electron-builder
- **Storage:** electron-store
- **Other:** Uses Sarvam for transcription and Groq for structuring (via API keys)


## Motivation
Open source voice notes for small clinics. After a patient leaves, the doctor can tap a button or use a global shortcut, speak for about thirty seconds in Hindi, English, or Hinglish, and receive a clean, structured patient note without typing or integrating with other clinic software.

---

*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*
