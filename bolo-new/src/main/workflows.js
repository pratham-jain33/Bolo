const agent = require('./agent');

// Original JSON workflow runner: { steps: [{ intent, args }] }.
async function runWorkflow(def) {
  const steps = (def && def.steps) || [];
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const r = await agent.run(s.intent, s.args || {});
    results.push({ index: i, intent: s.intent, result: r });
    if (!r.ok && def && def.stopOnError !== false) break;
  }
  return { ok: true, steps: results.length, results };
}

// Worked examples, shown in the workflows editor as a starting point. They are
// deliberately read-only: a sample a user clicks to see what a workflow looks
// like must not open an app, write a file or send an email on their behalf.
const samples = {
  screen_context: {
    name: 'screen_context',
    description: 'What is in front of you, right now.',
    steps: [
      { intent: 'active_window', args: {} },
      { intent: 'screenshot', args: {} }
    ]
  },
  open_and_capture: {
    name: 'open_and_capture',
    description: 'Open an app and take a screenshot of it.',
    steps: [
      { intent: 'open_app', args: { name: 'notepad' } },
      { intent: 'screenshot', args: {} }
    ]
  }
};

module.exports = { runWorkflow, samples };
