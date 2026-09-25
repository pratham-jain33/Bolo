'use strict';

// Spotify, for real. The first integration here whose actions change something
// the user can hear — a track starts playing in a different window — so the
// error paths matter more than the happy one: "Spotify has no active device" and
// "this needs Premium" are the two answers this will actually give, and both are
// turned into a sentence the notch can say.
//
// OAuth 2.0 Authorization Code with **PKCE and no client secret**, because that
// is the only flow Spotify offers a public client: an installed app cannot keep
// a secret, so Spotify's own guidance is S256 PKCE with the client id alone.
//
// The consequence that shapes this file is the redirect URI. Google matches a
// loopback redirect by the host and lets the port be ephemeral; Spotify matches
// the whole string against the app's dashboard entry and **forbids wildcard
// ports**, so the callback cannot live on a random port. It takes a fixed one
// out of PORTS below, the loopback server walks the list when a port is taken,
// and SETUP_HINT names the URIs to register — a URI that is not registered is
// refused by Spotify before this code ever sees a request, which is a failure
// with nothing to log.
//
// Consent opens in the user's *system browser* via shell.openExternal, never a
// BrowserWindow — same reasoning as Google: an embedded webview is not a browser
// the provider trusts, and the session that results is not the user's.
//
// Tokens live in the main-process-only store (see keys.js), never reach a
// renderer, and nothing here logs one.
//
// Playback control is Premium-only on Spotify's side and there is no way to ask
// in advance — the account's product is not in the token response, and the
// profile endpoint that carries it needs a scope this client deliberately does
// not request — so a 403 PREMIUM_REQUIRED body becomes a reason string instead
// of a status code, and the same for a 404 NO_ACTIVE_DEVICE.

const http = require('node:http');
const crypto = require('node:crypto');
const keys = require('./keys');
const settings = require('./settings');

const API_BASE = 'https://api.spotify.com/v1';
const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

// One scope per capability this client actually uses, spelled out rather than
// assembled: they are literally what the consent screen shows the user.
// `playlist-read-private` and the two `user-library-*` scopes are what the
// library and playlist surfaces read; `user-read-currently-playing` is what
// makes nowPlaying() work when nothing is on the player object.
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-library-modify',
  'user-library-read'
];
const SCOPE = SCOPES.join(' ');

// Spotify will not accept a wildcard port, so the redirect URI has to be one the
// user has already pasted into the app's dashboard. A fixed port can be taken by
// something else on the machine, so there are four of them; the first that binds
// wins and the setup hint names all four, because the alternative is a sign-in
// that silently times out.
const PORTS = [8888, 8890, 8891, 8892];
const CALLBACK_PATH = '/callback';

const AUTH_TIMEOUT_MS = 120000;
const REFRESH_MARGIN_MS = 60000;

// Shown wherever the Spotify integration needs the user's own app. One sentence,
// and it says exactly what to paste and where.
const SETUP_HINT =
  'Spotify needs your own app: create one at developer.spotify.com/dashboard, add ' +
  'http://127.0.0.1:8888/callback as a Redirect URI (Spotify matches it exactly and forbids ' +
  'wildcard ports, so also add http://127.0.0.1:8890/callback, 8891 and 8892 — this app uses ' +
  'the first of those four that is free), then add spotify: { clientId } to src/main/seed-keys.js.';

let lastError = null;

/* ---------------------------------------------------------------------------
   Credentials
   ------------------------------------------------------------------------ */

function client() {
  const c = keys.getSpotifyClient();
  if (!c || !c.clientId) return null;
  return c;
}

function auth() {
  return keys.getSpotifyAuth();
}

// What the account has actually granted. Spotify returns this on the
// authorization_code response (and not on a refresh), which is why it is stored
// at connect time — it is the only way to know whether a scope added later needs
// a fresh consent screen.
function grantedScopes() {
  const a = auth();
  const s = a && a.scope;
  if (!s) return [];
  return Array.isArray(s) ? s.slice() : String(s).split(' ').filter(Boolean);
}

function connected() {
  const a = auth();
  return !!(client() && a && a.refresh_token);
}

