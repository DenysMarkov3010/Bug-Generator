// ── voice ─────────────────────────────────────────────────────────────────
// Wraps the Web Speech API (Chrome/Edge). Firefox / Safari are not supported.
//
// IMPORTANT: On file:// origins, Chrome / Edge intentionally DO NOT persist
// microphone permission across page loads — every reload re-prompts. There
// is no JS-side fix for this; it is a browser security policy. The mic
// permission is only stored for https:// and http://localhost origins.
//
// For users running the app via the desktop shortcut (which opens file://),
// the friendly fix is `serve.bat` in the project root: it starts a tiny
// PowerShell HTTP server on http://localhost:8765 so the browser treats
// the page like any normal site and remembers Allow.
//
// SESSION HANDLING:
// Chrome's SpeechRecognition fires `onend` after a few seconds of silence
// even when continuous=true, and on the next session it ALSO resets the
// `e.results` buffer to empty. The naive "rebuild textarea = base + results"
// pattern therefore wipes everything dictated before the pause. To survive
// this, we:
//   1) accumulate finalized text into `committedFinal` across all sessions
//      using delta math (compare current frame's full final text to the
//      previous frame's snapshot — if it doesn't extend it, it's a reset
//      and we commit what we had);
//   2) auto-restart in `onend` when the user did NOT tap stop, so a pause
//      becomes invisible to the user and the mic icon keeps blinking.

function setLang(l) {
  lang = l;
  document.getElementById('lUk').classList.toggle('active', l === 'uk-UA');
  document.getElementById('lEn').classList.toggle('active', l === 'en-US');
}

function toggleRec() {
  isRec ? stopRec() : startRec();
}

// Map raw Web Speech API error codes to user-readable copy. Most users
// don't know what "not-allowed" or "audio-capture" mean — we translate.
function describeRecogError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return location.protocol === 'file:'
        ? 'Mic blocked. file:// resets permission on every reload — start the app via serve.bat to keep the Allow choice.'
        : 'Mic blocked. Click the lock icon in the address bar → Permissions → allow Microphone, then reload.';
    case 'no-speech':
      return 'No speech detected. Speak a bit louder or check that the right mic is selected in OS settings.';
    case 'audio-capture':
      return 'No microphone available. Check that a mic is plugged in and not used by another app.';
    case 'network':
      return 'Network error reaching the speech service. Check your connection and try again.';
    case 'aborted':
      return ''; // user cancelled — don't shout at them
    case 'language-not-supported':
      return 'This language is not supported by the speech engine on your system.';
    default:
      return 'Speech error: ' + code;
  }
}

// ── per-recording accumulators ────────────────────────────────────────────
// Module-level so they persist across the internal session restarts that
// Chrome triggers during pauses. Reset on every fresh tap of the mic.
let baseText       = '';   // textarea content captured when user tapped mic
let committedFinal = '';   // accumulated finalized transcript across ALL sub-sessions
let prevFrameFinal = '';   // last onresult's full final text — used for delta math
let userStopped    = false;// true when user (not the browser) ended recognition

// ── GPT-4o post-stop transcription ─────────────────────────────────────────
// `cleanupSeq` invalidates an in-flight transcription when a newer recording
// starts, so a slow response can never stomp fresher text.
let cleanupSeq = 0;

async function maybeTranscribeGpt4o(audioBlob) {
  if (!audioBlob || !audioBlob.size) return;
  if (!apiKey) return;
  if (typeof transcribeWithGpt4o !== 'function') return;
  const ta = document.getElementById('tin');
  if (!ta) return;

  const base = baseText;
  const snapshot = ta.value;
  const seq = ++cleanupSeq;
  const st = document.getElementById('vSt');
  const ht = document.getElementById('vHt');
  if (st) st.textContent = 'Transcribing with GPT-4o…';
  if (ht) ht.textContent = 'OpenRouter is transcribing the recorded audio — browser preview stays until it returns';

  let transcribed = '';
  try {
    transcribed = await transcribeWithGpt4o(audioBlob, transcribeLanguageHint(lang));
  } catch (e) {
    try { toast('⚠ GPT-4o transcription failed — keeping browser transcript (' + e.message + ')'); } catch {}
  }

  if (seq === cleanupSeq && !isRec) {
    if (st) st.textContent = 'Tap to dictate';
    if (ht) ht.textContent = 'Ukrainian or English — report will always be in English';
  }
  transcribed = (typeof correctTranscript === 'function') ? correctTranscript(transcribed) : transcribed;
  transcribed = String(transcribed || '').trim();
  if (!transcribed || seq !== cleanupSeq || isRec) return;

  const next = (base ? base + ' ' : '') + transcribed;
  if (ta.value === snapshot) {
    ta.value = next;
    try { toast('✓ GPT-4o transcript applied'); } catch {}
  } else {
    const currentTail = (base && snapshot.startsWith(base)) ? snapshot.slice(base.length).trim() : snapshot.trim();
    if (currentTail && ta.value.includes(currentTail)) {
      ta.value = ta.value.replace(currentTail, transcribed);
      try { toast('✓ GPT-4o transcript applied'); } catch {}
    }
  }
}

// ── background-tab awareness ──────────────────────────────────────────────
// While dictation is active, we want the user to be able to monitor and
// control recording even when they switch to another tab. We do four things:
//   1. swap document.title to "🔴 Recording… — <original>" so the tab is
//      identifiable in the tabstrip / Cmd-Tab list at a glance;
//   2. swap the favicon to a solid red dot so it stands out among 30 tabs;
//   3. when the tab goes hidden mid-recording, fire a system notification
//      with "Click here to return and stop" — clicking it focuses the tab;
//   4. when the tab becomes visible again, close any active notification
//      (otherwise it lingers in the OS notification center).
//
// All four pieces are no-ops if the browser doesn't support them, so this
// stays graceful on Firefox / Safari where notifications may be denied or
// the page is opened from file:// (no notification permission allowed).

const REC_FAVICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="7" fill="#ff3b30"/>' +
    '<circle cx="8" cy="8" r="3" fill="#fff"/>' +
    '</svg>'
  );

let origTitle        = '';
let origFaviconHref  = '';
let activeNotif      = null;
let visibilityHooked = false;

function setRecordingBadges(on) {
  // Title swap. Cache the original once so re-enabling is idempotent and
  // we don't end up stacking "🔴 Recording…" prefixes on rapid taps.
  if (on) {
    if (!origTitle) origTitle = document.title;
    document.title = '🔴 Recording… — ' + origTitle;
  } else if (origTitle) {
    document.title = origTitle;
  }

  // Favicon swap — `link[rel="icon"]` lives in index.html (favicon.svg).
  const link = document.querySelector('link[rel="icon"]')
            || document.querySelector('link[rel="shortcut icon"]');
  if (link) {
    if (on) {
      if (!origFaviconHref) origFaviconHref = link.getAttribute('href') || '';
      link.setAttribute('href', REC_FAVICON);
    } else if (origFaviconHref) {
      link.setAttribute('href', origFaviconHref);
    }
  }
}

