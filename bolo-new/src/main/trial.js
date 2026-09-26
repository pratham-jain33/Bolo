// Bolo Doctor trial mode: baked keys + a per-computer dictation cap.
//
// The trial build is produced by the build-trial workflow, which generates two
// gitignored files before packaging:
//   - src/main/seed-keys.js      (the API keys; the existing seed mechanism applies them)
//   - src/main/trial-config.json ({ trial: true, capMinutes: N })
//
// The cap is "per computer": the machine ID is derived from stable hardware
// identifiers — never the IP address. Every machine on a clinic's WiFi shares
// one public IP (three computers would share one quota), and IPs change
// constantly on mobile networks (one machine could dodge the cap). A hardware
// UUID survives reinstalls and identifies the actual computer.
// Usage accumulates real recorded milliseconds and is enforced in voice.toggle
// before a recording can start, so it also covers the global shortcut path.

const { app } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function trialConfig() {
  try {
    const cfg = require('./trial-config.json');
    if (cfg && cfg.trial === true) return cfg;
  } catch (_) { /* not a trial build: the file is gitignored and absent */ }
  return null;
}

function isTrial() {
  return trialConfig() !== null;
}

function capMs() {
  const cfg = trialConfig();
  const minutes = cfg && Number(cfg.capMinutes) > 0 ? Number(cfg.capMinutes) : 5;
  return Math.round(minutes * 60 * 1000);
}

// Stable per-computer ID. WMIC's UUID survives reinstalls; the registry
// MachineGuid is the fallback; the hostname is the last resort.
let cachedMachineId = null;
function machineId() {
  if (cachedMachineId) return cachedMachineId;
  try {
    const out = execFileSync('wmic', ['csproduct', 'get', 'uuid'],
      { timeout: 8000, windowsHide: true }).toString();
    const m = out.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (m) {
      cachedMachineId = 'wmic:' + m[0].toLowerCase();
      return cachedMachineId;
    }
  } catch (_) { /* fall through */ }
  try {
    const out = execFileSync('reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: 8000, windowsHide: true }).toString();
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    if (m) {
      cachedMachineId = 'reg:' + m[1].toLowerCase();
      return cachedMachineId;
    }
  } catch (_) { /* fall through */ }
  cachedMachineId = 'host:' + os.hostname();
  return cachedMachineId;
}

function usageFile() {
  return path.join(app.getPath('userData'), 'trial-usage.json');
}

function readUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    if (u && u.machineId === machineId() && Number(u.usedMs) >= 0) {
      return { machineId: u.machineId, usedMs: Number(u.usedMs) };
    }
  } catch (_) { /* missing or corrupt: start fresh */ }
  return { machineId: machineId(), usedMs: 0 };
}

function writeUsage(usedMs) {
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(),
      JSON.stringify({ machineId: machineId(), usedMs }), 'utf8');
  } catch (_) { /* bookkeeping must never break the app */ }
}

function status() {
  if (!isTrial()) return { trial: false };
  const cap = capMs();
  const { usedMs } = readUsage();
  const remaining = Math.max(0, cap - usedMs);
  return {
    trial: true,
    capMs: cap,
    usedMs,
    remainingMs: remaining,
    exhausted: remaining <= 0
  };
}

function canStart() {
  const s = status();
  return !s.trial || !s.exhausted;
}

// Record the milliseconds of a finished dictation against the cap. Counts
// even when transcription failed — the recording (and the STT attempt) happened.
function addUsage(ms) {
  if (!isTrial()) return;
  const n = Number(ms);
  if (!(n > 0)) return;
  const { usedMs } = readUsage();
  writeUsage(usedMs + Math.round(n));
}

module.exports = { isTrial, capMs, machineId, status, canStart, addUsage };