function status() {
  const cfg = client();
  if (!cfg) {
    return {
      ok: false, connected: false, configured: false,
      error: 'not-configured', reason: SETUP_HINT, hint: SETUP_HINT
    };
  }
  if (!connected()) {
    return {
      ok: false, connected: false, configured: true,
      reason: lastError ? lastError.reason : 'not-connected — no Spotify account connected yet'
    };
  }
  // No account name: Spotify's profile fields (display name, email, country,
  // product) all live behind `user-read-private`, which this client does not ask
  // for. Playback does not need it, so the consent screen stays as narrow as the
  // feature, and `scopes` is what the surface reports instead of a name.
  return { ok: true, connected: true, configured: true, scopes: grantedScopes() };
}

/* ---------------------------------------------------------------------------
   Pure helpers
   ------------------------------------------------------------------------ */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE S256: the challenge is the SHA-256 of the verifier, base64url, unpadded.
function challengeFor(verifier) {
  return b64url(crypto.createHash('sha256').update(String(verifier)).digest());
}

function redirectUriFor(port) {
  return 'http://127.0.0.1:' + port + CALLBACK_PATH;
}

// Spotify takes no `access_type` and no `prompt` (those are Google's way of
// asking for a refresh token, which Spotify issues unconditionally); `show_dialog`
// would force the consent screen every time and is deliberately left off, so a
// reconnect that already has the scopes is one click.
function authorizeUrl({ clientId, redirectUri, challenge, state }) {
  return AUTH_ENDPOINT + '?' + new URLSearchParams({
    client_id: String(clientId || ''),
    response_type: 'code',
    redirect_uri: String(redirectUri || ''),
    scope: SCOPE,
    code_challenge: String(challenge || ''),
    code_challenge_method: 'S256',
    state: String(state || '')
  }).toString();
}

// One place where an API URL is built. `path` may be absolute (the token
// endpoint is not on api.spotify.com) or a path under /v1.
function buildUrl(path, query, deviceId) {
  const p = String(path || '');
  const url = new URL(/^https?:\/\//i.test(p) ? p : API_BASE + (p.startsWith('/') ? p : '/' + p));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  // Every playback command takes the device the same way, as a query parameter
  // rather than a body field, so it is applied here and not at each call site.
  if (deviceId) url.searchParams.set('device_id', String(deviceId));
  return url;
}

// The id out of a Spotify URI — `spotify:track:<id>` — or an id handed in
// already. Null when neither, which is what makes like() fall back to whatever
// is playing rather than sending "undefined" to Spotify.
function idFromUri(uri) {
  const s = String(uri || '').trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length === 3) return parts[2] || null;
  return /^[A-Za-z0-9]{22}$/.test(s) ? s : null;
}

// The body for PUT /me/player/play, or null to resume. A track goes in `uris`;
// an album, playlist or artist is a playback *context* and goes in
// `context_uri` — the two are not interchangeable and the wrong one is a 400, so
// "play my Discover Weekly" cannot be spelled the same way as a single song.
const CONTEXT_URI = /^spotify:(album|playlist|artist):/;

function playBody(uri) {
  const s = String(uri || '').trim();
  if (!s) return null;
  return CONTEXT_URI.test(s) ? { context_uri: s } : { uris: [s] };
}

// Spotify's error body is one of two shapes: `{ error: { status, message,
// reason } }` from the API, and `{ error: 'invalid_client', error_description }`
// from the accounts endpoint. Both are read here, and the two codes that a
// caller must not see raw — NO_ACTIVE_DEVICE (a 404) and PREMIUM_REQUIRED (a
// 403) — are turned into the sentence to say, which is also why they are matched
// before the status codes they arrive with.
function normalizeError(status, data, text, base) {
  if (status === 0) {
    return { ok: false, status: 0, error: 'network', reason: 'Could not reach Spotify: ' + (text || 'no response') };
  }

  const err = data && data.error;
  const obj = err && typeof err === 'object' ? err : null;
  const code = obj ? String(obj.reason || obj.status || '') : (typeof err === 'string' ? err : '');
  const message = (obj && obj.message) || (data && data.error_description) || '';

  if (code === 'NO_ACTIVE_DEVICE' || /no active device/i.test(message)) {
    return {
      ok: false, status,
      error: 'no-device',
      reason: 'Spotify has no active device. Open Spotify on one and try again.'
    };
  }
  if (code === 'PREMIUM_REQUIRED' || /premium/i.test(message)) {
    return {
      ok: false, status,
      error: 'premium-required',
      reason: 'Controlling playback needs Spotify Premium.'
    };
  }
  if (status === 401) {
    return { ok: false, status, error: 'unauthorized', reason: 'Spotify refused the token. Connect again.' };
  }
  if (status === 403) {
    return { ok: false, status, error: 'forbidden', reason: message || 'Spotify refused that request (HTTP 403).' };
  }
  if (status === 429) {
    return { ok: false, status, error: 'rate-limited', reason: 'Spotify is rate limiting this app. Try again in a moment.' };
  }
  if (status === 404) {
    return { ok: false, status, error: 'not-found', reason: message || 'Spotify could not find that.' };
  }
  return { ok: false, status, error: (base || 'spotify') + '-error', reason: message || ('HTTP ' + status) };
}

