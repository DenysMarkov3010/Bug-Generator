// ── setup form ────────────────────────────────────────────────────────────
function renderSetup() {
  document.getElementById('sName').value  = cfg.projectName || '';
  document.getElementById('sKey').value   = cfg.projectKey  || '';
  document.getElementById('sType').value  = cfg.issueType   || 'Bug';
  document.getElementById('sUrl').value   = cfg.jiraUrl     || '';
  document.getElementById('sEmail').value = cfg.jiraEmail   || '';
  document.getElementById('sToken').value = cfg.jiraToken   || '';
  document.getElementById('sProxy').value = cfg.proxyUrl    || '';
  const envEl = document.getElementById('sDefEnv');
  if (envEl) envEl.value = cfg.defaultEnvironment || '';
  renderRules();
  renderFields();
  renderDefaultEnvStatus();
  renderVoiceCleanupToggle();
  renderLinkedWorkItems();
  refreshRestoreRulesUI();
  refreshRestoreFieldsUI();
}

// ── Linked work items (project defaults) ──────────────────────────────────
// The list every generated report gets linked to. Auto-filled by Analyze
// Template, manually curated here. Persisted to localStorage on every edit
// (like Context words) — no 💾 Save needed.
function _lwiSave() {
  cfg.linkedWorkItems = normalizeLinkedWorkItems(cfg.linkedWorkItems);
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
}

function renderLinkedWorkItems() {
  const list = document.getElementById('linkedList');
  if (!list) return;
  if (!Array.isArray(cfg.linkedWorkItems)) cfg.linkedWorkItems = [];
  const items = cfg.linkedWorkItems;

  // Keep the add-row relation dropdown populated (static options).
  const addRel = document.getElementById('newLwiRel');
  if (addRel && !addRel.options.length) addRel.innerHTML = linkRelationOptionsHtml(DEFAULT_LINK_RELATION);

  if (!items.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:6px 0">No linked work items yet. Add one below, or run <strong>Analyze Template</strong> to auto-extract from the reference bug.</div>`;
    return;
  }

  list.innerHTML = items.map((it, i) => {
    const url = linkedItemUrl(it);
    const open = url
      ? `<a class="lwi-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">↗</a>`
      : `<span class="lwi-open" style="opacity:.25" title="No URL — set Jira base URL in Setup or paste a link">↗</span>`;
    return `<div class="lwi-row">
      <select onchange="updateLinkedWorkItem(${i}, 'relation', this.value)">${linkRelationOptionsHtml(it.relation)}</select>
      <input type="text" value="${esc(it.key || '')}" placeholder="FER-123" oninput="updateLinkedWorkItem(${i}, 'key', this.value)"/>
      <input type="text" value="${esc(it.title || '')}" placeholder="Title (optional)" oninput="updateLinkedWorkItem(${i}, 'title', this.value)"/>
      ${open}
      <button class="rule-del" onclick="removeLinkedWorkItem(${i})" title="Remove">×</button>
    </div>`;
  }).join('');
}

function addLinkedWorkItem() {
  const relEl   = document.getElementById('newLwiRel');
  const keyEl   = document.getElementById('newLwiKey');
  const titleEl = document.getElementById('newLwiTitle');
  const rawKey  = (keyEl?.value || '').trim();
  if (!rawKey) { toast('⚠ Enter a ticket key (FER-123) or a Jira URL'); return; }
  const key = extractLinkedIssueKey(rawKey);
  if (!key) { toast('⚠ Could not find an issue key in "' + rawKey + '"'); return; }
  if (!Array.isArray(cfg.linkedWorkItems)) cfg.linkedWorkItems = [];
  cfg.linkedWorkItems.push({
    relation: normalizeLinkRelation(relEl?.value),
    key,
    title: (titleEl?.value || '').trim(),
    url: /^https?:\/\//i.test(rawKey) ? rawKey : '',
  });
  if (keyEl)   keyEl.value = '';
  if (titleEl) titleEl.value = '';
  _lwiSave();
  renderLinkedWorkItems();
  toast(`✓ Linked ${key}`);
}

