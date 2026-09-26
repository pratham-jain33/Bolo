// Bolo Doctor voice pipeline: one job — record a dictation, transcribe it,
// hand the transcript to the doctor window.
//
// States: idle -> listening -> routing -> idle. There is no router, no agent,
// no injector, no wake word here; those lived in the full Bolo app (see
// archive/bolo-full). Transcription prefers Sarvam Saaras (Hinglish) when a
// Sarvam key exists and falls back to Groq Whisper otherwise.

const audio = require('./audio');
const settings = require('./settings');
const keys = require('./keys');
const stt = require('./stt');
const sttSarvam = require('./stt_sarvam');

let state = 'idle'; // 'idle' | 'listening' | 'routing'

// The raw audio of the last finished dictation: { buffer, mime }. Held in
// memory only. The history-save path takes it (and clears it); a discarded
// dictation is simply overwritten by the next one, so nothing is written
// for notes the doctor never approved.
let lastRecording = null;

function getState() {
  return { state };
}

// Take the pending recording, clearing the slot. Called once per save.
function takeRecording() {
  const r = lastRecording;
  lastRecording = null;
  return r;
}

// The recorded clip to text. Never throws: every failure comes back as a
// result object so the UI can say something human.
async function transcribe(clip) {
  if (!clip || !clip.ok || !clip.buffer || !clip.bytes) {
    return { text: '', mode: 'no-audio', error: (clip && clip.error) || 'empty-audio' };
  }
  const wantSarvam = keys.has('sarvam');
  if (wantSarvam) {
    const r = await sttSarvam.transcribe(clip.buffer, {
      mime: clip.mime,
      ms: clip.ms,
      wav16k: clip.wav16k
    });
    if (r.ok) return r;
    // Missing keys or an over-long clip: Groq still gets a chance. Any other
    // Sarvam failure is reported as-is so the doctor knows what happened.
    if (r.error !== 'no-keys' && r.error !== 'too-long') return r;
  }
  return stt.transcribe(clip.buffer, {
    mime: clip.mime,
    language: settings.get('defaultLanguage')
  });
}

// One tap starts listening, the next tap stops and transcribes. `broadcast`
// carries voice events to the doctor window — the only consumer.
async function toggle({ broadcast } = {}) {
  const emit = (channel, payload) => {
    if (typeof broadcast === 'function') {
      try { broadcast(channel, payload); } catch (_) {}
    }
  };

  // A stop press while a transcription is in flight: not an error, just busy.
  if (state === 'routing') return { ...getState(), busy: true };

  if (state === 'listening') {
    const clipPromise = audio.stop();
    state = 'routing';
    emit('bolo:voice-state', getState());
    const clip = await clipPromise;
    lastRecording = (clip && clip.ok && clip.buffer && clip.bytes)
      ? { buffer: clip.buffer, mime: clip.mime || 'audio/webm' }
      : null;
    const t = await transcribe(clip);
    state = 'idle';
    emit('bolo:voice-state', getState());
    const result = {
      text: t.text || '',
      error: t.error || null,
      mode: t.mode || null,
      message: t.text
        ? null
        : (t.mode === 'no-audio'
          ? 'Heard nothing — try again, a little louder.'
          : 'Transcription failed — check the keys, then try again.')
    };
    emit('bolo:doctor-result', result);
    return { ...getState(), transcript: t };
  }

  // idle -> listening
  state = 'listening';
  emit('bolo:voice-state', getState());
  const started = await audio.start({ wav16k: true });
  if (!started.ok) {
    state = 'idle';
    emit('bolo:voice-state', getState());
    return { ...getState(), started, error: started.error };
  }
  return { ...getState(), started };
}

module.exports = { toggle, getState, transcribe, takeRecording };
