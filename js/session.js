// ── session ───────────────────────────────────────────────────────────────
// "Session" mode = add several bug cards in one page, dictate each one
// individually, then hit "Generate all" to fire the AI in parallel
// (Promise.all). Every successful result is auto-pushed into history.
//
// Each card is an in-memory object:
//   { id, text, result, recog, isRec }
// Cards are NOT persisted across reloads — by design. The persistent
// store is History (see history.js).
//
// Voice strategy: each card has its OWN SpeechRecognition instance so
// the user can switch between cards without losing finalized text. We
// stop other cards' mics when starting a new one (and also stop the
// page-level mic from voice.js if it happens to be recording) so two
// recognizers never compete for the microphone.

// ── format / language ─────────────────────────────────────────────────────
function setSessionFormat(f) {
  sessionFormat = f;
  localStorage.setItem('bra_session_format', f);
  const a = document.getElementById('sFmtNormal');
  const b = document.getElementById('sFmtGherkin');
  if (a) a.classList.toggle('active', f === 'normal');
  if (b) b.classList.toggle('active', f === 'gherkin');
}

function setSessionLang(l) {
  sessionLang = l;
  const a = document.getElementById('sLangUk');
  const b = document.getElementById('sLangEn');
  if (a) a.classList.toggle('active', l === 'uk-UA');
  if (b) b.classList.toggle('active', l === 'en-US');
}

