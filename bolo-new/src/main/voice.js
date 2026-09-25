const audio = require('./audio');
const injector = require('./injector');
const duck = require('./duck');
const settings = require('./settings');
const modes = require('./modes');
const intent = require('./intent');
const context = require('./context');
const history = require('./history');
const stt = require('./stt');
const sttSarvam = require('./stt_sarvam');
const keys = require('./keys');
const agent = require('./agent');

// Voice state machine: idle -> listening -> routing -> idle.
//
// There is one entry point. Nothing here asks the user which mode they wanted;
// a finished transcript goes to intent.js, which decides whether it was text to
// type, a question to answer, something to rewrite, or a job to do. See that
// file for the two-stage design and why the heuristic is allowed to guess only
// in the direction that cannot damage anyone's document.
//
// `handsFree` is not an intent — it is a flag set when the key was double-tapped
// (main.js). It changes only the label shown on the notch; the loop underneath
// is the same toggle either way, because globalShortcut is press-only and cannot
// see the key release that true hold-to-talk would need.
//
// transcriptionEnabled=false is the external-STT escape hatch: capture UI and
// context only, skip the inbuilt transcribe and skip auto-inject, so another
// tool owning the key handles speech-to-text itself.

let state = 'idle';
let lastTranscript = null;
let lastDecision = null;
let handsFree = false;
// Which activation key started this session: 'dictation' | 'edit' | 'agent' |
// null. Captured at listen-start and read at routing time so that stopping the
// session (which can be triggered by any of the three keys) routes by the mode
// the session BEGAN in, not by whichever key happened to stop it. null means the
// plain voice path / wake word, which still infers the intent.
let sessionMode = null;

// Doctor Mode sessions are flagged the same way: set when the session starts
// (from the doctor window or its shortcut), read when it stops. A doctor
// session skips the router and the injector entirely — the transcript goes
// back to the doctor window for templating, and the doctor pastes the note.
let sessionDoctor = false;

// A critical action (send an email, create or delete a calendar event, overwrite
// a file) is not run on the spoken command alone. It is staged here and only
// carried out once the user confirms — by clicking Confirm on the notch, or by
// saying "yes" on the very next utterance. Cleared on resolve or after a timeout,
// so a forgotten confirm can never fire later.
let pending = null;
let pendingTimer = null;

// Onboarding demo mode: during the dictation/edit demo steps a transcript is
// routed back to the dashboard's own textarea instead of being pasted into the
// foreground app. Set by main.js from the bolo:ob-demo-start/end handlers.
// The `emit` passed into toggle() already reaches main (via broadcastAll), so
// the demo redirect rides bolo:ob-demo-result — no circular require needed.
let demoMode = false;
function setDemoMode(on) { demoMode = !!on; }

const YES = /\b(yes|yeah|yep|yup|confirm|confirmed|do it|send it|send|go ahead|go for it|sure|ok|okay|please do|affirmative)\b/i;
function isYes(text) { return YES.test(String(text || '')); }

function stagePending(action) {
  pending = action;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { pending = null; pendingTimer = null; }, 25000);
}

function clearPending() {
  pending = null;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
}

function hasPending() { return !!pending; }

// Run or discard the staged action. Called both by the notch Confirm/Cancel
// buttons (through main) and by the spoken yes/no path inside toggle(). A "no",
// or anything that is not clearly a yes, cancels — the safe direction.
async function resolvePending(emit, yes) {
  const p = pending;
  clearPending();
  if (!p) return { ok: false, error: 'no-pending' };
  if (!yes) {
    emit('bolo:notch', {
      phase: 'reply', intent: 'act', label: modes.intentLabel('act'),
      text: 'Okay, cancelled.', instant: true, tool: p.tool, ok: false
    });
    emit('bolo:answer', { intent: 'act', ok: false, text: 'Okay, cancelled.', tool: p.tool, cancelled: true });
    return { ok: true, cancelled: true, tool: p.tool };
  }
  const done = await agent.runPlanned(p.tool, p.args);
  const said = done.say || (done.ok ? 'Done.' : 'That didn\'t work.');
  emit('bolo:notch', {
    phase: 'reply', intent: 'act', label: modes.intentLabel('act'),
    transcript: p.summary, text: said, tool: done.tool || null, ok: !!done.ok
  });
  emit('bolo:answer', {
    intent: 'act', ok: !!done.ok, text: said, tool: done.tool || null,
    args: done.args || null, error: done.error || undefined
  });
  return done;
}

