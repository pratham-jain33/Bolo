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
