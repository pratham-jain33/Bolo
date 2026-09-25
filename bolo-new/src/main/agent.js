// The agent dispatcher.
//
// Every intent here reaches something that actually happens: `capabilities.js`
// for the machine (open an app, read or write a file, take a screenshot,
// report the foreground window). Account-based integrations (email, calendar,
// notes, Spotify, maps, MCP) were removed; questions that no tool can answer
// fall through to `groq_chat`.
//
// The split is deliberate. Anything that touches only this machine is a
// capability, and capabilities.js owns the permission check and the allowlist
// for all of them. Anything with a connection state belongs to integrations.js,
// which owns the connection *and* the sentence to say when it is missing — so
// the line the user hears is the integration's own truth rather than a second
// guess made here.
//
// The `{ ok, ... }` return shape and the `list()` / `run(intent, args)` exports
// are load-bearing — main.js exposes them at bolo:agent-list /
// bolo:agent-run, and workflows.js steps are written against them.
const capabilities = require('./capabilities');
const intent = require('./intent');

// Email goes out to integrations.js rather than to a capability of this file's
// own: that module owns the Gmail connection state and already returns the exact
// The agent's reach is the machine itself: opening apps and paths, taking
// screenshots, reading and writing files under the home folder, and reporting
// the foreground window. Account-based integrations (email, calendar, music,
// notes, maps, MCP) were removed — the agent speaks through groq_chat and
// summarize_text for anything it cannot do on the machine.

const intents = {
  /* ── the real capabilities ──────────────────────────────────────────── */
  open_app: (args = {}) => capabilities.openApp(args.name || args.app || args.target),
  open_path: (args = {}) => capabilities.openPath(args.path || args.target),
  reveal_path: (args = {}) => capabilities.revealPath(args.path || args.target),
  // The whole op object is passed through: capabilities.editFile owns the
  // allowlist, the size caps and the confirmation rule, and it must see
  // `confirmed` and `op` exactly as the caller wrote them.
  edit_file: (args = {}) => capabilities.editFile(args),
  screenshot: (args = {}) => capabilities.screenshot(args),
  active_window: () => capabilities.activeWindow({ force: true }),


  /* ── kept working exactly as they were ──────────────────────────────── */
  summarize_text: async (args = {}) => {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, intent: 'summarize_text', error: 'empty-text', reason: 'There was nothing to summarise.' };
    // There is one summariser and it is the model. This used to fall back to
    // returning the first 280 characters under the name "summary", which is not
    // a summary — it is the input wearing the output's label, and a caller that
    // trusted it would show the user a truncation they never asked for.
    try {
      const groq = require('./groq');
      const r = await groq.summarize(text);
      if (r.ok) return { intent: 'summarize_text', summary: r.text, model: r.model };
      return { ok: false, intent: 'summarize_text', error: r.error || 'model-failed', reason: r.reason || null };
    } catch (e) {
      return { ok: false, intent: 'summarize_text', error: 'model-unavailable', reason: e.message };
    }
  },
  groq_chat: async (args = {}) => {
    try {
      const groq = require('./groq');
      const r = await groq.chat(args.messages || [{ role: 'user', content: String(args.prompt || 'hi') }]);
      if (r.ok) return { intent: 'groq_chat', text: r.text, model: r.model };
      return { intent: 'groq_chat', text: '', model: r.model, error: r.error, hint: r.hint };
    } catch (e) {
      return { intent: 'groq_chat', text: '', error: e.message };
    }
  },
  // The wiring probe. `bolo.workflowRun({ steps: [{ intent: 'echo', args: {text:'hi'} }] })`
  // is how the renderer proves the step runner reaches the dispatcher without
  // anything on the machine changing, which is why it is the one intent here
  // that does nothing.
  echo: async (args = {}) => ({ intent: 'echo', args })
};

async function run(intentName, args = {}) {
  const fn = intents[intentName];
  if (!fn) return { ok: false, error: 'unknown-intent', intent: intentName };
  try {
    const result = await fn(args);
    // A capability that refused is a failure, and the caller has to be able to
    // see that from `ok` alone — so its own `ok: false` wins over the wrapper's.
    if (result && result.ok === false) return { ...result, ok: false, intent: intentName };
    return { ok: true, intent: intentName, ...result };
  } catch (e) {
    return { ok: false, error: e.message, intent: intentName };
  }
}

function list() {
  return Object.keys(intents);
}

/* ── the voice path: transcript -> tool call -> execution ───────────────────
   `act` is the only intent that costs a model round trip, and this is where it
   is paid. The prompt is intent.js's desktop-agent prompt with the tool list
   appended here, so there is one description of what the agent is and the
   capabilities it can reach; agent.js supplies the list because it is the file
   that owns the dispatcher. */
const TOOLS = {
  open_app: '{ "name": "<app name, e.g. notepad, chrome, explorer, settings>" }',
  open_path: '{ "path": "<file, folder or http(s) URL the user named>" }',
  reveal_path: '{ "path": "<file or folder to show in Explorer>" }',
  edit_file: '{ "op": "read"|"write"|"append"|"replace", "path": "<path, relative to the user home folder>", "content"?: "<text>", "find"?: "<text>", "replace"?: "<text>", "all"?: true }',
  screenshot: '{ "display"?: <screen index, omit for the primary screen>, "save"?: "<optional path to save the PNG, inside the user home folder>" }',
  active_window: '{}'
};