// Edits update cfg in place WITHOUT re-rendering (keeps input focus while
// typing) — except relation, which has no caret to preserve.
function updateLinkedWorkItem(i, field, value) {
  const it = cfg.linkedWorkItems && cfg.linkedWorkItems[i];
  if (!it) return;
  if (field === 'relation') it.relation = normalizeLinkRelation(value);
  else it[field] = String(value);
  // NOTE: persist raw — normalization (key uppercase, URL→key) happens in
  // _lwiSave on add/remove and on push, so typing isn't fought mid-keystroke.
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
}

function removeLinkedWorkItem(i) {
  if (!Array.isArray(cfg.linkedWorkItems)) return;
  cfg.linkedWorkItems.splice(i, 1);
  _lwiSave();
  renderLinkedWorkItems();
}

// ── Dictation: Web Speech only / GPT-4o Transcribe ─────────────────────────
// Persisted immediately (like the Context-words threshold) — flipping the
// engine shouldn't require remembering to hit 💾 Save at the bottom.
// cfg.voiceAiCleanup stores: false = off · 'gpt4o-transcribe'.
// Retired modes (true / 'stop' / 'live' / 'whisper-turbo') migrate to
// 'gpt4o-transcribe' in migrateCfg / importCfg.
function voiceCleanupMode() {
  return cfg.voiceAiCleanup === 'gpt4o-transcribe' ? 'gpt4o-transcribe' : 'off';
}

function renderVoiceCleanupToggle() {
  const mode = voiceCleanupMode();
  const off  = document.getElementById('vcOff');
  const g4o  = document.getElementById('vcGpt4oTranscribe');
  if (off)  off.classList.toggle('active',  mode === 'off');
  if (g4o)  g4o.classList.toggle('active',  mode === 'gpt4o-transcribe');
}

function setVoiceCleanup(mode) {
  cfg.voiceAiCleanup = (mode === 'gpt4o-transcribe') ? 'gpt4o-transcribe' : false;
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderVoiceCleanupToggle();
  toast(mode === 'gpt4o-transcribe'
    ? '✓ GPT-4o Transcribe — final text is transcribed from audio after Pause / Stop'
    : '✓ Web Speech only — transcript is kept exactly as recognized');
}

// Updates the "not set / N chars" badge in the Default Environment card.
// Keeps the badge in sync after Analyze Template auto-fills the field,
// after manual edits, and after Clear.
function renderDefaultEnvStatus() {
  const badge = document.getElementById('envStatus');
  if (!badge) return;
  const el = document.getElementById('sDefEnv');
  // Prefer the live textarea content so the badge updates instantly while
  // the user types; fall back to cfg when the form isn't rendered yet.
  const v = (el && typeof el.value === 'string') ? el.value : (cfg.defaultEnvironment || '');
  if (!v.trim()) {
    badge.textContent = 'not set';
    badge.style.color = 'var(--dim)';
  } else {
    badge.textContent = `✓ saved (${v.length} chars)`;
    badge.style.color = 'var(--green)';
  }
}

function clearDefaultEnvironment() {
  const el = document.getElementById('sDefEnv');
  if (el) el.value = '';
  cfg.defaultEnvironment = '';
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderDefaultEnvStatus();
  toast('✓ Default Environment cleared');
}

// Index of the rule currently being edited inline (-1 = no edit in progress).
let editingRuleIndex = -1;

// Show / hide the "↶ Restore previous rules" row based on whether a backup
// exists in localStorage. analyzeTemplate writes the snapshot before it
// replaces cfg.rules; restorePreviousRules clears it.
function refreshRestoreRulesUI() {
  const row = document.getElementById('restoreRulesRow');
  if (!row) return;
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem('bra_rules_backup') || 'null'); } catch {}
  if (Array.isArray(backup) && backup.length) {
    row.style.display = '';
    const cnt = document.getElementById('restoreRulesCount');
    if (cnt) cnt.textContent = String(backup.length);
  } else {
    row.style.display = 'none';
  }
}