// ── cards CRUD ────────────────────────────────────────────────────────────
function addBugCard() {
  const id = ++cardCounter;
  sessionCards.push({ id, text: '', result: null, recog: null, isRec: false });
  renderCards();
  setTimeout(() => {
    const el = document.getElementById('card-' + id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 60);
}

function removeCard(id) {
  const card = sessionCards.find(c => c.id === id);
  if (card?.recog) { try { card.recog.stop(); } catch {} }
  sessionCards = sessionCards.filter(c => c.id !== id);
  renderCards();
}

function clearSession() {
  sessionCards.forEach(c => {
    if (c.recog) { try { c.recog.stop(); } catch {} }
  });
  sessionCards = [];
  const er = document.getElementById('sErrArea'); if (er) er.innerHTML = '';
  const rr = document.getElementById('sResArea'); if (rr) rr.innerHTML = '';
  renderCards();
}

function updateCardText(id, val) {
  const card = sessionCards.find(c => c.id === id);
  if (card) card.text = val;
}

// ── render ────────────────────────────────────────────────────────────────
function renderCards() {
  const container = document.getElementById('bugCards');
  if (!container) return;
  if (!sessionCards.length) {
    container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--dim);font-size:13px;font-family:'IBM Plex Mono',monospace;border:0.5px dashed var(--border);border-radius:var(--r);margin-bottom:1rem">No bugs yet — click "+ Add bug" to start</div>`;
    return;
  }
  container.innerHTML = sessionCards.map((card, idx) => {
    // Collapsed cards are dictation-finished but not-yet-edited entries —
    // we set this flag when the user taps "+ Add bug" in the PiP, so the
    // previous card folds down and the focus stays on the new one.
    // Click the row to expand it back into a full editable card.
    if (card.collapsed) {
      // While GPT-4o still processes this card's audio, say so instead of
      // the misleading "(no dictation captured)" — the text arrives shortly.
      const preview = card.transcribing
        ? '⏳ Transcribing with GPT-4o…'
        : ((card.text || '').trim().slice(0, 140) || '(no dictation captured)');
      const more = (!card.transcribing && (card.text || '').length > 140) ? '…' : '';
      const tag = card.result ? ' · generated' : (card.transcribing ? ' · transcribing…' : ' · dictated');
      return `
      <div class="card collapsed-card" id="card-${card.id}" onclick="expandCard(${card.id})" style="margin-bottom:.75rem;cursor:pointer">
        <div class="card-head" style="padding:8px 12px">
          <span class="card-title">Bug #${idx + 1}${tag}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--dim);font-family:'IBM Plex Mono',monospace">tap to edit</span>
            <button class="rule-del" onclick="event.stopPropagation();removeCard(${card.id})" title="Remove">×</button>
          </div>
        </div>
        <div style="padding:6px 12px 10px;font-size:12px;color:${card.transcribing ? 'var(--blue)' : 'var(--muted)'};line-height:1.5">${esc(preview)}${more}</div>
      </div>`;
    }
    return `
    <div class="card" id="card-${card.id}" style="margin-bottom:.75rem">
      <div class="card-head">
        <span class="card-title">Bug #${idx + 1}${card.result ? ' · generated' : ''}</span>
        <button class="rule-del" onclick="removeCard(${card.id})" title="Remove">×</button>
      </div>
      <div class="card-body" style="padding:12px">
        <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px">
          <button class="mic-btn ${card.isRec ? 'rec' : ''}" id="mic-${card.id}" onclick="toggleCardRec(${card.id})" style="width:42px;height:42px;font-size:18px;flex-shrink:0">${card.isRec ? '⏹' : '🎙'}</button>
          <textarea id="txt-${card.id}" rows="3" placeholder="Describe bug #${idx + 1}…" style="flex:1" oninput="updateCardText(${card.id}, this.value)">${esc(card.text)}</textarea>
        </div>
        ${card.result ? renderCardResult(card) : ''}
      </div>
    </div>`;
  }).join('');
}

// Expand a single card from its compact dictation summary back into the
// full editable view. Used by the row click + "tap to edit" hint.
function expandCard(id) {
  const card = sessionCards.find(c => c.id === id);
  if (!card) return;
  card.collapsed = false;
  renderCards();
}
window.expandCard = expandCard;

function renderCardResult(card) {
  const r = card.result || {};
  const isGherkin = sessionFormat === 'gherkin';
  const resultId  = 'card:' + card.id;
  const body = isGherkin ? renderEditableGherkinBody(r, resultId) : renderEditableNormalBody(r, resultId);

  return `<div data-result-id="${resultId}" style="background:var(--surface2);border:0.5px solid var(--border);border-radius:var(--r-sm);overflow:hidden;margin-top:4px">
    <div style="padding:8px 12px;border-bottom:0.5px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <span class="sev sev-edit sev-${esc(r.severity || 'Medium')}" onclick="cycleSeverity(this)" title="Click to change severity">${esc(r.severity || 'Medium')}</span>
      <span style="font-size:10px;color:var(--dim);font-family:'IBM Plex Mono',monospace">click anywhere to edit</span>
    </div>
    <div style="padding:12px">${body}</div>
    ${typeof renderLinkedItemsBlock === 'function' ? renderLinkedItemsBlock(r, resultId) : ''}
    <div style="padding:8px 12px;border-top:0.5px solid var(--border);display:flex;gap:7px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="copyCardReport(${card.id})">📋 Copy</button>
      <button class="btn btn-ghost btn-sm" onclick="pushCardReport(${card.id})">🚀 Push to Jira</button>
    </div>
  </div>`;
}

// ── per-card voice ────────────────────────────────────────────────────────
// Simpler than the page-level mic in voice.js: no PiP, no Service Worker
// notifications, no tab-title swap. Each card is meant for short bursts;
// the user is usually on the page actively dictating one card at a time.
//
// We DO replicate the "delta math" trick from voice.js so brief pauses
// (Chrome's internal session-end) don't wipe what was already finalized.
function toggleCardRec(id) {
  const card = sessionCards.find(c => c.id === id);
  if (!card) return;

  // Already recording → just stop this card's mic. The user might want
  // to keep the PiP open and tap + Add bug from there, so we don't auto-
  // close the floating window — leaving that to the PiP Stop button.
  if (card.isRec) {
    stopCardRec(card);
    return;
  }

  // Starting → open the Session PiP rooted at this card. The PiP itself
  // takes care of stopping every other mic on the page and exposing
  // + Add bug / Stop. requestWindow() needs the synchronous user gesture,
  // so we open it right from this click handler.
  openSessionPip({ cardId: id });
}

function startCardRec(card) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('⚠ Speech recognition not supported (Chrome/Edge only)'); return; }

  card.recog = new SR();
  card.recog.lang = sessionLang;
  card.recog.continuous = true;
  card.recog.interimResults = true;

  let baseTxt        = card.text || '';
  let committed      = '';
  let prevFrameFinal = '';
  let userStop       = false;
  let stopDoneResolve = null;
  card._stopDone = new Promise(resolve => { stopDoneResolve = resolve; });

  card.recog.onstart = () => {
    card.isRec = true;
    const btn = document.getElementById('mic-' + card.id);
    if (btn) { btn.classList.add('rec'); btn.textContent = '⏹'; }
    // Hold the input device open across Chrome's silence-triggered restarts
    // (see voice.js acquireMicStream) — Bluetooth headsets otherwise drop
    // the first words after every pause while the device re-opens.
    // Each card records into its OWN audio session (closure-scoped recorder
    // + chunks), so the "+ Add bug" overlap — card N still finalizing while
    // card N+1 already records — can't cross-contaminate or wipe buffers.
    if (typeof acquireMicStream === 'function') {
      acquireMicStream().then(() => {
        if (card.isRec && !card._audio && typeof createAudioSession === 'function') {
          card._audio = createAudioSession();
        }
      });
    }
  };
  card.recog.onresult = e => {
    // GPT-4o Transcribe mode shows NO live draft (ChatGPT-style) — the audio
    // is captured by the recorder and the polished text appears only after
    // Pause/Stop. Web Speech still runs to drive the lifecycle; we just drop
    // its low-quality interim text. The Session PiP shows an animated
    // equalizer instead (see _renderSessionPip).
    if (cfg.voiceAiCleanup === 'gpt4o-transcribe') return;
    let frameFinal   = '';
    let frameInterim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) frameFinal += (frameFinal ? ' ' : '') + r[0].transcript.trim();
      else           frameInterim += r[0].transcript;
    }
    let delta;
    if (frameFinal.startsWith(prevFrameFinal)) {
      delta = frameFinal.slice(prevFrameFinal.length).trim();
    } else {
      if (prevFrameFinal) committed = (committed + ' ' + prevFrameFinal).trim();
      delta = frameFinal.trim();
    }
    if (delta) {
      committed = (committed + ' ' + delta).trim();
    }
    prevFrameFinal = frameFinal;

    // Apply the Context-words glossary to the live transcript (committed +
    // interim) so corrected spellings appear in the PiP / card AS you speak.
    // Correcting the whole committed string keeps multi-word phrases intact.
    const committedShown = (typeof correctTranscript === 'function')
      ? correctTranscript(committed) : committed;
    const interimShown = (typeof correctTranscript === 'function')
      ? correctTranscript(frameInterim.trim()) : frameInterim.trim();

    const parts = [];
    if (baseTxt)        parts.push(baseTxt);
    if (committedShown) parts.push(committedShown);
    if (interimShown)   parts.push(interimShown);
    const joined = parts.join(' ');
    card.text = (baseTxt ? (baseTxt + (committedShown ? ' ' + committedShown : '')) : committedShown).trim();
    const ta = document.getElementById('txt-' + card.id);
    if (ta) ta.value = joined;
    // If the Session PiP is open AND tracking this card, mirror the live
    // interim text into the floating window so the user can read along.
    if (typeof _pushSessionPipTranscript === 'function') {
      _pushSessionPipTranscript(card.id, interimShown);
    }
  };
  card.recog.onend = () => {
    if (!userStop) {
      // Pause-induced — try to auto-restart so a 2-3 sec silence doesn't
      // look like recording stopped. Mirrors voice.js behaviour.
      prevFrameFinal = '';
      try { card.recog.start(); return; } catch {}
    }
    card.isRec = false;
    const btn = document.getElementById('mic-' + card.id);
    if (btn) { btn.classList.remove('rec'); btn.textContent = '🎙'; }
    // ALWAYS keep the recorded audio — in GPT-4o mode it IS the text. The
    // old `discard on PiP pause` logic (a whisper-era leftover) silently
    // threw the chunk away, so pausing produced no transcript at all.
    const session = card._audio;
    card._audio = null;
    const stopAudio = session ? session.stop() : Promise.resolve(null);
    stopAudio.then(audioBlob => {
      // Let go of the mic ONLY if no other card picked it up — in the
      // "+ Add bug" flow the next card is already recording on this stream.
      if (typeof releaseMicStream === 'function' && !sessionCards.some(c => c.isRec)) {
        releaseMicStream();
      }
      if (cfg.voiceAiCleanup === 'gpt4o-transcribe') return maybeTranscribeCardWithGpt4o(card, baseTxt, audioBlob);
      return null;
    }).finally(() => {
      if (stopDoneResolve) stopDoneResolve();
    });
  };
  // NOTE: no releaseMicStream here — onerror also fires for benign
  // 'no-speech' pauses that onend immediately restarts from; dropping the
  // held stream there would re-introduce the device-reopen gap. Every real
  // stop goes through onend above, which does release.
  card.recog.onerror = () => {
    card.isRec = false;
    const btn = document.getElementById('mic-' + card.id);
    if (btn) { btn.classList.remove('rec'); btn.textContent = '🎙'; }
  };

  // Wire up stopCardRec to set userStop = true before recog.stop() so
  // onend doesn't auto-restart.
  card._userStop = () => { userStop = true; };

  card.recog.start();
}

