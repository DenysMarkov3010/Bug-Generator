// ── init ──────────────────────────────────────────────────────────────────
// Bootstraps the UI once the DOM is ready. Loaded last so every helper
// function from the other modules is already in scope.

document.addEventListener('DOMContentLoaded', () => {
  migrateCfg();
  updateApiBtn();
  renderSetup();
  renderTemplate();
  renderVoiceExamples();
  updateProjSub();
  setProvider(provider, false);
  // Sync the Report/Session format toggles to whatever was persisted in
  // localStorage. Saves the user from clicking Gherkin every reload.
  if (typeof setReportFormat === 'function')  setReportFormat(reportFormat);
  if (typeof setSessionFormat === 'function') setSessionFormat(sessionFormat);
  if (typeof renderContextWords === 'function') renderContextWords();
  maybeShowInstallBanner();
  registerVoiceServiceWorker();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById('voiceArea').innerHTML =
      '<p style="font-size:12px;color:var(--dim);font-family:\'IBM Plex Mono\',monospace;padding:8px">⚠ Speech not supported. Use Chrome or Edge.</p>';
  } else {
    // Inform file:// users about the per-reload re-prompt + serve.bat fix.
    maybeShowMicHint();
  }

  // Esc closes the Jira fields browser popover from anywhere.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('fieldsBrowserOverlay');
    if (overlay && overlay.classList.contains('open')) {
      e.preventDefault();
      closeFieldsBrowser();
    }
  });
});

// ── one-shot config migrations ────────────────────────────────────────────
// Cheap, idempotent cleanups applied to cfg on every load. Safe to run
// repeatedly — each migration is a no-op once the data is already shaped
// the way the current version expects.
function migrateCfg() {
  let changed = false;

  // Environment moved out of Custom Fields into its own cfg.defaultEnvironment
  // slot. If a previous Analyze Template run added an "Environment" CF (often
  // with a truncated, comma-joined value), drop it now and adopt its value
  // as the verbatim default — but only if the user hasn't already curated
  // one. Idempotent: subsequent loads find nothing to remove.
  if (Array.isArray(cfg.customFields) && typeof isEnvironmentField === 'function') {
    const keep = [];
    const dropped = [];
    cfg.customFields.forEach(f => {
      if (f && isEnvironmentField(f.name, f.jiraId)) dropped.push(f);
      else keep.push(f);
    });
    if (dropped.length) {
      cfg.customFields = keep;
      if (!cfg.defaultEnvironment) {
        const adopted = dropped.find(f => f.default && f.default.trim());
        if (adopted) cfg.defaultEnvironment = adopted.default.trim();
      }
      changed = true;
    }
  }

  // Proxy Secret was removed entirely — any cfg coming from an older build
  // still has an empty/random `proxySecret` field; strip it so it doesn't
  // get re-introduced on the next saveCfg round-trip and confuse exports.
  if ('proxySecret' in cfg) {
    delete cfg.proxySecret;
    changed = true;
  }

  // Context words glossary — new in this build. Backfill + drop any
  // legacy Whisper fields from older snapshots so cfg stays clean.
  if (!Array.isArray(cfg.contextWords)) {
    cfg.contextWords = [];
    changed = true;
  }
  if (typeof cfg.contextThreshold !== 'number' || !(cfg.contextThreshold > 0)) {
    cfg.contextThreshold = DEFAULTS.contextThreshold;
    changed = true;
  }
  if (!cfg.reportTemplate || !Array.isArray(cfg.reportTemplate.sections) || !cfg.reportTemplate.sections.length) {
    cfg.reportTemplate = JSON.parse(JSON.stringify(DEFAULTS.reportTemplate));
    changed = true;
  } else if (typeof normalizeReportTemplate === 'function') {
    const normalized = normalizeReportTemplate(cfg.reportTemplate);
    if (JSON.stringify(normalized) !== JSON.stringify(cfg.reportTemplate)) {
      cfg.reportTemplate = normalized;
      changed = true;
    }
  }
  for (const k of ['speechEngine', 'whisperEndpoint', 'whisperModel', 'whisperLive']) {
    if (k in cfg) { delete cfg[k]; changed = true; }
  }

  if (changed) localStorage.setItem('bra_cfg', JSON.stringify(cfg));
}

// ── install banner (Windows + first-time-on-localhost hint) ───────────────
// Shows a small toast in the bottom-right that nudges the user to run
// install.bat once. install.bat creates a Desktop shortcut that launches
// start.bat → server + browser in one click — so they never have to
// double-click serve.bat / start.bat manually again.
//
// We deliberately ONLY show this once the user has already proven they
// can start the local server (i.e. they're currently on http://localhost),
// so the prompt is timely and actionable — not a generic "go run a batch
// file" pitch on a fresh file:// open.
function maybeShowInstallBanner() {
  // Dev/testing shortcut: open index.html#install to force the banner back.
  if (location.hash === '#install') localStorage.removeItem('bra_installDismissed');

  if (localStorage.getItem('bra_installDismissed') === '1') return;
  if (!/Windows/i.test(navigator.userAgent)) return;

  // Only on http://localhost — that means the user has already run
  // serve.bat / start.bat and can benefit from a desktop shortcut for
  // the same launcher. On file:// we stay silent (different problem,
  // already handled by the mic-hint in voice.js).
  const isLocalhost = location.protocol === 'http:' &&
                      /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!isLocalhost) return;

  const el = document.getElementById('installBanner');
  if (el) el.style.display = '';
}

function dismissInstallBanner() {
  localStorage.setItem('bra_installDismissed', '1');
  const el = document.getElementById('installBanner');
  if (el) el.style.display = 'none';
}

// ── Service Worker registration (voice notification actions only) ─────────
// Registered only on http(s):// origins — file:// refuses SW registration
// and would just spam console errors. With SW active, voice.js prefers
// `swReg.showNotification(...)` (supports action buttons) over plain
// `new Notification(...)` (no buttons).
//
// Also wires the `message` channel: the SW dispatches user clicks on the
// "Stop" / "Open tab" action buttons here, and we call into voice.js to
// either stop dictation or just bring the tab to focus.
function registerVoiceServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:')   return;

  navigator.serviceWorker.register('sw.js').then(reg => {
    window.__braSwReg = reg;
  }).catch(err => {
    // Non-fatal: the app works without SW, just without action buttons in
    // the recording notification. Log so it's discoverable in DevTools.
    console.warn('Service worker registration failed:', err);
  });

  // Inbound messages from sw.js → translate to voice.js calls.
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.source !== 'bra-sw') return;
    if (d.action === 'stop' && typeof stopRec === 'function') {
      try { stopRec(); } catch {}
      // No need to focus the tab — the user explicitly chose Stop, not Open.
    }
    // 'open' is handled SW-side via clients.focus() — nothing for the page.
  });
}
