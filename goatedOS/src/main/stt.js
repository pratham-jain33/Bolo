// Speech-to-text against Groq's OpenAI-compatible transcription endpoint.
//
// This replaces the old local echo stub. Keys stay in this process and are never
// handed to a renderer: the capture renderer returns raw audio bytes over IPC and
// the request is made here.
//
// Rotation matches groq.js exactly — each attempt takes the next key round-robin,
// and a 429/401/5xx puts that key in cooldown and moves on. See keys.js.
//
// The multipart body is built by hand, and the request goes through the pooled
// client in http.js rather than `fetch`. Both are about the same thing: the clip
// is the largest body the app sends and it sits on the critical path between the
// user releasing the key and their words appearing. FormData copies the audio
// into a Blob and lets undici serialise it a second time into the request, and
// undici drops an idle socket after 4s — so every dictation paid a fresh TCP +
// TLS handshake. Same request, same fields, same order; one copy instead of two,
// and a connection that is still there from the last thing you said.

const crypto = require('crypto');
const settings = require('./settings');
const keys = require('./keys');
const http = require('./http');

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';

// A hung request would otherwise leave the voice machine stuck in 'routing' with
// the notch spinning forever, so every attempt is bounded.
const TIMEOUT_MS = 45000;

// Groq infers the container from the filename extension, so the extension has to
// match what MediaRecorder actually produced. Getting this wrong reads as a
// corrupt-file rejection rather than an obvious format error.
const EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac'
};

function extFor(mime) {
  return EXT[String(mime || '').split(';')[0].trim()] || 'webm';
}

// One multipart/form-data body, assembled into a single Buffer.
//
// A FormData holding a Blob copies the clip twice — once into the Blob, once more
// as the form is serialised into the request — for a body that is already a
// Buffer in hand. This is the same encoding (verified against the live endpoint)
// with a single copy, and it is built before the socket is touched rather than
// while it is open. The boundary is random per request, so a byte sequence in the
// audio cannot collide with it.
function multipart(fields, file) {
  const boundary = '----bolo' + crypto.randomBytes(12).toString('hex');
  // The clip arrives from the capture renderer as an ArrayBuffer, not a Buffer, so
  // it is normalised into a view rather than copied — `Buffer.from(arrayBuffer)`
  // and the offset form both alias the same bytes.
  const d = file.data;
  const data = Buffer.isBuffer(d)
    ? d
    : (d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength));
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
      value + '\r\n',
      'utf8'
    ));
  }
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="' + file.name + '"; filename="' + file.filename + '"\r\n' +
    'Content-Type: ' + file.type + '\r\n\r\n',
    'utf8'
  ));
  parts.push(data);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

function shouldRotate(status) {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

async function transcribe(buffer, opts = {}) {
  const model = opts.model || settings.get('sttModel') || DEFAULT_MODEL;
  const total = keys.count();

  if (!total) {
    return { ok: false, error: 'no-keys', model, hint: 'add a Groq key in Settings' };
  }
  if (!buffer || !buffer.byteLength) {
    return { ok: false, error: 'empty-audio', model };
  }

  const mime = opts.mime || 'audio/webm';
  const filename = 'clip.' + extFor(mime);
  const attempts = Math.min(total, opts.maxKeys || total);
  let lastError = 'unknown';

  // Built once, outside the rotation loop: the clip and the fields are identical
  // on every attempt, so a second key must not pay for a second copy of it. The
  // field order is the one this shape was verified with against the live endpoint.
  //
  // `language` and `prompt` are optional and only sent when set — a wrong language
  // hint is worse than none.
  const form = multipart(
    [['model', model], ['response_format', 'json']]
      .concat(opts.language ? [['language', String(opts.language)]] : [])
      .concat(opts.prompt ? [['prompt', String(opts.prompt).slice(0, 800)]] : []),
    { name: 'file', filename, type: mime, data: buffer }
  );

  for (let i = 0; i < attempts; i++) {
    const key = keys.nextKey();
    if (!key) break;

    try {
      // Through the pooled client in http.js — see its header. Groq's handshake
      // measured ~100ms, and it was being paid on every dictation.
      const res = await http.post(ENDPOINT, {
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': form.contentType
        },
        body: form.body,
        timeoutMs: TIMEOUT_MS
      });

      if (shouldRotate(res.status)) {
        lastError = 'http-' + res.status;
        keys.markFailure();
        continue;
      }

      if (!res.ok) {
        lastError = 'http-' + res.status + ':' + res.body.toString('utf8').slice(0, 200);
        break;
      }

      // A body that is not JSON is not this key's fault, so it is not put into
      // cooldown over it: the transcript simply reads as empty.
      let data = null;
      try { data = JSON.parse(res.body.toString('utf8')); } catch (_) { data = null; }

      keys.markSuccess();
      return {
        ok: true,
        // Whisper pads silence with a stray space or period. Trim, and let the
        // caller treat an empty result as silence rather than as an error.
        text: String((data && data.text) || '').trim(),
        model,
        mode: 'groq-whisper',
        duration: (data && data.duration) || null,
        bytes: buffer.byteLength
      };
    } catch (e) {
      lastError = e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : e.message;
      keys.markFailure();
    }
  }

  return { ok: false, error: lastError, model };
}

module.exports = { transcribe, ENDPOINT, DEFAULT_MODEL, extFor, multipart };
