// ── history ───────────────────────────────────────────────────────────────
// Persists the last N generated bug reports in localStorage under
// 'bra_history'. Used by ai.js (auto-write after a successful generate())
// and by the dedicated History page (read / render / re-push / delete).
//
// Each item shape:
//   {
//     id:        Date.now(),
//     date:      "5/26/2026, 10:50:00 AM" (locale-formatted timestamp),
//     summary:   "Cannot save bug…",
//     severity:  "Critical|High|Medium|Low",
//     format:    "normal" | "gherkin",
//     ticketKey: "QA-123" | null,
//     report:    <full lastRep object, schema depends on format>,
//   }
//
// Keep MAX_HISTORY conservative — every item is a full JSON report and
// localStorage has a 5 MB hard cap per origin.

const HISTORY_KEY = 'bra_history';
const MAX_HISTORY = 20;

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch (e) {
    console.warn('History save failed (quota?):', e);
  }
}

// Called from ai.js generate() and session.js generateSession() after a
// successful AI response. `format` defaults to the global reportFormat
// so the History page knows how to re-render the item.
function addToHistory(report, format = reportFormat, ticketKey = null) {
  if (!report || !report.summary) return;
  const h = loadHistory();
  h.unshift({
    id:        Date.now(),
    date:      new Date().toLocaleString(),
    summary:   report.summary,
    severity:  report.severity || 'Medium',
    format:    format || 'normal',
    ticketKey: null,
    report:    report,
  });
  saveHistory(h);
}

// ── render ────────────────────────────────────────────────────────────────
function renderHistory() {
  const el = document.getElementById('historyList');
  if (!el) return;
  const h = loadHistory();
  if (!h.length) {
    el.innerHTML = `<div style="font-size:13px;color:var(--dim);padding:2rem;text-align:center;font-family:'IBM Plex Mono',monospace">No reports yet. Generate a bug on the Report or Session page — it lands here automatically.</div>`;
    return;
  }
  el.innerHTML = h.map((item, i) => {
    const fmtBadge = item.format === 'gherkin'
      ? `<span style="font-size:10px;font-family:'IBM Plex Mono',monospace;padding:2px 7px;border-radius:999px;background:var(--surface3);color:var(--muted)">Gherkin</span>`
      : '';
    const ticketBadge = item.ticketKey
      ? `<span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--muted)">${esc(item.ticketKey)}</span>`
      : '';
    const resultId = 'history:' + item.id;
    return `
    <div class="card" style="margin-bottom:.75rem" data-result-id="${resultId}">
      <div class="card-head" style="cursor:pointer" onclick="toggleHistoryItem(${i})">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <span class="sev sev-edit sev-${esc(item.severity)}" onclick="event.stopPropagation();cycleSeverity(this)" title="Click to change severity">${esc(item.severity)}</span>
          ${fmtBadge}
          <span style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.summary)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          ${ticketBadge}
          <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim)">${esc(item.date)}</span>
          <span style="color:var(--dim);font-size:13px" id="hist-arrow-${i}">▸</span>
        </div>
      </div>
      <div id="hist-body-${i}" style="display:none">
        <div class="res-body" style="border-top:0.5px solid var(--border)">
          ${renderHistoryBody(item)}
        </div>
        <div class="res-actions">
          <button class="btn btn-ghost btn-sm" onclick="copyHistoryItem(${i})">📋 Copy</button>
          <button class="btn btn-ghost btn-sm" onclick="pushHistoryItem(${i})">🚀 Push to Jira</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red);margin-left:auto" onclick="deleteHistoryItem(${i})">🗑 Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Re-uses the same editable renderers as the Report and Batch pages so a
// history item looks identical to a freshly-generated report — and the
// user can correct anything inline; the change auto-persists via the
// editable.js input router and the 'history' resolver.
function renderHistoryBody(item) {
  const r = item.report || {};
  const resultId = 'history:' + item.id;
  const body = item.format === 'gherkin'
    ? renderEditableGherkinBody(r, resultId)
    : renderEditableNormalBody(r, resultId);
  // Linked work items are editable here too — the history resolver persists
  // edits back to localStorage, so a re-push picks up the curated links.
  const linked = typeof renderLinkedItemsBlock === 'function' ? renderLinkedItemsBlock(r, resultId) : '';
  return body + linked;
}

function toggleHistoryItem(i) {
  const body  = document.getElementById('hist-body-' + i);
  const arrow = document.getElementById('hist-arrow-' + i);
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▸' : '▾';
}

function deleteHistoryItem(i) {
  const h = loadHistory();
  if (i < 0 || i >= h.length) return;
  h.splice(i, 1);
  saveHistory(h);
  renderHistory();
  toast('✓ Removed');
}

function clearHistory() {
  const n = loadHistory().length;
  if (!n) return;
  if (!confirm(`Delete all ${n} report${n === 1 ? '' : 's'} from history?`)) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  toast('✓ History cleared');
}

function copyHistoryItem(i) {
  const item = loadHistory()[i];
  if (!item) return;
  const r = item.report || {};
  let txt;
  if (item.format === 'gherkin') {
    txt = `Summary: ${r.summary}
Severity: ${r.severity}
Environment: ${r.environment || 'N/A'}

Description:
${r.description || ''}

Actual result:
${r.actualResult || ''}

Expected result:
${r.expectedResult || ''}${r.additionalInfo ? `\n\nAdditional info: ${r.additionalInfo}` : ''}${typeof buildLinkedWorkItemsText === 'function' ? buildLinkedWorkItemsText(r) : ''}`;
  } else {
    txt = typeof buildNormalPlainText === 'function' ? buildNormalPlainText(r) : `${r.summary || ''}`;
  }
  navigator.clipboard.writeText(txt).then(() => toast('✓ Copied'));
}

// Re-push a stored report through the existing pushToJira() helper. We
// temporarily restore lastRep + reportFormat so jira.js doesn't need to
// know about the History storage layout.
async function pushHistoryItem(i) {
  const item = loadHistory()[i];
  if (!item) return;
  const prevFmt = reportFormat;
  const prevRep = lastRep;
  reportFormat = item.format || 'normal';
  lastRep      = item.report;
  try {
    await pushToJira();
  } finally {
    reportFormat = prevFmt;
    lastRep      = prevRep;
  }
}
