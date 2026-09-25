// Playing speech that main synthesised.
//
// Main has the Deepgram key, so it does the synthesis and hands a renderer the
// finished MP3 bytes; a renderer owns the only thing that can actually make a
// sound. This is the small amount of code between those two facts, shared by the
// notch (which speaks replies) and the intro (which speaks its narration) so the
// ceiling and the cleanup cannot drift apart between them.
//
// Loaded as a plain script, exposing `window.boloAudio`. It must be loaded
// before the page's own script.

(function () {
  let current = null; // the <audio> that is playing, if any
  let pending = null; // the finish() of the clip on screen, so stop() can end it now

  function release(audio, url) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (current === audio) current = null;
  }

  // Stop whatever is speaking. Called before starting a new line: two replies
  // overlapping is worse than one being cut off.
  //
  // It also settles the paused clip's promise, which matters more than it looks:
  // a paused <audio> never fires `ended`, so without this the caller that awaited
  // it — the intro, which sequences its lines one after the other — would sit
  // until that clip's ceiling timer, seconds later, for a line it already knows is
  // over. Interrupting narration must not read as a stall.
  function stop() {
    if (live) { cancelStream('stopped'); return; }
    const audio = current;
    if (!audio) return;
    current = null;
    try { audio.pause(); } catch (_) {}
    try { URL.revokeObjectURL(audio.src); } catch (_) {}
    const settle = pending;
    pending = null;
    if (settle) settle('stopped');
  }

  // Estimated speaking time from the byte count. MP3 at ~48 kbps mono, which is
  // what Deepgram returns; the extra seconds are slack so the ceiling only ever
  // catches a decoder that genuinely never fires `ended`.
  function estimateMs(bytes) {
    return Math.max(6000, Math.round((bytes.length * 8) / 48) + 3000);
  }

  // Play one clip. Resolves — never rejects — with { ok, reason }, because a
  // caller that is sequencing narration must not be left hanging by audio that
  // failed to decode. `reason` is 'ended' on a clean finish.
  //
  // `opts.onStart` fires once, the moment the audio actually begins. The intro
  // needs it: it reveals a line word by word and must not start revealing until
  // the voice does, or the words finish long before the sentence is over.
  function play(bytes, mime, opts) {
    stop();

    return new Promise((resolve) => {
      let audio;
      let url;
      let settled = false;
      let began = false;
      let ceiling = null;

      function finish(reason, extra) {
        if (settled) return;
        settled = true;
        if (ceiling) clearTimeout(ceiling);
        if (pending === finish) pending = null;
        release(audio, url);
        resolve({ ok: reason === 'ended', reason, ...(extra || {}) });
      }

      // Registered before anything can call stop(): an interruption has to be
      // able to reach this clip's `finish`.
      pending = finish;

      function onStart() {
        // `playing` fires again after every pause/resume, so it is latched.
        if (began) return;
        began = true;
        try { if (opts && opts.onStart) opts.onStart(); } catch (_) {}
      }

      try {
        if (!bytes || !bytes.length) return finish('empty');
        const blob = new Blob([bytes], { type: mime || 'audio/mpeg' });
        url = URL.createObjectURL(blob);
        audio = new Audio();
        audio.preload = 'auto';
        audio.src = url;
        current = audio;

        audio.onplaying = onStart;
        audio.onended = () => finish('ended');
        audio.onerror = () => finish('error');
        ceiling = setTimeout(() => finish('timeout'), estimateMs(bytes));

        const started = audio.play();
        if (started && typeof started.catch === 'function') {
          // Autoplay policy, or no audio device. Both are worth reporting rather
          // than swallowing: this is the difference between "muted" and "broken".
          started.catch((e) => finish('blocked', { error: String((e && e.message) || e) }));
        }
      } catch (e) {
        finish('error', { error: String((e && e.message) || e) });
      }
    });
  }

  // The clip's real length, read from the decoder rather than estimated from the
  // byte count. Deepgram's MP3 carries its duration in the header, and the intro
  // paces its word-by-word reveal against this — the words have to land *with*
  // the voice, and a fixed step is only right for one speaking rate.
  //
  // Metadata only: nothing is played and the object URL goes straight back.
  // Resolves { ms: 0 } instead of rejecting, so a decoder that never reports a
  // duration costs a caller a fallback estimate and never a stalled beat.
  function meta(bytes, mime) {
    return new Promise((resolve) => {
      if (!bytes || !bytes.length) return resolve({ ms: 0 });
      let audio = null;
      let url = null;
      let settled = false;
      let ceiling = null;

      function finish(ms) {
        if (settled) return;
        settled = true;
        if (ceiling) clearTimeout(ceiling);
        try { if (audio) audio.src = ''; } catch (_) {}
        if (url) { try { URL.revokeObjectURL(url); } catch (_) {} }
        resolve({ ms: Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0 });
      }

      ceiling = setTimeout(() => finish(0), 1800);
      try {
        url = URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
        audio = new Audio();
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => finish((audio.duration || 0) * 1000);
        audio.onerror = () => finish(0);
        audio.src = url;
      } catch (_) { finish(0); }
    });
  }

  // Ask main to say something, then play it. Used by the intro, which wants a
  // line spoken but does not care where the bytes come from.
  //
  // Returns { ok: false, reason: 'muted' | 'unavailable' | ... } rather than
  // throwing, so a caller can fall back to another voice (the intro falls back to
  // the platform synthesiser) without a try/catch around it.
  async function say(text, opts) {
    if (!window.bolo || !window.bolo.speak) return { ok: false, reason: 'unavailable' };
    try {
      const r = await window.bolo.speak({ text: text, voice: opts && opts.voice });
      if (!r || !r.ok) return { ok: false, reason: (r && r.error) || 'unavailable' };
      const played = await play(r.audio, r.mime, opts);
      return { ...played, voice: r.voice, cached: !!r.cached };
    } catch (e) {
      return { ok: false, reason: 'error', error: String((e && e.message) || e) };
    }
  }

  /* ── Streaming playback ────────────────────────────────────────────────────
     A reply plays while it is still being generated. Deepgram returns MP3 with
     no length known up front, and an <audio> pointed at a URL can only play a
     file whose length it knows — so the chunks go into a MediaSource, which is
     the only thing that can play a stream of unknown length. Playback starts the
     moment the first chunk is appended, which is the whole point: the voice used
     to wait for the last word of the reply before saying the first one.

     Main drives this entirely (bolo:speak-begin / -chunk / -end / -cancel), so
     no caller has to opt in — a window that can play audio just does.
     ------------------------------------------------------------------------- */
  let live = null; // the stream in flight, if any

  // The notch holds its auto-hide open until the voice stops, so every path that
  // ends a stream has to say so — a missed `false` leaves the reply stuck on
  // screen, and a missed `true` lets it vanish mid-sentence.
  // Local subscribers that want to know when a streamed reply starts and stops
  // speaking — the notch uses this to reveal its text letter-by-letter in time
  // with the voice, and to hold a spinner until the voice begins. Separate from
  // the `notchSpeaking` IPC (which tells MAIN to hold the capsule open): this is
  // in-renderer and costs nothing when there are no subscribers.
  const speakingSubs = [];
  function onSpeaking(cb) { if (typeof cb === 'function') speakingSubs.push(cb); }
  function fireSpeaking(on) {
    for (const cb of speakingSubs) { try { cb(!!on); } catch (_) {} }
  }

  function noteSpeaking(on) {
    try { if (window.bolo && window.bolo.notchSpeaking) window.bolo.notchSpeaking(!!on); } catch (_) {}
    fireSpeaking(on);
  }

  function teardown(s, reason) {
    if (!s || s.done) return;
    s.done = true;
    if (live === s) live = null;
    if (s.timer) clearTimeout(s.timer);
    try { s.audio.pause(); s.audio.src = ''; } catch (_) {}
    if (s.url) { try { URL.revokeObjectURL(s.url); } catch (_) {} }
    if (current === s.audio) current = null;
    noteSpeaking(false);
    if (typeof s.onDone === 'function') { try { s.onDone(reason); } catch (_) {} }
  }

  // Append what is queued. SourceBuffer.appendBuffer throws if it is called while
  // `updating`, and a throw mid-reply would cost the rest of the sentence — so
  // every chunk goes through this queue and never straight at the buffer.
  function drain(s) {
    if (s.done || !s.sb || s.sb.updating) return;
    if (s.queue.length) {
      const next = s.queue.shift();
      try {
        s.sb.appendBuffer(next);
        // Start on the first append, not on the first arrival: an <audio> asked
        // to play with nothing buffered just stops again.
        if (!s.started) {
          s.started = true;
          const p = s.audio.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (_) {
        s.queue.length = 0;
      }
      return;
    }
    if (s.ended) {
      if (s.bytes === 0) return teardown(s, 'empty');
      try { s.ms.endOfStream(); } catch (_) {}
    }
  }

  function beginStream(payload) {
    if (live) teardown(live, 'superseded');
    if (typeof window.MediaSource !== 'function') return null;

    const s = {
      id: payload && payload.id,
      goal: null, audio: null, url: null, ms: null, sb: null,
      queue: [], bytes: 0, started: false, ended: false, done: false,
      timer: null, onDone: null
    };

    try {
      s.audio = new Audio();
      s.audio.preload = 'auto';
      s.ms = new window.MediaSource();
      s.url = URL.createObjectURL(s.ms);
      s.audio.src = s.url;
    } catch (_) {
      teardown(s, 'error');
      return null;
    }

    live = s;
    current = s.audio;

    s.ms.addEventListener('sourceopen', () => {
      try {
        s.sb = s.ms.addSourceBuffer('audio/mpeg');
        s.sb.addEventListener('updateend', () => drain(s));
        drain(s);
      } catch (_) {
        teardown(s, 'error');
      }
    }, { once: true });

    s.audio.onplaying = () => noteSpeaking(true);
    s.audio.onended = () => teardown(s, 'ended');
    s.audio.onerror = () => teardown(s, 'error');
    // A provider that dies mid-reply would otherwise leave the capsule open
    // forever; the ceiling is refreshed on every chunk, so it can only ever catch
    // a stream that genuinely stopped.
    s.timer = setTimeout(() => teardown(s, 'timeout'), 90000);
    return s;
  }

  function pushStream(id, bytes) {
    const s = live;
    if (!s || (id && s.id !== id) || s.done) return;
    try { s.queue.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch (_) {}
    s.bytes += 1;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => teardown(s, 'timeout'), 90000);
    drain(s);
  }

  function endStream(id) {
    const s = live;
    if (!s || (id && s.id !== id)) return;
    s.ended = true;
    drain(s);
  }

  function cancelStream(reason) {
    teardown(live, reason || 'cancelled');
  }

  function subscribe() {
    const b = window.bolo;
    if (!b || typeof b.on !== 'function') return;
    b.on('bolo:speak-begin', (p) => beginStream(p));
    b.on('bolo:speak-chunk', (p) => { if (p) pushStream(p.id, p.bytes); });
    b.on('bolo:speak-end', (p) => endStream(p && p.id));
    b.on('bolo:speak-cancel', () => cancelStream('cancelled'));
  }

  // Never allowed to throw: everything below this line is the player every
  // surface uses, so a subscription that failed would take the whole of
  // `window.boloAudio` with it and read as "the app has no voice".
  try { subscribe(); } catch (_) {}

  window.boloAudio = {
    play, say, stop, meta,
    isSpeaking: () => !!(live && !live.done) || !!current,
    streaming: () => !!(live && !live.done),
    // Fires (true) when a streamed reply begins speaking and (false) when it
    // ends — the hook the notch uses to pace its letter-by-letter reveal.
    onSpeaking,
    cancelStream
  };
})();