// Ask for notification permission lazily — only when the user starts a
// recording. This avoids a startup prompt on first load (which is the
// fastest way to get users to click "Block" forever).
async function ensureNotificationPermission() {
  if (typeof Notification === 'undefined')      return false;
  if (Notification.permission === 'granted')    return true;
  if (Notification.permission === 'denied')     return false;
  try {
    const r = await Notification.requestPermission();
    return r === 'granted';
  } catch { return false; }
}

async function showRecordingNotification() {
  if (typeof Notification === 'undefined')   return;
  if (Notification.permission !== 'granted') return;

  const title = '🔴 Recording in progress';
  const body  = 'Bug Report Agent is dictating. Use the buttons below to stop or return to the tab.';
  const tag   = 'bra-recording';

  // Prefer the Service Worker path — it's the ONLY way to render the Stop
  // and Open-tab action buttons in Chrome / Edge / Firefox. Without SW,
  // the `actions` array is silently ignored and we'd only get a clickable
  // body, which is acceptable but inferior UX.
  const swReg = window.__braSwReg;
  if (swReg && typeof swReg.showNotification === 'function') {
    try {
      await swReg.showNotification(title, {
        body,
        tag,
        requireInteraction: true,
        silent: true,
        actions: [
          { action: 'stop', title: '🛑 Stop' },
          { action: 'open', title: '↩ Open tab' },
        ],
      });
      // SW-owned notifications can't be closed via a JS handle from the
      // page — we close them by re-fetching by tag in closeRecordingNotification.
      activeNotif = null;
      return;
    } catch {
      // Fall through to the plain-Notification path below.
    }
  }

  // Fallback: plain Notification. No action buttons; clicking the body
  // both stops recording AND focuses the tab so the user gets feedback.
  try {
    activeNotif = new Notification(title, {
      body: 'Click this notification to STOP recording and bring the tab to focus.',
      tag,
      requireInteraction: true,
      silent: true,
    });
    activeNotif.onclick = () => {
      try { stopRec(); } catch {}
      try { window.focus(); } catch {}
      try { activeNotif && activeNotif.close(); } catch {}
      activeNotif = null;
    };
  } catch {}
}

async function closeRecordingNotification() {
  // Plain-Notification path: we hold a JS handle.
  if (activeNotif) {
    try { activeNotif.close(); } catch {}
    activeNotif = null;
  }
  // SW path: look up the tagged notification on the registration and close it.
  const swReg = window.__braSwReg;
  if (swReg && typeof swReg.getNotifications === 'function') {
    try {
      const list = await swReg.getNotifications({ tag: 'bra-recording' });
      list.forEach(n => n.close());
    } catch {}
  }
}

function onVisibilityChange() {
  if (!isRec) return;
  if (document.hidden) {
    showRecordingNotification();
  } else {
    closeRecordingNotification();
  }
}

// Single global subscription — startRec calls this idempotently so we
// don't keep adding duplicate listeners on every recording session.
function ensureVisibilityHook() {
  if (visibilityHooked) return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityHooked = true;
}

// ── Picture-in-Picture floating controller ────────────────────────────────
// The "right" way to control a recording from another tab: open a tiny
// always-on-top window with a STOP button. The Document Picture-in-Picture
// API (Chrome / Edge 116+) creates a real OS-level mini-window that stays
// visible no matter which tab or app is focused. Far more discoverable than
// a system tray notification (which Focus Assist or the user can miss).
//
// Browser support:
//   Chrome / Edge 116+ : yes
//   Firefox / Safari   : no → graceful fallback to the system notification
//
// User gesture: requestWindow() MUST be invoked synchronously inside a user
// gesture (the mic button click). We call openPipController() right after
// recog.start() in startRec, while the click activation is still alive.
//
// MODES:
// The window has two states. While Web Speech is active we're in 'rec' mode:
// the body shows live transcript and the foot has two controls — a Pause
// button (halts recognition but keeps the window open so the user can edit
// the transcript) and a red Stop button (fully ends the session and closes
// the window, identical to tapping the main mic button). Pause flips the
// window into 'edit' mode: the body becomes contenteditable, prefilled
// with the full textarea content, and the foot shows "Resume" + "Apply &
// close". This lets the user fix recognition mistakes right there without
// having to chase the cursor in the main page.
//
// pipPauseRequested is the signal from the PiP Pause button to recog.onend
// telling it "user paused from PiP, transition to edit mode rather than
// the usual closePipController()". Cleared after onend consumes it.

let pipWindow         = null;
let pipMode           = 'rec';   // 'rec' | 'edit'
let pipPauseRequested = false;

function normalizePipEditableText(s) {
  return String(s || '').replace(/^[\s\u00a0]+/, '');
}

