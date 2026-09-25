'use strict';

// One Google grant, shared by everything that talks to a Google API.
//
// Gmail owned this whole flow first, which was fine while Gmail was the only
// Google integration. It is not: Calendar reads the same account, and a second
// copy of the loopback consent dance would mean two grants, two refresh tokens,
// two consent screens and two things to disconnect. So the OAuth lives here and
// the per-API code lives in the integrators.
//
// OAuth 2.0 Authorization Code for an installed/desktop client, over a loopback
// redirect: a node:http server on 127.0.0.1:<ephemeral>/oauth2callback receives
// the `code`, and the consent screen opens in the user's *system browser* via
// shell.openExternal. Deliberately not a BrowserWindow: Google refuses to render
// its consent page inside an embedded webview (disallowed_useragent), so the
// system browser is the only route that works.
//
// PKCE (S256) is used even though this is a desktop client — it costs nothing,
// and it means a stolen redirect code is useless on its own. `state` is random
// and verified on return, so another local process cannot feed this server a
// code of its own.
//
// Tokens live in the main-process-only store (see keys.js) and never reach a
// renderer. Nothing here logs a token.

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const keys = require('./keys');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const AUTH_TIMEOUT_MS = 120000;
const REFRESH_MARGIN_MS = 60000;

// Shown wherever a Google integration needs the user's own OAuth client. One
// sentence, and it says exactly what to paste and where.
const SETUP_HINT =
  'Google integrations need your own OAuth client: add google: { clientId, clientSecret } to ' +
  'src/main/seed-keys.js, enable the Gmail and Calendar APIs on that Google Cloud project, and ' +
  'add http://127.0.0.1 as an allowed redirect (create the client as a Desktop app / loopback client).';

let lastError = null;

/* ---------------------------------------------------------------------------
   Credentials
   ------------------------------------------------------------------------ */

function client() {
  const c = keys.getGoogleClient();
  if (!c || !c.clientId || !c.clientSecret) return null;
  return c;
}

function auth() {
  return keys.getGoogleAuth();
}

// What the account has actually granted. Google returns this on the token
// response, and it is the only reliable way to know whether a scope added later
// needs a fresh consent screen.
function grantedScopes() {
  const a = auth();
  const s = a && a.scope;
  if (!s) return [];
  return Array.isArray(s) ? s.slice() : String(s).split(' ').filter(Boolean);
}

function missingScopes(want) {
  const have = new Set(grantedScopes());
  return (want || []).filter((s) => !have.has(s));
}

function connected() {
  const a = auth();
  return !!(client() && a && a.refresh_token);
}

function status() {
  const cfg = client();
  if (!cfg) {
    return {
      ok: false, connected: false, configured: false, email: null,
      error: 'not-configured', reason: SETUP_HINT, hint: SETUP_HINT
    };
  }
  if (!connected()) {
    return {
      ok: false, connected: false, configured: true, email: null,
      reason: lastError ? lastError.reason : 'not-connected — no Google account connected yet'
    };
  }
  return { ok: true, connected: true, configured: true, email: auth().email || null, scopes: grantedScopes() };
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
  try { p.resolve(fail('cancelled', 'Google sign-in was cancelled.')) } catch (_) {}
}

const PAGE = (title, line) =>
  '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
  '<body style="margin:0;font:15px system-ui;background:#0a0a0a;color:#fafafa">' +
  '<div style="max-width:32rem;margin:18vh auto;padding:0 1.5rem;text-align:center">' +
  '<div style="font-size:1.35rem;font-weight:600">' + title + '</div>' +
  '<p style="color:#a3a3a3;line-height:1.5">' + line + '</p></div></body>';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function exchange(params) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(params).toString();
    const url = new URL(TOKEN_ENDPOINT);
    const req = https.request(
      {
        hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
    req.end(body);
  });
}

