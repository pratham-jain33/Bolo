'use strict';

// Model Context Protocol, over stdio — a real MCP client for the main process.
//
// MCP is newline-delimited JSON-RPC 2.0 written to a child process's stdin and
// read back from its stdout. That is a few hundred lines of framing, not a
// library, so this file is the whole client and the app gains no dependency for
// it. `@modelcontextprotocol/sdk` is deliberately *not* installed: it is a large
// tree for one transport, and this repo's dependency list is one package long on
// purpose.
//
// The framing is where the bugs live, and every one of them is handled here:
//
//   * A pipe delivers *chunks*, not messages. One JSON object arrives split
//     across two reads; two objects arrive in one. Everything is accumulated and
//     cut on '\n' — see onStdout. Framing that assumes one read is one message
//     works in every test and fails on the first server that writes a big reply.
//   * stderr is not the protocol. Servers log there freely, so it is kept for a
//     failure sentence and never parsed. A server that writes a banner to
//     *stdout* instead is the harder case and is survived rather than trusted:
//     an unparseable line is dropped and the next real reply still resolves.
//   * Notifications have no `id`. They arrive unsolicited, out of band, in the
//     middle of a pending call — so a reply is matched to a request by id and
//     never by arrival order. A notification mistaken for a reply resolves some
//     other call with the wrong body, which reads as the server lying.
//
// The lifecycle order is fixed by the spec and the order is load-bearing:
// `initialize`, then the `notifications/initialized` acknowledgement, then
// `tools/list`. Ask a server for its tools before it has been initialised and it
// refuses — and the refusal looks like a broken server rather than a broken
// client.
//
// A server's `env` routinely holds an API token. Nothing here returns an env
// *value*: `servers()` and `status()` return key NAMES, which is enough for a
// Settings pane to show what a server was configured with and useless to anyone
// reading a payload that reached a renderer. Same rule as keys.js — a credential
// must never reach the renderer unmasked.
//
// Everything returns { ok, ... } and never throws. The callers are a voice
// command with a sentence to say and a Settings pane, and neither of those wants
// a try/catch.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('./settings');

// The revision this client speaks. Servers negotiate down from here, so this is
// a request rather than an assertion — what actually got agreed is what
// connect() reports back.
const PROTOCOL_VERSION = '2024-11-05';

// Long enough that a server which loads a model or opens a database on startup
// still answers, short enough that a wedged one does not hold a voice command
// open. Per-server override via `timeoutMs` in the config.
const DEFAULT_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 10000;

// A server that never emits a newline would otherwise grow the reassembly
// buffer until the process dies. Past this the junk in hand is dropped rather
// than the app.
const MAX_BUFFER = 4 * 1024 * 1024;
// stderr is kept only to explain a failure, so only the tail of it is worth
// holding.
const MAX_STDERR = 4000;
const MAX_JUNK = 200;

const CLIENT_INFO = (() => {
  let version = '0.0.0';
  try { version = String(require('../../package.json').version || version); } catch (_) {}
  return { name: 'bolo', version };
})();

// Shown wherever MCP needs the user to do something. One sentence, and it says
// exactly what to write and where.
const SETUP_HINT =
  'MCP servers are configured under the settings key `mcpServers`: a list of ' +
  '{ name, command, args, env, enabled }, where `command` is a program that speaks MCP over ' +
  'stdio. For example { "name": "files", "command": "npx", "args": ["-y", ' +
  '"@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\you\\\\notes"] }. `env` is where ' +
  'a server\'s token goes; it is stored, never echoed back and never logged.';

/* ---------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------ */

// name -> live connection. A connection is cheap to hold (one idle child) and
// expensive to rebuild (a spawn plus a handshake), so it is kept until the
// server dies or is switched off.
const conns = new Map();

let exitHookInstalled = false;

/* ---------------------------------------------------------------------------
   Framing — the pure half

   Nothing in this section touches a process, a socket or the clock. It is where
   the parse actually happens, so it is kept callable on a string.
   ------------------------------------------------------------------------ */