async function openPipController() {
  if (pipWindow) return;                                    // already open
  if (!('documentPictureInPicture' in window)) return;      // unsupported

  // Only ONE Document PiP window is allowed at a time browser-side. If the
  // Session-PiP (Batch) was somehow left open, requestWindow() below would
  // refuse to give us a window — close it first so Single Report's PiP can
  // come up cleanly.
  try { if (typeof sessionPip !== 'undefined' && sessionPip && typeof onSessionPipStop === 'function') onSessionPipStop(); } catch {}

  try {
    const win = await documentPictureInPicture.requestWindow({
      width:  440,
      height: 460,
    });
    pipWindow = win;

    const doc = win.document;
    doc.title = 'BRA · Recording';

    // Pull the same Google Fonts the main app uses so the floating window
    // looks like it's a real sub-view of the app, not a third-party popup.
    const fonts = doc.createElement('link');
    fonts.rel  = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';
    doc.head.appendChild(fonts);

    // Mirror the main palette (see css/styles.css :root). Self-contained
    // here so PiP renders correctly even if the host stylesheet hasn't
    // finished loading or fails (the PiP document is its own DOM).
    const style = doc.createElement('style');
    style.textContent = `
      :root {
        color-scheme: dark;
        --bg:#0c0c0e; --surface:#141417; --surface2:#1c1c21; --surface3:#222228;
        --border:rgba(255,255,255,0.07); --border-md:rgba(255,255,255,0.13);
        --text:#ededee; --muted:#7a7a85; --dim:#45454f;
        --accent:#d4ff47; --accent-dim:rgba(212,255,71,0.1); --accent-ink:#111800;
        --red:#ff5e57; --red-dim:rgba(255,94,87,0.1);
        --r:10px; --r-sm:6px;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0; width: 100%; height: 100%;
        background: var(--bg); color: var(--text);
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 13px; line-height: 1.5;
        overflow: hidden; user-select: none;
      }
      .wrap { display: flex; flex-direction: column; height: 100%; }

      .head {
        padding: 11px 14px;
        background: var(--surface2);
        border-bottom: 0.5px solid var(--border);
        display: flex; align-items: center; gap: 10px;
      }
      .logo-mark {
        width: 26px; height: 26px;
        background: var(--accent);
        border-radius: var(--r-sm);
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; flex-shrink: 0;
      }
      .head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
      .head-title {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; color: var(--text);
        text-transform: uppercase; letter-spacing: .08em; font-weight: 500;
      }
      .head-sub {
        font-size: 11px; color: var(--muted);
        display: flex; align-items: center; gap: 7px;
      }
      .rec-dot {
        width: 7px; height: 7px;
        background: var(--red); border-radius: 50%;
        animation: blink 1.2s ease-in-out infinite;
        box-shadow: 0 0 8px rgba(255, 94, 87, .55);
      }
      @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      /* Siri-style equalizer shown in GPT-4o mode (no live transcript). Bars
         grow symmetrically from the centre line, each with a colour along a
         cyan→purple→pink gradient and a soft glow. Heights are driven by the
         live mic level (updatePipEqLevel) with a per-bar wobble for a lively
         flow — flat when silent, dancing when the user speaks. */
      .pip-rec { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; }
      .pip-eq { display: flex; align-items: center; justify-content: center; gap: 6px; height: 64px; }
      .pip-eq span {
        width: 7px; height: 4px; border-radius: 999px;
        background: #a78bfa; box-shadow: 0 0 12px rgba(167,139,250,.5);
        transition: height 80ms cubic-bezier(.4, 0, .2, 1);
      }
      .pip-eq span:nth-child(1) { background: #5ee7ff; box-shadow: 0 0 12px rgba(94,231,255,.5); }
      .pip-eq span:nth-child(2) { background: #7cc4ff; box-shadow: 0 0 12px rgba(124,196,255,.5); }
      .pip-eq span:nth-child(3) { background: #9aa7fb; box-shadow: 0 0 12px rgba(154,167,251,.5); }
      .pip-eq span:nth-child(4) { background: #a78bfa; box-shadow: 0 0 12px rgba(167,139,250,.5); }
      .pip-eq span:nth-child(5) { background: #c08bf0; box-shadow: 0 0 12px rgba(192,139,240,.5); }
      .pip-eq span:nth-child(6) { background: #df7ddb; box-shadow: 0 0 12px rgba(223,125,219,.5); }
      .pip-eq span:nth-child(7) { background: #f472b6; box-shadow: 0 0 12px rgba(244,114,182,.5); }
      .pip-rec-label { font-size: 13px; color: var(--muted); font-style: normal; text-align: center; }
      .lang-pill {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; color: var(--muted);
        background: var(--surface3);
        padding: 3px 8px; border-radius: 999px;
        text-transform: uppercase; letter-spacing: .07em; font-weight: 500;
      }

      .body {
        flex: 1; padding: 18px 18px;
        background: var(--bg);
        overflow-y: auto; overflow-x: hidden;
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        font-size: 16px; line-height: 1.6;
        font-weight: 400;
        color: var(--text);
        white-space: pre-wrap; word-wrap: break-word;
        user-select: text; cursor: text;
      }
      .body.empty {
        color: var(--dim); font-style: italic;
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 24px;
        font-size: 14px;
      }
      .body .interim { color: var(--muted); font-style: italic; }
      .body.editable {
        cursor: text;
        outline: none;
        caret-color: var(--accent);
      }
      .body.editable:focus {
        background: var(--surface);
        box-shadow: inset 0 0 0 1px var(--border-md);
      }
      .body::-webkit-scrollbar { width: 6px; }
      .body::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 3px; }
      .body::-webkit-scrollbar-thumb:hover { background: var(--dim); }

      .foot {
        padding: 10px 12px;
        background: var(--surface);
        border-top: 0.5px solid var(--border);
        display: flex; gap: 8px;
      }
      .stop-btn {
        flex: 1;
        background: var(--red); color: #fff;
        border: 0; padding: 10px 22px;
        border-radius: 999px;
        font-size: 13px; font-weight: 600;
        cursor: pointer; font-family: 'DM Sans', sans-serif;
        transition: background 120ms, transform 80ms;
        display: flex; align-items: center; justify-content: center; gap: 6px;
      }
      .stop-btn:hover  { background: #e54a44; }
      .stop-btn:active { transform: scale(.97); }
      .stop-btn .x {
        width: 14px; height: 14px; border-radius: 50%;
        background: rgba(255,255,255,.25);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; line-height: 1; font-weight: 700;
      }
      .resume-btn, .pause-btn {
        background: var(--surface3); color: var(--text);
        border: 0.5px solid var(--border-md);
        padding: 10px 16px;
        border-radius: 999px;
        font-size: 13px; font-weight: 500;
        cursor: pointer; font-family: 'DM Sans', sans-serif;
        transition: background 120ms, transform 80ms;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        white-space: nowrap; flex-shrink: 0;
      }
      .resume-btn:hover, .pause-btn:hover  { background: #2a2a30; }
      .resume-btn:active, .pause-btn:active { transform: scale(.97); }
      .done-btn {
        flex: 1;
        background: var(--accent); color: var(--accent-ink);
        border: 0; padding: 10px 22px;
        border-radius: 999px;
        font-size: 13px; font-weight: 600;
        cursor: pointer; font-family: 'DM Sans', sans-serif;
        transition: background 120ms, transform 80ms;
        display: flex; align-items: center; justify-content: center; gap: 6px;
      }
      .done-btn:hover  { background: #c5f039; }
      .done-btn:active { transform: scale(.97); }
      .rec-dot.paused {
        animation: none;
        background: var(--muted);
        box-shadow: none;
        opacity: .4;
      }
      .rec-dot.transcribing { animation: none; background: #60afff; box-shadow: 0 0 8px rgba(96,175,255,.55); }
      /* Spinner shown on the Pause button (and in the body) while the dictated
         chunk is being transcribed by GPT-4o after a Pause. */
      .pip-spin {
        display: inline-block; width: 13px; height: 13px;
        border: 2px solid rgba(255,255,255,.25); border-top-color: #fff;
        border-radius: 50%; animation: pipspin .7s linear infinite;
        vertical-align: -2px;
      }
      .pip-spin-lg { width: 30px; height: 30px; border-width: 3px; border-top-color: #60afff; vertical-align: 0; }
      @keyframes pipspin { to { transform: rotate(360deg); } }
      .pause-btn:disabled, .stop-btn:disabled { cursor: default; opacity: .55; }
    `;
    doc.head.appendChild(style);

    const langText = (lang === 'en-US') ? 'EN' : 'УК';

    doc.body.innerHTML = `
      <div class="wrap">
        <div class="head">
          <div class="logo-mark">🐛</div>
          <div class="head-text">
            <div class="head-title">Bug Report Agent</div>
            <div class="head-sub"><span class="rec-dot" id="pipRecDot"></span><span id="pipHeadLabel">Recording — live transcript below</span></div>
          </div>
          <span class="lang-pill">${langText}</span>
        </div>
        <div class="body empty" id="pipBody">Waiting for speech…</div>
        <div class="foot">
          <button class="pause-btn" id="pipPauseBtn">⏸ Pause</button>
          <button class="stop-btn" id="pipStopBtn"><span class="x">■</span> Stop recording</button>
          <button class="resume-btn" id="pipResumeBtn" style="display:none">🎙 Resume</button>
          <button class="done-btn" id="pipDoneBtn" style="display:none">✓ Apply &amp; close</button>
        </div>
      </div>
    `;

    doc.getElementById('pipPauseBtn').addEventListener('click', () => {
      // Mark BEFORE stopRec so recog.onend knows to flip the window into
      // edit mode instead of closing it. stopRec lives in the parent window.
      pipPauseRequested = true;
      // GPT-4o: Pause kicks off a transcription network call — surface a
      // spinner immediately so the wait is obvious.
      if (cfg.voiceAiCleanup === 'gpt4o-transcribe') showPipTranscribing();
      try { stopRec(); } catch {}
    });

    doc.getElementById('pipStopBtn').addEventListener('click', () => {
      // Plain stop — same behaviour as the main mic button. recog.onend
      // will close the PiP window because pipPauseRequested stays false.
      try { stopRec(); } catch {}
    });

    doc.getElementById('pipResumeBtn').addEventListener('click', () => {
      // Treat the user's edits as the new starting point for the next
      // dictation session: write them back to the textarea so startRec()
      // picks them up as baseText, then re-arm recognition. The PiP itself
      // stays open and we flip back to 'rec' mode.
      const body = doc.getElementById('pipBody');
      if (body) document.getElementById('tin').value = normalizePipEditableText(body.innerText);
      try { startRec(); } catch {}
    });

    doc.getElementById('pipDoneBtn').addEventListener('click', () => {
      // Final commit: write the edited transcript to the main textarea
      // (it was already being kept in sync by the input listener below,
      // but do it once more to be defensive against missed events) and
      // close the floating window for good.
      const body = doc.getElementById('pipBody');
      if (body) document.getElementById('tin').value = normalizePipEditableText(body.innerText);
      closePipController();
    });

    // Live-sync edits in the PiP body back to the main textarea so the
    // user never loses keystrokes — even if they close the PiP via the
    // OS-level X button instead of "Apply & close".
    doc.getElementById('pipBody').addEventListener('input', () => {
      if (pipMode !== 'edit') return;
      const body = doc.getElementById('pipBody');
      document.getElementById('tin').value = normalizePipEditableText(body.innerText);
    });

    // If the user closes the PiP window themselves (X button), null out
    // our refs so the next recording session can open a fresh one. If
    // they were mid-edit, the input listener already mirrored the latest
    // text to the textarea, so nothing is lost.
    win.addEventListener('pagehide', () => {
      pipWindow = null;
      pipMode   = 'rec';
    });

    // Now that the window actually exists, render the current (rec) mode so
    // the GPT-4o recording visualizer appears IMMEDIATELY on open — the
    // setPipMode('rec') call in startRec ran before requestWindow() resolved
    // (pipWindow was still null), so it no-op'd.
    setPipMode('rec');

  } catch (err) {
    // Most common failure: requestWindow called outside a user gesture
    // (e.g. on a tab that's already hidden). We fall back silently to the
    // notification — user still has a way to stop.
    console.warn('PiP controller failed:', err);
    pipWindow = null;
  }
}