function stopCardRec(card) {
  if (card && card._userStop) card._userStop();
  if (card && card.recog) {
    try { card.recog.stop(); } catch {}
  }
  return card?._stopDone || Promise.resolve();
}

async function maybeTranscribeCardWithGpt4o(card, baseTxt, audioBlob) {
  if (!audioBlob || !audioBlob.size) return;
  if (!apiKey || typeof transcribeWithGpt4o !== 'function') return;

  // Mark the card as in-flight and repaint statuses everywhere — the Batch
  // page shows "⏳ transcribing…" and the PiP accordion shows a blue
  // ⏳ TRANSCRIBING pill instead of a misleading EMPTY, even when the user
  // has already moved on to dictating the next card (+ Add bug flow).
  card.transcribing = true;
  renderCards();
  _refreshSessionPipStatuses();

  try {
    const snapshot = card.text || '';
    const btn = document.getElementById('mic-' + card.id);
    if (btn && !card.isRec) { btn.textContent = '🤖'; btn.title = 'Transcribing with GPT-4o…'; }

    let transcribed = '';
    try {
      const hint = typeof transcribeLanguageHint === 'function' ? transcribeLanguageHint(sessionLang) : '';
      transcribed = await transcribeWithGpt4o(audioBlob, hint);
    } catch (e) {
      try { toast('⚠ GPT-4o transcription failed — keeping browser transcript (' + e.message + ')'); } catch {}
    }

    const btnAfter = document.getElementById('mic-' + card.id);
    if (btnAfter && !card.isRec) { btnAfter.textContent = '🎙'; btnAfter.title = ''; }

    transcribed = (typeof correctTranscript === 'function') ? correctTranscript(transcribed) : transcribed;
    transcribed = String(transcribed || '').trim();
    if (!transcribed || card.isRec) return;
    if ((card.text || '') !== snapshot) return;   // user edited meanwhile

    card.text = (baseTxt ? baseTxt + ' ' : '') + transcribed;
    const ta = document.getElementById('txt-' + card.id);
    if (ta) ta.value = card.text;
    try { toast('✓ GPT-4o transcript applied'); } catch {}
  } finally {
    // Flip ⏳ → DICTATED (or back to EMPTY on failure) on both surfaces,
    // regardless of which early-return path was taken.
    card.transcribing = false;
    renderCards();
    _refreshSessionPipStatuses();
  }
}

// Repaint the PiP accordion so per-card status pills stay truthful while a
// background transcription starts/finishes. Skipped in paused-edit mode —
// a full re-render there would yank the caret out of the contenteditable
// the user is typing in (statuses catch up on Resume / next render).
function _refreshSessionPipStatuses() {
  if (!sessionPip || sessionPipPaused) return;
  try { _renderSessionPip(); } catch {}
}

