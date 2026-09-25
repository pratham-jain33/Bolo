const settings = require('./settings');
const keys = require('./keys');
const http = require('./http');
const https = require('https');

// Text-to-speech, against Deepgram.
//
// A note on the provider, because it was not what was asked for: this was handed
// over as "deepseek api for tts", but DeepSeek publishes no text-to-speech
// endpoint at all — its API is chat completions and a balance endpoint. The key
// supplied authenticates against Deepgram and returns real audio, and
// api.deepseek.com rejects it with a 401. So Deepgram is what the key is, and
// Deepgram is what this speaks through. Verified live, not assumed.
//
// Two families, and the difference is not cosmetic — they are served from
// different endpoints, and using the wrong one for a voice is a 400:
//
//   flux     -> https://api.deepgram.com/v2/speak   (newest; 36 English voices)
//   aura-2   -> https://api.deepgram.com/v1/speak   (the previous generation)
//
// `/v2/speak` answers an Aura id with `V1_MODEL_ON_V2_SPEAK_ENDPOINT` and
// `/v1/speak` answers a flux id with a plain invalid-model error, so
// `endpointFor()` below is load-bearing rather than tidy.
//
// The audio never touches disk. It is fetched here (where the key lives), handed
// to the requesting renderer as a Uint8Array, and played from an object URL — so
// the key stays in the main process and a spoken reply leaves no file behind.
//
// Cached in memory by (voice, text): the intro's narration lines and the notch's
// short replies repeat constantly, and a cache hit is the difference between a
// spoken answer that starts instantly and one that waits on a round trip.

const V1_ENDPOINT = 'https://api.deepgram.com/v1/speak';
const V2_ENDPOINT = 'https://api.deepgram.com/v2/speak';

// The voice set. Exactly the five asked for, in the order they were asked for,
// grouped by the family that serves them.
//
// Genders are the ones given, cross-checked against Deepgram's own metadata where
// it publishes any: `orion` is tagged masculine by the API, and
// `delia` feminine. Note that the flux family lists no gender field at all in
// /v2/models — only an accent and an age — so for cole/sienna/alexis the labels
// rest on the genders they were given as.
const DEFAULT_VOICE = 'flux-cole-en';

const VOICES = [
  {
    id: 'flux-cole-en', label: 'Cole', gender: 'male', family: 'flux',
    desc: 'Young adult, American.'
  },
  {
    id: 'flux-sienna-en', label: 'Sienna', gender: 'female', family: 'flux',
    desc: 'Young adult, American.'
  },
  {
    id: 'flux-alexis-en', label: 'Alexis', gender: 'female', family: 'flux',
    desc: 'Adult, American.'
  },
  {
    id: 'aura-2-delia-en', label: 'Delia', gender: 'female', family: 'aura-2',
    desc: 'Casual and friendly, with a little breath.'
  },
  {
    id: 'aura-2-orion-en', label: 'Orion', gender: 'male', family: 'aura-2',
    desc: 'Calm, approachable and polite.'
  }
];

// Visible for testing and for the Settings pane; keeps the grouping honest
// instead of hard-coding it in the renderer.
const FAMILIES = [
  { id: 'flux', label: 'Flux', note: 'Deepgram’s newest voices.' },
  { id: 'aura-2', label: 'Aura 2', note: 'The previous generation.' }
];

// Which endpoint serves a given voice. Anything unrecognised is treated as
// Aura-style, which is the endpoint that at least answers with a clear error
// rather than the wrong family.
function endpointFor(model) {
  return String(model || '').startsWith('flux') ? V2_ENDPOINT : V1_ENDPOINT;
}

// A hung request must not leave the intro waiting on a line that never arrives.
const TIMEOUT_MS = 20000;

// Deepgram accepts 2000 characters per request. Stay under it rather than
// shipping a 400 that reads as a broken voice.
const MAX_CHARS = 1800;

const CACHE_MAX = 48;
const cache = new Map(); // `${voice}|${text}` -> Uint8Array