// Push the current dictation state to the PiP window. Called from
// recog.onresult on every speech frame. Shows the pre-existing textarea
// content (baseText — what was there when the user tapped the mic, OR
// what they just edited in edit-mode before clicking Resume) followed by
// committed (finalized) dictation in white, followed by the live interim
// guess in italicized muted color. This way the floating window mirrors
// exactly what's accumulating in the main textarea, and Resume picks up
// visibly where it left off rather than starting from a blank screen.
function updatePipTranscript(committed, interim) {
  if (!pipWindow) return;
  // Don't stomp on the user's edits if we somehow got here while the
  // window is in edit mode. updatePipTranscript only makes sense while
  // recognition is actively producing frames.
  if (pipMode !== 'rec') return;
  try {
    const body = pipWindow.document.getElementById('pipBody');
    if (!body) return;

    const seed  = (baseText  || '').trim();
    const final = (committed || '').trim();
    const live  = (interim   || '').trim();

    if (!seed && !final && !live) {
      body.classList.add('empty');
      body.textContent = 'Waiting for speech…';
      return;
    }

    // Speech transcripts are arbitrary user audio — escape before injecting.
    const esc = s => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    body.classList.remove('empty');
    let html = '';
    if (seed)  html += esc(seed);
    if (final) html += (html ? ' ' : '') + esc(final);
    if (live)  html += (html ? ' ' : '') + '<span class="interim">' + esc(live) + '</span>';
    body.innerHTML = html;

    // Keep the latest text visible — auto-scroll to the bottom whenever
    // content grows. Users can still scroll up manually to re-read; we
    // only force-scroll because new text appended to the bottom anyway.
    body.scrollTop = body.scrollHeight;
  } catch {}
}

function closePipController() {
  if (!pipWindow) return;
  try { pipWindow.close(); } catch {}
  pipWindow = null;
  pipMode   = 'rec';
}