// One message, framed the only way MCP over stdio frames it.
function frame(message) {
  return JSON.stringify(message) + '\n';
}

// A chunk of stdout, cut into whole lines. `rest` is the tail with no newline
// yet, which is the next call's prefix — this is the whole of partial-line
// reassembly.
function splitLines(buffer) {
  const text = String(buffer == null ? '' : buffer);
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) break;
    lines.push(text.slice(start, nl));
    start = nl + 1;
  }
  return { lines, rest: text.slice(start) };
}

// A JSON-RPC message off the wire, and which of the three things it is. This is
// the decision the whole client turns on: a message with no `id` is a
// notification and belongs to nobody's request, however much it looks like a
// reply to the one in flight.
function classify(line) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw) return { kind: 'blank' };
  let message;
  try {
    message = JSON.parse(raw);
  } catch (_) {
    return { kind: 'junk', raw: raw.slice(0, MAX_JUNK) };
  }
  // A JSON-RPC batch is an array, and is not a thing over stdio. Treating one as
  // a message would produce `undefined` for every field read off it.
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { kind: 'junk', raw: raw.slice(0, MAX_JUNK) };
  }
  if (message.id === undefined || message.id === null) {
    return { kind: 'notification', method: message.method ? String(message.method) : null, message };
  }
  return { kind: 'response', id: message.id, message };
}

// What a configured server looks like on the way OUT. `env` is the one field
// that must not survive the trip: it is where the token lives.
function redactServer(server) {
  const s = server && typeof server === 'object' ? server : {};
  const env = s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? s.env : {};
  const timeout = Number(s.timeoutMs);
  return {
    name: String(s.name == null ? '' : s.name),
    command: String(s.command == null ? '' : s.command),
    args: Array.isArray(s.args) ? s.args.map((a) => String(a)) : [],
    enabled: s.enabled !== false,
    // Names, never values. See the note at the top of the file.
    envKeys: Object.keys(env),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : null
  };
}

// The capability blocks a server announced, by name. Keep-listed rather than
// enumerated from the response so an unknown key cannot become an unknown field
// downstream.
const CAPABILITY_KEYS = ['tools', 'resources', 'prompts', 'logging', 'completions', 'experimental'];

function parseCapabilities(caps) {
  const c = caps && typeof caps === 'object' ? caps : {};
  return CAPABILITY_KEYS.filter((k) => c[k] && typeof c[k] === 'object');
}

// A tool description, normalised to the four fields anything here reads. The
// input schema travels through untouched: it is JSON Schema, and rewriting it
// would only create a second place for it to be wrong.
function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object' || !tool.name) return null;
  return {
    name: String(tool.name),
    title: tool.title ? String(tool.title) : null,
    description: tool.description ? String(tool.description) : '',
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null
  };
}

// The text out of a tools/call result, plus which content kinds came back. A
// result carrying only an image is a real answer, and flattening it to '' would
// report it as an empty one.
function contentText(result) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const text = content
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  const kinds = [...new Set(content.map((c) => (c && c.type ? String(c.type) : 'unknown')))];
  return { text, kinds };
}