function findVoice(id) {
  return VOICES.find((v) => v.id === id) || null;
}

function shouldRotate(status) {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

function cachePut(k, v) {
  if (cache.size >= CACHE_MAX) {
    // Oldest first — Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(k, v);
}

function voice() {
  return settings.get('ttsVoice') || DEFAULT_VOICE;
}

function available() {
  return keys.count('deepgram') > 0;
}

// Returns { ok, audio: Uint8Array, mime } — the caller hands `audio` to a
// renderer, which plays it from an object URL. Nothing here writes to disk.
/* ---------------------------------------------------------------------------
   Pronunciation

   Deepgram's speak endpoints take the text and nothing else: no SSML, no
   phoneme input, no pronunciation dictionary. A respelling is therefore the only
   lever there is — the same word rewritten the way an English voice has to see
   it in order to say it right. The user's own constraint is that the voice stays
   English, so this is the whole fix.

   Two things were reported as coming out wrong:

     the brand   an English voice mangles the *product* name, which is why this
                 table exists — but the entry left behind by the rename was
                 `bolo: 'bolo oh ess'`, which is the rule for the old
                 "goatedOS" (a word no voice knows) applied to a word every
                 voice does. "bolo" is a plain two-syllable word; spelling it
                 out over the top of the word itself makes it say "bolo oh ess"
                 out loud. Dropped, deliberately — do not re-add it.
     names       Indian given names get English vowels and English stress, which
                 is wrong for most of them — "Pratham" comes out with a flat a
                 and the accent on the second syllable.

   These are respellings, not phonetics: each is the word rewritten to force the
   right sounds out of the voice, and nothing else about the sentence changes.

   Applied whole-word and case-insensitively, longest entry first, so a shorter
   entry that is a prefix of a longer one cannot pre-empt it ("Raj" is inside
   "Rajesh", but `\bRaj\b` will not match there). Only the *spoken* text is
   rewritten — what the app displays is untouched.

   The list is curated rather than generated: a transliteration rule set would be
   wrong more often than it was right, and a wrong respelling is worse than
   none. Add names here as they come up.
   ------------------------------------------------------------------------ */
const SPOKEN = {
  // Product names the app itself says out loud. "bolo" is absent on purpose:
  // it is a real word, so a respelling can only make it worse. Qwen and Groq
  // are not words at all and must stay.
  Qwen: 'Kwen',
  Groq: 'Grock',

  // Given names. Only the ones an English voice reliably mangles; the rest are
  // deliberately absent rather than "fixed" into something else.
  Pratham: 'Pruthum',
  Aarav: 'Aaruv',
  Aditya: 'Aaditya',
  Ananya: 'Anunnya',
  Anjali: 'Unjulee',
  Arjun: 'Arjoon',
  Aryan: 'Aaryan',
  Deepak: 'Deepuk',
  Diya: 'Deeya',
  Ishaan: 'Eeshaan',
  Kavya: 'Kuvya',
  Manish: 'Muneesh',
  Nikhil: 'Nikil',
  Pranav: 'Prunuv',
  Priya: 'Preeya',
  Rahul: 'Rahool',
  Rajesh: 'Rujesh',
  Rakesh: 'Rukesh',
  Ravi: 'Ruvee',
  Riya: 'Reeya',
  Saanvi: 'Saanvee',
  Sahil: 'Suhil',
  Sameer: 'Sumeer',
  Sanjay: 'Sanjuy',
  Shreya: 'Shraya',
  Tanvi: 'Tunvee',
  Varun: 'Varoon',
  Vijay: 'Vijuy',
  Vikram: 'Vikrum',
  Vinay: 'Vinuy'
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RULES = Object.keys(SPOKEN)
  .sort((a, b) => b.length - a.length)
  .map((from) => [new RegExp('\\b' + escapeRe(from) + '\\b', 'gi'), SPOKEN[from]]);

function pronounce(text) {
  let out = String(text == null ? '' : text);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

/* ---------------------------------------------------------------------------
   Request building — shared by both paths

   Everything up to the HTTP call is identical whether the reply is buffered and
   handed back whole (`synthesize`) or pushed out as it is generated
   (`synthesizeStream`): respell, clip, pair the endpoint with the voice family,
   and refuse before spending a key when the speaker switch is off. Only the
   transport differs, so only the transport is duplicated.
   ------------------------------------------------------------------------ */

// The one gate on whether bolo may make noise on its own behalf, mirroring the
// check in the `bolo:speak` handler: the speaker switch in Settings, which is
// also the switch the intro's speaker button writes.
//
// Deliberately asymmetric between the two paths, because the callers are. The
// buffered path is what Settings' own voice test uses, and a test that answers
// "muted" while the speaker switch is off tells the user their voice is broken
// when it is only switched off — so the buffered path stays as it was and leaves
// the gate to its caller, exactly as the `bolo:speak` handler has it. The
// streaming path is push-only (main decides which window it addresses), so it
// checks for itself unless the caller has already decided and passed `muted`.
function gated(opts, useGate) {
  if (opts.muted !== undefined) return !!opts.muted;
  if (!useGate) return false;
  return !settings.get('ttsEnabled') || !settings.get('interactionSounds');
}

// Returns the prepared request, or { ok:false } with the reason already in the
// shape both callers return.
function prepare(text, opts, useGate) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, error: 'empty-text' };
  if (gated(opts, useGate)) {
    return { ok: false, error: 'muted', hint: 'turn replies on in Settings' };
  }

  const model = opts.voice || voice();
  // Respell first, clip second: the limit is on what the provider is asked to
  // say, and a respelling is always at least as long as what it replaces.
  const clipped = pronounce(clean).slice(0, MAX_CHARS);

  return {
    ok: true,
    model,
    clipped,
    cacheKey: model + '|' + clipped,
    // Built once per model rather than per attempt: the endpoint pairing is the
    // load-bearing part (see the header) and it is not per-call work.
    endpoint: endpointFor(model) + '?model=' + encodeURIComponent(model) + '&encoding=mp3',
    payload: JSON.stringify({ text: clipped }),
    total: keys.count('deepgram')
  };
}

const NO_KEYS = {
  ok: false,
  error: 'no-keys',
  provider: 'deepgram',
  hint: 'add a Deepgram key in Settings, or turn replies off'
};

async function synthesize(text, opts = {}) {
  const p = prepare(text, opts, false);
  if (!p.ok) return p;

  const model = p.model;
  const hit = cache.get(p.cacheKey);
  if (hit) return { ok: true, audio: hit, mime: 'audio/mpeg', voice: model, cached: true };
  if (!p.total) return { ...NO_KEYS };

  const attempts = Math.min(p.total, opts.maxKeys || p.total);
  let lastError = 'unknown';

  for (let i = 0; i < attempts; i++) {
    const key = keys.nextKey('deepgram');
    if (!key) break;

    try {
      // Through the pooled client in http.js, not `fetch`. Measured on this
      // endpoint: a reused socket answers headers in 456ms against 948ms on a
      // fresh one — and `fetch` drops the socket after 4s idle, so it was always
      // the fresh case. Deepgram's edge closes an idle socket after ~2s, so this
      // pays off when two lines are asked for close together; a lone reply pays
      // the handshake either way. See http.js.
      const res = await http.post(p.endpoint, {
        headers: {
          authorization: 'Token ' + key,
          'content-type': 'application/json'
        },
        body: p.payload,
        timeoutMs: TIMEOUT_MS
      });

      if (shouldRotate(res.status)) {
        lastError = 'http-' + res.status;
        keys.markFailure('deepgram');
        continue;
      }
      if (!res.ok) {
        lastError = 'http-' + res.status + ':' + res.body.toString('utf8').slice(0, 200);
        break;
      }

      keys.markSuccess('deepgram');
      // A view, not a copy: the bytes are handed straight to the renderer as they
      // arrived, and a second pass over a multi-hundred-KB buffer is pure cost.
      const audio = new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength);
      cachePut(p.cacheKey, audio);
      return { ok: true, audio, mime: 'audio/mpeg', voice: model, bytes: audio.byteLength };
    } catch (e) {
      lastError = e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : e.message;
      keys.markFailure('deepgram');
    }
  }

  return { ok: false, error: lastError, voice: model };
}

/* ---------------------------------------------------------------------------
   Streaming

   The same request, read incrementally instead of buffered. Deepgram answers
   /v1/speak and /v2/speak with chunked MP3 — the first frames land in a few
   hundred milliseconds and the rest trickle in behind them — so handing each
   body chunk to the renderer the moment it arrives is what lets playback start
   on the first words rather than on the last. The renderer appends them to a
   MediaSource; see src/renderer/speak.js.

   Transport is `https.request` through the *same pooled agent* http.js uses for
   the buffered path (http.agent), not `fetch`. Streaming was the reason to
   consider fetch, but it is not a reason to give up a pooled socket: the agent
   is measurable (456ms against 948ms to headers, see http.js) and undici's
   fetch would not use it. Nothing here buffers the body.

   Rotation is the one place this differs from `synthesize`. Retrying a key makes
   sense only while nothing has been spoken: once a chunk has left this process
   the reply is already audible in the renderer, so a mid-stream failure is
   terminal rather than a reason to start the sentence again over a second key.
   ------------------------------------------------------------------------ */

// One streaming attempt. Resolves — never rejects — with
//   { ok:true, status, bytes }              the stream completed
//   { ok:false, status, body, emitted }     headers refused it (body is the error)
//   { ok:false, error, emitted }            it died mid-flight
// `emitted` says whether any audio chunk already reached the caller, which is
// what tells the caller whether a retry is still meaningful.
function streamOnce(target, key, payload, onBegin, onChunk) {
  return new Promise((resolve) => {
    let settled = false;
    let emitted = false;
    let bytes = 0;
    let timer = null;
    let req = null;

    function finish(value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    }

    // An idle timer, not a total-budget one: a long reply that is still arriving
    // must not be cut off at 20s the way a *stalled* one should be. Reset on
    // every body chunk, so it only ever fires when the stream has genuinely gone
    // quiet.
    function arm() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { req.destroy(); } catch (_) {}
        finish({ ok: false, error: 'timeout', emitted });
      }, TIMEOUT_MS);
    }

    arm();
    try {
      req = https.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'POST',
        agent: http.agent,
        headers: {
          authorization: 'Token ' + key,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      }, (res) => {
        const status = res.statusCode;

        if (status < 200 || status >= 300) {
          // An error body is small and has to be read to be reported.
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => finish({
            ok: false, status, emitted: false, body: Buffer.concat(chunks).toString('utf8').slice(0, 200)
          }));
          res.on('error', (e) => finish({ ok: false, error: e.message, emitted: false }));
          return;
        }

        // The mime is what the caller hands its SourceBuffer. `encoding=mp3` is
        // in the query, so this is known before a byte of audio arrives — which
        // is the point of calling onBegin here and not on the first chunk.
        try { if (onBegin) onBegin('audio/mpeg'); } catch (_) {}

        res.on('data', (c) => {
          arm();
          emitted = true;
          bytes += c.length;
          try { onChunk(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)); } catch (_) {}
        });
        res.on('end', () => finish({ ok: true, status, bytes }));
        res.on('error', (e) => finish({ ok: false, error: e.message, emitted }));
      });

      req.on('error', (e) => {
        // A pooled socket the Deepgram edge closed first fails before any byte is
        // sent — the request never arrived, so resending it is safe. `retryable`
        // says so, and only while nothing has been emitted: this mirrors
        // http.post's staleSocket handling, which the buffered path gets for free
        // and the streaming path (raw https.request on the same agent) does not.
        finish({
          ok: false,
          error: e.name === 'TimeoutError' ? 'timeout' : e.message,
          emitted,
          retryable: !emitted && http.staleSocket(e)
        });
      });
      req.end(payload);
    } catch (e) {
      finish({ ok: false, error: e.message, emitted });
    }
  });
}