// Flip the floating window between live-recording and edit modes.
//   'rec'  — body is read-only, auto-updated from recog.onresult, header
//            shows a blinking red dot, foot shows the Stop button.
//   'edit' — body is contenteditable (plaintext-only), prefilled with
//            whatever sits in the main textarea so the user has the full
//            context to edit; foot shows Resume + Apply & close. The dot
//            goes grey/static so a glance at the window tells the user
//            recognition is paused.
function setPipMode(mode) {
  if (!pipWindow) return;
  pipMode = mode;
  const doc = pipWindow.document;
  const body      = doc.getElementById('pipBody');
  const pauseBtn  = doc.getElementById('pipPauseBtn');
  const stopBtn   = doc.getElementById('pipStopBtn');
  const resumeBtn = doc.getElementById('pipResumeBtn');
  const doneBtn   = doc.getElementById('pipDoneBtn');
  const dot       = doc.getElementById('pipRecDot');
  const label     = doc.getElementById('pipHeadLabel');
  if (!body || !pauseBtn || !stopBtn || !resumeBtn || !doneBtn) return;

  if (mode === 'edit') {
    // Pull the full current textarea content into the body so the user
    // can edit everything — both anything that was in the textarea before
    // they started dictating AND the freshly transcribed text.
    body.classList.remove('empty');
    body.innerHTML = '';
    body.textContent = normalizePipEditableText(document.getElementById('tin').value);
    // plaintext-only is a Chromium feature; PiP is Chromium-only too,
    // so this is safe and gives us a textarea-like contenteditable
    // (no rich-text from pastes, Enter inserts a real newline).
    body.setAttribute('contenteditable', 'plaintext-only');
    body.classList.add('editable');

    pauseBtn.style.display  = 'none';
    stopBtn.style.display   = 'none';
    resumeBtn.style.display = 'flex';
    doneBtn.style.display   = 'flex';

    if (dot)   dot.classList.add('paused');
    if (label) label.textContent = 'Paused — edit transcript, then Resume or Apply';

    // Drop the user straight into editing with the caret at the end —
    // saves a click and matches "I want to fix the last word" intent.
    try {
      body.focus();
      const range = doc.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      const sel = pipWindow.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  } else {
    // Back to rec mode — disable editing and seed the body with whatever
    // was already in the textarea (baseText). On Resume from edit mode
    // this shows the user their previously-dictated/edited text so new
    // dictation visibly appends to the bottom rather than starting from
    // a blank "Waiting for speech…" screen. On a fresh recording start
    // with an empty textarea, baseText is '' and we fall back to the
    // empty-state message as before.
    body.removeAttribute('contenteditable');
    body.classList.remove('editable');

    const gpt4o = (cfg.voiceAiCleanup === 'gpt4o-transcribe');
    const seed  = (baseText || '').trim();
    if (gpt4o) {
      // No live transcript in GPT-4o mode — show an animated equalizer so the
      // window visibly conveys recording; the text lands here in edit mode
      // once the user Pauses or Stops.
      body.classList.add('empty');
      body.innerHTML =
        '<div class="pip-rec">' +
          eqBarsMarkup('pipEq') +
          '<div class="pip-rec-label">Recording — text appears when you Pause or Stop</div>' +
        '</div>';
    } else if (seed) {
      const esc = s => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      body.classList.remove('empty');
      body.innerHTML = esc(seed);
    } else {
      body.classList.add('empty');
      body.innerHTML = '';
      body.textContent = 'Waiting for speech…';
    }

    pauseBtn.style.display  = 'flex';
    stopBtn.style.display   = 'flex';
    resumeBtn.style.display = 'none';
    doneBtn.style.display   = 'none';
    // Clear any leftover "transcribing" spinner state from a previous Pause.
    pauseBtn.disabled = false; pauseBtn.innerHTML = '⏸ Pause';
    stopBtn.disabled  = false; stopBtn.style.opacity = '';

    if (dot)   dot.classList.remove('paused', 'transcribing');
    if (label) label.textContent = gpt4o ? 'Recording — transcribes on Pause / Stop' : 'Recording — live transcript below';
  }
}

// Put the floating window into a "transcribing" state the moment GPT-4o Pause
// is tapped: a spinner on the Pause button + a spinner in the body, so the
// (1–3s) network transcription is obviously in progress. Cleared when the
// result arrives and setPipMode('edit') / ('rec') runs.
function showPipTranscribing() {
  if (!pipWindow) return;
  const doc      = pipWindow.document;
  const pauseBtn = doc.getElementById('pipPauseBtn');
  const stopBtn  = doc.getElementById('pipStopBtn');
  const label    = doc.getElementById('pipHeadLabel');
  const dot      = doc.getElementById('pipRecDot');
  const body     = doc.getElementById('pipBody');
  if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.innerHTML = '<span class="pip-spin"></span> Transcribing…'; }
  if (stopBtn)  { stopBtn.disabled = true; }
  if (label)    label.textContent = 'Transcribing with GPT-4o…';
  if (dot)      { dot.classList.remove('paused'); dot.classList.add('transcribing'); }
  if (body)     {
    body.classList.add('empty');
    body.innerHTML =
      '<div class="pip-rec"><span class="pip-spin pip-spin-lg"></span>' +
      '<div class="pip-rec-label">Transcribing with GPT-4o…</div></div>';
  }
}

// ── microphone keep-alive + level meter ───────────────────────────────────
// Web Speech API exposes NO sensitivity / gain controls — audio goes from
// the OS input device straight into the browser's recognizer and there is
// no JS knob for it. What we CAN do about "it doesn't hear my words":
//   1. Hold a parallel getUserMedia stream for the whole recording. Without
//      it the input device is re-acquired on EVERY internal auto-restart
//      (Chrome ends a session after a few seconds of silence — see onend).
//      With Bluetooth headsets that re-acquisition includes an audio-profile
//      switch, during which the first words after a pause are simply lost.
//      A held stream keeps the device open, so restarts resume instantly.
//   2. Drive a live input-level meter from that stream and show the name of
//      the device the browser actually picked. If the bar doesn't move
//      while you speak, the OS routed the wrong mic (e.g. laptop built-in
//      instead of the headset) or its level is near zero — otherwise
//      indistinguishable from "the recognizer ignored me".
// Both are best-effort: if getUserMedia fails, recognition works as before.
let micStream = null;
let micCtx    = null;
let micTimer  = 0;
// GPT-4o Transcribe audio capture (see createAudioSession). Batch cards hold
// their own session per card; this slot belongs to the Single-Report mic.
let audioSession = null;

// ── recognizer liveness watchdog ──────────────────────────────────────────
// Chrome's continuous SpeechRecognition is flaky: after a silence it fires
// `onend`, and the naive "call recog.start() again" sometimes resurrects a
// FROZEN session — start() succeeds and onstart fires, but no `onresult`
// ever comes. The level meter keeps moving (it runs off our own
// getUserMedia stream, not the recognizer), so the user sees "audio is
// flowing but no text appears". We defeat this with two mechanisms:
//   1. On every restart we build a FRESH recognizer (createRecognizer)
//      instead of reusing the dead object — a reused instance is what tends
//      to freeze.
//   2. A watchdog cross-checks the audio meter against transcription
//      progress: if sound is arriving (lastLoudAt recent) but no result has
//      landed for a few seconds (lastResultAt stale), the session is frozen
//      and we force a fresh restart.
let lastResultAt = 0;   // Date.now() of the last onstart/onresult
let lastLoudAt   = 0;   // Date.now() of the last above-threshold audio frame
let recogWatchdog = 0;  // setInterval handle
let restartTimer  = 0;  // debounce handle for scheduleRestart

