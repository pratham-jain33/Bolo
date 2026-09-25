// Real MCP, against a fake server. Everything here is a round trip through a
// live child process — the protocol is newline-delimited JSON over a pipe, and a
// check that stubbed the pipe would prove nothing about the only part that can be
// wrong.
//
// No MCP server needs to be installed on the machine. tools/fake-mcp-server.js is
// the server, it is spawned as a real child process, and it can be told to
// misbehave: a server that never answers, one that dies mid-call, and one that
// writes a banner to stdout and splits its replies across two writes. Those
// three are the cases a real server never produces on demand, and they are
// exactly the ones that break a client in production.
//
// The user's own configuration is snapshotted and put back: this check writes to
// the same settings store the app reads, and a server entry can hold an API
// token that would be destroyed by a test that forgot to restore it.
//   electron tools/mcp-check.js
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settings = require('../src/main/settings');
const mcp = require('../src/main/mcp');

let pass = 0;
let fail = 0;

// Held at module scope so the failure path below can put it back too. A check
// that throws half way through must not be the thing that deletes the user's
// servers.
let beforeConfig = null;

function restoreConfig() {
  try { settings.set('mcpServers', Array.isArray(beforeConfig) ? beforeConfig : []); } catch (_) {}
}

function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(label, ok, ok ? '' : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const FAKE = path.join(__dirname, 'fake-mcp-server.js');
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' };

function fake(name, mode, extra) {
  return {
    name,
    // The electron binary re-entered as plain Node. It is the one interpreter
    // guaranteed to exist on a machine that can run this check at all.
    command: process.execPath,
    args: [FAKE, mode],
    env: { ...NODE_ENV },
    enabled: true,
    ...(extra || {})
  };
}

const CONFIG = [
  fake('good', 'ok'),
  fake('noisy', 'noisy'),
  // A short deadline, so the timeout case costs a second rather than fifteen.
  fake('quiet', 'silent', { timeoutMs: 900 }),
  fake('crash', 'die'),
  // A token, to prove it never comes back out. Never a real one, and never
  // written to disk outside this store.
  fake('secretive', 'ok', { env: { ...NODE_ENV, BOLO_TEST_TOKEN: 'sk-do-not-leak-me' } })
];

// A .cmd shim, which is how Windows distributes almost every MCP server (npx is
// npx.cmd). Node refuses to spawn one without a shell, so this is the only shape
// that exercises the shell path — and it is the shape a real config will use.
let shimPath = null;
function writeShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolo-mcp-'));
  shimPath = path.join(dir, 'fake-mcp.cmd');
  fs.writeFileSync(shimPath, '@echo off\r\n"' + process.execPath + '" "' + FAKE + '" ok\r\n');
  return shimPath;
}

