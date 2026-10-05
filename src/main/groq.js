// Original Groq chat client for bolo with multi-key rotation.
// Keys are stored locally via keys.js and never logged.
// Model default comes from settings.groqModel (user set: qwen family).
const settings = require('./settings');
const keys = require('./keys');
// Pooled keep-alive POST rather than fetch: undici drops an idle socket after a
// few seconds, so every dictation paid a fresh TCP+TLS handshake to Groq on this
// leg as well as on speech-to-text. http.js exists for that reason and is shared.
const http = require('./http');

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

// A hung request must not leave the notch spinning on "thinking" forever, and
// the voice machine is holding the session open behind it.
const TIMEOUT_MS = 45000;

// Who the model is. Stated here as well as in the router prompt because the
// assistant's own name is the one word speech-to-text reliably mangles —
// "gotodos", "goat dos", "bolo dos" — and a model that does not know the name
// is its own reads "how can gotodos help me" as text to be typed. Prepended only
// when a caller sent no system message of its own, so a caller with a better
// prompt (intent.js) is never overridden.
const IDENTITY =
  'You are bolo, a voice assistant that runs on the user\'s own machine. ' +
  'The user may mis-hear or mis-transcribe your name: "gotodos", "goat dos", ' +
  '"bolo dos" and "bolo os" all mean bolo. A question about what you can ' +
  'do ("how can bolo help me") is a question about yourself — answer it as ' +
  'bolo, in the first person. ' +
  'This is a spoken assistant: answer in the fewest words possible — one short ' +
  'sentence when you can, two at the very most. No preamble, no filler, no ' +
  'sign-off. Just the answer.';

function shouldRotate(status) {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

async function chat(messages, opts = {}) {
  const model = opts.model || settings.get('groqModel') || DEFAULT_MODEL;
  // No identity added when the caller wrote its own system message.
  const turns = Array.isArray(messages) && messages.some((m) => m && m.role === 'system')
    ? messages
    : [{ role: 'system', content: IDENTITY }].concat(messages || []);
  const total = keys.count('groq');
  if (!total) {
    return { ok: false, error: 'no-keys', hint: 'add Groq keys in onboarding or settings' };
  }
  const attempts = Math.min(total, opts.maxKeys || total);
  let lastError = 'unknown';
  for (let i = 0; i < attempts; i++) {
    // Round-robin: each attempt takes the next key, so a retry lands on a
    // different key rather than repeating the one that just failed.
    const key = keys.nextKey('groq');
    if (!key) break;

    try {
      const res = await http.post(ENDPOINT, {
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key
        },
        body: JSON.stringify({
          model,
          messages: turns,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.maxTokens ?? 512
        }),
        timeoutMs: TIMEOUT_MS
      });
      if (shouldRotate(res.status)) {
        lastError = 'http-' + res.status;
        keys.markFailure('groq');
        continue;
      }
      if (!res.ok) {
        lastError = 'http-' + res.status + ':' + String(res.body.toString('utf8')).slice(0, 200);
        break;
      }
      const data = JSON.parse(res.body.toString('utf8'));
      const text = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      keys.markSuccess('groq');
      return { ok: true, model, text: String(text || ''), usage: data.usage || null };
    } catch (e) {
      // http.js owns the deadline and names it 'TimeoutError'. Timeout is the one
      // failure worth telling apart from the rest, because it means nobody
      // answered rather than that the answer was a refusal.
      lastError = e.name === 'TimeoutError' ? 'timeout' : e.message;
      keys.markFailure('groq');
    }
  }
  return { ok: false, error: lastError, model };
}

async function summarize(text) {
  const r = await chat([
    { role: 'system', content: 'Summarize briefly in 2-3 sentences.' },
    { role: 'user', content: String(text || '').slice(0, 4000) }
  ]);
  return r;
}

module.exports = { chat, summarize, ENDPOINT, DEFAULT_MODEL, IDENTITY };