/* ---------------------------------------------------------------------------
   The spoken lines
   ------------------------------------------------------------------------ */

// What the notch says out loud for each result. Short, one sentence, and built
// from what Spotify actually returned rather than from the request, so a search
// that resolved to a different recording still names the one that is playing.
function byLine(track) {
  const name = (track && track.name) || 'that track';
  const artists = Array.isArray(track && track.artists) ? track.artists.filter(Boolean) : [];
  return artists.length ? name + ' by ' + artists.join(', ') : name;
}

const SPEECH = {
  nothing: 'Nothing is playing on Spotify.',
  paused: 'Paused Spotify.',
  next: 'Skipped to the next track.',
  previous: 'Went back to the previous track.',
  resumed: 'Playing again on Spotify.',
  // `is_playing` false with a track loaded is a pause, not silence — saying
  // "nothing is playing" over a paused track is the one thing that would read as
  // a bug when the user can see the paused track on their own screen.
  playing: (t) => 'Playing ' + byLine(t) + '.',
  pausedOn: (t) => 'Paused on ' + byLine(t) + '.',
  library: (on, name) =>
    (on ? 'Added ' : 'Removed ') + (name || 'it') + (on ? ' to your library.' : ' from your library.')
};

/* ---------------------------------------------------------------------------
   Response shapes
   ------------------------------------------------------------------------ */

function deviceShape(d) {
  if (!d || typeof d !== 'object') return null;
  const raw = d.volume_percent;
  const vol = raw == null ? NaN : Number(raw);
  return {
    id: d.id || null,
    name: d.name || null,
    type: d.type || null,
    active: !!d.is_active,
    volumePercent: Number.isFinite(vol) ? vol : null
  };
}

// `item` is the track or episode object the player is on. A podcast episode has
// no artists and carries `show` instead; left as an empty list the spoken line
// becomes "Playing <name> by .", so the show name is the only sensible stand-in.
function trackShape(item, progressMs) {
  if (!item || typeof item !== 'object') return null;
  const show = item.show && item.show.name ? String(item.show.name) : null;
  const artists = Array.isArray(item.artists) && item.artists.length
    ? item.artists.map((a) => a && a.name).filter(Boolean)
    : (show ? [show] : []);
  const progress = Number(progressMs);
  return {
    name: item.name || null,
    artists,
    album: (item.album && item.album.name) || show || null,
    durationMs: Number(item.duration_ms) || 0,
    progressMs: Number.isFinite(progress) ? progress : 0,
    id: item.id || null,
    uri: item.uri || null
  };
}

// `/me/player` answers 204 with no body when nothing is playing anywhere, and a
// 200 with an `item` when something is. Both land here, so "nothing is playing"
// has exactly one shape rather than one per path.
function playerShape(data) {
  if (!data || typeof data !== 'object') {
    return { playing: false, track: null, device: null, shuffle: null, repeat: null, volume: null, speech: SPEECH.nothing };
  }
  const track = trackShape(data.item, data.progress_ms);
  const device = data.device ? deviceShape(data.device) : null;
  return {
    playing: !!data.is_playing,
    track,
    device,
    shuffle: typeof data.shuffle_state === 'boolean' ? data.shuffle_state : null,
    repeat: data.repeat_state || 'off',
    volume: device ? device.volumePercent : null,
    speech: track ? (data.is_playing ? SPEECH.playing(track) : SPEECH.pausedOn(track)) : SPEECH.nothing
  };
}