function getState() {
  return {
    state,
    intent: lastDecision ? lastDecision.intent : null,
    intentLabel: lastDecision ? modes.intentLabel(lastDecision.intent) : null,
    handsFree,
    listening: audio.isListening(),
    transcriptionEnabled: settings.get('transcriptionEnabled'),
    injectionEnabled: settings.get('injectionEnabled'),
    autoPasteAnswers: settings.get('autoPasteAnswers'),
    ducked: duck.isDucked(),
    // What the microphone is actually doing, for Settings and for diagnosing a
    // "the key works but nothing gets typed" report without a log file.
    mic: audio.getState(),
    lastTranscript: lastTranscript ? lastTranscript.text : null
  };
}

function getLastTranscript() {
  return lastTranscript;
}

function getLastDecision() {
  return lastDecision;
}

// A double-tap that lands while a session the first tap just started is still
// listening promotes it to hands-free in place, rather than toggling it off.
// Returns whether there was a live session to promote.
function markHandsFree() {
  if (state === 'listening') { handsFree = true; return true; }
  return false;
}

function isHandsFree() {
  return handsFree;
}

// A microphone failure has to say which failure it was. "It didn't work" is a
// support ticket; "Windows is blocking the microphone" is something the user can
// fix in ten seconds. The error names come from getUserMedia.
function micMessage(result) {
  const name = (result && result.name) || '';
  const stage = (result && result.stage) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone blocked — allow bolo in Windows privacy settings';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone found';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is in use by another app';
  }
  if (stage === 'timeout') return 'The microphone did not open';
  return 'Microphone unavailable';
}

// Same idea for the transcription round trip: a rate-limited key and a rejected
// key need different responses from the user, and both look identical if all the
// notch ever says is "failed".
function sttMessage(result) {
  const err = String((result && result.error) || '');
  const provider = result && result.mode === 'sarvam-saaras' ? 'Sarvam' : 'Groq';
  if (err === 'no-keys') return 'No ' + provider + ' key — add one in Settings';
  if (err === 'timeout') return 'Transcription timed out';
  if (err.startsWith('http-401') || err.startsWith('http-403')) return provider + ' rejected the key';
  if (err.startsWith('http-429')) return 'Rate limited — every ' + provider + ' key is cooling down';
  if (err.startsWith('http-')) return 'Transcription failed (' + err.split(':')[0] + ')';
  return 'Transcription failed';
}

// Provider routing for transcription. Groq Whisper stays the default and the
// English path; Sarvam Saaras is used when the setting says so, or in 'auto'
// when a Sarvam key exists. A clip Sarvam cannot take — a webm longer than its
// ~30s per-request limit with no WAV to split — falls back to Groq rather than
// failing the dictation, because a Whisper transcript of a long note beats no
// transcript. An explicit 'sarvam' choice with no key is surfaced, not
// silently swapped, so the missing key is discoverable in Settings.
async function transcribeWithProvider(clip) {
  const groqOpts = { mime: clip.mime, language: settings.get('defaultLanguage') };
  const pref = settings.get('sttProvider') || 'groq';
  // Doctor sessions prefer Sarvam (Hindi/Hinglish) whenever a key exists; the
  // explicit setting and 'auto' behave as before.
  const wantSarvam = pref === 'sarvam'
    || (sessionDoctor && keys.has('sarvam'))
    || (pref === 'auto' && keys.has('sarvam'));
  if (!wantSarvam) return stt.transcribe(clip.buffer, groqOpts);

  const r = await sttSarvam.transcribe(clip.buffer, {
    mime: clip.mime,
    ms: clip.ms,
    wav16k: clip.wav16k
  });
  if (r.ok) return r;
  if (r.error === 'too-long') return stt.transcribe(clip.buffer, groqOpts);
  if (r.error === 'no-keys' && (pref === 'auto' || sessionDoctor)) return stt.transcribe(clip.buffer, groqOpts);
  return r;
}

