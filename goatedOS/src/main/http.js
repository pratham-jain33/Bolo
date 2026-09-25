const https = require('https');

// One pooled HTTPS client for every provider call in the main process.
//
// Why this exists at all: `fetch` in Node (undici) returns an idle socket to a
// pool whose keepAliveTimeout is 4 seconds, so a request that follows a quiet
// spell pays a fresh TCP + TLS handshake to a CDN edge that is a long way from
// this machine. Measured from here against api.deepgram.com, same body, same
// voice: 1382ms to response headers on a fresh connection, 423ms on a reused one,
// and 1434ms again after 9s idle — undici had already dropped it.
//
// An `https.Agent` with keepAlive holds sockets across requests instead, and it is
// a core module — no dependency to add. What that is worth differs by provider,
// and it is worth being exact about it rather than claiming the whole 950ms:
//
//   api.groq.com      a free socket is still there after 60s idle, and the next
//                     transcription reuses it (283ms cold against 199ms reused)
//   api.deepgram.com  the edge drops an idle socket after ~2s (reusable at +1.5s:
//                     456ms against 948ms fresh; gone by +2.0s), so a lone spoken
//                     reply pays the handshake anyway and two requests close
//                     together do not. A HEAD probe to pre-warm is no use either:
//                     the 404 it gets back is not pooled.
//
// So this is a real win on the transcription leg and a partial one on the voice.
// It never costs anything on the cold paths, which is what makes it safe to keep
// as the single transport for both.
//
// Nothing here is provider-specific. Rotation, endpoints, models and formats stay
// in stt.js and tts.js; this only carries bytes and hands back the response.

// Idle sockets are kept until the server closes them. `keepAliveMsecs` is the
// TCP keepalive probe interval on a free socket, not its lifetime — it is what
// keeps a NAT or a firewall from silently dropping the connection mid-conversation.
const KEEP_ALIVE_MS = 25000;

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MS,
  maxSockets: 6,
  maxFreeSockets: 4,
  // Newest socket first: the one most recently used is the one least likely to
  // have been reaped by the server since.
  scheduling: 'lifo'
});

const DEFAULT_TIMEOUT_MS = 20000;

// A pooled socket that the server closed first fails the request before it is
// sent. That is not a provider error and must not be reported as one: the request
// never arrived, so sending it again is safe — and it is the difference between a
// reply and an ECONNRESET on the first utterance after a quiet spell.
function staleSocket(e) {
  return !!e && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ERR_STREAM_PREMATURE_CLOSE');
}

function once(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let answered = false;
    let timer = null;

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    }

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        agent,
        headers
      },
      (res) => {
        answered = true;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(resolve, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: Buffer.concat(chunks)
        }));
        res.on('error', (e) => finish(reject, e));
      }
    );

    timer = setTimeout(() => {
      const e = new Error('timed out after ' + timeoutMs + 'ms');
      e.name = 'TimeoutError';
      req.destroy(e);
    }, timeoutMs);

    // `retryable` is set where it is known: before any response byte arrived.
    req.on('error', (e) => finish(reject, Object.assign(e, { retryable: !answered && staleSocket(e) })));
    req.end(body);
  });
}

// POST a body and read the whole response. Bodies here are small — a JSON
// request, a clip to transcribe, an MP3 reply — so there is nothing to gain from
// handing back a stream, and a caller that can hold the finished bytes is simpler
// to reason about.
//
// Returns { ok, status, body } where `body` is a Buffer. Status is always
// available: the rotation logic in stt.js and tts.js decides what a 429 or a 500
// means, and this deliberately has no opinion.
async function post(url, opts = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const body = Buffer.isBuffer(opts.body)
    ? opts.body
    : Buffer.from(String(opts.body == null ? '' : opts.body), 'utf8');

  const headers = Object.assign({}, opts.headers, { 'content-length': body.length });
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await once(target, headers, body, timeoutMs);
    } catch (e) {
      if (attempt >= 1 || !e.retryable) throw e;
    }
  }
}

module.exports = { post, agent, staleSocket, DEFAULT_TIMEOUT_MS, KEEP_ALIVE_MS };