// The address out of an id_token, when Google sent one. Only present if `openid`
// was among the scopes, which is why it is a fallback and not the source of
// truth — see resolveEmail in connect().
function idTokenEmail(idToken) {
  try {
    const part = String(idToken || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64').toString('utf8')).email || null;
  } catch (_) { return null; }
}

// Ask for `scopes`. Anything the account has already granted is added to the
// request rather than dropped, because Google issues a *new* refresh token for
// the scopes in this request — asking for calendar alone after granting gmail
// would silently break Gmail.
//
// `resolveEmail` is how an integrator names the account without this file having
// to know which API it is. Gmail asks its own profile endpoint; the id_token is
// tried first because it costs nothing when it is there.
async function connect(want, label, resolveEmail) {
  const cfg = client();
  if (!cfg) return fail('not-configured', SETUP_HINT, { hint: SETUP_HINT });
  if (pending) return fail('auth-in-progress', 'A Google sign-in is already waiting in your browser.');

  const scopes = Array.from(new Set(grantedScopes().concat(want || [])));
  if (!scopes.length) return fail('no-scopes', 'Nothing to ask Google for.');

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  const port = await new Promise((resolve) => {
    server.once('error', () => resolve(0));
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  if (!port) return fail('listen-failed', 'Could not open a local port for the Google redirect.');

  const redirectUri = 'http://127.0.0.1:' + port + '/oauth2callback';
  const authUrl = AUTH_ENDPOINT + '?' + new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // offline + consent is what makes Google hand back a refresh_token; without
    // it the connection dies an hour later with no way to renew it.
    access_type: 'offline',
    prompt: 'consent'
  }).toString();

  const waited = new Promise((resolve) => {
    const timer = setTimeout(() => {
      finish(fail('timeout', 'Google sign-in timed out after two minutes. Nothing was changed.'));
    }, AUTH_TIMEOUT_MS);

    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') { res.writeHead(204).end(); return; }

      const send = (code, html) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };

      const err = url.searchParams.get('error');
      if (err) {
        send(200, PAGE('Sign-in refused', 'Google returned: ' + err + '. You can close this tab.'));
        finish(fail('denied', 'Google sign-in was refused (' + err + ').'));
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
        send(400, PAGE('No code returned', 'Google did not return an authorization code. You can close this tab.'));
        finish(fail('no-code', 'Google did not return an authorization code.'));
        return;
      }

      // Answer the browser first: the token exchange is a second network round
      // trip, and leaving the tab hanging on it reads as a hung sign-in.
      send(200, PAGE('Connected', 'bolo is connected. You can close this tab.'));
      finish({ ok: true, code, redirectUri, verifier, scopes });
    });

    pending = { server, timer, resolve, state };
  });

  require('electron').shell.openExternal(authUrl);

  const got = await waited;
  if (!got || !got.ok) return got || fail('cancelled', 'Google sign-in was cancelled.');

  const tok = await exchange({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code: got.code,
    code_verifier: got.verifier,
    redirect_uri: got.redirectUri,
    grant_type: 'authorization_code'
  });

  if (!tok.json || !tok.json.access_token) {
    const code = (tok.json && tok.json.error) || ('HTTP ' + tok.status);
    return fail('exchange-failed', 'Google refused the sign-in (' + code + ').');
  }

  const fresh = !!tok.json.refresh_token;

  keys.setGoogleAuth({
    access_token: tok.json.access_token,
    refresh_token: tok.json.refresh_token || (auth() || {}).refresh_token || null,
    expiry: Date.now() + (Number(tok.json.expires_in) || 3600) * 1000,
    scope: tok.json.scope || scopes.join(' '),
    email: idTokenEmail(tok.json.id_token)
  });

  // The id_token is absent unless openid was requested, so the integrator gets a
  // say. A profile call is also the first proof that the token actually works.
  let email = (auth() || {}).email || null;
  if (!email && typeof resolveEmail === 'function') {
    try {
      const found = await resolveEmail();
      if (found) {
        email = String(found);
        keys.setGoogleAuth({ ...auth(), email });
      }
    } catch (_) { /* an address we cannot read is not a reason to fail the connect */ }
  }

  lastError = null;
  return {
    ok: true, email, scopes: grantedScopes(), label: label || 'Google',
    // A connect that returns no refresh token works for an hour and then cannot
    // renew. Worth saying out loud rather than discovering later.
    reusable: fresh || !!(auth() || {}).refresh_token
  };
}

