// Speech-to-text against Sarvam AI's Saaras endpoint.
//
// Same interface as stt.js — `transcribe(buffer, opts)` resolving to
// { ok, text, ... } — so voice.js can route between Groq Whisper and Saaras
// without caring which one answered. Keys stay in this process and are never
// handed to a renderer; the capture renderer returns raw audio bytes over IPC
// and the request is made here.
//
// Saaras specifics that shaped this file:
//
// - Auth is `api-subscription-key: <key>`, not Bearer. A wrong scheme reads as
//   a 403, which is also what an actually-bad key returns.
// - The synchronous endpoint accepts at most ~30 seconds of audio per request.
//   Doctor dictations routinely run longer, so a long clip is sent as WAV
//   16kHz mono (produced by the capture renderer when asked) split into 25s
//   pieces; each piece is transcribed separately and the texts are joined.
//   A webm clip with no WAV alongside it and a duration past ~28s comes back
//   as { ok: false, error: 'too-long' } so the caller can fall back to Groq
//   Whisper rather than failing the dictation.
// - `mode: 'codemix'` is the default because the target users mix Hindi and
//   English inside one sentence; `language_code: 'unknown'` auto-detects.
// - The response shape is { transcript, language_code, ... } — `transcript`,
//   not Whisper's `text`.
//
// Rotation matches stt.js: each attempt takes the next Sarvam key round-robin,
// and a 429/401/403/5xx puts that key in cooldown and moves on. See keys.js.

const settings = require('./settings');
const keys = require('./keys');
const http = require('./http');
const stt = require('./stt');

const PROVIDER = 'sarvam';
const ENDPOINT = 'https://api.sarvam.ai/speech-to-text';
const DEFAULT_MODEL = 'saaras:v3';
const DEFAULT_MODE = 'codemix';
const DEFAULT_LANGUAGE = 'unknown';

// Same bound as stt.js: a hung request must not leave the voice machine stuck
// in 'routing' with the notch spinning forever.
const TIMEOUT_MS = 45000;

// Stay safely under the 30s per-request limit; a word cut at a chunk boundary
// still transcribes, and the join below puts a space where the cut was.
const CHUNK_SECONDS = 25;

// Past this duration a bare webm clip is not sent at all — without a WAV to
// split, the request would be rejected and the dictation lost.
const WEBM_MAX_MS = 28000;

function shouldRotate(status) {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

// Split a 16-bit PCM WAV (44-byte header, as produced by the capture
// renderer's webmToWav16k) into <= maxSeconds pieces, each a valid WAV. The
// byte rate is read from the header rather than assumed, so a future change to
// the capture encoding does not silently mis-slice.
function splitWav(buffer, maxSeconds) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF') return [data];
  let byteRate = 32000; // 16kHz mono 16-bit
  try { byteRate = data.readUInt32LE(28) || byteRate; } catch (_) {}
  const header = data.slice(0, 44);
  const pcm = data.slice(44);
  const chunkBytes = Math.max(1, Math.floor(maxSeconds * byteRate));
  const out = [];
  for (let off = 0; off < pcm.length; off += chunkBytes) {
    const piece = pcm.slice(off, off + chunkBytes);
    const h = Buffer.from(header);
    h.writeUInt32LE(piece.length + 36, 4); // RIFF chunk size
    h.writeUInt32LE(piece.length, 40); // data subchunk size
    out.push(Buffer.concat([h, piece]));
  }
  return out.length ? out : [data];
}

async function transcribePiece(piece, fields, total) {
  const attempts = Math.min(total, 3);
  let lastError = 'unknown';

  // Built once, outside the rotation loop, like stt.js: the clip and the
  // fields are identical on every attempt, so a second key must not pay for a
  // second copy of it. `stt.multipart` is the same hand-rolled encoder, one
  // copy instead of FormData's two.
  const form = stt.multipart(
    [['model', fields.model], ['mode', fields.mode], ['language_code', fields.languageCode]],
    { name: 'file', filename: piece.filename, type: piece.type, data: piece.data }
  );

  for (let i = 0; i < attempts; i++) {
    const key = keys.nextKey(PROVIDER);
    if (!key) break;

    try {
      const res = await http.post(ENDPOINT, {
        headers: {
          'api-subscription-key': key,
          'content-type': form.contentType
        },
        body: form.body,
        timeoutMs: TIMEOUT_MS
      });

      if (shouldRotate(res.status)) {
        lastError = 'http-' + res.status;
        keys.markFailure(PROVIDER);
        continue;
      }

      if (!res.ok) {
        lastError = 'http-' + res.status + ':' + res.body.toString('utf8').slice(0, 200);
        break;
      }

      let parsed = null;
      try { parsed = JSON.parse(res.body.toString('utf8')); } catch (_) { parsed = null; }

      keys.markSuccess(PROVIDER);
      return {
        ok: true,
        text: String((parsed && parsed.transcript) || '').trim(),
        languageCode: (parsed && parsed.language_code) || null
      };
    } catch (e) {
      lastError = e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : e.message;
      keys.markFailure(PROVIDER);
    }
  }

  return { ok: false, error: lastError };
}

async function transcribe(buffer, opts = {}) {
  const model = opts.model || settings.get('sarvamModel') || DEFAULT_MODEL;
  const mode = opts.mode || settings.get('sarvamMode') || DEFAULT_MODE;
  const languageCode = opts.languageCode || settings.get('sarvamLanguage') || DEFAULT_LANGUAGE;
  const total = keys.count(PROVIDER);

  if (!total) {
    return { ok: false, error: 'no-keys', model, hint: 'add a Sarvam key in Settings' };
  }

  // The pieces to send. A WAV alongside the webm means the clip can be split
  // for the 30s limit; without it, a long webm is declined up front.
  let pieces;
  if (opts.wav16k && opts.wav16k.byteLength) {
    pieces = splitWav(opts.wav16k, CHUNK_SECONDS).map((data) => ({
      data,
      filename: 'clip.wav',
      type: 'audio/wav'
    }));
  } else {
    if (!buffer || !buffer.byteLength) {
      return { ok: false, error: 'empty-audio', model };
    }
    if (Number(opts.ms) > WEBM_MAX_MS) {
      return { ok: false, error: 'too-long', model };
    }
    const mime = opts.mime || 'audio/webm';
    pieces = [{
      data: buffer,
      filename: 'clip.' + stt.extFor(mime),
      type: mime
    }];
  }

  const fields = { model, mode, languageCode };
  const texts = [];
  let languageCodeOut = null;
  for (const piece of pieces) {
    const r = await transcribePiece(piece, fields, total);
    if (!r.ok) return { ok: false, error: r.error, model };
    if (r.text) texts.push(r.text);
    if (!languageCodeOut && r.languageCode) languageCodeOut = r.languageCode;
  }

  return {
    ok: true,
    text: texts.join(' ').trim(),
    model,
    mode: 'sarvam-saaras',
    sarvamMode: mode,
    languageCode: languageCodeOut,
    pieces: pieces.length,
    bytes: buffer ? buffer.byteLength : 0
  };
}

module.exports = {
  transcribe,
  ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_MODE,
  DEFAULT_LANGUAGE,
  CHUNK_SECONDS,
  splitWav
};