const TOOL_SYSTEM = intent.ACT_SYSTEM + '\n\n' +
  'You do not carry the instruction out in prose — you choose ONE tool and its exact ' +
  'arguments, and this machine runs it. Reply with a single JSON object and nothing ' +
  'else:\n\n' +
  '{"tool": "<name>", "args": { ... }}\n\n' +
  'The tools:\n' +
  Object.keys(TOOLS).map((t) => '- ' + t + ' ' + TOOLS[t]).join('\n') + '\n\n' +
  'Rules:\n' +
  '- Use exactly one tool. Never invent a tool name or an argument that is not listed.\n' +
  '- Copy a path the user named verbatim; if they named none, use "args": {} rather than ' +
  'guessing one.\n' +
  '- If no tool fits — a question, a greeting, something you cannot do on this machine — ' +
  'reply with {"tool": "none", "args": {}}; the answer is then carried by the chat path.\n' +
  '- Output the JSON object only. No prose, no code fences, no explanation.';

function parseTool(reply) {
  const raw = String(reply || '');
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const tool = String(obj.tool || '').trim();
  // `none` is the model saying no tool fits. It is a valid answer, not a
  // parse failure, and it is kept distinct so the reply can list what this
  // machine can actually do rather than shrugging.
  if (tool === 'none') return { tool: 'none', args: {} };
  if (!Object.prototype.hasOwnProperty.call(TOOLS, tool)) return null;
  const args = obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args) ? obj.args : {};
  return { tool, args };
}

// What actually happened, in one spoken line. Every branch is driven by the
// result object — there is no path through here that says something worked
// when it did not.
function sayFor(tool, args, result) {
  const base = (p) => String(p || '').split(/[\\/]/).pop() || String(p || '');
  const err = String((result && result.error) || '');

  if (err === 'not-permitted') {
    const what = result.capability === 'edit_file'
      ? 'change files'
      : (result.capability === 'screenshot' ? 'take screenshots' : 'open things');
    return 'I\'m not allowed to ' + what + ' — that switch is off in Settings, under Context Awareness.';
  }
  if (!result || result.ok === false) {
    switch (err) {
      case 'not-found':
        return tool === 'open_app'
          ? 'I couldn\'t find an app called ' + (args.name || args.app || 'that') + '.'
          : 'I couldn\'t find ' + (result.path || args.path || 'that') + '.';
      case 'needs-confirmation':
        return base(result.path) + ' already exists. I won\'t overwrite it without you confirming — ask me to do it again and say that you mean it.';
      case 'outside-home':
      case 'outside-home-after-symlink':
        return 'I only touch files inside your own home folder, and that one is outside it.';
      case 'refused-unc-path':
      case 'refused-device-path':
        return 'I won\'t open that kind of path.';
      case 'too-large':
        return 'That file is too big for me to handle safely.';
      case 'empty-path':
      case 'no-app-named':
        return 'Tell me which one, and I\'ll do it.';
      case 'no-match':
        return 'I couldn\'t find that text in ' + base(result.path) + '.';
      case 'is-a-directory':
        return base(result.path) + ' is a folder, not a file.';
      case 'no-such-display':
        return 'There is no screen ' + args.display + ' on this machine.';
      case 'no-thumbnail':
        return 'The screen capture came back empty — Windows refused it.';
      case 'timeout':
        return 'That took too long, so I stopped.';
      case 'unknown-op':
        return 'I can read, write, append to or replace text in a file — not that.';
      default:
        return 'That didn\'t work' + (err ? ' (' + err + ')' : '') + '.';
    }
  }

  switch (tool) {
    case 'open_app':
      return 'Opened ' + (result.app || args.name || 'it') + '.';
    case 'open_path':
      return 'Opened ' + base(result.opened || args.path) + '.';
    case 'reveal_path':
      return 'Showed ' + base(result.revealed || args.path) + ' in Explorer.';
    case 'edit_file':
      if (result.op === 'read') {
        return base(result.path) + ' — ' + result.lines + ' lines, ' + result.bytes + ' bytes.';
      }
      if (result.op === 'replace') {
        return 'Replaced ' + result.replaced + ' in ' + base(result.path) + '.';
      }
      return (result.created ? 'Created ' : 'Wrote ') + base(result.path) + ' — ' + result.bytes + ' bytes.';
    case 'screenshot':
      return 'Took a screenshot — ' + result.width + ' by ' + result.height +
        (result.saved ? ', saved to ' + base(result.saved) : '') + '.';
    case 'active_window':
      if (!result.title && !result.owner) return 'I couldn\'t tell which window is in front.';
      return 'You\'re in ' + (result.owner || 'an app') + (result.title ? ' — ' + result.title : '') + '.';
    default:
      return 'Done.';
  }
}