async function disconnect() {
  const refresh = (auth() || {}).refresh_token || null;
  shutdown();
  // Drop the local token first: the moment the user asks to disconnect, this app
  // must no longer be able to act, whatever the revoke call does next.
  keys.clearGoogleAuth();
  lastError = null;

  if (refresh) {
    // Best effort. A revoke that fails still leaves us disconnected locally.
    try {
      const body = new URLSearchParams({ token: refresh }).toString();
      const url = new URL(REVOKE_ENDPOINT);
      await new Promise((resolve) => {
        const req = https.request(
          {
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
          },
          (res) => { res.resume(); res.on('end', resolve); }
        );
        req.on('error', resolve);
        req.end(body);
      });
    } catch (_) { /* the local token is already gone */ }
  }

  return { ok: true, connected: false, email: null };
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
    lastError = { error: 'not-connected', reason: 'No Google account is connected.' };
    return null;
  }
  if (a.access_token && a.expiry && Date.now() < Number(a.expiry) - REFRESH_MARGIN_MS) return a.access_token;

  const tok = await exchange({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: a.refresh_token,
    grant_type: 'refresh_token'
  });

  if (!tok.json || !tok.json.access_token) {
    const code = tok.json && tok.json.error;
    if (tok.status === 400 || tok.status === 401 || code === 'invalid_grant') {
      keys.clearGoogleAuth();
      lastError = { error: 'revoked', reason: 'Google sign-in was revoked or expired. Connect again.' };
    } else {
      lastError = { error: 'refresh-failed', reason: 'Could not renew the Google token (HTTP ' + tok.status + ').' };
    }
    return null;
  }

  keys.setGoogleAuth({
    ...a,
    access_token: tok.json.access_token,
    expiry: Date.now() + (Number(tok.json.expires_in) || 3600) * 1000,
    ...(tok.json.scope ? { scope: tok.json.scope } : {})
  });
  return tok.json.access_token;
}

/* ---------------------------------------------------------------------------
   Requests
   ------------------------------------------------------------------------ */

// One place where a Google request happens. Adds the bearer token, refreshes once
// on a 401, and turns every outcome into { ok, ... } rather than an exception.
//
// `url` is absolute: Gmail and Calendar live on different hosts, and pretending
// they share a base is how the wrong API gets called with the right token.
async function request(method, url, { query, body, headers, base } = {}) {
  const at = await token();
  if (!at) return { ok: false, ...(lastError || { error: 'not-connected', reason: 'Not connected.' }) };

  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      // An array is a repeated parameter, which is how both APIs want lists —
      // not a comma-joined single value.
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
  }

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
    const a = auth();
    if (a) keys.setGoogleAuth({ ...a, expiry: 0 });
    const fresh = await token();
    if (fresh) r = await send(fresh);
  }

  if (r.status === 0) return { ok: false, error: 'network', reason: 'Could not reach Google: ' + r.text };
  if (r.status >= 400) {
    const msg = (r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status);
    return { ok: false, status: r.status, error: (base || 'google') + '-error', reason: msg };
  }
  return { ok: true, data: r.data };
}

// True when the account is connected but has not granted everything the caller
// needs — the case a stale connection lands in after a new API is added.
function needsConsent(want) {
  if (!connected()) return true;
  return missingScopes(want).length > 0;
}

module.exports = {
  SETUP_HINT,
  client, auth, status, connected, grantedScopes, missingScopes, needsConsent,
  connect, disconnect, shutdown, token, request,
  _internals: { b64url, exchange, PAGE }
};