app.whenReady().then(async () => {
  beforeConfig = settings.get('mcpServers');

  console.log('\n— the framing (pure) —');
  const { frame, splitLines, classify, redactServer, shellArgs, resolveCommand, parseCapabilities } = mcp._internals;

  eq('frame() ends a message with exactly one newline', frame({ a: 1 }), '{"a":1}\n');
  eq('splitLines() keeps the unterminated tail back', splitLines('{"a":1}\n{"b"'), { lines: ['{"a":1}'], rest: '{"b"' });
  eq('splitLines() handles a chunk with no newline at all', splitLines('{"a"'), { lines: [], rest: '{"a"' });
  eq('splitLines() handles a chunk with two whole messages',
    splitLines('{"a":1}\n{"b":2}\n').lines.length, 2);

  // The three kinds of line, and the one that matters: a notification must never
  // come back as a response, whatever else it looks like.
  eq('a reply is a response', classify('{"jsonrpc":"2.0","id":7,"result":{}}').kind, 'response');
  eq('and it carries its id', classify('{"jsonrpc":"2.0","id":7,"result":{}}').id, 7);
  eq('an id of 0 is still a response', classify('{"jsonrpc":"2.0","id":0,"result":{}}').kind, 'response');
  eq('a message with no id is a notification',
    classify('{"jsonrpc":"2.0","method":"notifications/message"}').kind, 'notification');
  eq('and it carries its method',
    classify('{"jsonrpc":"2.0","method":"notifications/message"}').method, 'notifications/message');
  eq('a banner on stdout is junk, not a crash', classify('Starting server...').kind, 'junk');
  eq('a JSON array is junk', classify('[1,2,3]').kind, 'junk');
  eq('an empty line is blank', classify('   ').kind, 'blank');

  eq('capabilities are reported by name',
    parseCapabilities({ tools: {}, logging: {} }), ['tools', 'logging']);
  eq('an unknown capability is not invented', parseCapabilities({ tools: {}, madeUp: {} }), ['tools']);
  eq('no capabilities is an empty list', parseCapabilities(null), []);

  eq('redactServer keeps env key names', redactServer(CONFIG[4]).envKeys, ['ELECTRON_RUN_AS_NODE', 'BOLO_TEST_TOKEN']);
  eq('and never the values', Object.prototype.hasOwnProperty.call(redactServer(CONFIG[4]), 'env'), false);
  check('redactServer output cannot carry the token',
    !JSON.stringify(redactServer(CONFIG[4])).includes('sk-do-not-leak-me'));

  eq('shellArgs quotes an argument with a space', shellArgs(['a b']), ['"a b"']);
  eq('shellArgs leaves a plain argument alone', shellArgs(['-y']), ['-y']);
  eq('a .cmd resolves to a shell', resolveCommand('C:\\nope\\server.cmd').shell, true);
  eq('a .bat resolves to a shell', resolveCommand('C:\\nope\\server.bat').shell, true);
  eq('an .exe does not', resolveCommand('C:\\nope\\server.exe').shell, false);

  console.log('\n— the configuration —');

  mcp.shutdown();
  settings.set('mcpServers', []);

  const empty = mcp.servers();
  eq('an empty list is not an error', empty.ok, true);
  eq('and counts zero', empty.count, 0);
  check('and explains how to add one', /mcpServers/.test(String(empty.reason || '')));

  eq('a server with no name is refused', (await mcp.addServer({ command: 'node' })).error, 'bad-name');
  eq('a server with no command is refused', (await mcp.addServer({ name: 'x' })).error, 'bad-command');

  for (const c of CONFIG) {
    const r = await mcp.addServer(c);
    eq('added ' + c.name, r.ok, true);
  }
  eq('a duplicate name is refused, not overwritten',
    (await mcp.addServer(fake('good', 'ok'))).error, 'duplicate-name');
  eq('every server is listed', mcp.servers().count, CONFIG.length);

  const added = { ...CONFIG[4], name: 'secretive2' };
  await mcp.addServer(added);
  check('the token is not in servers()', !JSON.stringify(mcp.servers()).includes('sk-do-not-leak-me'));
  check('the token is not in status()', !JSON.stringify(mcp.status()).includes('sk-do-not-leak-me'));
  check('the token is still readable by the launcher',
    JSON.stringify(settings.get('mcpServers')).includes('sk-do-not-leak-me'));
  eq('removeServer() drops it', mcp.removeServer('secretive2').ok, true);

  eq('an unknown server is refused by connect', (await mcp.connect('nope')).error, 'unknown-server');
  eq('an unknown server is refused by listTools', (await mcp.listTools('nope')).error, 'unknown-server');
  eq('an unknown server is refused by setEnabled', mcp.setEnabled('nope', true).error, 'unknown-server');
  eq('an unknown server is refused by removeServer', mcp.removeServer('nope').error, 'unknown-server');
  eq('a call with no server named is refused', (await mcp.callTool('', 'echo', {})).error, 'bad-name');
  eq('a call with no tool named is refused', (await mcp.callTool('good', '', {})).error, 'bad-tool');

  console.log('\n— the handshake —');

  const conn = await mcp.connect('good');
  eq('connect() succeeds', conn.ok, true);
  eq('and agrees the protocol version', conn.protocolVersion, '2024-11-05');
  eq('and names the server', conn.serverInfo && conn.serverInfo.name, 'fake-mcp');
  eq('and reports the capabilities it announced', conn.capabilities, ['tools']);
  eq('and has the tools', conn.toolCount, 2);

  const again = await mcp.connect('good');
  eq('a second connect reuses the live child', again.alreadyConnected, true);

  const listed = await mcp.listTools('good');
  eq('listTools() answers', listed.ok, true);
  eq('with both tools', listed.tools.map((t) => t.name).sort(), ['boom', 'echo']);
  check('and their input schemas survive',
    !!(listed.tools.find((t) => t.name === 'echo') || {}).inputSchema);

  console.log('\n— calling a tool —');

  const echoed = await mcp.callTool('good', 'echo', { text: 'hello there' });
  eq('a round trip succeeds', echoed.ok, true);
  eq('and the tool\'s own text comes back', echoed.text, 'echo: hello there');
  eq('and it is attributed to the server and tool', [echoed.server, echoed.tool], ['good', 'echo']);
  // The fake sends a notification right before answering. If replies were matched
  // by arrival order rather than by id, this is where it would surface.
  check('an unsolicited notification did not become the reply', !String(echoed.text).includes('working on it'));

  const errored = await mcp.callTool('good', 'boom', {});
  eq('a tool that refuses is a refusal, not a crash', errored.ok, false);
  eq('and is reported as the tool\'s own error', errored.error, 'tool-error');
  eq('with the tool\'s own words', errored.reason, 'the tool refused');

  const invented = await mcp.callTool('good', 'rm-rf', {});
  eq('an invented tool name is refused', invented.error, 'unknown-tool');
  check('and the refusal lists what does exist', /echo/.test(String(invented.reason)));

  console.log('\n— a server that frames badly —');

  const noisy = await mcp.connect('noisy');
  eq('a banner on stdout and a reply split in two still handshake', noisy.ok, true);
  eq('with the tools intact', noisy.toolCount, 2);
  const noisyCall = await mcp.callTool('noisy', 'echo', { text: 'hi' });
  eq('and a split reply still resolves the right call', noisyCall.text, 'echo: hi');
  const noisyRepeat = await mcp.listTools('noisy');
  eq('and does so repeatedly', noisyRepeat.count, 2);

  console.log('\n— a server that stops answering —');

  eq('a silent server still handshakes', (await mcp.connect('quiet')).ok, true);
  const t0 = Date.now();
  const timedOut = await mcp.callTool('quiet', 'echo', { text: 'x' });
  const took = Date.now() - t0;
  eq('a call with no reply times out', timedOut.error, 'timeout');
  check('and times out on its own deadline, not the default',
    took < 5000, took + 'ms against a 900ms deadline');
  check('and says which server and which call', /quiet/.test(String(timedOut.reason)));
  // A timed-out id must not be left behind to swallow the next reply.
  eq('the connection is still usable afterwards', (await mcp.listTools('quiet')).ok, true);

  console.log('\n— a server that dies mid-call —');

  eq('a server that will die still handshakes', (await mcp.connect('crash')).ok, true);
  const died = await mcp.callTool('crash', 'echo', { text: 'x' });
  eq('a call in flight when the child exits is a refusal', died.ok, false);
  eq('reported as the server going away', died.error, 'server-exited');
  check('and says how it went', /exited with code 3/.test(String(died.reason)), String(died.reason));
  // The dead connection must not be reused — a reconnect has to start a new child.
  const revived = await mcp.connect('crash');
  eq('and a later connect starts a fresh child', revived.ok, true);
  check('which is not the dead one', revived.alreadyConnected !== true);

  console.log('\n— switching a server off —');

  eq('switching off reports success', mcp.setEnabled('good', false).ok, true);
  const off = await mcp.connect('good');
  eq('and a switched-off server refuses to start', off.error, 'disabled');
  eq('and its tools are refused too', (await mcp.listTools('good')).error, 'disabled');
  mcp.setEnabled('good', true);
  eq('and switching it back on reconnects', (await mcp.connect('good')).ok, true);

  console.log('\n— a server launched through a shell —');

  writeShim();
  const shimmed = { ...fake('shimmed', 'ok'), command: shimPath, args: [], env: { ...NODE_ENV } };
  eq('a .cmd server is accepted', (await mcp.addServer(shimmed)).ok, true);
  const viaShim = await mcp.connect('shimmed');
  eq('a .cmd server connects through cmd.exe', viaShim.ok, true);
  if (viaShim.ok) {
    const shimCall = await mcp.callTool('shimmed', 'echo', { text: 'via cmd' });
    eq('and answers a call', shimCall.text, 'echo: via cmd');
  }

  console.log('\n— stopping everything —');

  eq('shutdown() stops every child', mcp.shutdown().ok, true);
  eq('and nothing is left running', mcp.status().running, 0);
  mcp.removeServer('shimmed');
  for (const c of CONFIG) mcp.removeServer(c.name);
  eq('and the configuration is empty again', mcp.servers().count, 0);

  // Put the user's own list back. A server entry can hold a token they pasted
  // once and cannot see again, so this is the one cleanup that has to happen.
  restoreConfig();
  eq('the user\'s own servers are back', mcp.servers().count,
    Array.isArray(beforeConfig) ? beforeConfig.length : 0);
  if (shimPath) { try { fs.rmSync(path.dirname(shimPath), { recursive: true, force: true }); } catch (_) {} }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('the check itself threw: ' + (e && e.stack ? e.stack : e));
  try { mcp.shutdown(); } catch (_) {}
  restoreConfig();
  app.exit(1);
});