function restorePreviousRules() {
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem('bra_rules_backup') || 'null'); } catch {}
  if (!Array.isArray(backup) || !backup.length) {
    toast('⚠ No backup to restore');
    refreshRestoreRulesUI();
    return;
  }
  const replacing = cfg.rules.length;
  cfg.rules = backup.slice();
  // One-shot restore: clear the backup so the button hides until the next
  // Analyze Template run creates a fresh snapshot. Avoids the footgun of
  // a stale backup lingering after the user has manually curated the
  // restored list.
  localStorage.removeItem('bra_rules_backup');
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderRules();
  refreshRestoreRulesUI();
  toast(`✓ Restored ${backup.length} previous rules (was ${replacing})`);
}

// Symmetric to the rules pair above, but for the Custom Jira fields list.
// analyzeTemplate writes bra_fields_backup right before it replaces the
// non-pinned portion of cfg.customFields; this restores the full previous
// list (pinned + non-pinned) and clears the backup so the button hides.
function refreshRestoreFieldsUI() {
  const row = document.getElementById('restoreFieldsRow');
  if (!row) return;
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem('bra_fields_backup') || 'null'); } catch {}
  if (Array.isArray(backup) && backup.length) {
    row.style.display = '';
    const cnt = document.getElementById('restoreFieldsCount');
    if (cnt) cnt.textContent = String(backup.length);
  } else {
    row.style.display = 'none';
  }
}

function restorePreviousFields() {
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem('bra_fields_backup') || 'null'); } catch {}
  if (!Array.isArray(backup) || !backup.length) {
    toast('⚠ No backup to restore');
    refreshRestoreFieldsUI();
    return;
  }
  const replacing = cfg.customFields.length;
  // Restore as-is — backup snapshot already contained pinned + non-pinned
  // exactly as they were before Analyze Template ran.
  cfg.customFields = backup.slice();
  localStorage.removeItem('bra_fields_backup');
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderFields();
  refreshRestoreFieldsUI();
  toast(`✓ Restored ${backup.length} previous field${backup.length === 1 ? '' : 's'} (was ${replacing})`);
}