// Stop the microphone and turn what it heard into text.
//
// Always resolves to a transcript-shaped object. A failure comes back with empty
// text and `error` set, which is what makes the caller's `if (transcript.text)`
// guard skip the router — and the notch has already been told what went wrong,
// so nothing fails silently.
//
// There used to be a local stub echo here. The real call is transcribeWithProvider
// above: Groq's whisper-large-v3-turbo by default, Sarvam's Saaras when the
// sttProvider setting (or a doctor session) asks for it.
async function transcribe(emit, clipPromise) {
  const clip = await clipPromise;

  if (!clip.ok || !clip.buffer || !clip.bytes) {
    emit('bolo:notch', { phase: 'error', text: micMessage(clip) });
    return { text: '', mode: 'no-audio', error: clip.error || 'empty-audio', bytes: 0 };
  }

  const r = await transcribeWithProvider(clip);

  if (!r.ok) {
    emit('bolo:notch', { phase: 'error', text: sttMessage(r) });
    return { ...r, text: '' };
  }

  return { ...r, bytes: clip.bytes, ms: clip.ms };
}

// Customize -> Replacements, applied to the transcript itself rather than to
// what gets typed: a replacement can be the thing that turns a sentence into a
// command ("scratch that" -> "rewrite this"), so it has to land before the
// router reads the words, not after.
//
// Whole-word and case-insensitive on `from`; the replacement is inserted
// verbatim. Boundaries are asserted with lookarounds rather than \b so a `from`
// that begins or ends in punctuation still matches.
function applyReplacements(text, list) {
  let out = String(text == null ? '' : text);
  if (!Array.isArray(list) || !out) return out;

  for (const r of list) {
    const from = r && typeof r.from === 'string' ? r.from.trim() : '';
    const to = r && typeof r.to === 'string' ? r.to : '';
    if (!from) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![\\w])' + escaped + '(?![\\w])', 'gi');
    out = out.replace(re, to);
  }
  return out;
}

// Everything the router needs to know about what is on screen right now.
// Gathered lazily: the plain-dictation fast path never calls this, so the
// common case pays nothing for it.
async function gatherContext() {
  try {
    return await context.getContext();
  } catch (e) {
    return { window: {}, selection: { text: '' }, clipboard: { text: '' }, error: e.message };
  }
}

function hasPayload(ctx) {
  return !!(ctx && ((ctx.selection && ctx.selection.text) ||
    (ctx.clipboard && ctx.clipboard.text)));
}

// decide() is the whole brain of the app: transcript in, {intent, text} out.
//
// The fast path matters more than it looks. Plain dictation is the commonest
// utterance by a wide margin, and it is the only one that must feel instant — a
// model round-trip before every sentence lands in someone's editor would make
// the app unusable for its main job. So when the heuristic says "this is just
// text", nothing else is consulted.
async function decide(transcript, emit, mode) {
  // A dedicated activation key fixes the intent — the user chose the mode, so
  // there is nothing to infer. Dictation types, Edit rewrites the selection,
  // Agent acts. Only Edit needs the on-screen context (the text to rewrite).
  if (mode) {
    if (mode !== 'edit') {
      const forced = await intent.forced(mode, transcript, null);
      if (forced) {
        emit('bolo:intent', {
          intent: forced.intent,
          label: modes.intentLabel(forced.intent),
          source: 'mode',
          mode,
          transcript
        });
        return forced;
      }
    } else {
      emit('bolo:notch', { phase: 'thinking', text: transcript, guess: 'edit' });
      const ctx = await gatherContext();
      const forced = await intent.forced('edit', transcript, ctx);
      if (forced) {
        emit('bolo:intent', {
          intent: forced.intent,
          label: modes.intentLabel(forced.intent),
          source: 'mode',
          mode,
          transcript
        });
        return forced;
      }
    }
    // Unknown mode: fall through to inference.
  }

  const quick = intent.classify(transcript, { hasPayload: false });

  if (quick.intent === 'insert') {
    return { intent: 'insert', text: transcript, source: 'heuristic', reason: quick.reason };
  }

  emit('bolo:notch', { phase: 'thinking', text: transcript, guess: quick.intent });

  const ctx = await gatherContext();
  // Re-run with the context known: a directive about "this" is only an edit if
  // there is actually something for "this" to be.
  const heuristic = intent.classify(transcript, { hasPayload: hasPayload(ctx) });
  const decision = await intent.route(transcript, ctx, heuristic);

  emit('bolo:intent', {
    intent: decision.intent,
    label: modes.intentLabel(decision.intent),
    source: decision.source || 'model',
    guess: decision.guess || heuristic.intent,
    transcript
  });

  return decision;
}

