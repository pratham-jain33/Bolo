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
// `demo_echo` used to live here — it existed to prove the step runner reached
// the dispatcher, which these do too, while also being worth running.
const samples = {
  morning_brief: {
    name: 'morning_brief',
    description: 'What is in front of you, what is unread, and what is next.',
    steps: [
      { intent: 'active_window', args: {} },
      { intent: 'list_unread', args: { limit: 3 } },
      { intent: 'next_event', args: {} }
    ]
  },
  find_and_show: {
    name: 'find_and_show',
    description: 'Find a file by name and show it in Explorer.',
    // Two steps with an argument carried between them is the thing a workflow is
    // *for*; `{{ }}` in a later version, spelled out here as the shape it takes.
    steps: [
      { intent: 'find_file', args: { query: 'invoice' } },
      { intent: 'recent_files', args: { limit: 5 } }
    ]
  }
};

module.exports = { runWorkflow, samples };
