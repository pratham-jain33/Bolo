/* Exercises spotify.js's PURE helpers — URL building, the PKCE challenge, the
   error normalisation and the spoken lines — plus the module's shape and the
   keys.js accessors it reads through. No network and no consent: every case
   below is a function of its arguments, which is the point of exposing them
   under _internals.
     ./node_modules/.bin/electron tools/spotify-check.js
   Exits non-zero on failure. */

const { app } = require('electron');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Must run BEFORE whenReady: without it `electron <script>` uses Electron's own
// default app name, and electron-store would read %APPDATA%\Electron instead of
// the real store.
app.setName('bolo');
app.disableHardwareAcceleration();

// And the store itself is thrown away rather than touched. The real one is
// %APPDATA%\bolo\bolo-keys.json, where the user's live Groq and Deepgram keys
// are — a check that cleared a provider there would cost them their keys.
// electron-store reads app.getPath('userData') when it is constructed, which is
// after this line.
const STORE_DIR = path.join(os.tmpdir(), 'bolo-spotify-check');
fs.rmSync(STORE_DIR, { recursive: true, force: true });
app.setPath('userData', STORE_DIR);

const spotify = require('../src/main/spotify');
const keys = require('../src/main/keys');

const { SETUP_HINT, SCOPES, SCOPE, PORTS, REPEAT_MODES } = spotify;
const P = spotify._internals;

let pass = 0;
let fail = 0;

// Key-order-insensitive, so an expected object can be written in the order that
// reads best rather than the order it happened to be built in.
function stable(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function check(label, got, want) {
  const ok = stable(got) === stable(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label);
  if (!ok) {
    console.log('        want ' + stable(want));
    console.log('        got  ' + stable(got));
  }
}

function checkTrue(label, cond, detail) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label);
  if (!ok && detail !== undefined) console.log('        ' + detail);
}

// RFC 7636 Appendix B — an independent vector, so this is a real check of the
// S256 transform and not a re-run of its own formula.
const VECTOR_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const VECTOR_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const TRACK = {
  name: 'Around the World',
  duration_ms: 428000,
  id: '4uLU6hMCjMI75M1A2tKUQC',
  uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  artists: [{ name: 'Daft Punk' }],
  album: { name: 'Homework' }
};

const PLAYER = {
  is_playing: true,
  progress_ms: 42000,
  shuffle_state: false,
  repeat_state: 'off',
  device: { id: 'd1', name: 'Laptop', type: 'Computer', is_active: true, volume_percent: 73 },
  item: TRACK
};