async function toggle({ broadcast, handsFree: hf, mode, doctor } = {}) {
  const emit = (ch, payload) => {
    if (typeof broadcast === 'function') broadcast(ch, payload);
  };

  // A press that lands mid-transcription is not a new session: starting one
  // here would interleave two record/transcribe cycles and the routed result
  // would belong to neither. Hold the press until the current one settles.
  if (state === 'routing') {
    return { ...getState(), busy: true };
  }

  if (state === 'listening') {
    // Stop, then transcribe the bytes as they settle. Releasing the microphone
    // first is what puts the OS indicator out, and it should not wait on a
    // network round trip. Called exactly once — a second audio.stop() would
    // supersede this promise and lose the clip.
    const clip = audio.stop();
    state = 'routing';
    emit('bolo:voice-level', { level: 0 });
    emit('bolo:voice-state', getState());

    const transcriptionOn = settings.get('transcriptionEnabled');
    const injectionOn = settings.get('injectionEnabled');
    let transcript = null;
    let injected = null;
    let decision = null;
    // Set only by the `act` branch below: what the agent actually did, so the
    // session's return value carries the real outcome rather than just words.
    let acted = null;

    if (!transcriptionOn) {
      // External tool owns transcription: report passthrough explicitly.
      transcript = {
        text: '',
        mode: 'passthrough-external',
        note: 'inbuilt transcription OFF — external tool handles STT'
      };
      emit('bolo:transcript', transcript);
    } else {
      // `state` is already 'routing', so the notch is showing the thinking
      // state from the moment the key is released rather than after the
      // transcript lands.
      transcript = await transcribe(emit, clip);

      // Replacements land here rather than on the injected text: the router
      // reads `transcript.text` too, and a replacement is often exactly what
      // makes an utterance read as a command.
      const substituted = applyReplacements(transcript.text, settings.get('replacements'));
      if (substituted !== transcript.text) {
        transcript = { ...transcript, text: substituted, replaced: true };
      }

      lastTranscript = transcript;
      emit('bolo:transcript', transcript);

      if (sessionDoctor) {
        // Doctor Mode: the transcript goes back to the doctor window for
        // templating. No router, no injection — the doctor reviews the note
        // and pastes it when it is right.
        if (settings.get('audioDucking')) duck.setDucked(false);
        state = 'idle';
        handsFree = false;
        sessionMode = null;
        sessionDoctor = false;
        emit('bolo:voice-state', getState());
        emit('bolo:notch', { phase: 'idle' });
        emit('bolo:doctor-result', {
          text: transcript.text || '',
          mode: transcript.mode || null,
          languageCode: transcript.languageCode || null
        });
        return { ...getState(), transcript, doctor: true };
      }

      if (transcript.text && pending) {
        // A critical action is awaiting confirmation, so this utterance is the
        // answer to it, not a new command. "yes" runs it; anything else cancels.
        acted = await resolvePending(emit, isYes(transcript.text));
      } else if (transcript.text) {
        decision = await decide(transcript.text, emit, sessionMode);
        lastDecision = decision;

        const text = decision.text || transcript.text;

        if (decision.intent === 'edit' && decision.error === 'no-selection') {
          // Edit mode with nothing selected: there is nothing to rewrite, and
          // typing the spoken instruction into the document would be exactly
          // wrong. Say what to do instead.
          emit('bolo:notch', {
            phase: 'hint',
            text: 'Select some text first, then use Edit.'
          });
          emit('bolo:answer', {
            intent: 'edit',
            ok: false,
            text: 'Nothing was selected to rewrite.',
            source: decision.source,
            transcript: transcript.text
          });
        } else if (decision.intent === 'insert') {
          // Dictation: type it and stay silent. The user dictated text — repeating
          // it back on the notch or speaking it aloud is pure noise. Collapse the
          // capsule to its resting tab; emit no `reply`, so speakReply never fires.
          if (demoMode) {
            // Onboarding dictation demo: drop the text into the dashboard's own
            // textarea instead of pasting into the foreground app.
            emit('bolo:ob-demo-result', { text, intent: 'insert' });
          } else if (injectionOn) {
            injected = await injector.inject(text);
            emit('bolo:injected', injected);
          }
          emit('bolo:notch', { phase: 'idle' });
        } else if (decision.intent === 'edit') {
          if (demoMode) {
            // Onboarding edit demo: return the rewrite to the dashboard instead of
            // pasting it into whatever app has focus.
            emit('bolo:ob-demo-result', { text, intent: 'edit' });
          } else if (injectionOn) {
            injected = await injector.inject(text);
            emit('bolo:injected', injected);
          }
          emit('bolo:notch', {
            phase: 'reply',
            intent: decision.intent,
            label: modes.intentLabel(decision.intent),
            transcript: transcript.text,
            text
          });
        } else if (decision.intent === 'act') {
          // The one intent that touches the machine. `act` used to stop at the
          // notch — the router said "this was a command" and the app said a
          // line about it and did nothing. Now the command is carried out.
          //
          // It is gated three times over, and each gate is a different kind of
          // no. The router had to decide this was a command rather than text to
          // type; capabilities.js checks the user's own permission switch and
          // answers `not-permitted` when it is off; and anything destructive —
          // overwriting a file that already exists — is refused outright,
          // because a voice utterance cannot supply the confirmation that
          // operation needs.
          //
          // The line spoken is the *result*, never the plan: "Opened notepad"
          // only after notepad opened, and the real reason when it did not.
          // There is no branch here that reports a success nobody had.
          acted = await agent.act(transcript.text);

          if (acted.pending) {
            // A critical action. Do not run it — stage it and ask. The card
            // shows Confirm / Cancel buttons; the spoken prompt invites a "yes".
            // Either path resolves through resolvePending().
            stagePending({ tool: acted.tool, args: acted.args, summary: acted.summary });
            emit('bolo:notch', {
              phase: 'reply',
              intent: 'act',
              label: modes.intentLabel('act'),
              transcript: transcript.text,
              text: acted.say,
              instant: true,
              confirm: true,
              tool: acted.tool || null,
              actions: [
                { id: 'confirm', label: 'Confirm', icon: 'check' },
                { id: 'cancel', label: 'Cancel' }
              ]
            });
            emit('bolo:answer', {
              intent: 'act',
              ok: true,
              pending: true,
              text: acted.say,
              tool: acted.tool || null,
              args: acted.args || null,
              source: decision.source,
              transcript: transcript.text
            });
          } else {
            const said = acted.say || (acted.ok ? 'Done.' : 'That didn\'t work.');

            emit('bolo:notch', {
              phase: 'reply',
              intent: 'act',
              label: modes.intentLabel('act'),
              transcript: transcript.text,
              text: said,
              // The tool and whether it worked, so the notch can show a failed
              // command differently from a successful one without parsing prose.
              tool: acted.tool || null,
              ok: !!acted.ok
            });

            emit('bolo:answer', {
              intent: 'act',
              ok: !!acted.ok,
              text: said,
              tool: acted.tool || null,
              args: acted.args || null,
              error: acted.error || undefined,
              source: decision.source,
              transcript: transcript.text
            });
          }
        } else {
          // `answer` never touches the focused app on its own. It is only
          // pasted when the user has asked for that.
          const shouldPaste = decision.intent === 'answer' &&
            settings.get('autoPasteAnswers') && injectionOn;
          if (shouldPaste) {
            injected = await injector.inject(text);
            emit('bolo:injected', injected);
          }
          emit('bolo:notch', {
            phase: 'reply',
            intent: decision.intent,
            label: modes.intentLabel(decision.intent),
            transcript: transcript.text,
            text,
            pasted: !!shouldPaste
          });
        }

        // The `act` branch above already emitted its own answer — with the real
        // outcome rather than a blanket ok:true — so this one is for the paths
        // that only produce words.
        if (decision.intent !== 'act') {
          emit('bolo:answer', {
            intent: decision.intent,
            ok: true,
            text,
            source: decision.source,
            transcript: transcript.text
          });
        }
      } else if (transcript.ok) {
        // Heard something, but nothing intelligible came back — a cough, or a
        // key press with silence behind it. Not an error, but the key press must
        // not look ignored either.
        emit('bolo:notch', { phase: 'hint', text: 'Didn’t catch that' });
      }
    }

    if (settings.get('audioDucking')) duck.setDucked(false);
    if (transcript && transcript.text) {
      history.push({
        kind: decision ? decision.intent : 'insert',
        text: transcript.text,
        // The routed text is what actually landed, and for an edit it is the
        // only record of what the user's document was changed to.
        result: decision && decision.text && decision.text !== transcript.text
          ? decision.text
          : undefined
      });
    }
    state = 'idle';
    handsFree = false; // the session is over; the flag doesn't outlive it
    sessionMode = null; // and neither does the mode it began in
    sessionDoctor = false; // nor the doctor flag
    emit('bolo:voice-state', getState());
    return { ...getState(), clip: await clip, transcript, injected, decision, acted };
  }

  // idle -> listening. A double-tap sets handsFree for this session only.
  //
  // The state flips before the await because the notch has to respond to the key
  // press immediately; the microphone takes a moment to spin up behind it. If it
  // never opens, the state is put back and the reason is said out loud — a
  // session that reports "listening", animates a meter and then types nothing is
  // the worst of the available outcomes.
  handsFree = !!hf;
  // Remember which mode key opened this session; routing reads it when the
  // session stops. Defaults to null (the inferring path) for the wake word and
  // the voice-toggle IPC.
  sessionMode = mode || null;
  // Doctor Mode sessions always record a WAV alongside the webm, because the
  // Sarvam path they prefer chunks long dictations past its ~30s limit.
  sessionDoctor = !!doctor;
  if (settings.get('audioDucking')) duck.setDucked(true);
  state = 'listening';
  emit('bolo:voice-state', getState());

  const started = await audio.start({ wav16k: sessionDoctor });
  if (!started.ok) {
    state = 'idle';
    handsFree = false;
    sessionMode = null;
    sessionDoctor = false;
    if (settings.get('audioDucking')) duck.setDucked(false);
    emit('bolo:voice-state', getState());
    emit('bolo:notch', { phase: 'error', text: micMessage(started) });
    return { ...getState(), started, error: started.error };
  }

  return { ...getState(), started };
}

// Re-insert the previous transcript. Drives the paste-last shortcut and the
// notch's "insert instead" action — which is also the undo for a transcript the
// router decided not to type.
async function pasteLast() {
  if (!lastTranscript || !lastTranscript.text) {
    return { ok: false, error: 'no-previous-transcript' };
  }
  // Re-inject the routed text when there is one: for a misrouted command the
  // user wants the words they said, but for a misrouted edit they want the
  // rewrite the model already produced.
  const text = (lastDecision && lastDecision.text) || lastTranscript.text;
  const injected = await injector.inject(text);
  return { ok: true, text, injected };
}

module.exports = {
  toggle,
  getState,
  getLastTranscript,
  getLastDecision,
  pasteLast,
  transcribe,
  micMessage,
  sttMessage,
  markHandsFree,
  isHandsFree,
  decide,
  resolvePending,
  hasPending,
  clearPending,
  setDemoMode
};