// The track list out of a /search response. An empty list when the response
// carried no track object at all, which is the normal answer when `type` was
// something other than `track`.
function tracksIn(data) {
  const items = data && data.tracks && Array.isArray(data.tracks.items) ? data.tracks.items : [];
  return items
    .filter((it) => it && it.uri)
    .map((it) => ({
      name: it.name || null,
      artists: Array.isArray(it.artists) ? it.artists.map((a) => a && a.name).filter(Boolean) : [],
      uri: it.uri,
      id: it.id || null,
      durationMs: Number(it.duration_ms) || 0
    }));
}

/* ---------------------------------------------------------------------------
   The loopback consent flow
   ------------------------------------------------------------------------ */

let pending = null; // { server, timer, resolve, state }

function fail(error, reason, extra) {
  lastError = { error, reason };
  return { ok: false, error, reason, ...(extra || {}) };
}

function finish(result) {
  const p = pending;
  pending = null;
  if (!p) return;
  clearTimeout(p.timer);
  // Always close the socket. Success, failure, timeout, cancellation — a
  // listening port left behind is a port that answers the next request.
  try { p.server.close(); } catch (_) {}
  try { p.resolve(result); } catch (_) {}
}

// Called on app quit, and by a second connect attempt. Safe when nothing is
// pending.
function shutdown() {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  try { p.server.close(); } catch (_) {}
  try { p.resolve(fail('cancelled', 'Spotify sign-in was cancelled.')); } catch (_) {}
}

const PAGE = (title, line) =>
  '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
  '<body style="margin:0;font:15px system-ui;background:#0a0a0a;color:#fafafa">' +
  '<div style="max-width:32rem;margin:18vh auto;padding:0 1.5rem;text-align:center">' +
  '<div style="font-size:1.35rem;font-weight:600">' + title + '</div>' +
  '<p style="color:#a3a3a3;line-height:1.5">' + line + '</p></div></body>';

// The first port in PORTS that binds, or null. A taken port is an ordinary
// condition on a machine that runs other software, not an error — Spotify
// simply requires the fallback to have been registered too.
async function listenOnFixedPort() {
  for (const port of PORTS) {
    const server = http.createServer();
    const bound = await new Promise((resolve) => {
      server.once('error', () => resolve(0));
      server.listen(port, '127.0.0.1', () => resolve(port));
    });
    if (bound) {
      // Keep an error listener attached: an EADDRINUSE after this point would
      // otherwise be an unhandled 'error' event and take the process down.
      server.on('error', () => {});
      return { server, port: bound };
    }
    try { server.close(); } catch (_) {}
  }
  return null;
}

async function exchange(params) {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = null; }
    return { status: res.status, json, raw };
  } catch (e) {
    return { status: 0, json: null, raw: e.message };
  }
}