app.whenReady().then(() => {
  /* ---- the scope string ------------------------------------------------ */
  console.log('\nscopes');
  check('SCOPE is the six scopes, space-joined, in order', SCOPE,
    'user-read-playback-state user-modify-playback-state user-read-currently-playing ' +
    'playlist-read-private user-library-modify user-library-read');
  check('SCOPES has one entry per scope', SCOPES, SCOPE.split(' '));
  check('six of them', SCOPES.length, 6);
  checkTrue('the scope sent to Spotify is the same string', P.authorizeUrl({
    clientId: 'x', redirectUri: 'http://127.0.0.1:8888/callback', challenge: 'c', state: 's'
  }).includes('scope=' + SCOPE.replace(/ /g, '+')));

  /* ---- the fixed redirect ports ---------------------------------------- */
  console.log('\nredirect');
  check('PORTS starts at 8888, the URI in SETUP_HINT', PORTS[0], 8888);
  check('PORTS', PORTS, [8888, 8890, 8891, 8892]);
  check('redirectUriFor(8888)', P.redirectUriFor(8888), 'http://127.0.0.1:8888/callback');
  check('redirectUriFor(8892)', P.redirectUriFor(8892), 'http://127.0.0.1:8892/callback');

  /* ---- PKCE ------------------------------------------------------------ */
  console.log('\nPKCE');
  check('challengeFor matches RFC 7636 Appendix B', P.challengeFor(VECTOR_VERIFIER), VECTOR_CHALLENGE);
  check('challenge is 43 chars', P.challengeFor(VECTOR_VERIFIER).length, 43);
  checkTrue('base64url — no padding, no +, no /', !/[=+/]/.test(P.challengeFor(VECTOR_VERIFIER)));
  checkTrue('a different verifier gives a different challenge',
    P.challengeFor('a'.repeat(64)) !== P.challengeFor('a'.repeat(63)));
  check('b64url strips padding and stays url-safe', P.b64url(Buffer.from([251, 255, 191])), '-_-_');

  /* ---- the authorize URL ----------------------------------------------- */
  console.log('\nauthorize URL');
  const authUrl = P.authorizeUrl({
    clientId: 'client-abc',
    redirectUri: 'http://127.0.0.1:8888/callback',
    challenge: VECTOR_CHALLENGE,
    state: 'state-xyz'
  });
  const au = new URL(authUrl);
  checkTrue('https + host', authUrl.startsWith('https://accounts.spotify.com/authorize?'), authUrl);
  check('client_id', au.searchParams.get('client_id'), 'client-abc');
  check('response_type', au.searchParams.get('response_type'), 'code');
  check('redirect_uri round-trips exactly', au.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
  check('scope', au.searchParams.get('scope'), SCOPE);
  check('code_challenge', au.searchParams.get('code_challenge'), VECTOR_CHALLENGE);
  check('code_challenge_method', au.searchParams.get('code_challenge_method'), 'S256');
  check('state', au.searchParams.get('state'), 'state-xyz');
  checkTrue('no client_secret anywhere in the URL', !authUrl.includes('client_secret'));
  checkTrue("no Google-only params (access_type/prompt)", !/access_type|prompt=/.test(authUrl));

  /* ---- API URL building ------------------------------------------------ */
  console.log('\nrequest URLs');
  check('path under /v1', String(P.buildUrl('/me/player')), 'https://api.spotify.com/v1/me/player');
  check('a missing leading slash is added', String(P.buildUrl('me/player')), 'https://api.spotify.com/v1/me/player');
  check('an absolute URL is left alone', String(P.buildUrl('https://accounts.spotify.com/api/token')),
    'https://accounts.spotify.com/api/token');
  const search = P.buildUrl('/search', { q: 'daft punk', type: 'track', limit: 10 });
  check('search q', search.searchParams.get('q'), 'daft punk');
  check('search type', search.searchParams.get('type'), 'track');
  check('search limit', search.searchParams.get('limit'), '10');
  check('null and empty query values are dropped',
    String(P.buildUrl('/me/player', { limit: null, offset: '' })), 'https://api.spotify.com/v1/me/player');
  check('deviceId becomes device_id', P.buildUrl('/me/player/play', null, 'dev-1').searchParams.get('device_id'), 'dev-1');
  check('no device_id when there is no device', P.buildUrl('/me/player').searchParams.has('device_id'), false);

  /* ---- ids out of URIs ------------------------------------------------- */
  console.log('\ntrack ids');
  check('id out of a track URI', P.idFromUri('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), '4uLU6hMCjMI75M1A2tKUQC');
  check('a bare 22-char id is already an id', P.idFromUri('4uLU6hMCjMI75M1A2tKUQC'), '4uLU6hMCjMI75M1A2tKUQC');
  check('empty', P.idFromUri(''), null);
  check('not a URI at all', P.idFromUri('around the world'), null);
  check('nothing after the last colon', P.idFromUri('spotify:track:'), null);

  /* ---- what play() sends ----------------------------------------------- */
  console.log('\nplay body');
  check('a track goes in uris', P.playBody('spotify:track:4uLU6hMCjMI75M1A2tKUQC'),
    { uris: ['spotify:track:4uLU6hMCjMI75M1A2tKUQC'] });
  check('a playlist is a context, not a uri list', P.playBody('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'),
    { context_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' });
  check('so is an album', P.playBody('spotify:album:1ATL5GLyefJaxhQzSPVrLX'),
    { context_uri: 'spotify:album:1ATL5GLyefJaxhQzSPVrLX' });
  check('no uri at all means resume', P.playBody(''), null);

  /* ---- error normalisation --------------------------------------------- */
  console.log('\nerrors');
  check('404 NO_ACTIVE_DEVICE is not a raw 404',
    P.normalizeError(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }, '', 'player'),
    { ok: false, status: 404, error: 'no-device', reason: 'Spotify has no active device. Open Spotify on one and try again.' });
  check('403 PREMIUM_REQUIRED says what it needs',
    P.normalizeError(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }, '', 'player'),
    { ok: false, status: 403, error: 'premium-required', reason: 'Controlling playback needs Spotify Premium.' });
  check('a premium reason alone is enough',
    P.normalizeError(403, { error: { status: 403, message: 'Premium required' } }, '', 'player').error,
    'premium-required');
  check('429', P.normalizeError(429, null, '', 'player').error, 'rate-limited');
  check('401', P.normalizeError(401, null, '', 'player').error, 'unauthorized');
  check('403 without a known reason', P.normalizeError(403, { error: { status: 403, message: 'Not authorized' } }, '', 'player'),
    { ok: false, status: 403, error: 'forbidden', reason: 'Not authorized' });
  check('404 with a plain message', P.normalizeError(404, { error: { status: 404, message: 'Device not found' } }, '', 'player'),
    { ok: false, status: 404, error: 'not-found', reason: 'Device not found' });
  check('the accounts-endpoint shape (error is a string)',
    P.normalizeError(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' }, '', 'spotify'),
    { ok: false, status: 400, error: 'spotify-error', reason: 'Refresh token revoked' });
  check('a bare 500', P.normalizeError(500, null, '', 'spotify'),
    { ok: false, status: 500, error: 'spotify-error', reason: 'HTTP 500' });
  check('the base names the caller', P.normalizeError(500, null, '', 'player').error, 'player-error');
  check('status 0 is the network', P.normalizeError(0, null, 'ECONNREFUSED', 'spotify'),
    { ok: false, status: 0, error: 'network', reason: 'Could not reach Spotify: ECONNREFUSED' });
  checkTrue('every failure is ok:false', [401, 403, 404, 429, 500].every((s) => P.normalizeError(s, null, '', 'x').ok === false));

  /* ---- the spoken lines ------------------------------------------------ */
  console.log('\nspeech');
  check('nothing playing', P.SPEECH.nothing, 'Nothing is playing on Spotify.');
  check('playing, one artist', P.SPEECH.playing({ name: 'Around the World', artists: ['Daft Punk'] }),
    'Playing Around the World by Daft Punk.');
  check('playing, two artists', P.SPEECH.playing({ name: 'X', artists: ['A', 'B'] }), 'Playing X by A, B.');
  check('playing, no artist at all', P.SPEECH.playing({ name: 'X', artists: [] }), 'Playing X.');
  check('paused on a track', P.SPEECH.pausedOn({ name: 'X', artists: ['A'] }), 'Paused on X by A.');
  check('paused', P.SPEECH.paused, 'Paused Spotify.');
  check('next', P.SPEECH.next, 'Skipped to the next track.');
  check('previous', P.SPEECH.previous, 'Went back to the previous track.');
  check('resumed', P.SPEECH.resumed, 'Playing again on Spotify.');
  check('liked, named', P.SPEECH.library(true, 'X'), 'Added X to your library.');
  check('unliked, named', P.SPEECH.library(false, 'X'), 'Removed X from your library.');
  check('liked, unnamed', P.SPEECH.library(true, null), 'Added it to your library.');

  const LINES = [P.SPEECH.nothing, P.SPEECH.paused, P.SPEECH.next, P.SPEECH.previous, P.SPEECH.resumed,
    P.SPEECH.playing({ name: 'X', artists: ['A', 'B'] }), P.SPEECH.pausedOn({ name: 'X', artists: ['A'] }),
    P.SPEECH.library(true, 'X'), P.SPEECH.library(false, null)];
  checkTrue('every line is one sentence ending in a full stop',
    LINES.every((l) => l.endsWith('.') && !l.includes('\n')), JSON.stringify(LINES));
  checkTrue('and short enough to say in one breath', LINES.every((l) => l.length <= 80),
    JSON.stringify(LINES.filter((l) => l.length > 80)));

  /* ---- response shapes ------------------------------------------------- */
  console.log('\nplayer shape');
  check('no body at all (the 204 from /me/player)', P.playerShape(null),
    { playing: false, track: null, device: null, shuffle: null, repeat: null, volume: null, speech: 'Nothing is playing on Spotify.' });
  check('a real payload', P.playerShape(PLAYER), {
    playing: true,
    track: {
      name: 'Around the World', artists: ['Daft Punk'], album: 'Homework',
      durationMs: 428000, progressMs: 42000, id: '4uLU6hMCjMI75M1A2tKUQC', uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'
    },
    device: { id: 'd1', name: 'Laptop', type: 'Computer', active: true, volumePercent: 73 },
    shuffle: false, repeat: 'off', volume: 73,
    speech: 'Playing Around the World by Daft Punk.'
  });
  check('paused with a track loaded is not "nothing is playing"',
    P.playerShape({ is_playing: false, item: TRACK, device: PLAYER.device }).speech,
    'Paused on Around the World by Daft Punk.');
  check('a null item is nothing playing', P.playerShape({ is_playing: true, item: null }).speech,
    'Nothing is playing on Spotify.');
  check('a podcast episode stands in the show for the artist',
    P.trackShape({ name: 'Ep 12', show: { name: 'The Show' }, duration_ms: 1000 }, 0).artists, ['The Show']);
  check('no item', P.trackShape(null, 0), null);
  check('a device with no volume in it', P.deviceShape({ id: 'd', name: 'n', is_active: false }).volumePercent, null);

  /* ---- search results -------------------------------------------------- */
  console.log('\nsearch results');
  check('tracks are flattened to what a voice command needs',
    P.tracksIn({ tracks: { items: [TRACK] } }),
    [{ name: 'Around the World', artists: ['Daft Punk'], uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', id: '4uLU6hMCjMI75M1A2tKUQC', durationMs: 428000 }]);
  check('a search with no tracks object', P.tracksIn({}), []);
  check('an item with no uri cannot be played', P.tracksIn({ tracks: { items: [{ name: 'x' }] } }), []);

  /* ---- the dark page the browser gets ---------------------------------- */
  console.log('\nloopback page');
  const page = P.PAGE('Connected', 'bolo is connected to Spotify. You can close this tab.');
  checkTrue('dark, and it carries the title', page.includes('background:#0a0a0a') && page.includes('Connected'), page.slice(0, 80));

  /* ---- module surface -------------------------------------------------- */
  console.log('\nmodule surface');
  const FN = ['status', 'connect', 'disconnect', 'shutdown', 'token', 'request',
    'nowPlaying', 'play', 'pause', 'next', 'previous', 'seek', 'volume', 'shuffle', 'repeat',
    'like', 'devices', 'search', 'client', 'auth', 'connected', 'grantedScopes', 'preferredDevice'];
  for (const name of FN) checkTrue('spotify.' + name + ' is a function', typeof spotify[name] === 'function', typeof spotify[name]);
  check('repeat takes the three Spotify modes', REPEAT_MODES, ['track', 'context', 'off']);
  checkTrue('SETUP_HINT names the dashboard', SETUP_HINT.includes('developer.spotify.com'));
  checkTrue('SETUP_HINT names the exact redirect URI', SETUP_HINT.includes('http://127.0.0.1:8888/callback'));
  checkTrue('SETUP_HINT names seed-keys.js and the field',
    SETUP_HINT.includes('src/main/seed-keys.js') && SETUP_HINT.includes('spotify: { clientId }'));
  checkTrue('no token ever travels in a hint', !/access_token|refresh_token/.test(SETUP_HINT));

  /* ---- keys.js: what spotify.js reads through -------------------------- */
  console.log('\nkeys.js (a throwaway store)');
  checkTrue('keys.getSpotifyClient', typeof keys.getSpotifyClient === 'function');
  checkTrue('keys.setSpotifyClient', typeof keys.setSpotifyClient === 'function');
  checkTrue('keys.getSpotifyAuth', typeof keys.getSpotifyAuth === 'function');
  checkTrue('keys.setSpotifyAuth', typeof keys.setSpotifyAuth === 'function');
  checkTrue('keys.clearSpotifyAuth', typeof keys.clearSpotifyAuth === 'function');
  check('spotify is a provider', keys.PROVIDERS.includes('spotify'), true);
  check('the google accessors are untouched',
    typeof keys.getGoogleAuth === 'function' && typeof keys.clearGoogleAuth === 'function', true);
  // The spotify client id is seeded outside the version gate on purpose (see
  // seedSpotifyClient in keys.js) — a bump here would re-offer the bundled Groq
  // and Deepgram keys to an install that had cleared them.
  check('SEED_VERSION is not bumped for spotify', keys.SEED_VERSION, 2);

  keys.init();
  const ID = 'a'.repeat(24) + 'bcd';

  // Whatever the seed file offers is exactly what a fresh store must end up
  // holding — no more, no less. The section is usually absent (it is gitignored
  // and the id is the user's own), and that case has to leave the provider empty
  // rather than half-configured.
  let offered = null;
  try {
    const sp = require('../src/main/seed-keys').spotify;
    offered = sp && sp.clientId ? String(sp.clientId).trim() : null;
  } catch (_) { /* no seed file at all: nothing offered */ }
  check('a fresh store holds exactly what the seed file offers, and nothing else',
    keys.getSpotifyClient(), offered ? { clientId: offered } : null);
  check('no tokens are invented either', keys.getSpotifyAuth(), null);
  check('connected() is false with no account', spotify.connected(), false);
  check('it asks nothing of Spotify for a device it was never given', spotify.preferredDevice(), null);
  if (!offered) {
    check('so spotify reports not-configured', spotify.status(),
      { ok: false, connected: false, configured: false, error: 'not-configured', reason: SETUP_HINT, hint: SETUP_HINT });
  } else {
    check('a seeded id reads as configured but not connected', spotify.status(),
      { ok: false, connected: false, configured: true, reason: 'not-connected — no Spotify account connected yet' });
  }

  check('setSpotifyClient refuses an empty id', keys.setSpotifyClient('').ok, false);
  check('setSpotifyClient refuses a missing id', keys.setSpotifyClient().ok, false);
  keys.setSpotifyClient(ID);
  check('the client id round-trips', keys.getSpotifyClient(), { clientId: ID });
  check('and spotify reads it', spotify.client(), { clientId: ID });
  check('the masked list never carries the id itself',
    keys.listMasked('spotify').some((k) => k.masked === ID || k.masked.includes(ID)), false);
  check('it is masked to first-3…last-4', keys.listMasked('spotify')[0].masked, 'aaa…abcd');

  const AUTH = { access_token: 'at-1', refresh_token: 'rt-1', expiry: 1, scope: SCOPE };
  check('setSpotifyAuth round-trips', (keys.setSpotifyAuth(AUTH), keys.getSpotifyAuth()), AUTH);
  check('connected() is now true', spotify.connected(), true);
  check('and status() reports it', spotify.status().ok, true);
  check('with the granted scopes', spotify.status().scopes, SCOPE.split(' '));
  check('a token never appears in the renderer-visible list',
    JSON.stringify(keys.listMasked('spotify')).includes('rt-1') ||
    JSON.stringify(keys.listMasked('spotify')).includes('at-1'), false);
  check('clearSpotifyAuth takes the tokens away', (keys.clearSpotifyAuth(), keys.getSpotifyAuth()), null);
  check('but leaves the client id', keys.getSpotifyClient(), { clientId: ID });
  check('and the connection is gone', spotify.connected(), false);
  check('clearing the provider clears the id too', (keys.clear('spotify'), keys.getSpotifyClient()), null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  try { fs.rmSync(STORE_DIR, { recursive: true, force: true }); } catch (_) {}
  app.exit(fail ? 1 : 0);
});

setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 20000);