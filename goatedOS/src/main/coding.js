const { execFile } = require('child_process');

// Original thin wrappers around your own CLIs. No bolo coding agents.
// Configure command names in settings later; stubs report missing-binary.
function runCli(bin, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeoutMs || 60000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, bin, error: error.message, stdout: String(stdout || '').slice(0, 2000), stderr: String(stderr || '').slice(0, 2000) });
        return;
      }
      resolve({ ok: true, bin, stdout: String(stdout || '').slice(0, 4000), stderr: String(stderr || '').slice(0, 2000) });
    });
  });
}

async function runClaudeCode(prompt) {
  return runCli('claude', ['--print', String(prompt || '')]);
}

async function runCodex(prompt) {
  return runCli('codex', ['exec', String(prompt || '')]);
}

module.exports = { runCli, runClaudeCode, runCodex };