// ── parallel generate ─────────────────────────────────────────────────────
// Builds one system prompt (shared across cards), then fires one AI
// request per non-empty card via Promise.all. Each successful result is
// also written to History via addToHistory().
async function generateSession() {
  sessionCards.forEach(c => { if (c.isRec && c.recog) stopCardRec(c); });

  const filled = sessionCards.filter(c => (c.text || '').trim());
  const errEl  = document.getElementById('sErrArea');
  if (!filled.length) {
    if (errEl) errEl.innerHTML = '<div class="err-box">Add at least one bug description.</div>';
    return;
  }
  if (!apiKey) { promptKey(); return; }

  const btn = document.getElementById('sGenBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Generating ${filled.length} report${filled.length === 1 ? '' : 's'}…`; }
  if (errEl) errEl.innerHTML = '';

  const isGherkin = sessionFormat === 'gherkin';
  const sys = buildSystemPrompt({ isGherkin });

  const promises = filled.map(card => callAi(sys, card.text).then(
    raw => ({ id: card.id, result: normalizeAiResult(raw, isGherkin) }),
    e   => ({ id: card.id, error: e.message })
  ));

  const results = await Promise.all(promises);
  let ok = 0;
  const errors = [];
  results.forEach(r => {
    const card = sessionCards.find(c => c.id === r.id);
    if (!card) return;
    if (r.result) {
      card.result = r.result;
      addToHistory(r.result, sessionFormat);
      ok++;
    } else if (r.error) {
      errors.push(`Bug #${sessionCards.indexOf(card) + 1}: ${r.error}`);
    }
  });

  renderCards();
  if (btn) { btn.disabled = false; btn.innerHTML = '→ Generate all reports'; }
  if (errors.length && errEl) {
    errEl.innerHTML = `<div class="err-box">${esc(errors.join('\n'))}</div>`;
  }
  toast(`✓ Generated ${ok} of ${filled.length}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Session PiP — floating "Dictate all" controller
// ──────────────────────────────────────────────────────────────────────────
// Same Document Picture-in-Picture API as voice.js / openPipController(),
// but tuned for the multi-bug Batch flow:
//
//   ▸ HEAD shows "Bug #N" of total + the engine (always Browser).
//   ▸ BODY shows the live Web Speech transcript for the active card.
//   ▸ FOOT has THREE buttons:
//        Pause       — stops the recognizer but keeps the card's text
//                      intact. Press 🎙 Resume to continue.
//        + Add bug   — stops the current card's recording, ADDS a new
//                      empty card, and immediately starts dictating it.
//        Stop        — fully stops dictation and closes the PiP. All the
//                      cards stay visible on the Batch tab.
//
// State on the global object so the window-level button handlers can
// access it without closures over a stale render.

let sessionPip            = null;   // PiP Window handle
let sessionPipActiveId    = null;   // id of the card currently being DICTATED (mic is hot)
let sessionPipExpandedId  = null;   // id of the card currently EXPANDED in the PiP (accordion focus)
let sessionPipBusy        = false;  // disable buttons while transcription in flight
let sessionPipPaused      = false;  // Browser engine: user tapped Pause
let sessionPipLastInterim = '';     // mirrored from per-card recog so PiP body shows it

function normalizeSessionPipText(s) {
  return typeof normalizePipEditableText === 'function'
    ? normalizePipEditableText(s)
    : String(s || '').replace(/^[\s\u00a0]+/, '');
}

// Internal: open the OS-level PiP window with the right HTML / CSS. Must
// be called synchronously from a user gesture (the "Dictate all" click).
async function _createSessionPipWindow() {
  if (sessionPip) return sessionPip;
  if (!('documentPictureInPicture' in window)) {
    toast('⚠ Floating window requires Chrome/Edge 116+ — falling back to in-page mic');
    return null;
  }
  // Browser allows only one Document PiP at a time; make sure the Single
  // Report PiP is closed first.
  try { if (typeof closePipController === 'function' && typeof pipWindow !== 'undefined' && pipWindow) closePipController(); } catch {}
  try {
    const win = await documentPictureInPicture.requestWindow({ width: 460, height: 500 });
    const doc = win.document;
    doc.title = 'BRA · Batch dictation';

    const fonts = doc.createElement('link');
    fonts.rel  = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';
    doc.head.appendChild(fonts);

    const style = doc.createElement('style');
    style.textContent = `
      :root{color-scheme:dark;--bg:#0c0c0e;--surface:#141417;--surface2:#1c1c21;--surface3:#222228;--border:rgba(255,255,255,0.07);--border-md:rgba(255,255,255,0.13);--text:#ededee;--muted:#7a7a85;--dim:#45454f;--accent:#d4ff47;--accent-dim:rgba(212,255,71,0.1);--accent-ink:#111800;--red:#ff5e57;--blue:#60afff;--blue-dim:rgba(96,175,255,0.12);--r:10px;--r-sm:6px}
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;width:100%;height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5;overflow:hidden;user-select:none}
      .wrap{display:flex;flex-direction:column;height:100%}
      .head{padding:11px 14px;background:var(--surface2);border-bottom:0.5px solid var(--border);display:flex;align-items:center;gap:10px}
      .logo-mark{width:26px;height:26px;background:var(--accent);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
      .head-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
      .head-title{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text);text-transform:uppercase;letter-spacing:.08em;font-weight:500}
      .head-sub{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:7px}
      .rec-dot{width:7px;height:7px;background:var(--red);border-radius:50%;animation:blink 1.2s ease-in-out infinite;box-shadow:0 0 8px rgba(255,94,87,.55)}
      @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
      .rec-dot.paused{animation:none;background:var(--muted);box-shadow:none;opacity:.4}
      .rec-dot.transcribing{animation:none;background:var(--blue);box-shadow:0 0 8px rgba(96,175,255,.5)}
      /* Spinner shown on the Pause button + body while a paused chunk is being transcribed by GPT-4o. */
      .pip-spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:pipspin .7s linear infinite;vertical-align:-2px}
      .pip-spin-lg{width:30px;height:30px;border-width:3px;border-top-color:var(--blue);vertical-align:0}
      @keyframes pipspin{to{transform:rotate(360deg)}}
      .pause-btn:disabled,.stop-btn:disabled{cursor:default;opacity:.55}
      /* Siri-style equalizer for GPT-4o mode (no live transcript) — centre-
         anchored gradient bars driven by updatePipEqLevel. */
      .pip-rec{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:14px 0}
      .pip-eq{display:flex;align-items:center;justify-content:center;gap:6px;height:60px}
      .pip-eq span{width:7px;height:4px;border-radius:999px;background:#a78bfa;box-shadow:0 0 12px rgba(167,139,250,.5);transition:height 80ms cubic-bezier(.4,0,.2,1)}
      .pip-eq span:nth-child(1){background:#5ee7ff;box-shadow:0 0 12px rgba(94,231,255,.5)}
      .pip-eq span:nth-child(2){background:#7cc4ff;box-shadow:0 0 12px rgba(124,196,255,.5)}
      .pip-eq span:nth-child(3){background:#9aa7fb;box-shadow:0 0 12px rgba(154,167,251,.5)}
      .pip-eq span:nth-child(4){background:#a78bfa;box-shadow:0 0 12px rgba(167,139,250,.5)}
      .pip-eq span:nth-child(5){background:#c08bf0;box-shadow:0 0 12px rgba(192,139,240,.5)}
      .pip-eq span:nth-child(6){background:#df7ddb;box-shadow:0 0 12px rgba(223,125,219,.5)}
      .pip-eq span:nth-child(7){background:#f472b6;box-shadow:0 0 12px rgba(244,114,182,.5)}
      .pip-rec-label{font-size:12px;color:var(--muted);text-align:center}
      .lang-pill{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted);background:var(--surface3);padding:3px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.07em;font-weight:500}
      .body{flex:1;display:flex;flex-direction:column;padding:12px;background:var(--bg);overflow-y:auto;overflow-x:hidden;font-size:14px;line-height:1.55;color:var(--text);word-wrap:break-word;user-select:text;min-height:0}
      .body.empty{color:var(--dim);font-style:italic;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:14px;white-space:pre-wrap}
      .body::-webkit-scrollbar{width:6px}
      .body::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:3px}
      .body::-webkit-scrollbar-thumb:hover{background:var(--dim)}
      .body-hint{font-size:11px;color:var(--muted);text-align:center;padding:6px 0 8px;font-family:'IBM Plex Mono',monospace;font-style:italic;flex-shrink:0}
      .pip-card{background:var(--surface);border:0.5px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden;transition:border-color .15s,background .15s}
      .pip-card.expanded{flex:1;display:flex;flex-direction:column;min-height:0}
      .pip-card.active{border-color:var(--red);box-shadow:0 0 0 1px rgba(255,94,87,.22)}
      .pip-card.active.paused{border-color:var(--border-md);box-shadow:none}
      .pip-card-head{padding:8px 12px;background:var(--surface2);display:flex;justify-content:space-between;align-items:center;font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;cursor:pointer;user-select:none;flex-shrink:0}
      .pip-card-head:hover{background:var(--surface3)}
      .pip-card.expanded .pip-card-head{cursor:default}
      .pip-card.expanded .pip-card-head:hover{background:var(--surface2)}
      .pip-card.active .pip-card-head{background:rgba(255,94,87,.10);color:#ff9d95}
      .pip-card.active.paused .pip-card-head{background:var(--surface3);color:var(--muted)}
      .pip-card.expanded.active .pip-card-head{background:rgba(255,94,87,.14)}
      .pip-card-title{font-weight:500}
      .pip-card-status{font-weight:500}
      .pip-card-body{padding:12px 14px;font-size:14px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-wrap:break-word;outline:none;flex:1;overflow-y:auto;min-height:0}
      .pip-card-body.dim{color:var(--dim);font-style:italic}
      .pip-card-body.editable{caret-color:var(--accent)}
      .pip-card-body.editable:focus{background:var(--surface2);box-shadow:inset 0 0 0 1px var(--border-md)}
      .pip-card-body .interim{color:var(--muted);font-style:italic}
      .pip-card-body::-webkit-scrollbar{width:6px}
      .pip-card-body::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:3px}
      .foot{padding:10px 12px;background:var(--surface);border-top:0.5px solid var(--border);display:flex;gap:8px;flex-wrap:wrap}
      .stop-btn{flex:1;min-width:120px;background:var(--red);color:#fff;border:0;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background 120ms,transform 80ms;display:flex;align-items:center;justify-content:center;gap:6px}
      .stop-btn:hover{background:#e54a44}
      .stop-btn:active{transform:scale(.97)}
      .stop-btn .x{width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,.25);display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;font-weight:700}
      .add-btn{background:var(--blue-dim);color:var(--blue);border:0.5px solid rgba(96,175,255,0.35);padding:10px 16px;border-radius:999px;font-size:13px;font-weight:500;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background 120ms,transform 80ms;display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;flex-shrink:0}
      .add-btn:hover{background:rgba(96,175,255,0.18)}
      .add-btn:active{transform:scale(.97)}
      .pause-btn,.resume-btn{background:var(--surface3);color:var(--text);border:0.5px solid var(--border-md);padding:10px 16px;border-radius:999px;font-size:13px;font-weight:500;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background 120ms,transform 80ms;display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;flex-shrink:0}
      .pause-btn:hover,.resume-btn:hover{background:#2a2a30}
      .pause-btn:active,.resume-btn:active{transform:scale(.97)}
      .done-btn{flex:1;background:var(--accent);color:var(--accent-ink);border:0;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background 120ms,transform 80ms;display:flex;align-items:center;justify-content:center;gap:6px}
      .done-btn:hover{background:#c5f039}
      .done-btn:active{transform:scale(.97)}
      button:disabled{opacity:.45;cursor:not-allowed;transform:none!important}
      button:disabled:hover{background:inherit}
    `;
    doc.head.appendChild(style);

    doc.body.innerHTML = `
      <div class="wrap">
        <div class="head">
          <div class="logo-mark">🗂</div>
          <div class="head-text">
            <div class="head-title">Bug Report Agent · Batch</div>
            <div class="head-sub"><span class="rec-dot" id="spipDot"></span><span id="spipLabel">Recording — Bug #1</span></div>
          </div>
          <span class="lang-pill" id="spipPill">UK</span>
        </div>
        <div class="body empty" id="spipBody">Waiting for speech…</div>
        <div class="foot">
          <button class="pause-btn" id="spipPause">⏸ Pause</button>
          <button class="resume-btn" id="spipResume" style="display:none">🎙 Resume</button>
          <button class="add-btn" id="spipAdd">+ Add bug</button>
          <button class="stop-btn" id="spipStop"><span class="x">■</span> Stop</button>
          <button class="done-btn" id="spipDone" style="display:none">✓ Apply &amp; close</button>
        </div>
      </div>`;

    doc.getElementById('spipPause').addEventListener('click',  () => onSessionPipPause());
    doc.getElementById('spipResume').addEventListener('click', () => onSessionPipResume());
    doc.getElementById('spipAdd').addEventListener('click',    () => onSessionPipAddBug());
    doc.getElementById('spipStop').addEventListener('click',   () => onSessionPipStop());
    doc.getElementById('spipDone').addEventListener('click',   () => onSessionPipApplyClose());

    // ── inline edit inside the PiP body (Pause mode) ──────────────────────
    // When the user taps Pause, the expanded pip-card-body becomes
    // contenteditable (see _renderSessionPip). This single delegated
    // listener mirrors any change back into the underlying card.text +
    // the matching textarea on the Batch tab, so when they tap Resume
    // new dictation appends to their edited text, and Copy / Push /
    // Generate use the latest version.
    doc.body.addEventListener('input', e => {
      const el = e.target;
      if (!el || !el.matches || !el.matches('.pip-card-body.editable')) return;
      const cid = parseInt(el.dataset.cardId, 10);
      if (!cid) return;
      const card = sessionCards.find(c => c.id === cid);
      if (!card) return;
      card.text = normalizeSessionPipText(el.innerText);
      const ta = document.getElementById('txt-' + cid);
      if (ta) ta.value = card.text;
    });

    // ── accordion: click any COLLAPSED card's head to expand it ───────────
    // The currently expanded card's head is non-clickable (cursor:default
    // via CSS), so only collapsed entries trigger expansion. Switching
    // expansion in paused-edit mode flushes the in-flight edit first so
    // we don't lose user's typing when their card folds.
    doc.body.addEventListener('click', e => {
      const head = e.target && e.target.closest ? e.target.closest('.pip-card-head') : null;
      if (!head) return;
      const cardEl = head.closest('.pip-card');
      if (!cardEl || cardEl.classList.contains('expanded')) return;
      const cid = parseInt(cardEl.dataset.cardId, 10);
      if (!cid) return;
      _setSessionPipExpanded(cid);
    });

    // If the user closes the PiP via its OS-level X button we still need
    // to halt any active dictation cleanly so the mic doesn't keep
    // listening in the background.
    win.addEventListener('pagehide', () => {
      onSessionPipStop({ skipClose: true });
      sessionPip = null;
    });

    sessionPip = win;
    return win;
  } catch (err) {
    console.warn('Session PiP failed:', err);
    sessionPip = null;
    toast('⚠ Could not open floating window');
    return null;
  }
}

// Switch the accordion focus to `cardId`. Before swapping, commit any
// in-flight contenteditable edit on the currently expanded card so the
// user's text doesn't vanish when their card folds.
function _setSessionPipExpanded(cardId) {
  if (sessionPip) {
    const cur = sessionPip.document.querySelector('.pip-card.expanded .pip-card-body.editable');
    if (cur) {
      const cid = parseInt(cur.dataset.cardId, 10);
      const c = sessionCards.find(x => x.id === cid);
      if (c) {
        c.text = normalizeSessionPipText(cur.innerText);
        const ta = document.getElementById('txt-' + cid);
        if (ta) ta.value = c.text;
      }
    }
  }
  sessionPipExpandedId = cardId;
  _renderSessionPip();
}
window._setSessionPipExpanded = _setSessionPipExpanded;

// Refresh the PiP UI. Body is rendered as an ACCORDION:
//   ▸ Exactly one pip-card is "expanded" at a time (its full body shown).
//   ▸ All other cards collapse to just their head row (title + status).
//   ▸ Clicking a collapsed head expands that card; the previously
//     expanded one folds in the same step.
//   ▸ ACTIVE (mic is hot) and EXPANDED (visible body) are independent —
//     the user can browse / edit Bug #1 while Bug #2 keeps recording in
//     the background. The card-head status pill makes this explicit
//     (`🔴 RECORDING` stays on the actively dictated card even when it's
//     collapsed).
//   ▸ Pause flips the expanded card's body to contenteditable so the
//     user can fix whatever they're looking at. The accordion still
//     works in paused mode — switching cards commits the current edit
//     first (see _setSessionPipExpanded).
function _renderSessionPip() {
  if (!sessionPip) return;
  const doc   = sessionPip.document;
  const label = doc.getElementById('spipLabel');
  const pill  = doc.getElementById('spipPill');
  const dot   = doc.getElementById('spipDot');
  const body  = doc.getElementById('spipBody');
  const pause = doc.getElementById('spipPause');
  const resume= doc.getElementById('spipResume');
  const addBtn= doc.getElementById('spipAdd');
  const stop  = doc.getElementById('spipStop');
  const done  = doc.getElementById('spipDone');
  if (!label || !body) return;

  const activeCard = sessionCards.find(c => c.id === sessionPipActiveId);
  const idx        = activeCard ? sessionCards.indexOf(activeCard) + 1 : 0;

  if (pill) pill.textContent = (sessionLang === 'en-US' ? 'EN' : 'УК') + ' · BROWSER';

  if (sessionPipBusy) {
    label.textContent = 'Transcribing previous bug…';
    if (dot)    { dot.classList.remove('paused'); dot.classList.add('transcribing'); }
    if (pause)  pause.disabled  = true;
    if (resume) resume.disabled = true;
    if (addBtn) addBtn.disabled = true;
    if (stop)   { stop.style.display = 'flex'; stop.disabled = false; }
    if (done)   done.style.display = 'none';
  } else if (sessionPipPaused) {
    label.textContent = 'Paused — edit any bug below, then Resume or Apply';
    if (dot)    { dot.classList.remove('transcribing'); dot.classList.add('paused'); }
    if (pause)  pause.style.display  = 'none';
    if (resume) { resume.style.display = 'flex'; resume.disabled = false; }
    if (addBtn) addBtn.disabled = false;
    if (stop)   stop.style.display  = 'none';
    if (done)   { done.style.display = 'flex'; done.disabled = false; }
  } else {
    label.textContent = 'Recording — Bug #' + idx;
    if (dot)    { dot.classList.remove('paused','transcribing'); }
    // Reset the Pause button label too — it may still hold the transcribing
    // spinner from a previous Pause.
    if (pause)  { pause.style.display  = 'flex'; pause.disabled  = false; pause.innerHTML = '⏸ Pause'; }
    if (resume) { resume.style.display = 'none'; resume.disabled = false; }
    if (addBtn) addBtn.disabled = false;
    if (stop)   { stop.style.display = 'flex'; stop.disabled = false; }
    if (done)   done.style.display = 'none';
  }

  // ── body: accordion stack of pip-card blocks ──────────────────────────
  body.classList.remove('empty');
  const escTxt = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Default the expanded card to the active one if nothing was set or
  // the previously-expanded card was removed in the meantime.
  if (!sessionPipExpandedId || !sessionCards.find(c => c.id === sessionPipExpandedId)) {
    sessionPipExpandedId = sessionPipActiveId;
  }
  const editable = sessionPipPaused && !sessionPipBusy;

  const hintHtml = editable
    ? `<div class="body-hint">📝 click any bug to edit · tap 🎙 Resume to keep dictating</div>`
    : '';

  body.innerHTML = hintHtml + sessionCards.map((c, i) => {
    const isActive   = c.id === sessionPipActiveId;
    const isExpanded = c.id === sessionPipExpandedId;
    const num = i + 1;

    let status;
    if (c.transcribing && !c.isRec) {
      // GPT-4o transcription in flight for this card — shown even when the
      // card is collapsed and the user already dictates the next one, so a
      // just-stopped bug never reads as a misleading EMPTY.
      status = '<span class="pip-card-status" style="color:#60afff">⏳ TRANSCRIBING</span>';
    } else if (isActive) {
      if (sessionPipBusy)        status = '<span class="pip-card-status" style="color:#60afff">⏳ TRANSCRIBING</span>';
      else if (sessionPipPaused) status = '<span class="pip-card-status">⏸ PAUSED</span>';
      else                       status = '<span class="pip-card-status">🔴 RECORDING</span>';
    } else if ((c.text || '').trim()) {
      status = '<span class="pip-card-status" style="color:var(--dim)">DICTATED</span>';
    } else {
      status = '<span class="pip-card-status" style="color:var(--dim)">EMPTY</span>';
    }

    const cardCls = 'pip-card'
      + (isExpanded ? ' expanded' : ' collapsed')
      + (isActive ? ' active' : '')
      + (isActive && sessionPipPaused ? ' paused' : '');

    const headHtml = `
        <div class="pip-card-head">
          <span class="pip-card-title">Bug #${num}</span>
          ${status}
        </div>`;

    if (!isExpanded) {
      // Collapsed → just the clickable header, no body.
      return `<div class="${cardCls}" data-card-id="${c.id}">${headHtml}</div>`;
    }

    // Expanded → render full body. Content depends on whether THIS card
    // is also the active (mic-hot) one and whether we're in paused mode.
    let inner;
    let dimCls = '';
    if (isActive && !sessionPipPaused) {
      if (cfg.voiceAiCleanup === 'gpt4o-transcribe') {
        // GPT-4o mode shows no live transcript — render the Siri-style
        // equalizer that reacts to the live mic level (updatePipEqLevel).
        const eq = (typeof eqBarsMarkup === 'function')
          ? eqBarsMarkup('spipEq')
          : '<div class="pip-eq" id="spipEq">' + '<span></span>'.repeat(7) + '</div>';
        inner = sessionPipBusy
          ? '<div class="pip-rec"><div class="pip-rec-label">⏳ Transcribing…</div></div>'
          : '<div class="pip-rec">' + eq + '<div class="pip-rec-label">Recording — text appears when you Pause or Stop</div></div>';
      } else {
        const committed = (c.text || '').trim();
        const live      = (sessionPipLastInterim || '').trim();
        if (!committed && !live) {
          inner = 'Waiting for speech…'; dimCls = ' dim';
        } else {
          let html = '';
          if (committed) html += escTxt(committed);
          if (live)      html += (html ? ' ' : '') + '<span class="interim">' + escTxt(live) + '</span>';
          inner = html;
        }
      }
    } else {
      // Either a previous card (not active) OR the active card while
      // paused — show plain text so the user can read / edit it.
      const txt = (c.text || '').trim();
      if (txt) {
        inner = escTxt(normalizeSessionPipText(txt));
      } else {
        inner = editable ? '(empty — click to type)' : '(no dictation captured yet)';
        dimCls = ' dim';
      }
    }

    const bodyCls = 'pip-card-body' + dimCls + (editable ? ' editable' : '');
    const editAttr = editable ? 'contenteditable="plaintext-only"' : '';
    return `<div class="${cardCls}" data-card-id="${c.id}">${headHtml}
        <div class="${bodyCls}" data-card-id="${c.id}" ${editAttr}>${inner}</div>
      </div>`;
  }).join('');

  // Make sure the expanded card's head is visible after a switch — useful
  // when the list grew past the body height.
  const expandedEl = body.querySelector('.pip-card.expanded');
  if (expandedEl) {
    requestAnimationFrame(() => {
      try { expandedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    });
  }
}

// Patch the body of the currently expanded+active pip-card with arbitrary
// HTML. Single chokepoint used by _pushSessionPipTranscript (committed +
// interim pulled from the per-card recog state).
// Early-returns in all the "wrong moment" states (PiP closed, switched
// expansion to a different card, paused-edit mode, etc.) so callers
// don't have to repeat the guards.
function _pushSessionPipBody(cardId, html) {
  if (!sessionPip) return;
  if (cardId !== sessionPipActiveId) return;
  if (sessionPipPaused || sessionPipBusy) return;
  if (sessionPipExpandedId !== sessionPipActiveId) return;
  const doc    = sessionPip.document;
  const bodyEl = doc.querySelector('.pip-card.expanded.active .pip-card-body');
  if (!bodyEl) return;
  if (!html || !String(html).trim()) {
    bodyEl.classList.add('dim');
    bodyEl.textContent = 'Waiting for speech…';
  } else {
    bodyEl.classList.remove('dim');
    bodyEl.innerHTML = html;
  }
  bodyEl.scrollTop = bodyEl.scrollHeight;
}
window._pushSessionPipBody = _pushSessionPipBody;

// Browser engine push hook called from startCardRec()'s onresult. The
// per-card recog already commits finalized text into card.text, so we
// just stitch (card.text + interim) and hand it off to _pushSessionPipBody.
function _pushSessionPipTranscript(cardId, interim) {
  sessionPipLastInterim = interim || '';
  const card = sessionCards.find(c => c.id === cardId);
  if (!card) return;
  const escTxt = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const committed = (card.text || '').trim();
  const live      = (sessionPipLastInterim || '').trim();
  let html = '';
  if (committed) html += escTxt(committed);
  if (live)      html += (html ? ' ' : '') + '<span class="interim">' + escTxt(live) + '</span>';
  _pushSessionPipBody(cardId, html);
}
window._pushSessionPipTranscript = _pushSessionPipTranscript;

// ── public entry: kick off batch dictation ────────────────────────────────
// Invoked from the per-card 🎙 button via toggleCardRec(). Accepts a
// { cardId } option so we always dictate into the card the user clicked,
// not whatever heuristic-picked "first empty" card we'd otherwise guess.
async function openSessionPip(opts) {
  opts = opts || {};
  let card = null;
  if (opts.cardId) {
    card = sessionCards.find(c => c.id === opts.cardId);
  }
  if (!card) {
    // Fallback — reuse the last empty card or create a fresh one. Kept
    // for direct programmatic calls (e.g. future "Dictate all" shortcut).
    card = [...sessionCards].reverse().find(c => !(c.text || '').trim() && !c.result);
    if (!card) {
      addBugCard();
      card = sessionCards[sessionCards.length - 1];
    }
  }

  // Make sure the active card is expanded — user just asked to dictate it.
  card.collapsed = false;

  sessionPipActiveId    = card.id;
  sessionPipExpandedId  = card.id;
  sessionPipBusy        = false;
  sessionPipPaused      = false;
  sessionPipLastInterim = '';

  // Open the floating window FIRST (sync user gesture), THEN start the
  // mic. requestWindow() needs the live activation; getUserMedia is
  // permissive after the first grant so the slight gap is fine.
  // If the PiP is already open (rare — user double-clicked a mic), just
  // switch the active card instead of re-opening.
  if (!sessionPip) {
    const win = await _createSessionPipWindow();
    if (!win) {
      // No PiP support — fall back to plain in-page card mic so the user
      // can still dictate. Bypasses toggleCardRec to avoid infinite loop.
      startCardRec(card);
      return;
    }
  }
  renderCards();
  _renderSessionPip();
  _startActiveCardDictation();
}
window.openSessionPip = openSessionPip;

// Start dictation on whatever card is currently sessionPipActiveId using
// the Browser (Web Speech API) recognizer.
function _startActiveCardDictation() {
  const card = sessionCards.find(c => c.id === sessionPipActiveId);
  if (!card) return;
  // Stop everything else first — same mutual-exclusion rules as toggleCardRec.
  sessionCards.forEach(c => {
    if (c.id !== card.id && c.isRec && c.recog) { try { c.recog.stop(); } catch {} }
  });
  if (typeof isRec !== 'undefined' && isRec && typeof stopRec === 'function') { try { stopRec(); } catch {} }

  if (!card.isRec) startCardRec(card);
}

// ── PiP button handlers ───────────────────────────────────────────────────
async function onSessionPipPause() {
  if (sessionPipBusy) return;
  const card = sessionCards.find(c => c.id === sessionPipActiveId);
  if (!card) return;

  sessionPipPaused = true;
  if (card.isRec) {
    // GPT-4o: stopping the card kicks off a transcription network call that
    // `await stopCardRec` blocks on — show a spinner immediately so the wait
    // is obvious (otherwise the equalizer just freezes).
    if (cfg.voiceAiCleanup === 'gpt4o-transcribe') showSessionPipTranscribing();
    await stopCardRec(card);
  }

  // The expanded pip-card-body flips to contenteditable in _renderSessionPip,
  // so the user can fix the just-captured text inline. Resume will commit
  // any edits back into card.text before re-arming dictation.
  _renderSessionPip();
}

// Counterpart of voice.js showPipTranscribing for the Batch/session PiP:
// spinner on the Pause button + in the body while a paused chunk transcribes.
// Cleared by the _renderSessionPip() that runs once transcription resolves.
function showSessionPipTranscribing() {
  if (!sessionPip) return;
  const doc   = sessionPip.document;
  const pause = doc.getElementById('spipPause');
  const stop  = doc.getElementById('spipStop');
  const label = doc.getElementById('spipLabel');
  const dot   = doc.getElementById('spipDot');
  const body  = doc.getElementById('spipBody');
  if (pause) { pause.disabled = true; pause.innerHTML = '<span class="pip-spin"></span> Transcribing…'; }
  if (stop)  { stop.disabled = true; }
  if (label) label.textContent = 'Transcribing with GPT-4o…';
  if (dot)   { dot.classList.remove('paused'); dot.classList.add('transcribing'); }
  if (body)  {
    body.classList.add('empty');
    body.innerHTML =
      '<div class="pip-rec"><span class="pip-spin pip-spin-lg"></span>' +
      '<div class="pip-rec-label">Transcribing with GPT-4o…</div></div>';
  }
}

function onSessionPipResume() {
  if (sessionPipBusy) return;
  // The input listener already keeps card.text in sync as the user types,
  // but do one final sweep right before re-arming dictation so even an
  // IME composition or paste that didn't fire a clean input event lands
  // in the underlying data. Otherwise the next startCardRec() would use
  // a stale baseTxt and the user would see their edit wiped on first
  // recognized phrase.
  if (sessionPip) {
    sessionPip.document.querySelectorAll('.pip-card-body.editable').forEach(el => {
      const cid = parseInt(el.dataset.cardId, 10);
      const c = sessionCards.find(x => x.id === cid);
      if (!c) return;
      c.text = normalizeSessionPipText(el.innerText);
      const ta = document.getElementById('txt-' + cid);
      if (ta) ta.value = c.text;
    });
  }
  sessionPipPaused     = false;
  // Snap the accordion focus back to the actively dictated card so the
  // live transcript immediately appears in the body of the card the user
  // is now speaking into. Otherwise they'd be staring at some other bug
  // they were just editing.
  sessionPipExpandedId = sessionPipActiveId;
  _renderSessionPip();
  _startActiveCardDictation();
}

// "+ Add bug" — stop current, wait for transcription if needed, add a new
// card, start dictating it. The async middle bit (GPT-4o transcription)
// is what makes this less trivial than the Browser path.
async function onSessionPipAddBug() {
  if (sessionPipBusy) return;
  const card = sessionCards.find(c => c.id === sessionPipActiveId);
  if (!card) return;

  if (card.isRec) stopCardRec(card);

  // Fold the just-finished card down to a compact summary on the Batch
  // tab. The user asked for this: when "+ Add bug" is tapped, Bug #1
  // should "minimize" and Bug #2 becomes the active form. Clicking the
  // collapsed row re-expands it for editing.
  if (card) card.collapsed = true;
  renderCards();

  addBugCard();
  const next = sessionCards[sessionCards.length - 1];
  next.collapsed = false;
  sessionPipActiveId    = next.id;
  sessionPipExpandedId  = next.id;     // focus accordion on the freshly added card
  sessionPipPaused      = false;
  sessionPipLastInterim = '';
  _renderSessionPip();
  _startActiveCardDictation();
}

// "Stop" — finish the current recording, then close the PiP. Cards
// remain visible on the Batch tab.
async function onSessionPipStop(opts) {
  const o = opts || {};
  const card = sessionCards.find(c => c.id === sessionPipActiveId);

  if (card && card.isRec) await stopCardRec(card);

  sessionPipActiveId    = null;
  sessionPipPaused      = false;
  sessionPipBusy        = false;
  sessionPipLastInterim = '';
  renderCards();

  if (!o.skipClose && sessionPip) {
    try { sessionPip.close(); } catch {}
    sessionPip = null;
  }
}

// "Apply & close" — flush any pending contenteditable edits back into the
// underlying card objects, then close the PiP. Mirrors the single-report
// PiP's done-btn so the user gets the same familiar exit gesture.
function onSessionPipApplyClose() {
  if (sessionPip) {
    sessionPip.document.querySelectorAll('.pip-card-body.editable').forEach(el => {
      const cid = parseInt(el.dataset.cardId, 10);
      const c = sessionCards.find(x => x.id === cid);
      if (!c) return;
      c.text = normalizeSessionPipText(el.innerText);
      const ta = document.getElementById('txt-' + cid);
      if (ta) ta.value = c.text;
    });
  }
  onSessionPipStop();
}

// ── per-card actions ──────────────────────────────────────────────────────
function copyCardReport(id) {
  const card = sessionCards.find(c => c.id === id);
  if (!card?.result) return;
  const r = card.result;
  let txt;
  if (sessionFormat === 'gherkin') {
    txt = `Summary: ${r.summary}
Severity: ${r.severity}
Environment: ${r.environment || 'N/A'}

Description:
${r.description || ''}

Actual result:
${r.actualResult || ''}

Expected result:
${r.expectedResult || ''}${r.additionalInfo ? `\n\nAdditional info: ${r.additionalInfo}` : ''}`;
  } else {
    txt = typeof buildNormalPlainText === 'function' ? buildNormalPlainText(r) : `${r.summary || ''}`;
  }
  navigator.clipboard.writeText(txt).then(() => toast('✓ Copied'));
}

// Re-use the existing pushToJira() pipeline so the Session page benefits
// from the same proxy, ADF builder, sprint-id shaping, accountId
// validation, auto-open-on-success, etc. We swap lastRep + reportFormat
// for the duration of the push and restore them on exit.
async function pushCardReport(id) {
  const card = sessionCards.find(c => c.id === id);
  if (!card?.result) return;
  const prevFmt = reportFormat;
  const prevRep = lastRep;
  reportFormat = sessionFormat;
  lastRep      = card.result;
  try {
    await pushToJira();
  } finally {
    reportFormat = prevFmt;
    lastRep      = prevRep;
  }
}