// cmd.exe re-parses the whole command line, so an argument with a space has to
// arrive already quoted. A literal `"` cannot be expressed that way at all, and
// silently mangling it would start a *different* server with different arguments
// — worse than refusing, which is what the caller does.
const SHIM_EXT = new Set(['.cmd', '.bat']);
const SHELL_UNSAFE = /[\s"^&|<>]/;

function shellArgs(args) {
  return (Array.isArray(args) ? args : []).map((a) => {
    const s = String(a);
    return SHELL_UNSAFE.test(s) ? '"' + s + '"' : s;
  });
}

function argsShellSafe(args) {
  return !(Array.isArray(args) ? args : []).some((a) => String(a).includes('"'));
}

// The command and whether cmd.exe has to interpret it.
//
// Two shapes are common and they are not the same shape. `node` and `python` are
// real executables that must be spawned directly. `npx` and `uvx` — which is how
// almost every published MCP server is launched — resolve to `.cmd` shims, and
// Node refuses to spawn a `.cmd` without a shell (the CVE-2024-27980 fix turned
// that into EINVAL). Worse, `spawn('npx', …)` does not fail loudly: CreateProcess
// only ever appends `.exe`, so a bare `npx` is simply "not found" — which would
// report the single most common MCP command in the world as a missing program.
function resolveCommand(command) {
  const cmd = String(command == null ? '' : command).trim();
  if (!cmd || process.platform !== 'win32') return { command: cmd, shell: false };

  const ext = path.extname(cmd).toLowerCase();
  if (ext) return { command: cmd, shell: SHIM_EXT.has(ext) };

  const dirs = /[\\/]/.test(cmd) ? [''] : String(process.env.PATH || '').split(';').filter(Boolean);
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);

  for (const dir of dirs) {
    for (const e of exts) {
      const full = dir ? path.join(dir, cmd + e) : cmd + e;
      try {
        if (fs.statSync(full).isFile()) return { command: full, shell: SHIM_EXT.has(e) };
      } catch (_) { /* not in this directory */ }
    }
  }
  return { command: cmd, shell: false };
}

/* ---------------------------------------------------------------------------
   One connection

   Everything below is per-child-process. `conn` is the whole of a server's
   runtime state and is discarded with it.
   ------------------------------------------------------------------------ */

// Past this the buffer in hand is dropped rather than the app. Only the tail
// survives, because the newline that ends the oversized line has not arrived.
function onStdout(conn, chunk) {
  conn.buf += chunk;
  if (conn.buf.length > MAX_BUFFER) {
    const nl = conn.buf.lastIndexOf('\n');
    conn.junk = 'oversized-line';
    conn.buf = nl >= 0 ? conn.buf.slice(nl + 1) : '';
  }
  const { lines, rest } = splitLines(conn.buf);
  conn.buf = rest;
  for (const line of lines) onLine(conn, line);
}

function onLine(conn, line) {
  const got = classify(line);
  if (got.kind === 'blank') return;
  if (got.kind === 'junk') {
    // A banner, a log line, a stray prompt. Recorded so a failure can quote it —
    // the alternative, killing the connection over somebody's `console.log`, is
    // how a working server gets reported as a broken one.
    conn.junk = got.raw;
    return;
  }
  if (got.kind === 'notification') {
    conn.notes.push(got.method);
    if (conn.notes.length > 32) conn.notes.shift();
    return;
  }
  const pending = conn.pending.get(got.id);
  // A reply to something already timed out. Dropping it keeps a slow server from
  // resolving a *later* call with an earlier answer.
  if (!pending) return;
  conn.pending.delete(got.id);
  clearTimeout(pending.timer);
  pending.resolve(got.message);
}

// Everything in flight when the child goes away. Resolved rather than rejected:
// a rejection here would be an unhandled one, because the caller awaits a plain
// promise and has no try/catch.
function failPending(conn, why) {
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timer);
    pending.resolve({ __dead: why });
  }
  conn.pending.clear();
}

function killConn(conn) {
  conn.dead = conn.dead || 'closed';
  failPending(conn, conn.dead);
  try { conn.child.stdin.end(); } catch (_) {}
  try { conn.child.kill(); } catch (_) {}
}

// The child dies with the app, not after it.
//
// main.js owns the quit sequence and this module is not wired into it — a
// forgotten `shutdown()` would leave every configured server running with a
// closed stdin, which on Windows is a process nobody can find. An `exit` handler
// registered here is synchronous and therefore runs inside the quit, which is
// the one place a child can still be killed reliably.
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [, conn] of conns) {
      try { conn.child.kill(); } catch (_) {}
    }
  });
}

