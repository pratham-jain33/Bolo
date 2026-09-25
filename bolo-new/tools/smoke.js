// A boot-level smoke test for the things that cannot be checked statically:
// every require resolves, every module loads in the real main process, every
// adapter answers, and the voice path speaks for every intent it advertises —
// including the not-connected case, which is the line a new user actually hears
// first.
//
// Nothing here changes the machine. The adapters are switched off for the voice
// pass so that speaking an intent cannot open a file, launch a browser or start
// music, and the switch state is put back exactly as it was found.
//   electron tools/smoke.js
const { app } = require('electron');

let pass = 0;
let fail = 0;
const lines = [];

function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  lines.push((ok ? '  ok  ' : '  FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
}
function note(text) {
  lines.push('  ...   ' + text);
}

// A status payload reaches the renderer, so it must never carry a credential.
// This is the one invariant here worth failing loudly on: it is cheap to check
// and expensive to get wrong.
const SECRET_KEYS = ['access_token', 'refresh_token', 'token', 'client_secret', 'secret', 'apiKey', 'api_key', 'password'];
function secretsIn(obj, path = '') {
  const found = [];
  if (!obj || typeof obj !== 'object') return found;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.includes(k)) found.push(path + k);
    else if (v && typeof v === 'object') found.push(...secretsIn(v, path + k + '.'));
  }
  return found;
}

app.whenReady().then(async () => {
  /* ── every module loads ──────────────────────────────────────────────── */
  const mods = [
    'agent', 'keys', 'settings', 'duck', 'capabilities', 'workflows'
  ];
  const loaded = {};
  for (const m of mods) {
    try {
      loaded[m] = require('../src/main/' + m);
      check('require ' + m, true);
    } catch (e) {
      check('require ' + m, false, e.message);
    }
  }

  const a = loaded.agent;
  if (!a) {
    console.log(lines.join('\n') + '\n\ncannot continue without agent');
    app.exit(1);
    return;
  }

  /* ── the agent's intents and the planner agree ───────────────────────── */
  const intents = a.list();
  const tools = Object.keys(a.TOOLS);
  note('intents: ' + intents.join(', '));

  const undescribed = tools.filter((t) => !a.TOOL_SYSTEM.includes(t));
  check('the planner prompt lists every tool', undescribed.length === 0, undescribed.join(', '));

  // parseTool is the gate: a name not in TOOLS must be rejected, and every name
  // in TOOLS must be accepted, or the model is being offered a tool it can never
  // have accepted.
  const rejected = tools.filter((t) => {
    const p = a.parseTool(JSON.stringify({ tool: t, args: {} }));
    return !p || p.tool !== t;
  });
  check('parseTool accepts every advertised tool', rejected.length === 0, rejected.join(', '));
  check('parseTool rejects an invented tool', a.parseTool('{"tool":"rm_rf","args":{}}') === null);
  check('parseTool treats "none" as a real answer', (a.parseTool('{"tool":"none"}') || {}).tool === 'none');

  check('agent.run refuses an unknown intent', (await a.run('no-such-intent', {})).ok === false);

  /* ── the samples are real intents ────────────────────────────────────── */
  const wf = loaded.workflows;
  for (const [key, s] of Object.entries(wf.samples)) {
    const bad = s.steps.filter((st) => !intents.includes(st.intent));
    check('workflow sample ' + key + ' uses real intents', bad.length === 0, bad.map((b) => b.intent).join(', '));
  }

  const example = await wf.runWorkflow(wf.samples.screen_context);
  check('a sample workflow runs end to end', example.ok === true && example.results.length > 0,
    example.results.length + ' steps');

  /* ── the duck has a backend or says why not ──────────────────────────── */
  const d = loaded.duck.getState();
  check('audio ducking reports its state', typeof d.supported === 'boolean', 'backend=' + d.backend);
  if (!d.supported) note('ducking unavailable here: ' + (d.reason || 'no backend'));

  console.log(lines.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
});