async function connect() {
  const cfg = client();
  if (!cfg) return fail('not-configured', SETUP_HINT, { hint: SETUP_HINT });
  if (pending) return fail('auth-in-progress', 'A Spotify sign-in is already waiting in your browser.');

  const verifier = b64url(crypto.randomBytes(64));
  const challenge = challengeFor(verifier);
  const state = b64url(crypto.randomBytes(16));

  const bound = await listenOnFixedPort();
  if (!bound) {
    return fail('listen-failed',
      'Could not open a local port for the Spotify redirect: ' + PORTS.join(', ') + ' are all in use.');
  }

  const redirectUri = redirectUriFor(bound.port);
  const authUrl = authorizeUrl({ clientId: cfg.clientId, redirectUri, challenge, state });

  const waited = new Promise((resolve) => {
    const timer = setTimeout(() => {
      finish(fail('timeout', 'Spotify sign-in timed out after two minutes. Nothing was changed.'));
    }, AUTH_TIMEOUT_MS);

    bound.server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(204).end(); return; }

      const send = (code, html) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };

      const err = url.searchParams.get('error');
      if (err) {
        send(200, PAGE('Sign-in refused', 'Spotify returned: ' + err + '. You can close this tab.'));
        finish(fail('denied', 'Spotify sign-in was refused (' + err + ').'));
        return;
      }
      const gotState = url.searchParams.get('state');
      if (gotState !== state) {
        send(400, PAGE('Unexpected request', 'This sign-in did not start from this app. You can close this tab.'));
        finish(fail('bad-state', 'The sign-in response did not match the request that started it.'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        send(400, PAGE('No code returned', 'Spotify did not return an authorization code. You can close this tab.'));
        finish(fail('no-code', 'Spotify did not return an authorization code.'));
        return;
      }

      // Answer the browser first: the token exchange is a second network round
      // trip, and leaving the tab hanging on it reads as a hung sign-in.
      send(200, PAGE('Connected', 'bolo is connected to Spotify. You can close this tab.'));
      finish({ ok: true, code, redirectUri, verifier, scopes: SCOPES.slice() });
    });

    pending = { server: bound.server, timer, resolve, state };
  });

  // The system browser, never a BrowserWindow — see the note at the top.
  require('electron').shell.openExternal(authUrl);

  const got = await waited;
  if (!got || !got.ok) return got || fail('cancelled', 'Spotify sign-in was cancelled.');

  // No client_secret here, and none anywhere else: the verifier is what proves
  // this is the same client that started the flow. A redirect URI that was not
  // registered never reaches this code — Spotify shows its own error page and
  // the wait above ends in a timeout, which is the only symptom it can have.
  const tok = await exchange({
    client_id: cfg.clientId,
    grant_type: 'authorization_code',
    code: got.code,
    code_verifier: got.verifier,
    redirect_uri: got.redirectUri
  });

  if (!tok.json || !tok.json.access_token) {
    const code = (tok.json && (tok.json.error || tok.json.error_description)) || ('HTTP ' + tok.status);
    return fail('exchange-failed', 'Spotify refused the sign-in (' + code + ').');
  }

  keys.setSpotifyAuth({
    access_token: tok.json.access_token,
    refresh_token: tok.json.refresh_token || null,
    expiry: Date.now() + (Number(tok.json.expires_in) || 3600) * 1000,
    scope: tok.json.scope || SCOPE,
    token_type: tok.json.token_type || 'Bearer'
  });

  lastError = null;
  return { ok: true, scopes: grantedScopes(), label: 'Spotify', port: bound.port, redirectUri };
}

async function disconnect() {
  shutdown();
  // Drop the local token first: the moment the user asks to disconnect, this app
  // must no longer be able to act.
  keys.clearSpotifyAuth();
  lastError = null;
  // Deliberately local-only. Spotify's revocation endpoint authenticates the
  // *client* with a secret over Basic auth, and a PKCE public client has no
  // secret to send — so there is nothing to call. The refresh token stays valid
  // on Spotify's side until the user revokes the app from their account page,
  // which is worth saying in the UI rather than pretending otherwise.
  return { ok: true, connected: false };
}

/* ---------------------------------------------------------------------------
   Tokens
   ------------------------------------------------------------------------ */

// The access token for right now, refreshed transparently when it is expired or
// within a minute of expiring. Returns null (with lastError set) when there is
// no connection — a revoked refresh token clears the connection instead of being
// retried on every call forever.
async function token() {
  const cfg = client();
  if (!cfg) { lastError = { error: 'not-configured', reason: SETUP_HINT }; return null; }

  const a = auth();
  if (!a || !a.refresh_token) {
    lastError = { error: 'not-connected', reason: 'No Spotify account is connected.' };
    return null;
  }
  if (a.access_token && a.expiry && Date.now() < Number(a.expiry) - REFRESH_MARGIN_MS) return a.access_token;

  const tok = await exchange({
    client_id: cfg.clientId,
    grant_type: 'refresh_token',
    refresh_token: a.refresh_token
  });

  if (!tok.json || !tok.json.access_token) {
    const code = tok.json && tok.json.error;
    if (tok.status === 400 || tok.status === 401 || code === 'invalid_grant') {
      keys.clearSpotifyAuth();
      lastError = { error: 'revoked', reason: 'Spotify sign-in was revoked or expired. Connect again.' };
    } else {
      lastError = { error: 'refresh-failed', reason: 'Could not renew the Spotify token (HTTP ' + tok.status + ').' };
    }
    return null;
  }

  keys.setSpotifyAuth({
    ...a,
    access_token: tok.json.access_token,
    expiry: Date.now() + (Number(tok.json.expires_in) || 3600) * 1000,
    // Spotify normally leaves the refresh token alone, but a response that does
    // carry one has to be stored or the next refresh fails on a dead token.
    ...(tok.json.refresh_token ? { refresh_token: tok.json.refresh_token } : {}),
    ...(tok.json.scope ? { scope: tok.json.scope } : {})
  });
  return tok.json.access_token;
}