function renderRules() {
  document.getElementById('rulesList').innerHTML = cfg.rules.map((r, i) => {
    const pinTitle = r.pinned
      ? 'Pinned — Analyze Template will not modify this rule. Click to unpin.'
      : 'Pin this rule — Analyze Template will leave it untouched.';
    const pinBtn = `<button class="rule-pin ${r.pinned ? 'on' : ''}" onclick="toggleRulePin(${i})" title="${pinTitle}" aria-label="${pinTitle}">📌</button>`;

    if (i === editingRuleIndex) {
      return `
        <div class="rule-item ${r.pinned ? 'pinned' : ''}">
          ${pinBtn}
          <input type="text" class="rule-edit-input" id="ruleEditInput" value="${esc(r.text)}"
                 onkeydown="onRuleEditKey(event)"/>
          <button class="rule-edit" onclick="saveRuleEdit()" title="Save">✓</button>
          <button class="rule-del"  onclick="cancelRuleEdit()" title="Cancel">×</button>
        </div>`;
    }
    return `
      <div class="rule-item ${r.pinned ? 'pinned' : ''}">
        ${pinBtn}
        <span style="flex:1">${esc(r.text)}</span>
        <button class="rule-edit" onclick="startRuleEdit(${i})" title="Edit">✎</button>
        <button class="rule-del"  onclick="delRule(${i})"       title="Delete">×</button>
      </div>`;
  }).join('');

  // Auto-focus the edit input and place caret at end.
  if (editingRuleIndex >= 0) {
    const input = document.getElementById('ruleEditInput');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function addRule() {
  const el = document.getElementById('newRule');
  const v  = el.value.trim();
  if (!v) return;
  cfg.rules.push({ text: v, pinned: false });
  el.value = '';
  renderRules();
}

function delRule(i) {
  cfg.rules.splice(i, 1);
  if (editingRuleIndex === i) editingRuleIndex = -1;
  renderRules();
}

function startRuleEdit(i) {
  editingRuleIndex = i;
  renderRules();
}

function saveRuleEdit() {
  if (editingRuleIndex < 0) return;
  const input = document.getElementById('ruleEditInput');
  if (!input) return;
  const v = input.value.trim();
  if (v) cfg.rules[editingRuleIndex].text = v;
  editingRuleIndex = -1;
  renderRules();
}

function cancelRuleEdit() {
  editingRuleIndex = -1;
  renderRules();
}

function onRuleEditKey(e) {
  if (e.key === 'Enter')  { e.preventDefault(); saveRuleEdit();   }
  if (e.key === 'Escape') { e.preventDefault(); cancelRuleEdit(); }
}

// Toggle the "pinned" flag on an AI rule. Pinned rules are protected from
// Analyze Template — the analyzer's rule-replace step keeps any pinned rule
// exactly as-is and tells the AI not to re-suggest a duplicate of it.
// Mirrors toggleFieldPin for Custom Jira fields below.
//
// Manual edits/delete remain allowed when pinned — pin only blocks the
// AUTOMATIC Analyze Template pipeline, not user intent.
function toggleRulePin(i) {
  const r = cfg.rules[i];
  if (!r) return;
  r.pinned = !r.pinned;
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderRules();
  toast(r.pinned ? `📌 Pinned rule` : `Unpinned rule`);
}

// Two inline-edit slots in the custom-fields table: one for the Jira ID
// column, one for the Default-value column. -1 = no edit in progress.
let editingFieldIdIndex      = -1;
let editingFieldDefaultIndex = -1;

function renderFields() {
  const el = document.getElementById('fieldsList');
  if (!cfg.customFields.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--dim);padding:4px 0">No custom fields yet.</div>';
    return;
  }
  el.innerHTML = cfg.customFields.map((f, i) => {
    // ── Jira ID cell ─────────────────────────────────────────────────
    let idCell;
    if (i === editingFieldIdIndex) {
      idCell = `<input type="text" class="rule-edit-input" id="fieldIdEditInput"
                 value="${esc(f.jiraId || '')}" placeholder="customfield_10xxx"
                 onkeydown="onFieldIdEditKey(event)" onblur="saveFieldIdEdit()"
                 style="font-size:11px;padding:3px 6px"/>`;
    } else if (f.jiraId) {
      idCell = `<span onclick="startFieldIdEdit(${i})"
                title="${esc(f.jiraId)} — click to edit"
                style="color:var(--dim);font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                >${esc(f.jiraId)}</span>`;
    } else {
      idCell = `<span onclick="startFieldIdEdit(${i})"
                title="Click to add Jira field ID"
                style="font-size:10px;cursor:pointer;background:var(--amber-dim);color:var(--amber);padding:2px 6px;border-radius:999px;text-align:center;white-space:nowrap"
                >⚠ needs ID</span>`;
    }

    // ── Default value cell ───────────────────────────────────────────
    let defCell;
    if (i === editingFieldDefaultIndex) {
      defCell = `<input type="text" class="rule-edit-input" id="fieldDefaultEditInput"
                  value="${esc(f.default || '')}" placeholder="default value…"
                  onkeydown="onFieldDefaultEditKey(event)" onblur="saveFieldDefaultEdit()"
                  style="font-size:11px;padding:3px 6px"/>`;
    } else if (f.default) {
      defCell = `<span onclick="startFieldDefaultEdit(${i})"
                  title="${esc(f.default)} — click to edit default"
                  style="color:var(--text);font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                  >${esc(f.default)}</span>`;
    } else {
      defCell = `<span onclick="startFieldDefaultEdit(${i})"
                  title="Click to add a default value"
                  style="color:var(--dim);font-size:11px;cursor:pointer;font-style:italic"
                  >+ default</span>`;
    }

    const pinTitle = f.pinned
      ? 'Pinned — Analyze Template will not modify this field. Click to unpin.'
      : 'Pin this field — Analyze Template will leave it untouched.';
    const pinBtn = `<button class="rule-pin ${f.pinned ? 'on' : ''}" onclick="toggleFieldPin(${i})" title="${pinTitle}" aria-label="${pinTitle}">📌</button>`;

    return `
    <div class="field-row ${f.pinned ? 'pinned' : ''}">
      ${pinBtn}
      <span>${esc(f.name)}</span>
      <span style="color:var(--muted)">${f.type}</span>
      ${idCell}
      ${defCell}
      <span class="f-req ${f.required}">${f.required === 'yes' ? 'required' : 'optional'}</span>
      <button class="rule-del" onclick="delField(${i})">×</button>
    </div>`;
  }).join('');

  if (editingFieldIdIndex >= 0) {
    const input = document.getElementById('fieldIdEditInput');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  if (editingFieldDefaultIndex >= 0) {
    const input = document.getElementById('fieldDefaultEditInput');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

// ── jiraId inline-edit ────────────────────────────────────────────────────
function startFieldIdEdit(i) {
  editingFieldIdIndex      = i;
  editingFieldDefaultIndex = -1;
  renderFields();
}

function saveFieldIdEdit() {
  if (editingFieldIdIndex < 0) return;
  const input = document.getElementById('fieldIdEditInput');
  if (!input) return;
  cfg.customFields[editingFieldIdIndex].jiraId = input.value.trim();
  editingFieldIdIndex = -1;
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderFields();
}

function cancelFieldIdEdit() {
  editingFieldIdIndex = -1;
  renderFields();
}

function onFieldIdEditKey(e) {
  if (e.key === 'Enter')  { e.preventDefault(); saveFieldIdEdit();   }
  if (e.key === 'Escape') { e.preventDefault(); cancelFieldIdEdit(); }
}

// ── default-value inline-edit ─────────────────────────────────────────────
function startFieldDefaultEdit(i) {
  editingFieldDefaultIndex = i;
  editingFieldIdIndex      = -1;
  renderFields();
}

function saveFieldDefaultEdit() {
  if (editingFieldDefaultIndex < 0) return;
  const input = document.getElementById('fieldDefaultEditInput');
  if (!input) return;
  cfg.customFields[editingFieldDefaultIndex].default = input.value.trim();
  editingFieldDefaultIndex = -1;
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderFields();
}

function cancelFieldDefaultEdit() {
  editingFieldDefaultIndex = -1;
  renderFields();
}

function onFieldDefaultEditKey(e) {
  if (e.key === 'Enter')  { e.preventDefault(); saveFieldDefaultEdit();   }
  if (e.key === 'Escape') { e.preventDefault(); cancelFieldDefaultEdit(); }
}

function addField() {
  const name = document.getElementById('nfName').value.trim();
  if (!name) { alert('Field name required'); return; }
  const id = document.getElementById('nfId').value.trim();
  // Environment is owned by the dedicated Default Environment card above.
  // Block CF additions so it can't be re-introduced after migration.
  if (typeof isEnvironmentField === 'function' && isEnvironmentField(name, id)) {
    toast('⚠ Environment is managed in the Default Environment card — paste the value there instead');
    return;
  }
  cfg.customFields.push({
    name,
    type:     document.getElementById('nfType').value,
    jiraId:   document.getElementById('nfId').value.trim(),
    required: document.getElementById('nfReq').value,
    default:  (document.getElementById('nfDef')?.value || '').trim(),
  });
  document.getElementById('nfName').value = '';
  document.getElementById('nfId').value   = '';
  const defEl = document.getElementById('nfDef');
  if (defEl) defEl.value = '';
  renderFields();
}

function delField(i) {
  cfg.customFields.splice(i, 1);
  renderFields();
}

// Toggle the "pinned" flag on a custom field. Pinned fields are protected
// from Analyze Template — the analyzer's detectedFields loop ignores any
// detection whose name matches a pinned row, so the user-curated jiraId /
// default / required values stay intact across template re-analyses.
//
// Manual inline edits (jiraId, default) remain allowed when pinned — pin
// only blocks the AUTOMATIC pipeline, not user intent.
function toggleFieldPin(i) {
  const f = cfg.customFields[i];
  if (!f) return;
  f.pinned = !f.pinned;
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderFields();
  toast(f.pinned ? `📌 Pinned "${f.name}"` : `Unpinned "${f.name}"`);
}

// ── Jira fields browser (popover) ─────────────────────────────────────────
// Opens a search-as-you-type list of every field returned by
// /rest/api/3/field. Used to quickly fill a "Jira field ID" without
// digging through Jira admin or raw JSON. When triggered while a field's
// jiraId cell is being inline-edited, picking a row injects the ID into
// that cell. Otherwise the ID is copied to clipboard.

let jiraFieldsCache = null;          // [{id, name, custom, schema}, ...]
let pendingPickerTargetIndex = -1;   // cfg.customFields index to inject into

async function openFieldsBrowser() {
  // Capture the inline-edit target BEFORE focus shifts to the popover.
  // The Browse button uses onmousedown=event.preventDefault() so blur on
  // the inline input is suppressed long enough for us to read the index.
  pendingPickerTargetIndex = editingFieldIdIndex;

  if (editingFieldIdIndex >= 0) {
    // Close the inline editor cleanly so its blur doesn't fire later and
    // overwrite the value we're about to inject. Skip the auto-save: we'll
    // write the picked value directly into cfg.customFields[idx].jiraId.
    editingFieldIdIndex = -1;
    renderFields();
  }

  const overlay = document.getElementById('fieldsBrowserOverlay');
  if (!overlay) return;
  overlay.classList.add('open');

  const search = document.getElementById('fbSearch');
  if (search) { search.value = ''; }

  const status = document.getElementById('fbStatus');
  const hint   = document.getElementById('fbTargetHint');
  if (hint) {
    if (pendingPickerTargetIndex >= 0 && cfg.customFields[pendingPickerTargetIndex]) {
      const fname = cfg.customFields[pendingPickerTargetIndex].name;
      hint.innerHTML = `Click a row to set ID for <span class="fb-target">${esc(fname)}</span>`;
    } else {
      hint.textContent = 'Click a row to copy its ID to clipboard';
    }
  }

  if (!jiraFieldsCache) {
    if (status) status.textContent = 'Loading fields from Jira…';
    document.getElementById('fbList').innerHTML = '';
    try {
      const fields = await jiraRequest('/rest/api/3/field');
      if (!Array.isArray(fields)) throw new Error('Unexpected response shape');
      jiraFieldsCache = fields.slice().sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''))
      );
      if (status) status.textContent = `${jiraFieldsCache.length} fields loaded`;
    } catch (e) {
      if (status) status.textContent = '⚠ Failed: ' + e.message;
      return;
    }
  } else if (status) {
    status.textContent = `${jiraFieldsCache.length} fields (cached)`;
  }

  renderFieldsBrowser('');
  if (search) search.focus();
}

function closeFieldsBrowser() {
  pendingPickerTargetIndex = -1;
  const overlay = document.getElementById('fieldsBrowserOverlay');
  if (overlay) overlay.classList.remove('open');
}

function renderFieldsBrowser(query) {
  const list = document.getElementById('fbList');
  if (!list || !jiraFieldsCache) return;
  const q = (query || '').toLowerCase().trim();
  const filtered = !q
    ? jiraFieldsCache
    : jiraFieldsCache.filter(f =>
        String(f.name || '').toLowerCase().includes(q) ||
        String(f.id   || '').toLowerCase().includes(q)
      );

  if (!filtered.length) {
    list.innerHTML = '<div class="fb-empty">No fields match.</div>';
    return;
  }

  const slice = filtered.slice(0, 200);
  list.innerHTML = slice.map(f => {
    const type = (f.schema && f.schema.type) || (f.custom ? 'custom' : 'system');
    return `<div class="fb-row" onclick="pickJiraField('${esc(f.id)}', ${JSON.stringify(f.name || '').replace(/"/g, '&quot;')})">
      <span class="fb-name">${esc(f.name || '(unnamed)')}</span>
      <span class="fb-id">${esc(f.id)}</span>
      <span class="fb-type">${esc(type)}</span>
    </div>`;
  }).join('');

  if (filtered.length > slice.length) {
    list.innerHTML += `<div class="fb-empty">Showing first ${slice.length} of ${filtered.length} matches — refine search to narrow.</div>`;
  }
}

function pickJiraField(id, name) {
  if (pendingPickerTargetIndex >= 0 && cfg.customFields[pendingPickerTargetIndex]) {
    const idx   = pendingPickerTargetIndex;
    const fname = cfg.customFields[idx].name;
    cfg.customFields[idx].jiraId = id;
    pendingPickerTargetIndex = -1;
    localStorage.setItem('bra_cfg', JSON.stringify(cfg));
    renderFields();
    closeFieldsBrowser();
    toast(`✓ Set "${fname}" → ${id}`);
  } else {
    navigator.clipboard.writeText(id).then(() => toast(`✓ Copied ${id} (${name})`));
    closeFieldsBrowser();
  }
}

// One-click removal of Jira-internal / computed fields that may have been
// auto-added by an earlier Analyze Template run before we tightened the
// SKIP list. Re-uses the same name patterns as template.js.
function cleanupNoiseFields() {
  if (typeof isInternalFieldName !== 'function') {
    toast('⚠ Cleanup helper unavailable (template.js not loaded)');
    return;
  }
  const before = cfg.customFields.length;
  cfg.customFields = cfg.customFields.filter(f => !isInternalFieldName(f.name));
  const removed = before - cfg.customFields.length;
  if (!removed) { toast('✓ Nothing to clean up'); return; }
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderFields();
  toast(`✓ Removed ${removed} noise field${removed === 1 ? '' : 's'}`);
}

function saveCfg() {
  cfg.projectName = document.getElementById('sName').value.trim();
  cfg.projectKey  = document.getElementById('sKey').value.trim();
  cfg.issueType   = document.getElementById('sType').value;
  cfg.jiraUrl     = document.getElementById('sUrl').value.trim();
  cfg.jiraEmail   = document.getElementById('sEmail').value.trim();
  cfg.jiraToken   = document.getElementById('sToken').value.trim();
  cfg.proxyUrl    = document.getElementById('sProxy').value.trim();
  const envEl = document.getElementById('sDefEnv');
  // Trim only trailing whitespace — internal newlines/indents are part of
  // the verbatim block (e.g. multi-device "Display: 6.1\nApp_version: …").
  cfg.defaultEnvironment = envEl ? envEl.value.replace(/\s+$/, '') : '';
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  updateProjSub();
  renderDefaultEnvStatus();
  toast('✓ Config saved');
}

function exportCfg() {
  // Intentionally strip secrets so the JSON is safe to share with the team.
  const safe = { ...cfg, jiraToken: '' };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' }));
  a.download = `bra-${(cfg.projectKey || 'project').toLowerCase()}.json`;
  a.click();
}

function importCfg(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      // Preserve locally-stored secrets — imported JSON should never
      // overwrite them.
      cfg = {
        ...DEFAULTS,
        ...JSON.parse(ev.target.result),
        jiraToken: cfg.jiraToken || '',
      };
      // Migrate retired AI modes (true/'stop'/'whisper-turbo'/'live') to
      // 'gpt4o-transcribe'; anything unrecognized falls back to the default.
      if (cfg.voiceAiCleanup === true || cfg.voiceAiCleanup === 'stop' || cfg.voiceAiCleanup === 'whisper-turbo' || cfg.voiceAiCleanup === 'live') {
        cfg.voiceAiCleanup = 'gpt4o-transcribe';
      } else if (cfg.voiceAiCleanup !== false && cfg.voiceAiCleanup !== 'gpt4o-transcribe') {
        cfg.voiceAiCleanup = DEFAULTS.voiceAiCleanup;
      }
      if (!Array.isArray(cfg.contextWords)) cfg.contextWords = [];
      if (typeof normalizeRules === 'function') cfg.rules = normalizeRules(cfg.rules);
      cfg.linkedWorkItems = normalizeLinkedWorkItems(cfg.linkedWorkItems);
      cfg.reportTemplate = typeof normalizeReportTemplate === 'function'
        ? normalizeReportTemplate(cfg.reportTemplate)
        : (cfg.reportTemplate || DEFAULTS.reportTemplate);
      localStorage.setItem('bra_cfg', JSON.stringify(cfg));
      renderSetup();
      if (typeof renderContextWords === 'function') renderContextWords();
      toast('✓ Imported');
    } catch {
      alert('Invalid JSON');
    }
  };
  r.readAsText(f);
}

function updateProjSub() {
  document.getElementById('projSub').textContent = cfg.projectName
    ? `Project: ${cfg.projectName} (${cfg.projectKey}) · Describe the bug — voice or text.`
    : 'Describe the bug — voice or text — get a Jira-ready report.';
}