function attach(server, child) {
  const conn = {
    name: server.name,
    child,
    buf: '',
    nextId: 1,
    pending: new Map(),
    tools: [],
    info: null,
    capabilities: [],
    protocolVersion: null,
    stderr: '',
    notes: [],
    junk: null,
    dead: null
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => onStdout(conn, chunk));

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    conn.stderr = (conn.stderr + chunk).slice(-MAX_STDERR);
  });

  child.stdin.on('error', () => { /* the exit handler below owns the failure */ });

  child.on('error', (e) => {
    conn.dead = 'could not be started: ' + (e && e.message ? e.message : 'unknown error');
    failPending(conn, conn.dead);
  });
  child.on('exit', (code, signal) => {
    conn.dead = signal ? 'was killed (' + signal + ')' : 'exited with code ' + code;
    failPending(conn, conn.dead);
  });

  installExitHook();
  return conn;
}

// One request, one reply, matched by id, with a deadline. Resolves — never
// rejects — with either the server's message or a tagged failure the caller
// turns into a sentence.
function rpc(conn, method, params, timeoutMs) {
  return new Promise((resolve) => {
    if (conn.dead) { resolve({ __dead: conn.dead }); return; }
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      resolve({ __timeout: true, method });
    }, timeoutMs);
    conn.pending.set(id, { resolve, timer, method });
    try {
      conn.child.stdin.write(frame({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
    } catch (e) {
      conn.pending.delete(id);
      clearTimeout(timer);
      resolve({ __dead: e.message });
    }
  });
}

// A message with no id expects no reply. Writing one is fire-and-forget by
// definition — there is nothing to await, and awaiting it would hang forever.
function notify(conn, method, params) {
  if (conn.dead) return;
  try {
    conn.child.stdin.write(frame({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
  } catch (_) { /* the exit handler owns it */ }
}

// A JSON-RPC outcome as a refusal, or null when there is a result. The three
// failures get three sentences because each has a different fix: a timeout is
// the server being slow, `server-exited` is the server being gone, and a
// protocol error is the server disagreeing.
function refusal(res, name, what) {
  if (!res) return { ok: false, error: 'no-reply', reason: '"' + name + '" gave no answer to ' + what + '.' };
  if (res.__timeout) {
    return { ok: false, error: 'timeout', reason: '"' + name + '" did not answer ' + what + ' in time.' };
  }
  if (res.__dead) {
    return { ok: false, error: 'server-exited', reason: '"' + name + '" ' + res.__dead + ' while ' + what + ' was in flight.' };
  }
  if (res.error) {
    return {
      ok: false,
      error: 'server-error',
      code: res.error.code == null ? null : res.error.code,
      reason: '"' + name + '" refused ' + what + ': ' + String(res.error.message || 'no message') + '.'
    };
  }
  return null;
}

function connectTimeout(server) {
  const t = Number(server && server.timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : CONNECT_TIMEOUT_MS;
}

function callTimeout(server) {
  const t = Number(server && server.timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
}

/* ---------------------------------------------------------------------------
   Configuration

   The stored list is the truth; nothing here caches it. A server's `env` keeps
   its values in the store — they are needed to launch it — and leaves this
   module redacted.
   ------------------------------------------------------------------------ */

function stored() {
  const v = settings.get('mcpServers');
  return Array.isArray(v) ? v.filter((s) => s && typeof s === 'object' && s.name) : [];
}

function save(list) {
  settings.set('mcpServers', list);
  return list;
}

function find(name) {
  const wanted = String(name == null ? '' : name);
  return stored().find((s) => String(s.name) === wanted) || null;
}

/* ---------------------------------------------------------------------------
   The surface
   ------------------------------------------------------------------------ */

// Every configured server, redacted. The voice path and the Settings pane both
// read this, so it is the shape that has to be safe rather than a preview of it.
function servers() {
  const list = stored().map(redactServer);
  return {
    ok: true,
    integration: 'mcp',
    count: list.length,
    servers: list,
    reason: list.length ? null : SETUP_HINT
  };
}

async function addServer(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const name = String(s.name == null ? '' : s.name).trim();
  const command = String(s.command == null ? '' : s.command).trim();

  if (!name) return { ok: false, error: 'bad-name', reason: 'An MCP server needs a name.' };
  if (!command) {
    return { ok: false, error: 'bad-command', reason: 'The MCP server "' + name + '" needs a command to run.' };
  }
  // Refused rather than replaced. Silently overwriting a server would discard an
  // `env` token the user pasted once and cannot see again, which is the one field
  // they have no way to check afterwards.
  if (find(name)) {
    return {
      ok: false, error: 'duplicate-name',
      reason: 'An MCP server called "' + name + '" is already configured. Remove it first.'
    };
  }

  const rawArgs = Array.isArray(s.args) ? s.args.map((a) => String(a)) : [];
  const env = {};
  if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
    for (const [k, v] of Object.entries(s.env)) {
      if (k && v != null) env[String(k)] = String(v);
    }
  }

  const entry = { name, command, args: rawArgs, env, enabled: s.enabled !== false };
  const t = Number(s.timeoutMs);
  if (Number.isFinite(t) && t > 0) entry.timeoutMs = t;

  const list = stored();
  list.push(entry);
  save(list);

  return { ok: true, integration: 'mcp', name, server: redactServer(entry), count: list.length };
}

function removeServer(name) {
  const wanted = String(name == null ? '' : name);
  const list = stored();
  const next = list.filter((s) => String(s.name) !== wanted);
  if (next.length === list.length) {
    return { ok: false, error: 'unknown-server', reason: 'No MCP server called "' + wanted + '" is configured.' };
  }
  // Killed before the config is written: a server left running with no
  // configuration entry is a process the user cannot see or stop.
  disconnect(wanted);
  save(next);
  return { ok: true, integration: 'mcp', name: wanted, removed: true, count: next.length };
}

function setEnabled(name, on) {
  const wanted = String(name == null ? '' : name);
  const want = !!on;
  const list = stored();
  const entry = list.find((s) => String(s.name) === wanted);
  if (!entry) {
    return { ok: false, error: 'unknown-server', reason: 'No MCP server called "' + wanted + '" is configured.' };
  }
  entry.enabled = want;
  // Switching a server off stops it. Leaving the child running would make the
  // switch a label rather than a control — the process keeps its files and its
  // network handles open either way.
  if (!want) disconnect(wanted);
  save(list);
  return { ok: true, integration: 'mcp', name: wanted, enabled: want };
}

function status() {
  const list = stored().map(redactServer);
  const running = list.filter((s) => {
    const conn = conns.get(s.name);
    return !!conn && !conn.dead;
  });
  return {
    ok: true,
    integration: 'mcp',
    configured: list.length > 0,
    count: list.length,
    running: running.length,
    servers: list,
    reason: list.length ? null : SETUP_HINT
  };
}

/* ---------------------------------------------------------------------------
   The lifecycle
   ------------------------------------------------------------------------ */

// A name that was never given is worth its own refusal. Every other sentence
// here quotes the name back, and `No server called "" is configured` is a
// sentence that helps nobody.
function nameless(what) {
  return { ok: false, integration: 'mcp', error: 'bad-name', reason: 'Which MCP server? ' + what };
}

// Spawn, then handshake. Reports the protocol version the server actually agreed
// to rather than the one asked for: a server is free to answer with an older
// revision, and a status payload claiming otherwise would be a guess.
async function connect(name) {
  const wanted = String(name == null ? '' : name).trim();
  if (!wanted) return nameless('Give the server\'s name as it appears in the settings.');
  const server = find(wanted);
  if (!server) {
    return { ok: false, error: 'unknown-server', reason: 'No MCP server called "' + wanted + '" is configured.' };
  }
  if (server.enabled === false) {
    return { ok: false, error: 'disabled', reason: 'The MCP server "' + wanted + '" is switched off.' };
  }

  const live = conns.get(wanted);
  if (live && !live.dead) {
    return {
      ok: true, integration: 'mcp', name: wanted, connected: true, alreadyConnected: true,
      protocolVersion: live.protocolVersion,
      serverInfo: live.info,
      capabilities: live.capabilities.slice(),
      toolCount: live.tools.length
    };
  }
  if (live) conns.delete(wanted);

  const args = Array.isArray(server.args) ? server.args.map((a) => String(a)) : [];
  const { command, shell } = resolveCommand(server.command);
  if (shell && !argsShellSafe(args)) {
    return {
      ok: false, error: 'unsupported-args',
      reason: 'The MCP server "' + wanted + '" runs through ' + path.basename(command) +
        ', which cannot carry an argument containing a double quote.'
    };
  }

  let child;
  try {
    child = spawn(command, shell ? shellArgs(args) : args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
      // The server's own env wins, because that is where it expects its token.
      // The rest of this process's environment travels with it so PATH, HOME and
      // the Windows system variables are still there.
      env: { ...process.env, ...(server.env && typeof server.env === 'object' ? server.env : {}) }
    });
  } catch (e) {
    return {
      ok: false, error: 'spawn-failed',
      reason: 'Could not start the MCP server "' + wanted + '": ' + (e && e.message ? e.message : 'unknown error') + '.'
    };
  }

  // ENOENT and EACCES arrive as an event, not as a throw, so the spawn has to be
  // waited on before anything is written to its stdin.
  const started = await new Promise((resolve) => {
    let settled = false;
    child.once('spawn', () => { if (!settled) { settled = true; resolve(null); } });
    child.once('error', (e) => { if (!settled) { settled = true; resolve(e); } });
  });
  if (started) {
    try { child.kill(); } catch (_) {}
    return {
      ok: false, error: 'spawn-failed',
      reason: 'Could not start the MCP server "' + wanted + '": ' + (started.message || 'unknown error') +
        '. Check the command and its arguments.'
    };
  }

  const conn = attach(server, child);
  conns.set(wanted, conn);

  const init = await rpc(conn, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { ...CLIENT_INFO }
  }, connectTimeout(server));

  const bad = refusal(init, wanted, 'initialize');
  if (bad) {
    killConn(conn);
    conns.delete(wanted);
    return { ...bad, stderr: conn.stderr.trim() || null };
  }

  const result = init.result && typeof init.result === 'object' ? init.result : {};
  conn.protocolVersion = result.protocolVersion ? String(result.protocolVersion) : PROTOCOL_VERSION;
  conn.info = result.serverInfo && typeof result.serverInfo === 'object'
    ? { name: String(result.serverInfo.name || ''), version: String(result.serverInfo.version || '') }
    : null;
  conn.capabilities = parseCapabilities(result.capabilities);

  // The acknowledgement, and only then the tool list. A server that is asked for
  // its tools before this arrives refuses, and the refusal reads as a bad server.
  notify(conn, 'notifications/initialized');

  const list = await rpc(conn, 'tools/list', {}, connectTimeout(server));
  const failed = refusal(list, wanted, 'tools/list');
  if (failed) {
    // Connected, but with nothing to offer. Reported rather than swallowed, and
    // not turned into a failed connection: the handshake itself worked, and a
    // server whose tools/list is refused may still be one the user wants.
    conn.tools = [];
    return {
      ok: true, integration: 'mcp', name: wanted, connected: true,
      protocolVersion: conn.protocolVersion,
      serverInfo: conn.info,
      capabilities: conn.capabilities.slice(),
      toolCount: 0,
      tools: [],
      warning: failed.reason
    };
  }

  conn.tools = toolsIn(list.result);
  return {
    ok: true, integration: 'mcp', name: wanted, connected: true,
    protocolVersion: conn.protocolVersion,
    serverInfo: conn.info,
    capabilities: conn.capabilities.slice(),
    toolCount: conn.tools.length,
    tools: conn.tools
  };
}

function toolsIn(result) {
  const list = result && Array.isArray(result.tools) ? result.tools : [];
  return list.map(normalizeTool).filter(Boolean);
}

function disconnect(name) {
  const wanted = String(name == null ? '' : name).trim();
  if (!wanted) return nameless('Give the server\'s name as it appears in the settings.');
  const conn = conns.get(wanted);
  if (conn) {
    killConn(conn);
    conns.delete(wanted);
  }
  return { ok: true, integration: 'mcp', name: wanted, connected: false };
}

// Called on quit and by a settings reset. Every child goes; the configuration
// stays, because a stopped server is not a forgotten one.
function shutdown() {
  const names = [...conns.keys()];
  for (const n of names) disconnect(n);
  return { ok: true, integration: 'mcp', stopped: names.length, names };
}

// Connected on demand. A caller asking for a server's tools is a caller that
// wants them now; requiring a separate connect() first would only be a step the
// voice path has no way to perform.
async function listTools(serverName) {
  const wanted = String(serverName == null ? '' : serverName).trim();
  if (!wanted) return nameless('Give the server\'s name as it appears in the settings.');
  const server = find(wanted);
  if (!server) {
    return { ok: false, error: 'unknown-server', reason: 'No MCP server called "' + wanted + '" is configured.' };
  }
  let conn = conns.get(wanted);
  if (!conn || conn.dead) {
    const c = await connect(wanted);
    if (!c.ok) return c;
    conn = conns.get(wanted);
  }

  const res = await rpc(conn, 'tools/list', {}, callTimeout(server));
  const bad = refusal(res, wanted, 'tools/list');
  if (bad) return bad;

  const tools = toolsIn(res.result);
  conn.tools = tools;
  return { ok: true, integration: 'mcp', server: wanted, count: tools.length, tools };
}

// One tool, called for real. The tool's own failure is not this client's failure
// and is reported separately: `isError` from the server is a refusal the tool
// made, while `server-error` is the server refusing the request.
async function callTool(serverName, toolName, args) {
  const wanted = String(serverName == null ? '' : serverName).trim();
  const tool = String(toolName == null ? '' : toolName).trim();
  if (!wanted) return nameless('Give the server\'s name as it appears in the settings.');
  if (!tool) {
    return { ok: false, integration: 'mcp', error: 'bad-tool', reason: 'No tool name was given.', server: wanted };
  }

  const server = find(wanted);
  if (!server) {
    return { ok: false, error: 'unknown-server', reason: 'No MCP server called "' + wanted + '" is configured.' };
  }
  let conn = conns.get(wanted);
  if (!conn || conn.dead) {
    const c = await connect(wanted);
    if (!c.ok) return c;
    conn = conns.get(wanted);
  }

  // Checked against the list the server actually published, so a hallucinated
  // tool name gets one clear sentence instead of a protocol error the user
  // cannot act on.
  if (!conn.tools.some((t) => t.name === tool)) {
    return {
      ok: false, error: 'unknown-tool', server: wanted, tool,
      reason: '"' + wanted + '" has no tool called "' + tool + '".' +
        (conn.tools.length ? ' It offers: ' + conn.tools.map((t) => t.name).join(', ') + '.' : ' It offers no tools.')
    };
  }

  const res = await rpc(conn, 'tools/call', {
    name: tool,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  }, callTimeout(server));

  const bad = refusal(res, wanted, 'tools/call ' + tool);
  if (bad) return { ...bad, server: wanted, tool };

  const result = res.result && typeof res.result === 'object' ? res.result : {};
  const { text, kinds } = contentText(result);
  const structured = result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : null;

  // A tool that ran and said no. Distinct from a transport failure on purpose:
  // the call worked, the answer was a refusal.
  if (result.isError) {
    return {
      ok: false, error: 'tool-error', server: wanted, tool, text, kinds, structured,
      reason: text || 'The tool "' + tool + '" on "' + wanted + '" reported an error.'
    };
  }

  return { ok: true, integration: 'mcp', server: wanted, tool, isError: false, text, kinds, structured };
}

module.exports = {
  SETUP_HINT,
  PROTOCOL_VERSION,
  servers,
  addServer,
  removeServer,
  setEnabled,
  status,
  connect,
  disconnect,
  shutdown,
  listTools,
  callTool,
  _internals: {
    frame, splitLines, classify, redactServer, parseCapabilities, normalizeTool,
    contentText, resolveCommand, shellArgs, argsShellSafe, toolsIn, refusal,
    PROTOCOL_VERSION, CLIENT_INFO, CAPABILITY_KEYS, DEFAULT_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_BUFFER
  }
};