// transcript -> { ok, tool, args } or a refusal with a line to say.
async function planTool(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return { ok: false, error: 'empty-transcript', say: 'I didn\'t catch that.' };

  let groq;
  try {
    groq = require('./groq');
  } catch (e) {
    return { ok: false, error: 'no-model', say: 'I can\'t reach the model right now.' };
  }

  let r;
  try {
    // temperature 0 and a small ceiling: this call is meant to emit one small
    // JSON object, and a chatty answer is a parsing failure waiting to happen.
    r = await groq.chat([
      { role: 'system', content: TOOL_SYSTEM },
      { role: 'user', content: text }
    ], { maxTokens: 300, temperature: 0 });
  } catch (e) {
    return { ok: false, error: 'model-failed', say: 'I can\'t reach the model right now.' };
  }

  if (!r || !r.ok) {
    const e = String((r && r.error) || 'unknown');
    return {
      ok: false,
      error: e,
      say: e === 'no-keys'
        ? 'I need a Groq key before I can do things for you — add one in Settings.'
        : 'I can\'t reach the model right now, so I won\'t guess.'
    };
  }

  const parsed = parseTool(r.text);
  if (!parsed) {
    return { ok: false, error: 'unparsed-tool-call', say: 'I\'m not sure how to do that one yet.' };
  }
  if (parsed.tool === 'none') {
    return {
      ok: false,
      error: 'no-tool-fit',
      say: 'That isn\'t something I can do from here. I can open apps and files, read or ' +
        'change files in your home folder, take a screenshot, and tell you which window is ' +
        'in front. For anything else, ask me and I\'ll answer.'
    };
  }
  return { ok: true, tool: parsed.tool, args: parsed.args };
}

// Actions that destroy data. These are not run on the spoken command alone —
// the caller stages them and asks the user to confirm (say "yes", or click
// Confirm on the notch) before they run. Everything else runs straight away.
// `edit_file` is critical only when it writes.
const CRITICAL = new Set([]);

function isCritical(tool, args) {
  if (CRITICAL.has(tool)) return true;
  if (tool === 'edit_file') {
    const op = String((args && args.op) || 'write').toLowerCase();
    return op === 'write' || op === 'append' || op === 'replace';
  }
  return false;
}

// A short, human line naming what is about to happen — shown on the confirm card
// and spoken as "About to …, say yes to go ahead." Kept deliberately terse.
function describeAction(tool, args) {
  args = args || {};
  const base = (p) => String(p || '').split(/[\\/]/).pop() || String(p || '');
  switch (tool) {
    case 'edit_file':
      return 'Write to ' + base(args.path || 'a file');
    default:
      return 'Do that';
  }
}

// Execute a planned tool and describe what happened. This is the half of the old
// act() that actually runs — split out so a confirmed action (email, calendar,
// delete, file write) can be run later, after the user has said yes.
async function runPlanned(tool, args) {
  // A confirmed file write carries the confirmation capabilities.editFile needs
  // to overwrite; the agent path never sets it from a raw transcript, so it is
  // set here now that the user has explicitly confirmed.
  const a = tool === 'edit_file' ? { ...args, confirmed: true } : args;
  const result = await run(tool, a);
  return { ...result, tool, args: a, say: sayFor(tool, a, result) };
}

// When no tool fits, the instruction was almost always a QUESTION, not a command
// — "how does X work", "what's the capital of France". Agent mode used to recite
// its capability list at those, which reads as "I only do things, I don't think".
// Answer them as bolo instead, crisply.
async function answer(transcript) {
  let groq;
  try { groq = require('./groq'); } catch (_) { return { ok: false }; }
  try {
    const r = await groq.chat([
      { role: 'system', content: intent.ANSWER_SYSTEM },
      { role: 'user', content: transcript }
    ], { maxTokens: 300, temperature: 0.3 });
    if (r && r.ok && r.text && r.text.trim()) return { ok: true, text: r.text.trim() };
  } catch (_) {}
  return { ok: false };
}

// The whole act path: plan, then either run straight away or — for a critical
// action — hand back a `pending` decision for the caller to confirm and run.
async function act(transcript) {
  const plan = await planTool(transcript);
  if (!plan.ok) {
    // No tool fit = a question. Answer it rather than reciting what bolo can do.
    if (plan.error === 'no-tool-fit') {
      const ans = await answer(transcript);
      if (ans.ok) return { ok: true, tool: null, say: ans.text };
    }
    return { ok: false, error: plan.error, tool: null, say: plan.say };
  }

  if (isCritical(plan.tool, plan.args)) {
    const summary = describeAction(plan.tool, plan.args);
    return {
      ok: true,
      pending: true,
      tool: plan.tool,
      args: plan.args,
      summary,
      say: summary + '. Say yes to go ahead, or no to cancel.'
    };
  }

  return runPlanned(plan.tool, plan.args);
}

module.exports = {
  run,
  runPlanned,
  list,
  act,
  planTool,
  parseTool,
  sayFor,
  isCritical,
  describeAction,
  TOOL_SYSTEM,
  TOOLS
};