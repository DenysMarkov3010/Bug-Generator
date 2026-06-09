// ── Bug Report Agent · Service Worker ────────────────────────────────────
//
// Sole purpose: enable Notification action buttons (Stop / Open tab) so the
// user can control voice dictation from a different browser tab.
//
// Why a Service Worker is required:
//   - The plain `new Notification(...)` API in Chrome does NOT render the
//     `actions` array — only Service-Worker-shown notifications get buttons.
//   - SW persists across tabs in the same origin and can fire `postMessage`
//     to every open client (= our tab) to relay "user clicked Stop".
//
// Scope limits:
//   - Lives only on http(s):// origins (incl. http://localhost via serve.bat).
//     Browsers refuse to register SW on file:// — we gracefully fall back to
//     plain Notification + onclick=stop in voice.js for that case.
//   - Does NOT cache anything (no fetch handler). Updating index.html does
//     not need any cache-busting on the SW side.

self.addEventListener('install', e => {
  // Activate immediately on first install instead of waiting for old tabs
  // to close — there are no old tabs to worry about, this SW is brand new.
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Take control of pages that were already open when SW activated, so
  // the very first recording session after install can use it without
  // requiring a full page reload.
  e.waitUntil(self.clients.claim());
});

// Click on the notification body OR on an action button. We relay the
// intent to the page via postMessage; the page (voice.js) decides what
// to do (stop dictation, focus tab, both, neither).
self.addEventListener('notificationclick', event => {
  event.notification.close();

  // 'stop'    → action button "Stop"
  // 'open'    → action button "Open tab"
  // ''        → user clicked the notification body itself (treat as Open)
  const action = event.action || 'open';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // Send the action to every open BRA tab — if there are multiple, the
    // user almost certainly meant the one that posted the notification,
    // but we broadcast and let each client check its own `isRec` state.
    for (const c of allClients) {
      c.postMessage({ source: 'bra-sw', action });
    }

    // For 'open' (and the bare-click default), focus a client window so
    // the user lands back on the app. Prefer an already-visible one.
    if (action === 'open') {
      const focusable = allClients.find(c => 'focus' in c);
      if (focusable) {
        try { await focusable.focus(); } catch {}
      }
    }
  })());
});
