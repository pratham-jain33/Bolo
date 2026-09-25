#!/usr/bin/env node
'use strict';

// A fake MCP server — a test fixture for tools/mcp-check.js, and nothing else.
// It ships, but nothing in src/ ever spawns it.
//
// It exists because the interesting half of an MCP client is the half that deals
// with a server misbehaving, and no real server misbehaves on request. The mode
// is the first argument, and each mode is one of the traps the client has to
// survive:
//
//   ok      (default) — a well-behaved server, plus notifications sent at the
//                       worst possible moment (see below)
//   noisy             — writes a non-JSON line to *stdout* before every reply and
//                       delivers the reply in two writes, cut mid-line. This is
//                       the banner-on-stdout and partial-line cases at once.
//   silent            — answers the handshake and then never answers tools/call,
//                       which is the only way to test a timeout against a server
//                       that is alive rather than dead
//   die               — writes half a reply and exits mid-call
//
// The unsolicited notification is deliberate and is the point of the `ok` mode:
// it is sent *while a request is in flight*, which is the only moment at which a
// client that matches replies by arrival order instead of by id can be caught
// getting it wrong.

const MODE = String(process.argv[2] || 'ok');

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns whatever text it was given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'the text to echo' } },
      required: ['text']
    }
  },
  {
    name: 'boom',
    description: 'Always fails, with a tool-level error rather than a protocol one.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function write(text) {
  process.stdout.write(text);
}
function send(message) {
  write(JSON.stringify(message) + '\n');
}
// Two writes with a gap, so the halves cannot be coalesced into one pipe read.
// Without the gap this test passes against a client that never reassembled
// anything, which is the bug it exists to catch.
function sendSplit(message) {
  const text = JSON.stringify(message) + '\n';
  const cut = Math.max(1, Math.floor(text.length / 2));
  write(text.slice(0, cut));
  setTimeout(() => write(text.slice(cut)), 25);
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
}
function reply(id, result) {
  if (MODE === 'noisy') {
    write('this line is not JSON, and is not allowed to break anything\n');
    sendSplit({ jsonrpc: '2.0', id, result });
  } else {
    send({ jsonrpc: '2.0', id, result });
  }
}
function fail(id, code, message) {
  if (MODE === 'noisy') write('{ this is a broken json line\n');
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function onCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};

  if (MODE === 'silent') return;                       // never answers; the client must time out
  if (MODE === 'die') {
    // Half a reply, then gone. A client that waits for a newline waits forever.
    write(JSON.stringify({ jsonrpc: '2.0', id }).slice(0, 20));
    process.exit(3);
  }
  // A notification arriving in the middle of a pending call — the exact moment a
  // client that trusts arrival order resolves the wrong request with this body.
  notify('notifications/message', { level: 'info', data: 'working on it' });

  if (name === 'echo') {
    const text = args && args.text != null ? String(args.text) : '';
    return reply(id, { content: [{ type: 'text', text: 'echo: ' + text }] });
  }
  if (name === 'boom') {
    return reply(id, { isError: true, content: [{ type: 'text', text: 'the tool refused' }] });
  }
  return fail(id, -32602, 'Unknown tool: ' + String(name));
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method } = message;
  const hasId = id !== undefined && id !== null;

  if (method === 'initialize') {
    return hasId ? reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' }
    }) : undefined;
  }
  if (method === 'notifications/initialized') {
    // Unsolicited, no id, no reply expected. A client that reads it as a reply
    // has nothing pending to match it to during the handshake; one that stores it
    // as "the answer to whatever is next" fails on the next real call.
    notify('notifications/message', { level: 'info', data: 'ready' });
    return undefined;
  }
  if (method === 'tools/list') {
    return hasId ? reply(id, { tools: TOOLS }) : undefined;
  }
  if (method === 'tools/call') {
    return hasId ? onCall(id, message.params) : undefined;
  }
  if (method === 'ping') {
    return hasId ? reply(id, {}) : undefined;
  }
  // An unknown *notification* is ignored; an unknown *request* is an error,
  // because a request is owed an answer and a client waiting on one hangs.
  return hasId ? fail(id, -32601, 'Method not found: ' + String(method)) : undefined;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      continue; // the client should never send one, but a fixture should not die on it
    }
    try {
      handle(message);
    } catch (e) {
      if (message && message.id != null) fail(message.id, -32603, String(e.message || e));
    }
  }
});

process.stdin.on('end', () => process.exit(0));