// Synthesise a reply and hand it out as it is generated.
//
//   tts.synthesizeStream(text, opts, onChunk)
//     opts.onBegin(mime)   called exactly once, before the first chunk
//     onChunk(bytes)       a Uint8Array, per body chunk, the moment it arrives
//   -> { ok:true, mime, voice, streamed:true }
//   -> { ok:false, error, hint? }
//
// The promise resolves when the stream is complete, so a caller that wants to
// await the whole utterance still can; a caller that does not care may ignore it.
async function synthesizeStream(text, opts = {}, onChunk) {
  const p = prepare(text, opts, true);
  if (!p.ok) return p;

  const emit = typeof onChunk === 'function' ? onChunk : opts.onChunk;
  if (typeof emit !== 'function') return { ok: false, error: 'no-sink' };
  if (!p.total) return { ...NO_KEYS };

  const target = new URL(p.endpoint);
  const attempts = Math.min(p.total, opts.maxKeys || p.total);

  // A stream is appended to a SourceBuffer by the renderer, so there is no URL
  // and no Blob: `onBegin` is the renderer's cue to open its MediaSource, and it
  // is called from inside streamOnce once the response is known to be 2xx.
  let began = false;
  const onBegin = (mime) => {
    if (began) return;
    began = true;
    try { if (typeof opts.onBegin === 'function') opts.onBegin(mime); } catch (_) {}
  };

  let lastError = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const key = keys.nextKey('deepgram');
    if (!key) break;

    let r = await streamOnce(target, key, p.payload, onBegin, emit);
    // Stale pooled socket the edge reaped during a quiet spell (the intro's first
    // reply after boot is exactly this): resend once on the same key rather than
    // burning the key's failure counter or the attempt. Nothing was emitted, so
    // the retry is a clean start — onBegin/onChunk have not fired.
    if (r.retryable) r = await streamOnce(target, key, p.payload, onBegin, emit);

    if (r.ok) {
      keys.markSuccess('deepgram');
      return { ok: true, mime: 'audio/mpeg', voice: p.model, streamed: true, bytes: r.bytes };
    }

    // Already audible: a retry would repeat the sentence from the top, which is
    // worse than a reply that stops mid-way. Report it and stop.
    if (r.emitted) return { ok: false, error: r.error || 'stream-failed', voice: p.model, streamed: true };

    if (r.body) { lastError = 'http-' + r.status + ':' + r.body; break; }
    if (r.status) { lastError = 'http-' + r.status; }

    if (r.status && !shouldRotate(r.status)) break;

    lastError = r.error || lastError;
    keys.markFailure('deepgram');
    // Nothing was spoken, so a second key is a clean second attempt.
  }

  return { ok: false, error: lastError, voice: p.model };
}

// A live check for the Settings pane. Synthesises one short line so the result
// is real audio rather than a reachability probe that can pass while speaking
// is broken.
async function test(voiceId) {
  const started = Date.now();
  const r = await synthesize('bolo is ready.', { voice: voiceId });
  return {
    ok: !!r.ok,
    voice: r.voice || voice(),
    bytes: r.bytes || (r.audio ? r.audio.byteLength : 0),
    cached: !!r.cached,
    ms: Date.now() - started,
    error: r.error || null
  };
}

function clearCache() {
  cache.clear();
}

module.exports = {
  synthesize, synthesizeStream, test, available, clearCache,
  voice, findVoice, endpointFor,
  pronounce,
  voices: VOICES, families: FAMILIES,
  V1_ENDPOINT, V2_ENDPOINT, DEFAULT_VOICE, MAX_CHARS
};