async function acquireMicStream() {
  if (micStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch { return; }

  // Fresh recording → start the equalizer from rest (drop any residual level
  // and reset the wobble phase).
  eqLevel = 0; eqFrame = 0;

  // Two level bars share this loop: #vLive on the Single Report voice area
  // and #sLive at the top of the Batch tab. Both exist in the DOM at all
  // times; only the visible sub-tab's bar is actually seen.
  ['vLive', 'sLive'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  });

  try {
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = micCtx.createAnalyser();
    analyser.fftSize = 512;
    micCtx.createMediaStreamSource(micStream).connect(analyser);
    const buf   = new Uint8Array(analyser.fftSize);
    const fills = ['vMeterFill', 'sMeterFill']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    // setInterval, NOT requestAnimationFrame: rAF freezes in background
    // tabs, and monitoring the mic from another tab (PiP open) is exactly
    // when the user needs the meter alive.
    micTimer = setInterval(() => {
      if (!micStream) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = (buf[i] - 128) / 128;
        sum += d * d;
      }
      const rms = Math.sqrt(sum / buf.length);
      // ~0.3 RMS is already loud speech — scale so normal voice fills most
      // of the bar and quiet-but-audible speech is clearly visible.
      const pct = Math.min(100, Math.round(rms * 300)) + '%';
      fills.forEach(f => { f.style.width = pct; });
      // Drive the GPT-4o recording equalizer in the floating window(s) from the
      // same live level so the bars only come alive when the user speaks.
      updatePipEqLevel(rms);
      // Liveness signal for the recognizer watchdog: remember when we last
      // heard real audio (above background noise). 0.045 sits just above
      // typical room hiss and below quiet speech.
      if (rms > 0.045) lastLoudAt = Date.now();
    }, 70);   // 70ms ≈ 14fps — smooth enough for the bars without churn
  } catch {} // meter is optional — keep-alive still holds the device
}

// ── Siri-style equalizer (GPT-4o recording visualizer) ────────────────────
// A small set of centre-anchored bars that grow with the live mic level. Each
// bar also carries a per-bar, time-varying "wobble" so the row dances like
// Siri instead of moving as one rigid block. Amplitude comes purely from the
// (smoothed) voice level, so the bars sit flat when silent and come alive only
// when the user speaks.
const EQ_BARS    = 7;
// Centre bars taller than the edges (classic Siri silhouette).
const EQ_WEIGHTS = [0.5, 0.72, 0.9, 1, 0.9, 0.72, 0.5];
let eqLevel = 0;   // smoothed 0..1 level
let eqFrame = 0;   // tick counter driving the wobble (NOT Date.now — stable)

// Markup helper shared by the Single PiP ('pipEq') and the Batch PiP ('spipEq')
// so the bar count always matches EQ_BARS.
function eqBarsMarkup(id) {
  return '<div class="pip-eq" id="' + id + '">' + '<span></span>'.repeat(EQ_BARS) + '</div>';
}

// Feed the live mic level (RMS, ~0..0.4 for speech) into the equalizer and
// repaint the bars in whichever floating window is open. No-op outside GPT-4o
// mode.
//
// Sensitivity: raw RMS of normal speech sits around 0.03–0.15, which a linear
// scale renders as barely-moving bars. We gate out room hiss, then apply a
// square-root curve so QUIET speech is already clearly visible, and use
// VU-meter ballistics — fast attack (bars jump up the instant you speak),
// slower decay (they fall back smoothly) — so the equalizer visibly reacts
// to every word.
function updatePipEqLevel(rms) {
  if (cfg.voiceAiCleanup !== 'gpt4o-transcribe') return;
  const gated = Math.max(0, rms - 0.006);          // ignore background hiss
  const lvl   = Math.min(1, Math.sqrt(gated * 9)); // 0.03 rms → ~0.47, 0.12 → ~1
  eqLevel = lvl > eqLevel
    ? eqLevel * 0.30 + lvl * 0.70                  // fast attack
    : eqLevel * 0.80 + lvl * 0.20;                 // slow, smooth decay
  eqFrame++;
  const heights = new Array(EQ_BARS);
  for (let i = 0; i < EQ_BARS; i++) {
    // Shallow, slow wobble → fluid Siri-like flow that keeps the centre-
    // weighted silhouette readable instead of jittering bar-to-bar. The
    // floor sits high (0.56) so the wobble adds life without eating the
    // perceived loudness.
    const wobble = 0.78 + 0.22 * Math.sin(eqFrame * 0.42 + i * 0.9);
    heights[i] = 4 + Math.round(eqLevel * EQ_WEIGHTS[i] * wobble * 44);   // 4..48 px
  }
  const paint = (winDoc, id) => {
    try {
      const wrap = winDoc && winDoc.getElementById(id);
      if (!wrap) return;
      const bars = wrap.children;
      for (let i = 0; i < bars.length && i < EQ_BARS; i++) bars[i].style.height = heights[i] + 'px';
    } catch {}
  };
  if (pipWindow && pipMode === 'rec') paint(pipWindow.document, 'pipEq');
  if (typeof sessionPip !== 'undefined' && sessionPip) paint(sessionPip.document, 'spipEq');
}

function releaseMicStream() {
  stopRecogWatchdog();
  if (micTimer) { clearInterval(micTimer); micTimer = 0; }
  if (micStream) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch {}
    micStream = null;
  }
  if (micCtx) { try { micCtx.close(); } catch {} micCtx = null; }
  ['vLive', 'sLive'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  ['vMeterFill', 'sMeterFill'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = '0%';
  });
}

// Build a fresh SpeechRecognition with all handlers wired. Used both for the
// initial start and for every auto-restart — a brand-new instance avoids
// Chrome's frozen-session bug that a reused object falls into. All handlers
// read module-level state only, so the fresh instance behaves identically.
function createRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = lang;
  r.continuous = true;
  r.interimResults = true;
  r.onstart   = onRecogStart;
  r.onresult  = onRecogResult;
  r.onend     = onRecogEnd;
  r.onerror   = onRecogError;
  return r;
}

// Debounced, fresh-instance restart. Discards the old (possibly frozen)
// recognizer — silencing its handlers first so its abort-triggered onend
// can't recursively schedule another restart — then starts a new one.
function scheduleRestart(delay) {
  if (restartTimer) return;                 // a restart is already pending
  restartTimer = setTimeout(() => {
    restartTimer = 0;
    if (userStopped || !isRec) return;
    prevFrameFinal = '';                     // next frame is a clean append
    if (recog) {
      try { recog.onend = null; recog.onerror = null; recog.onresult = null; recog.abort(); } catch {}
    }
    try {
      recog = createRecognizer();
      if (recog) recog.start();
      // Give the fresh session a grace window before the watchdog can judge
      // it dead.
      lastResultAt = Date.now();
    } catch {
      // start() throws if Chrome is still tearing the old session down —
      // back off and try again shortly.
      scheduleRestart(500);
    }
  }, delay == null ? 250 : delay);
}

