# CLAUDE.md — Bolo Doctor

Open source voice notes for small clinics (Windows Electron app). Post-consult dictation only: the doctor speaks after the patient leaves, reviews the structured note, approves it, then saves / prints / shares. No clinic-software integration.

## Hard rules

- Never silently correct or guess medicine names. Never alter dose, timing, duration, units, or numbers. Never invent missing information. The safety contract lives in `src/main/doctor.js` (STRUCTURE_SYSTEM) and is enforced by `tools/doctor-check.js`.
- Notes use English and Latin script only, never Devanagari. Durations in English ("3 days", never "3 din").
- Generic "khane ke baad" / "after food" with no meal named becomes "after meals" — never guess breakfast, lunch, or dinner.
- Doctor review and explicit approval are mandatory before anything saves.
- `npm run check` (tools/check.js) must pass: syntax over src/ and tools/, plus the require-graph check.

## Layout

`src/main`, `src/preload`, `src/renderer`, `tools`, `server`. Entry: `src/main/main.js`. Run with `npm start` (needs Node 20+). Keys go in Settings, never in code; `src/main/seed-keys.js` is gitignored and optional.
