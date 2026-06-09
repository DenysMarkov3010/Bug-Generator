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
      if (body) document.getElementById('tin').value = body.innerText;
      try { startRec(); } catch {}
    });

    doc.getElementById('pipDoneBtn').addEventListener('click', () => {
      // Final commit: write the edited transcript to the main textarea
      // (it was already being kept in sync by the input listener below,
      // but do it once more to be defensive against missed events) and
      // close the floating window for good.
      const body = doc.getElementById('pipBody');
      if (body) document.getElementById('tin').value = body.innerText;
      closePipController();
    });

    // Live-sync edits in the PiP body back to the main textarea so the
    // user never loses keystrokes — even if they close the PiP via the
    // OS-level X button instead of "Apply & close".
    doc.getElementById('pipBody').addEventListener('input', () => {
      if (pipMode !== 'edit') return;
      const body = doc.getElementById('pipBody');
      document.getElementById('tin').value = body.innerText;
    });

    // If the user closes the PiP window themselves (X button), null out
    // our refs so the next recording session can open a fresh one. If
    // they were mid-edit, the input listener already mirrored the latest
    // text to the textarea, so nothing is lost.
    win.addEventListener('pagehide', () => {
      pipWindow = null;
      pipMode   = 'rec';
    });

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
    body.textContent = document.getElementById('tin').value;
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

    const seed = (baseText || '').trim();
    if (seed) {
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

    if (dot)   dot.classList.remove('paused');
    if (label) label.textContent = 'Recording — live transcript below';
  }
}

function startRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  // Reset accumulators — this tap starts a fresh recording from scratch.
  baseText          = document.getElementById('tin').value;
  committedFinal    = '';
  prevFrameFinal    = '';
  userStopped       = false;
  pipPauseRequested = false;

  // Lazily ask for notification permission so we can ping the user if
  // they switch tabs while recording. Fire-and-forget — if they deny,
  // we still record fine, they just won't get the background ping.
  ensureNotificationPermission();
  ensureVisibilityHook();

  recog = new SR();
  recog.lang = lang;
  recog.continuous = true;
  recog.interimResults = true;

  recog.onstart = () => {
    isRec = true;
    document.getElementById('micBtn').classList.add('rec');
    document.getElementById('vSt').textContent = 'Listening…';
    document.getElementById('vHt').textContent = 'Tap again to stop · floating Stop button on your desktop works from any tab';
    document.getElementById('vHt').classList.add('rec');
    setRecordingBadges(true);
    // If the user started recording while the tab was already in the
    // background (unlikely but possible via keyboard shortcut), surface
    // the notification immediately so they know it's running.
    if (document.hidden) showRecordingNotification();
  };

  recog.onresult = e => {
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
    // updatePipTranscript itself prepends baseText so on Resume the user
    // sees their previous text and the new dictation flowing onto it.
    updatePipTranscript(committedShown, interimShown);
  };

  recog.onend = () => {
    if (!userStopped) {
      // Pause-induced session end. Auto-restart so the user perceives
      // recognition as truly continuous. committedFinal stays intact;
      // we clear prevFrameFinal so the next session's first onresult
      // is treated as a clean append (its startsWith('') is always true,
      // so its full content lands in delta unchanged).
      prevFrameFinal = '';
      try {
        recog.start();
        return;
      } catch {
        // Chrome rate-limits start() (must be at least ~250ms apart),
        // or recognition is in a stuck state — fall through and stop.
      }
    }

    // Real stop — clean up UI.
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
      setPipMode('edit');
    } else {
      closePipController();
    }
  };

  recog.onerror = e => {
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
  };

  try {
    recog.start();
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
  if (recog) {
    try { recog.stop(); } catch {}
  }
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