function startRecogWatchdog() {
  if (recogWatchdog) return;
  lastResultAt = Date.now();
  recogWatchdog = setInterval(() => {
    if (!isRec || userStopped) return;
    const now = Date.now();
    // Audio is arriving right now but nothing has been transcribed for a
    // while → the recognizer froze. Force a fresh restart.
    if (now - lastLoudAt < 1500 && now - lastResultAt > 3500) {
      lastResultAt = now;                    // avoid thrashing while it recovers
      try { document.getElementById('vHt').textContent = 'Reconnecting the recognizer…'; } catch {}
      scheduleRestart(0);
    }
  }, 1200);
}

function stopRecogWatchdog() {
  if (recogWatchdog) { clearInterval(recogWatchdog); recogWatchdog = 0; }
  if (restartTimer)  { clearTimeout(restartTimer);   restartTimer  = 0; }
}

function gpt4oTranscribeEnabled() {
  return cfg.voiceAiCleanup === 'gpt4o-transcribe';
}

function transcribeLanguageHint(recLang) {
  return String(recLang || '').toLowerCase().startsWith('uk') ? 'uk'
    : String(recLang || '').toLowerCase().startsWith('en') ? 'en'
      : '';
}

// Create an INDEPENDENT audio-recording session on the held mic stream.
// Each session owns its MediaRecorder and chunk buffer in a closure, so
// overlapping recordings can't clobber each other — critical for the Batch
// "+ Add bug" flow, where card N's audio is still being finalized while
// card N+1 already records (multiple MediaRecorders on one MediaStream are
// allowed). Returns { stop({discard}) → Promise<Blob|null> } or null.
function createAudioSession() {
  if (!gpt4oTranscribeEnabled() || !micStream || typeof MediaRecorder === 'undefined') return null;
  try {
    const preferred = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    const chunks = [];
    const rec = preferred ? new MediaRecorder(micStream, { mimeType: preferred }) : new MediaRecorder(micStream);
    rec.ondataavailable = e => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.start();
    return {
      stop(opts) {
        const discard = opts && opts.discard;
        return new Promise(resolve => {
          const type = rec.mimeType || 'audio/webm';
          const finish = () => {
            if (discard || !chunks.length) { resolve(null); return; }
            resolve(new Blob(chunks, { type }));
          };
          try {
            rec.onstop = finish;
            if (rec.state === 'inactive') finish();
            else rec.stop();
          } catch {
            finish();
          }
        });
      },
    };
  } catch {
    return null;
  }
}

// Single-Report mic keeps the simple start/stop pair — it never overlaps
// with itself, so one module-level "current session" is enough.
function startTranscribeRecording() {
  audioSession = createAudioSession();
}

function stopTranscribeRecording(opts) {
  const s = audioSession;
  audioSession = null;
  return s ? s.stop(opts || {}) : Promise.resolve(null);
}

// ── recognizer event handlers (module-level so createRecognizer can wire a
//    fresh instance on every restart) ──────────────────────────────────────
function onRecogStart() {
  lastResultAt = Date.now();
  isRec = true;
  document.getElementById('micBtn').classList.add('rec');
  // GPT-4o Transcribe records cleanly and reveals text only on Pause/Stop —
  // so the status reflects "recording" rather than "live transcribing".
  const gpt4o = (cfg.voiceAiCleanup === 'gpt4o-transcribe');
  document.getElementById('vSt').textContent = gpt4o ? '🔴 Recording…' : 'Listening…';
  document.getElementById('vHt').textContent = gpt4o
    ? 'Speak freely — GPT-4o transcribes your audio when you Pause or Stop'
    : 'Tap again to stop · floating Stop button on your desktop works from any tab';
  document.getElementById('vHt').classList.add('rec');
  setRecordingBadges(true);
  // If the user started recording while the tab was already in the
  // background (unlikely but possible via keyboard shortcut), surface
  // the notification immediately so they know it's running.
  if (document.hidden) showRecordingNotification();
}

function onRecogResult(e) {
  lastResultAt = Date.now();   // liveness ping for the watchdog
  // GPT-4o Transcribe mode shows NO live draft: the recorder captures clean
  // audio and the polished text appears only after Pause/Stop (ChatGPT-style).
  // We still let Web Speech run (it drives the start/stop lifecycle) but drop
  // its low-quality interim text so nothing jumpy lands in the textarea.
  if (cfg.voiceAiCleanup === 'gpt4o-transcribe') return;
  // Re-collect the full state of this frame (Chrome may give us several
  // result entries — some final, some interim). We stitch them, then
  // diff against the previous frame to figure out what's new.
  let frameFinal   = '';
  let frameInterim = '';
  for (let i = 0; i < e.results.length; i++) {
    const r = e.results[i];
    if (r.isFinal) {
      frameFinal += (frameFinal ? ' ' : '') + r[0].transcript.trim();
    } else {
      frameInterim += r[0].transcript;
    }
  }

  let delta;
  if (frameFinal.startsWith(prevFrameFinal)) {
    // Normal case: Chrome accumulated on top of the previous frame.
    delta = frameFinal.slice(prevFrameFinal.length).trim();
  } else {
    // Reset case: Chrome wiped its internal buffer mid-session (happens
    // after silence). Commit what the previous frame held, then treat
    // the whole new frame as a fresh chunk.
    if (prevFrameFinal) {
      committedFinal = (committedFinal + ' ' + prevFrameFinal).trim();
    }
    delta = frameFinal.trim();
  }
  if (delta) {
    committedFinal = (committedFinal + ' ' + delta).trim();
  }
  prevFrameFinal = frameFinal;

  // Apply the Context-words glossary to the LIVE transcript so unique
  // terms the recognizer mis-hears (e.g. "OTP" → "OTB Calendar") get
  // rewritten to their exact spelling AS you speak — for both the
  // finalized text and the in-progress interim phrase. We correct the
  // whole committed string each frame (not per-chunk) so multi-word
  // phrases split across recognition frames still match.
  const committedShown = (typeof correctTranscript === 'function')
    ? correctTranscript(committedFinal) : committedFinal;
  const interimShown = (typeof correctTranscript === 'function')
    ? correctTranscript(frameInterim.trim()) : frameInterim.trim();

  // Render: pre-existing textarea content + everything dictated so far +
  // the current interim guess (which will solidify into committedFinal
  // on the next isFinal callback).
  const parts = [];
  if (baseText)       parts.push(baseText);
  if (committedShown) parts.push(committedShown);
  if (interimShown)   parts.push(interimShown);
  document.getElementById('tin').value = parts.join(' ');

  // Mirror what we just dictated into the floating PiP controller (if
  // any) so the user can read the live transcript from another tab.
  updatePipTranscript(committedShown, interimShown);
}

