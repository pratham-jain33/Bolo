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
    'google', 'gmail', 'calendar', 'integrations', 'agent', 'keys', 'settings',
    'spotify', 'obsidian', 'local-files', 'local-notes', 'chat-import', 'maps', 'duck'
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

  const i = loaded.integrations;
  const a = loaded.agent;
  if (!i || !a) {
    console.log(lines.join('\n') + '\n\ncannot continue without integrations and agent');
    app.exit(1);
    return;
  }

  /* ── the catalogue ───────────────────────────────────────────────────── */
  const names = i.list();
  note('adapters: ' + names.join(', '));
  check('the catalogue is populated', names.length >= 10, names.length + ' adapters');

  const cat = i.catalog();
  check('every adapter appears in the catalogue', names.every((n) => cat.some((c) => c.name === n || c.id === n)),
    cat.length + ' catalogue rows');

  /* ── every adapter answers, and leaks nothing ────────────────────────── */
  for (const n of names) {
    let st = null;
    try {
      st = await i.status(n);
      check('status answers for ' + n, st && typeof st === 'object');
    } catch (e) {
      check('status answers for ' + n, false, e.message);
      continue;
    }
    const leaked = secretsIn(st);
    check('  ' + n + ' status carries no credential', leaked.length === 0, leaked.join(', '));
    const d = i.detail(n);
    check('  ' + n + ' declares its actions', !!(d && Array.isArray(d.actions) && d.actions.length), d ? d.actions.length + ' actions' : 'no detail');
  }

  /* ── a hallucinated verb refuses instead of throwing ─────────────────── */
  for (const n of names) {
    try {
      const r = await i.run(n, 'definitely-not-an-action', {});
      check('  ' + n + ' refuses an unknown action', r && r.ok === false && (r.error === 'unknown-action' || r.error === 'not-connected'),
        r && r.error);
    } catch (e) {
      check('  ' + n + ' refuses an unknown action', false, 'threw: ' + e.message);
    }
  }

  /* ── the agent's intents and the planner agree ───────────────────────── */
  const intents = a.list();
  const tools = Object.keys(a.TOOLS);

  const voiceNames = i.voiceList();
  note('voice intents: ' + voiceNames.length);

  const notAnIntent = voiceNames.filter((v) => !intents.includes(v));
  check('every voice intent is a real agent intent', notAnIntent.length === 0, notAnIntent.join(', '));

  const notATool = voiceNames.filter((v) => !tools.includes(v));
  check('every voice intent is a planner tool', notATool.length === 0, notATool.join(', '));

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

  /* ── every voice intent speaks, even when nothing is connected ───────── */
  // Switched off first, so this cannot open anything: `run()` refuses before it
  // reaches an adapter. The switch state is restored in the `finally`, because
  // leaving the user's integrations switched off would be a worse outcome than
  // any failure this test could find.
  const wasOn = {};
  for (const n of names) { wasOn[n] = i.isEnabled(n); i.setEnabled(n, false); }

  try {
    const silent = [];
    for (const v of voiceNames) {
      try {
        const r = await i.voiceIntent(v, {});
        if (!r || r.ok !== false) silent.push(v + ' (did not refuse while off)');
        else if (typeof r.speech !== 'string' || !r.speech) silent.push(v + ' (no line to say)');
      } catch (e) {
        silent.push(v + ' (threw: ' + e.message + ')');
      }
    }
    check('every voice intent has something to say when unconnected', silent.length === 0, silent.join('; '));

    check('an invented voice intent refuses', (await i.voiceIntent('nope', {})).ok === false);

    // And through the dispatcher, which is the path the notch actually uses.
    const viaAgent = [];
    for (const v of voiceNames) {
      try {
        const r = await a.run(v, {});
        if (!r || r.ok !== false) viaAgent.push(v);
        else if (typeof r.speech !== 'string' || !r.speech) viaAgent.push(v + ' (no speech)');
      } catch (e) {
        viaAgent.push(v + ' (threw: ' + e.message + ')');
      }
    }
    check('the dispatcher carries every voice intent', viaAgent.length === 0, viaAgent.join('; '));
  } finally {
    for (const n of names) i.setEnabled(n, wasOn[n]);
  }
  const restored = names.filter((n) => i.isEnabled(n) !== wasOn[n]);
  check('the enable switches were put back', restored.length === 0, restored.join(', '));

  check('agent.run refuses an unknown intent', (await a.run('no-such-intent', {})).ok === false);

  /* ── the samples are real intents ────────────────────────────────────── */
  const wf = require('../src/main/workflows');
  for (const [key, s] of Object.entries(wf.samples)) {
    const bad = s.steps.filter((st) => !intents.includes(st.intent));
    check('workflow sample ' + key + ' uses real intents', bad.length === 0, bad.map((b) => b.intent).join(', '));
  }

  const example = await wf.runWorkflow(wf.samples.morning_brief);
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
