# Bolo — the full vision (parked)

> Parked on 2026-09-26. The complete implementation lives on the
> `archive/bolo-full` branch. `main` is now the **Bolo Doctor** vertical
> slice: post-consult voice notes for Indian solo clinics. Nothing here is
> lost; this document is the map back.

## What Bolo was meant to be

A voice-first operating layer for Windows. Not an app you open — a layer
that sits under everything you do, so speaking to your computer feels as
natural as speaking to a person next to you.

## The pieces (all on `archive/bolo-full`)

- **The Pill** — a small floating microphone that lives on screen. One tap,
  speak, done. Always one key away.
- **The Notch** — a capsule UI at the top of the screen that shows what Bolo
  heard, what it is doing, and what it did. Waveform while listening,
  transcript while thinking, quiet confirmation when done.
- **The Dashboard** — the main window: settings, keys, microphone choice,
  customization.
- **The Intro** — an animated first-run onboarding that lets you try
  dictation with your own voice before you commit to anything.
- **Voice modes** — Dictation (speak, it types), Edit (speak, it rewrites
  what is selected), Agent (speak, it does things on the machine).
  An intent router decided which one you meant.
- **Global activation** — system-wide hotkeys (press or hold) plus an
  optional wake word, so the microphone is available in any app.
- **Injection** — typed the words into whatever app had focus, with a
  clipboard fallback when focus could not be trusted.
- **Bring your own keys** — Groq for the brain, Deepgram for speech,
  Sarvam Saaras for Indian languages. Keys stored locally, rotated on
  failure.
- **Extras** — Spotify control, audio ducking, spoken replies (TTS),
  text replacements, per-app context awareness.

## Why it is parked

A horizontal platform needs years. A vertical slice needs weeks and can
earn its first users now. Bolo Doctor takes the two strongest pieces —
Hinglish speech-to-text and LLM structuring — and aims them at one job:
a solo doctor's patient notes. If the slice works, the platform gets its
second chance with real users behind it.

## Resuming

Everything needed is on `archive/bolo-full` at the commit this file was
written against. The automated doctor checks from that era are in
`bolo-new/tools/doctor-check.js` history if the slice ever needs them.