// A device the user has already chosen in Settings wins over Spotify's own
// default. The key is read here rather than declared in settings.js's defaults
// on purpose: an absent key answers `undefined`, which is exactly "no
// preference", so Settings can start writing it without this file changing.
function preferredDevice() {
  try {
    const id = settings.get('spotifyDeviceId');
    return id ? String(id) : null;
  } catch (_) { return null; }
}

// Throw away the cached token so the next call renews it. Used when Spotify
// rejects a token the clock still believed in.
async function forceRefresh() {
  const a = auth();
  if (a) keys.setSpotifyAuth({ ...a, expiry: 0 });
  return token();
}

/* ---------------------------------------------------------------------------
   Requests
   ------------------------------------------------------------------------ */

// One place where a Spotify request happens. Adds the bearer token, refreshes
// once on a 401, and turns every outcome into { ok, ... } rather than an
// exception — the caller is a voice command with a sentence to say, not a place
// with a try/catch.
async function request(method, path, { query, body, headers, base, deviceId } = {}) {
  const at = await token();
  if (!at) return { ok: false, ...(lastError || { error: 'not-connected', reason: 'Not connected to Spotify.' }) };

  const u = buildUrl(path, query, deviceId);

  const send = async (bearer) => {
    try {
      const res = await fetch(u, {
        method,
        headers: {
          Authorization: 'Bearer ' + bearer,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(headers || {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
      return { status: res.status, data, text };
    } catch (e) {
      return { status: 0, data: null, text: e.message };
    }
  };

  let r = await send(at);
  if (r.status === 401) {
    // The cached token was stale even though the clock said otherwise.
    const fresh = await forceRefresh();
    if (fresh) r = await send(fresh);
  }

  if (r.status === 0) return { ok: false, status: 0, error: 'network', reason: 'Could not reach Spotify: ' + r.text };
  // 204 is a success with no body, and it is the normal answer to every playback
  // command Spotify has — pause, next, seek, volume, play. Reading it as an empty
  // body is what keeps a working pause from looking like a failure.
  if (r.status === 204) return { ok: true, status: 204, data: null };
  if (r.status >= 400) return normalizeError(r.status, r.data, r.text, base);
  return { ok: true, status: r.status, data: r.data };
}

/* ---------------------------------------------------------------------------
   Playback
   ------------------------------------------------------------------------ */

// `play({ query })` searches first and plays what it found; `play({ uri })`
// plays that; neither resumes whatever was paused, which is what "play" means
// when nothing else was said.
async function play({ query, uri, deviceId } = {}) {
  const dev = deviceId || preferredDevice();
  let target = uri ? { uri: String(uri), id: idFromUri(uri), name: null, artists: [], durationMs: 0 } : null;

  if (!target && query) {
    const found = await search({ query, limit: 1 });
    if (!found.ok) return found;
    if (!found.tracks.length) {
      const q = String(query);
      return {
        ok: false,
        error: 'not-found',
        reason: 'Nothing on Spotify matched "' + q + '".',
        speech: 'Nothing on Spotify matched that.'
      };
    }
    target = found.tracks[0];
  }

  // With a body Spotify replaces the queue with the one track; without a body it
  // resumes. Same endpoint, and the difference is the whole meaning of the call.
  const r = await request('PUT', '/me/player/play', {
    body: target ? playBody(target.uri) : undefined,
    deviceId: dev
  });
  if (!r.ok) return r;

  if (!target) return { ok: true, playing: true, resumed: true, speech: SPEECH.resumed };
  return {
    ok: true,
    playing: true,
    track: {
      name: target.name || null,
      artists: target.artists || [],
      uri: target.uri,
      id: target.id || null,
      durationMs: target.durationMs || 0
    },
    speech: SPEECH.playing(target)
  };
}

async function pause({ deviceId } = {}) {
  const r = await request('PUT', '/me/player/pause', { deviceId: deviceId || preferredDevice() });
  if (!r.ok) return r;
  return { ok: true, playing: false, speech: SPEECH.paused };
}

async function next({ deviceId } = {}) {
  const r = await request('POST', '/me/player/next', { deviceId: deviceId || preferredDevice() });
  if (!r.ok) return r;
  return { ok: true, speech: SPEECH.next };
}

async function previous({ deviceId } = {}) {
  const r = await request('POST', '/me/player/previous', { deviceId: deviceId || preferredDevice() });
  if (!r.ok) return r;
  return { ok: true, speech: SPEECH.previous };
}

async function seek({ positionMs, deviceId } = {}) {
  const ms = Math.round(Number(positionMs));
  if (!Number.isFinite(ms) || ms < 0) {
    return { ok: false, error: 'bad-position', reason: 'seek needs a position in milliseconds.' };
  }
  const r = await request('PUT', '/me/player/seek', {
    query: { position_ms: ms },
    deviceId: deviceId || preferredDevice()
  });
  if (!r.ok) return r;
  return { ok: true, positionMs: ms };
}

async function volume({ percent, deviceId } = {}) {
  const pct = Math.round(Number(percent));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: 'bad-volume', reason: 'volume takes a percentage from 0 to 100.' };
  }
  const r = await request('PUT', '/me/player/volume', {
    query: { volume_percent: pct },
    deviceId: deviceId || preferredDevice()
  });
  if (!r.ok) return r;
  return { ok: true, percent: pct };
}

async function shuffle({ on, deviceId } = {}) {
  const state = !!on;
  const r = await request('PUT', '/me/player/shuffle', {
    query: { state },
    deviceId: deviceId || preferredDevice()
  });
  if (!r.ok) return r;
  return { ok: true, on: state };
}

const REPEAT_MODES = ['track', 'context', 'off'];

async function repeat({ mode, deviceId } = {}) {
  const m = String(mode || '').toLowerCase();
  if (!REPEAT_MODES.includes(m)) {
    return { ok: false, error: 'bad-mode', reason: 'repeat takes track, context or off.' };
  }
  const r = await request('PUT', '/me/player/repeat', {
    query: { state: m },
    deviceId: deviceId || preferredDevice()
  });
  if (!r.ok) return r;
  return { ok: true, mode: m };
}

// GET /me/player — the whole playback state in one call. A 204 means nothing is
// playing anywhere, which request() hands back as `data: null`; playerShape()
// turns that into the same result a null item produces, so this never throws on
// the empty case and there is one shape for "nothing".
async function nowPlaying() {
  const r = await request('GET', '/me/player');
  if (!r.ok) return { ...r, speech: r.reason };
  return { ok: true, ...playerShape(r.data) };
}

/* ---------------------------------------------------------------------------
   Library, devices, search
   ------------------------------------------------------------------------ */

// PUT/DELETE /me/tracks. Without a track it saves whatever is playing, which is
// what "like this" means when the user is looking at Spotify and not at bolo.
async function like({ on = true, id, uri } = {}) {
  const want = !!on;
  let trackId = id ? String(id) : idFromUri(uri);
  let name = null;

  if (!trackId) {
    const cur = await nowPlaying();
    if (!cur.ok) return cur;
    if (!cur.track || !cur.track.id) {
      return { ok: false, error: 'no-track', reason: 'Nothing is playing to save.' };
    }
    trackId = cur.track.id;
    name = cur.track.name;
  }

  const r = await request(want ? 'PUT' : 'DELETE', '/me/tracks', { query: { ids: trackId } });
  if (!r.ok) return r;
  return { ok: true, on: want, id: trackId, speech: SPEECH.library(want, name) };
}

async function devices() {
  const r = await request('GET', '/me/player/devices');
  if (!r.ok) return r;
  const list = r.data && Array.isArray(r.data.devices) ? r.data.devices : [];
  return { ok: true, devices: list.map(deviceShape).filter(Boolean) };
}

async function search({ query, type = 'track', limit = 10 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty-query', reason: 'Nothing to search Spotify for.' };
  const r = await request('GET', '/search', { query: { q, type, limit } });
  if (!r.ok) return r;
  return { ok: true, query: q, tracks: tracksIn(r.data) };
}

module.exports = {
  SETUP_HINT, SCOPES, SCOPE, PORTS, REPEAT_MODES,
  client, auth, status, connected, grantedScopes, preferredDevice,
  connect, disconnect, shutdown, token, request,
  nowPlaying, play, pause, next, previous, seek, volume, shuffle, repeat,
  like, devices, search,
  _internals: {
    b64url, challengeFor, redirectUriFor, authorizeUrl, buildUrl, idFromUri, playBody,
    normalizeError, byLine, SPEECH, deviceShape, trackShape, playerShape, tracksIn, PAGE
  }
};