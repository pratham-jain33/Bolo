const http = require('http');

const PORT = process.env.BOLO_PORT || 8787;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'bolo-stub' });
  }
  if (req.method === 'GET' && url.pathname === '/v1/status') {
    return json(res, 200, { planType: 'local_dev', status: 'active', isActive: true, entitlement: 'dev' });
  }
  if (req.method === 'GET' && url.pathname === '/v1/usage') {
    return json(res, 200, { currentUsage: 0, weeklyLimit: -1, entitlement: 'dev' });
  }
  if (req.method === 'POST' && url.pathname === '/v1/transcribe') {
    const body = await readBody(req);
    return json(res, 200, { text: 'hello from bolo stub', mode: 'local-stub-echo', got: body });
  }
  if (req.method === 'POST' && url.pathname === '/v1/context') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, stored: true, got: body });
  }
  if (req.method === 'POST' && url.pathname === '/v1/agent/run') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, intent: body.intent || 'echo', result: { stub: true } });
  }
  if (req.method === 'POST' && url.pathname === '/v1/workflows/run') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, steps: (body.steps || []).length });
  }
  if (req.method === 'POST' && url.pathname === '/v1/dictionary/sync') {
    return json(res, 200, { ok: true, merged: 0 });
  }
  return json(res, 404, { error: 'not-found' });
});

server.listen(PORT, () => {
  console.log(`bolo stub server on http://localhost:${PORT}`);
});
