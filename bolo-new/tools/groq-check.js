/* Throwaway: prove the two Groq keys authenticate and that the configured model
   IDs are real. Reads keys from the app's own store so no key is ever written
   into a source file. Not part of the app — tools/ is not in the build `files`
   list, so nothing here ships.

   Usage: ./node_modules/.bin/electron tools/groq-check.js   (or plain node) */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS = 'https://api.groq.com/openai/v1/models';
const STT = 'https://api.groq.com/openai/v1/audio/transcriptions';

const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen/qwen3.8-27b';
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3-turbo';

const storeFile = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'bolo', 'bolo-keys.json'
);

const keys = (JSON.parse(fs.readFileSync(storeFile, 'utf8')).keys) || [];
const mask = (k) => (k ? k.slice(0, 7) + '…' + k.slice(-4) : '(none)');

// A valid 16-bit mono PCM WAV of a quiet sine, so the transcription endpoint
// gets real decodable audio rather than a byte blob it can only reject.
function makeWav(seconds = 1.5, rate = 16000, freq = 220) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000);
    data.writeInt16LE(v, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function listModels(key) {
  const r = await fetch(MODELS, { headers: { authorization: 'Bearer ' + key } });
  if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 200) };
  const j = await r.json();
  return { ok: true, ids: (j.data || []).map((m) => m.id) };
}

async function chatOnce(key) {
  const r = await fetch(CHAT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 12, temperature: 0
    })
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
}

async function transcribeOnce(key) {
  const wav = makeWav();
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
  fd.append('model', STT_MODEL);
  fd.append('response_format', 'json');
  const r = await fetch(STT, { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: fd });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
}

(async () => {
  console.log('store   :', storeFile);
  console.log('keys    :', keys.length, keys.map(mask).join(', '));
  console.log('chat    :', CHAT_MODEL);
  console.log('stt     :', STT_MODEL);
  console.log('');

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    console.log('=== key ' + (i + 1) + '  ' + mask(k));

    const m = await listModels(k);
    if (!m.ok) {
      console.log('  models  : FAIL ' + m.status + ' ' + m.body);
    } else {
      console.log('  models  : ok, ' + m.ids.length + ' available');
      console.log('    chat id present : ' + m.ids.includes(CHAT_MODEL) +
        (m.ids.includes(CHAT_MODEL) ? '' : '   <-- NOT IN LIST'));
      console.log('    stt  id present : ' + m.ids.includes(STT_MODEL) +
        (m.ids.includes(STT_MODEL) ? '' : '   <-- NOT IN LIST'));
      if (!m.ids.includes(CHAT_MODEL)) {
        const qwen = m.ids.filter((x) => /qwen/i.test(x));
        console.log('    qwen ids on this account: ' + (qwen.length ? qwen.join(', ') : '(none)'));
      }
      if (!m.ids.includes(STT_MODEL)) {
        const w = m.ids.filter((x) => /whisper/i.test(x));
        console.log('    whisper ids on this account: ' + (w.length ? w.join(', ') : '(none)'));
      }
    }

    const c = await chatOnce(k);
    console.log('  chat    : ' + (c.ok ? 'ok' : 'FAIL ' + c.status) + '  ' + c.body.replace(/\s+/g, ' ').slice(0, 160));

    const t = await transcribeOnce(k);
    console.log('  stt     : ' + (t.ok ? 'ok' : 'FAIL ' + t.status) + '  ' + t.body.replace(/\s+/g, ' ').slice(0, 160));
    console.log('');
  }
})();