function onRecogEnd() {
  if (!userStopped) {
    // Pause-induced session end. Auto-restart with a FRESH recognizer
    // (scheduleRestart) so the user perceives recognition as continuous;
    // reusing this ended instance is what triggers Chrome's frozen-session
    // bug. committedFinal stays intact; scheduleRestart clears prevFrameFinal
    // so the next session's first onresult is a clean append.
    scheduleRestart();
    return;
  }

  // Real stop — hand off to the shared teardown.
  teardownAfterStop();
}

// Final cleanup for a real stop: reset the UI, release the mic, and fire the
// post-stop transcription/polish. Idempotent (guards on isRec) so it's safe
// to call from BOTH onRecogEnd and stopRec's fallback path.
function teardownAfterStop() {
  if (!isRec) return;
  isRec = false;
  document.getElementById('micBtn').classList.remove('rec');
  document.getElementById('vSt').textContent = 'Tap to dictate';
  document.getElementById('vHt').textContent = 'Ukrainian or English — report will always be in English';
  document.getElementById('vHt').classList.remove('rec');
  setRecordingBadges(false);
  closeRecordingNotification();

  // If the user paused via the PiP Pause button, keep the floating
  // window open and switch it into edit mode so they can fix the
  // transcript right there. Any other stop path (PiP Stop, main mic
  // button, page navigation) closes the PiP as before.
  if (pipPauseRequested && pipWindow) {
    pipPauseRequested = false;
    if (cfg.voiceAiCleanup === 'gpt4o-transcribe') {
      // GPT-4o mode: transcribe the audio captured up to this Pause and write
      // it into the textarea FIRST, then flip to edit mode (which seeds the
      // PiP body from the textarea) so the user sees the result. Resume then
      // records a fresh chunk that appends after it.
      stopTranscribeRecording().then(audioBlob => {
        releaseMicStream();
        Promise.resolve(maybeTranscribeGpt4o(audioBlob)).finally(() => setPipMode('edit'));
      });
    } else {
      stopTranscribeRecording({ discard: true }).then(() => releaseMicStream());
      setPipMode('edit');
    }
  } else {
    closePipController();
    stopTranscribeRecording().then(audioBlob => {
      releaseMicStream();
      if (cfg.voiceAiCleanup === 'gpt4o-transcribe') maybeTranscribeGpt4o(audioBlob);
    });
  }
}

function onRecogError(e) {
  // `no-speech` is a benign error fired during long silences. If the
  // user hasn't tapped stop, let onend handle it (which will auto-
  // restart). Same for `aborted` triggered by the internal restart cycle.
  if ((e.error === 'no-speech' || e.error === 'aborted') && !userStopped) {
    return;
  }

  // Anything else is a real failure — surface it and stop for good.
  // Drop pipPauseRequested so the onend cleanup path closes the window
  // instead of stranding the user in an edit-mode PiP after an error.
  userStopped       = true;
  pipPauseRequested = false;
  isRec = false;
  stopTranscribeRecording({ discard: true }).then(() => releaseMicStream());
  document.getElementById('micBtn').classList.remove('rec');
  setRecordingBadges(false);
  closeRecordingNotification();
  closePipController();
  const msg = describeRecogError(e.error);
  if (msg) {
    document.getElementById('vSt').textContent = 'Tap to dictate';
    document.getElementById('vHt').textContent = msg;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      try { toast('⚠ ' + msg); } catch {}
    }
  }
}

function startRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  // Reset accumulators — this tap starts a fresh recording from scratch.
  // Bumping cleanupSeq invalidates any in-flight GPT-4o transcription from
  // the previous recording so its late response can't overwrite this one.
  baseText          = document.getElementById('tin').value;
  committedFinal    = '';
  prevFrameFinal    = '';
  userStopped       = false;
  pipPauseRequested = false;
  cleanupSeq++;
  lastLoudAt        = 0;

  // Lazily ask for notification permission so we can ping the user if
  // they switch tabs while recording. Fire-and-forget — if they deny,
  // we still record fine, they just won't get the background ping.
  ensureNotificationPermission();
  ensureVisibilityHook();

  recog = createRecognizer();
  if (!recog) return;

  try {
    recog.start();
    // Keep the input device open for the whole recording (feeds the level
    // meter and the recognizer watchdog). Fire-and-forget.
    acquireMicStream().then(() => startTranscribeRecording());
    startRecogWatchdog();
    // Open the floating Picture-in-Picture controller SYNCHRONOUSLY in
    // the same call stack as the user gesture (mic tap). requestWindow()
    // needs that live activation — if we move it into onstart we lose it.
    // If a PiP window already exists (e.g. user clicked Resume from edit
    // mode), openPipController returns early; we still need to flip it
    // back into 'rec' mode so the UI matches reality.
    openPipController();
    setPipMode('rec');
  } catch (err) {
    // start() throws InvalidStateError if recognition is already started —
    // happens occasionally when onend hasn't fired yet between rapid taps.
    isRec = false;
    document.getElementById('vHt').textContent = 'Mic busy — wait a sec and tap again.';
  }
}

function stopRec() {
  // Mark BEFORE calling stop() — the resulting onend must see userStopped=true
  // so it doesn't auto-restart us right after we asked to halt.
  userStopped = true;
  // If a restart was queued, the current recog instance has already ended and
  // won't fire another onend — so the normal stop-cleanup path wouldn't run.
  // Detect that and finalize directly. Read the flag BEFORE clearing it.
  const hadPendingRestart = !!restartTimer;
  // Cancel any pending watchdog restart immediately so it can't fire a fresh
  // session after the user asked to halt.
  stopRecogWatchdog();
  if (recog) {
    try { recog.stop(); } catch {}
  }
  if (hadPendingRestart) teardownAfterStop();
}

// Inline hint shown under the mic button when running via file://.
// Reminds the user that permission re-prompts are a browser behaviour,
// not an app bug, and points to the one-click fix (serve.bat).
function maybeShowMicHint() {
  if (location.protocol !== 'file:') return;
  const hintEl = document.getElementById('vHt');
  if (!hintEl) return;
  // Only nudge once per session — keep it light, not spammy.
  if (sessionStorage.getItem('bra_micHintShown') === '1') return;
  sessionStorage.setItem('bra_micHintShown', '1');
  hintEl.innerHTML =
    'Mic permission will re-prompt on every reload (file:// limitation). ' +
    'Run <strong>serve.bat</strong> once to open via http://localhost — Chrome will then remember Allow.';
}
