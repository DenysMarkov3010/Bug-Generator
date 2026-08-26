// ── editable result cards ─────────────────────────────────────────────────
// Lets the user fix anything the AI got wrong by clicking directly on the
// generated report. Implementation philosophy:
//
//   ▸ contenteditable="plaintext-only" on text nodes — no rich-text
//     pollution from clipboard pastes; Enter stays a real newline.
//   ▸ Every editable field carries data-edit="<key>" — one global input
//     listener routes the new value back to the underlying object
//     (lastRep, card.result, or a history item) by looking up an ancestor
//     with [data-result-id].
//   ▸ Steps live in <ol data-edit="steps"> with <li data-edit="step"> kids;
//     we serialize the list back to an array on every input.
//   ▸ Severity is a small clickable badge — clicking opens a dropdown so
//     users don't have to memorise the four levels.
//
// Registries:
//   Every result card carries data-result-id="<scope>:<key>". Examples:
//     data-result-id="report"
//     data-result-id="card:42"
//     data-result-id="history:1748257200000"
//   resolveResultTarget(id) returns the live JS object so onEditableInput
//   can update it without each call-site having to know where it lives.

(function () {
  // Map scope → resolver. Each resolver returns { obj, onUpdate } where:
  //   obj      — the live object being edited (lastRep / card.result / item.report)
  //   onUpdate — optional callback to persist the change (e.g. saveHistory)
  const resolvers = {};

  function registerResultResolver(scope, fn) {
    resolvers[scope] = fn;
  }
  window.registerResultResolver = registerResultResolver;

  function resolveResultTarget(id) {
    if (!id) return null;
    const [scope, key] = String(id).split(':');
    const r = resolvers[scope];
    if (!r) return null;
    return r(key);
  }
  window.resolveResultTarget = resolveResultTarget;

  // ── built-in resolvers ─────────────────────────────────────────────────
  // Report scope ("report") — single global lastRep.
  registerResultResolver('report', () => {
    if (typeof lastRep === 'undefined' || !lastRep) return null;
    return { obj: lastRep };
  });

  // Session card scope ("card:<id>") — one resolver call per card render.
  registerResultResolver('card', (id) => {
    if (typeof sessionCards === 'undefined') return null;
    const cardId = parseInt(id, 10);
    const card = sessionCards.find(c => c.id === cardId);
    if (!card || !card.result) return null;
    return { obj: card.result };
  });

  // History scope ("history:<unixTs>") — also persists back to localStorage.
  registerResultResolver('history', (id) => {
    if (typeof loadHistory !== 'function') return null;
    const list = loadHistory();
    const ts = parseInt(id, 10);
    const idx = list.findIndex(it => it.id === ts);
    if (idx === -1) return null;
    const item = list[idx];
    // Keep a single source of truth — update item.report AND mirror the
    // top-level summary/severity so the collapsed history row stays in sync.
    return {
      obj: item.report,
      onUpdate: () => {
        item.summary  = item.report.summary  || item.summary;
        item.severity = item.report.severity || item.severity;
        saveHistory(list);
      },
    };
  });

  // ── input router ───────────────────────────────────────────────────────
  // ONE document-level input listener picks up every contenteditable
  // change and persists it. Avoids per-render listener bookkeeping.
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el || !el.matches || !el.matches('[data-edit]')) return;

    const scopeEl = el.closest('[data-result-id]');
    if (!scopeEl) return;
    const target = resolveResultTarget(scopeEl.dataset.resultId);
    if (!target || !target.obj) return;

    const key = el.dataset.edit;
    if (!key) return;

    // Template-driven Normal section text.
    if (key === 'sectionText') {
      const sid = el.dataset.sectionId;
      if (!sid) return;
      target.obj.sections = target.obj.sections || {};
      target.obj.sections[sid] = el.innerText.trim();
    } else if (key === 'sectionItem') {
      const listEl = el.closest('[data-edit-list]');
      if (!listEl) return;
      const sid = listEl.dataset.editList;
      target.obj.sections = target.obj.sections || {};
      target.obj.sections[sid] = [...listEl.querySelectorAll('[data-edit="sectionItem"]')]
        .map(el => el.innerText.trim()).filter(Boolean);
    // Special legacy / Gherkin list shapes.
    } else if (key === 'step' || key === 'precondition' || key === 'arBullet' || key === 'erBullet') {
      const listEl = el.closest('[data-edit-list]');
      if (!listEl) return;
      const listKey = listEl.dataset.editList;
      const items   = [...listEl.querySelectorAll('[data-edit="' + key + '"]')]
        .map(el => el.innerText.trim()).filter(Boolean);
      target.obj[listKey] = items;
      // Special-case: AR/ER bullets in Gherkin are joined back into a
      // newline-prefixed string so buildAdfDescriptionGherkin still works.
      if (listKey === 'actualResult' || listKey === 'expectedResult') {
        target.obj[listKey] = items.map(s => '- ' + s).join('\n');
      }
    } else if (key === 'customField') {
      // Custom field cells carry data-cf-name="..." with the field name.
      const name = el.dataset.cfName;
      if (!name) return;
      target.obj.customFields = target.obj.customFields || {};
      target.obj.customFields[name] = el.innerText.trim();
    } else {
      // Plain scalar field: summary / environment / expected / actual /
      // description / additionalInfo …
      target.obj[key] = el.innerText.trim();
    }

    if (target.onUpdate) target.onUpdate();
  });

  // ── severity inline picker ─────────────────────────────────────────────
  // Clicking a .sev-edit badge cycles through Critical → High → Medium →
  // Low → Critical … Mirrors the value back into the result object and
  // re-paints the badge color.
  const SEV_CYCLE = ['Critical', 'High', 'Medium', 'Low'];

  function cycleSeverity(el) {
    const scopeEl = el.closest('[data-result-id]');
    if (!scopeEl) return;
    const target = resolveResultTarget(scopeEl.dataset.resultId);
    if (!target || !target.obj) return;
    const cur = SEV_CYCLE.indexOf(target.obj.severity);
    const next = SEV_CYCLE[(cur + 1) % SEV_CYCLE.length];
    target.obj.severity = next;
    el.classList.remove('sev-Critical', 'sev-High', 'sev-Medium', 'sev-Low');
    el.classList.add('sev-' + next);
    el.textContent = next;
    if (target.onUpdate) target.onUpdate();
  }
  window.cycleSeverity = cycleSeverity;

  // ── steps list management ──────────────────────────────────────────────
  // Add / remove a step from any ordered list. The DOM is the source of
  // truth — after we mutate it we trigger an 'input' event so the router
  // above writes the new list back into the result object.
  function addListItem(listEl, key) {
    if (!listEl) return;
    const li   = document.createElement('li');
    li.style.display     = 'flex';
    li.style.alignItems  = 'flex-start';
    li.style.gap         = '6px';

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('draggable', 'true');
    handle.title = 'Drag to reorder';
    handle.textContent = '⠿';

    const span = document.createElement('span');
    span.setAttribute('contenteditable', 'plaintext-only');
    span.setAttribute('data-edit', key);
    span.style.flex    = '1';
    span.style.padding = '2px 0';

    const btn = document.createElement('button');
    btn.className = 'list-item-del';
    btn.title     = 'Remove';
    btn.textContent = '×';
    btn.onclick = () => removeListItem(btn.closest('[data-edit-list]'), btn);

    li.appendChild(handle);
    li.appendChild(span);
    li.appendChild(btn);
    listEl.appendChild(li);
    span.focus();
    listEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function removeListItem(listEl, btn) {
    if (!listEl || !btn) return;
    const li = btn.closest('li');
    if (!li) return;
    // Support both new (<span data-edit>) and old (<li data-edit>) structure
    const editEl = li.querySelector('[data-edit]');
    const key    = editEl?.dataset.edit || li.dataset.edit;
    li.remove();
    // Resync: fire input on a surviving item so the router re-reads the list.
    // If the last item was removed, directly clear the array on the result object.
    const survivor = key && listEl.querySelector('[data-edit="' + key + '"]');
    if (survivor) {
      survivor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const scopeEl = listEl.closest('[data-result-id]');
      if (!scopeEl) return;
      const target  = resolveResultTarget(scopeEl.dataset.resultId);
      if (!target || !target.obj) return;
      const listKey = listEl.dataset.editList;
      if (listEl.dataset.sectionList === '1') {
        target.obj.sections = target.obj.sections || {};
        target.obj.sections[listKey] = [];
      } else if (listKey === 'actualResult' || listKey === 'expectedResult') {
        target.obj[listKey] = '';
      } else {
        target.obj[listKey] = [];
      }
      if (target.onUpdate) target.onUpdate();
    }
  }
  // ── drag & drop reordering (list sections: Steps, Preconditions, etc.) ──
  // Native HTML5 DnD scoped to a small grip handle (.drag-handle) so
  // dragging never fights with editing/selecting the contenteditable text
  // next to it. Reordering happens LIVE during dragover — the dragged <li>
  // is moved in the DOM as the user hovers, Trello-style — then dragend
  // fires a synthetic 'input' event on a surviving item so the existing
  // input router (above) re-reads the new DOM order into the underlying
  // array. No separate persistence path to keep in sync.
  let dragEl = null;

  document.addEventListener('dragstart', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const li = handle.closest('li');
    if (!li) return;
    dragEl = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without setData; the payload itself
    // is unused since we track the dragged element via `dragEl` (same
    // document, same synchronous drag session).
    try { e.dataTransfer.setData('text/plain', ''); } catch {}
  });

  document.addEventListener('dragover', e => {
    if (!dragEl) return;
    const listEl = e.target.closest('[data-edit-list]');
    // Only allow reordering within the SAME list — dragging a step into the
    // preconditions list (or vice versa) would corrupt both arrays.
    if (!listEl || dragEl.parentElement !== listEl) return;
    e.preventDefault();   // required for a drop to be permitted at all
    const overLi = e.target.closest('li');
    if (overLi && overLi !== dragEl) {
      const rect = overLi.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      listEl.insertBefore(dragEl, before ? overLi : overLi.nextSibling);
    } else if (!overLi) {
      // Hovering empty space below the last item → move to the end.
      listEl.appendChild(dragEl);
    }
  });

  document.addEventListener('drop', e => {
    if (dragEl) e.preventDefault();
  });

  document.addEventListener('dragend', () => {
    if (!dragEl) return;
    const listEl = dragEl.closest('[data-edit-list]');
    dragEl.classList.remove('dragging');
    dragEl = null;
    const survivor = listEl && listEl.querySelector('[data-edit]');
    if (survivor) survivor.dispatchEvent(new Event('input', { bubbles: true }));
  });

  window.addStep        = (listSel) => addListItem(document.querySelector(listSel), 'step');
  window.addPrecond     = (listSel) => addListItem(document.querySelector(listSel), 'precondition');
  window.addSectionItem = (listSel) => addListItem(document.querySelector(listSel), 'sectionItem');
  window.addArBullet    = (listSel) => addListItem(document.querySelector(listSel), 'arBullet');
  window.addErBullet    = (listSel) => addListItem(document.querySelector(listSel), 'erBullet');
  window.removeStep     = (btn) => removeListItem(btn.closest('[data-edit-list]'), btn);
  window.removeListItem = (btn) => removeListItem(btn.closest('[data-edit-list]'), btn);
})();

// ──────────────────────────────────────────────────────────────────────────
// Renderers used by ai.js / session.js / history.js
// ──────────────────────────────────────────────────────────────────────────
// These return the inner HTML for an editable result body. Each scope
// (Report / Card / History) calls these so the markup is identical no
// matter where the report is displayed.

function renderEditableNormalBody(r, resultId) {
  const tpl = typeof getReportTemplate === 'function' ? getReportTemplate() : { sections: [] };
  const sections = typeof ensureNormalSections === 'function'
    ? ensureNormalSections(r)
    : (r.sections || {});

  function sectionLabel(s) {
    const style = s.style || {};
    const color = style.color ? `color:${esc(style.color)};` : '';
    const txt = esc(s.title || s.id);
    if (style.heading === 'h2' || style.heading === 'h1') {
      return `<h3 style="font-size:17px;font-weight:600;${color}margin:0 0 10px;line-height:1.4">${txt}</h3>`;
    }
    return `<div class="r-l" style="${color}">${txt}</div>`;
  }

  function renderSection(s) {
    const style = s.style || {};
    const v = sections[s.id];
    const divider = style.dividerBefore ? '<hr class="r-div">' : '';
    const panelStyle = style.panel
      ? 'background:rgba(76,112,255,.10);border:1px solid rgba(76,112,255,.32);border-left:3px solid #4c70ff;border-radius:6px;padding:12px 14px 10px'
      : '';
    const wrapStart = `<div class="r-f" ${panelStyle ? `style="${panelStyle}"` : ''}>`;

    if (s.type === 'list') {
      const items = Array.isArray(v) ? v.filter(x => x && String(x).trim()) : [];
      const tag = s.listStyle === 'ordered' ? 'ol' : 'ul';
      const cls = s.listStyle === 'ordered' ? ' class="steps-ol"' : ' style="margin:0;padding-left:22px;color:var(--text);font-size:13px;line-height:1.65"';
      const lis = items.length
        ? items.map(item => `<li style="display:flex;align-items:flex-start;gap:6px"><span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span><span style="flex:1;padding:2px 0" contenteditable="plaintext-only" data-edit="sectionItem">${esc(item)}</span><button class="list-item-del" onclick="removeListItem(this)" title="Remove">×</button></li>`).join('')
        : `<li><span style="flex:1;color:var(--dim);font-style:italic" contenteditable="plaintext-only" data-edit="sectionItem">(click to add)</span></li>`;
      return `${divider}${wrapStart}
        ${sectionLabel(s)}
        <${tag}${cls} data-edit-list="${esc(s.id)}" data-section-list="1">${lis}</${tag}>
        <button class="add-step-btn" onclick="addSectionItem('[data-result-id=&quot;${esc(resultId)}&quot;] [data-edit-list=&quot;${esc(s.id)}&quot;]')">+ ${esc((s.title || 'item').toLowerCase())}</button>
      </div>`;
    }

    const text = v === undefined || v === null ? '' : String(v);
    const prefix = style.prefix || '';
    if (style.heading === 'h2' || style.heading === 'h1') {
      const color = style.color ? `color:${esc(style.color)};` : '';
      const label = prefix || (s.title ? `${s.title}: ` : '');
      return `${divider}<h3 style="font-size:17px;font-weight:600;${color}margin:0 0 10px;line-height:1.4">${esc(label)}<span contenteditable="plaintext-only" data-edit="sectionText" data-section-id="${esc(s.id)}">${esc(text)}</span></h3>`;
    }
    return `${divider}${wrapStart}
      ${sectionLabel(s)}
      <div class="r-v" style="white-space:pre-wrap;line-height:1.65" contenteditable="plaintext-only" data-edit="sectionText" data-section-id="${esc(s.id)}">${esc(text)}</div>
    </div>`;
  }

  const populatedFields = (cfg.customFields || []).filter(f => {
    if (typeof isEnvironmentField === 'function' && isEnvironmentField(f.name, f.jiraId)) return false;
    const v = r.customFields?.[f.name];
    return v !== undefined && v !== null && v !== '' && v !== 'null';
  });
  const cfHtml = populatedFields.length
    ? `<hr class="r-div"><div class="r-l">Custom fields</div><div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">`
      + populatedFields.map(f => {
          const v = r.customFields[f.name];
          return `<div style="display:flex;gap:10px;align-items:baseline">
            <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim);min-width:130px">${esc(f.name)}</span>
            <span style="font-size:13px;color:var(--text);flex:1" contenteditable="plaintext-only" data-edit="customField" data-cf-name="${esc(f.name)}">${esc(String(v))}</span>
          </div>`;
        }).join('') + '</div>'
    : '';

  return `
    <div class="r-f"><div class="r-l">Summary</div><div class="r-v sum" contenteditable="plaintext-only" data-edit="summary">${esc(r.summary || '')}</div></div>
    <hr class="r-div">
    ${tpl.sections.map(renderSection).join('<hr class="r-div">')}
    ${r.environment ? `<hr class="r-div"><div class="r-f"><div class="r-l">Environment</div><div class="r-v" style="white-space:pre-wrap;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.55" contenteditable="plaintext-only" data-edit="environment">${esc(r.environment || '')}</div></div>` : ''}
    ${cfHtml}`;
}

function renderEditableGherkinBody(r, resultId = 'report') {
  // AR / ER come in as multiline strings ("- bullet\n- bullet"); split
  // them into list items so the user can edit individual bullets.
  function splitBullets(s) {
    return String(s || '').replace(/\\n/g, '\n').split('\n')
      .map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean);
  }
  const arItems = splitBullets(r.actualResult);
  const erItems = splitBullets(r.expectedResult);

  const populatedFields = (cfg.customFields || []).filter(f => {
    if (typeof isEnvironmentField === 'function' && isEnvironmentField(f.name, f.jiraId)) return false;
    const v = r.customFields?.[f.name];
    return v !== undefined && v !== null && v !== '' && v !== 'null';
  });
  const cfHtml = populatedFields.length
    ? `<hr class="r-div"><div class="r-l">Custom fields</div><div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">`
      + populatedFields.map(f => {
          const v = r.customFields[f.name];
          return `<div style="display:flex;gap:10px;align-items:baseline">
            <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim);min-width:130px">${esc(f.name)}</span>
            <span style="font-size:13px;color:var(--text);flex:1" contenteditable="plaintext-only" data-edit="customField" data-cf-name="${esc(f.name)}">${esc(String(v))}</span>
          </div>`;
        }).join('') + '</div>'
    : '';

  return `
    <div class="r-f"><div class="r-l">Summary</div><div class="r-v sum" contenteditable="plaintext-only" data-edit="summary">${esc(r.summary || '')}</div></div>
    <hr class="r-div">
    <div class="r-f"><div class="r-l">Description</div><div class="r-v" style="line-height:1.8;white-space:pre-wrap" contenteditable="plaintext-only" data-edit="description">${esc(r.description || '')}</div></div>
    <hr class="r-div">
    <div class="r-f"><div class="r-l">Environment</div><div class="r-v" style="white-space:pre-wrap;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.55" contenteditable="plaintext-only" data-edit="environment">${esc(r.environment || '')}</div></div>
    <hr class="r-div">
    <div class="r-f">
      <div class="r-l">Actual result</div>
      <ul style="margin:0;padding-left:22px;color:var(--text);font-size:13px;line-height:1.7" data-edit-list="actualResult">
        ${arItems.length
          ? arItems.map(s => `<li contenteditable="plaintext-only" data-edit="arBullet">${esc(s)}</li>`).join('')
          : `<li contenteditable="plaintext-only" data-edit="arBullet" style="color:var(--dim);font-style:italic">(click to add)</li>`}
      </ul>
    </div>
    <hr class="r-div">
    <div class="r-f">
      <div class="r-l">Expected result</div>
      <ul style="margin:0;padding-left:22px;color:var(--text);font-size:13px;line-height:1.7" data-edit-list="expectedResult">
        ${erItems.length
          ? erItems.map(s => `<li contenteditable="plaintext-only" data-edit="erBullet">${esc(s)}</li>`).join('')
          : `<li contenteditable="plaintext-only" data-edit="erBullet" style="color:var(--dim);font-style:italic">(click to add)</li>`}
      </ul>
    </div>
    ${r.additionalInfo !== undefined
      ? `<hr class="r-div"><div class="r-f"><div class="r-l">Additional info</div><div class="r-v" contenteditable="plaintext-only" data-edit="additionalInfo">${esc(r.additionalInfo || '')}</div></div>`
      : ''}
    ${cfHtml}`;
}

// ── Linked work items block (result cards) ─────────────────────────────────
// Shared widget rendered inside every result card (Report page, Batch cards,
// History items) showing which tickets the new bug will be linked to on
// Push to Jira. Fully editable per report: add / edit / remove rows mutate
// r.linkedWorkItems on the object resolved via data-result-id, so edits
// persist exactly like the rest of the editable card (History auto-saves
// through its resolver's onUpdate).
function renderLinkedItemsBlock(r, resultId) {
  const items = Array.isArray(r.linkedWorkItems) ? r.linkedWorkItems : [];
  const rows = items.map((it, i) => {
    const url = (typeof linkedItemUrl === 'function') ? linkedItemUrl(it) : (it.url || '');
    const open = url
      ? `<a class="lwi-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">↗</a>`
      : `<span class="lwi-open" style="opacity:.25">↗</span>`;
    return `<div class="lwi-row">
      <select onchange="updateResultLinked('${esc(resultId)}', ${i}, 'relation', this.value)">${linkRelationOptionsHtml(it.relation)}</select>
      <input type="text" value="${esc(it.key || '')}" placeholder="FER-123" oninput="updateResultLinked('${esc(resultId)}', ${i}, 'key', this.value)"/>
      <input type="text" value="${esc(it.title || '')}" placeholder="Title (optional)" oninput="updateResultLinked('${esc(resultId)}', ${i}, 'title', this.value)"/>
      ${open}
      <button class="rule-del" onclick="removeResultLinked('${esc(resultId)}', ${i})" title="Remove">×</button>
    </div>`;
  }).join('');

  return `<div class="linked-block" data-linked-block>
    <div class="linked-block-head">
      <span class="linked-block-title">🔗 Linked work items</span>
      <span class="linked-block-count">${items.length ? items.length + ' · created on Push to Jira' : 'none'}</span>
      <button class="btn btn-ghost btn-sm" onclick="addResultLinked('${esc(resultId)}')">+ Add</button>
    </div>
    ${rows || `<div class="linked-block-empty">No links — this bug will be created standalone. Defaults come from Setup → Linked work items.</div>`}
  </div>`;
}
window.renderLinkedItemsBlock = renderLinkedItemsBlock;

// Re-render JUST the linked block of one result card (used after add/remove;
// per-keystroke edits intentionally skip re-render to keep input focus).
function _refreshLinkedBlock(resultId) {
  const target = resolveResultTarget(resultId);
  if (!target || !target.obj) return;
  const scopeEl = document.querySelector(`[data-result-id="${CSS.escape(resultId)}"]`);
  const blockEl = scopeEl && scopeEl.querySelector('[data-linked-block]');
  if (!blockEl) return;
  blockEl.outerHTML = renderLinkedItemsBlock(target.obj, resultId);
}

function addResultLinked(resultId) {
  const target = resolveResultTarget(resultId);
  if (!target || !target.obj) return;
  if (!Array.isArray(target.obj.linkedWorkItems)) target.obj.linkedWorkItems = [];
  target.obj.linkedWorkItems.push({
    relation: (typeof DEFAULT_LINK_RELATION !== 'undefined') ? DEFAULT_LINK_RELATION : 'relates to',
    key: '', title: '', url: '',
  });
  if (target.onUpdate) target.onUpdate();
  _refreshLinkedBlock(resultId);
  // Focus the fresh key input so the user can type the ticket right away.
  const scopeEl = document.querySelector(`[data-result-id="${CSS.escape(resultId)}"]`);
  const rows = scopeEl ? scopeEl.querySelectorAll('[data-linked-block] .lwi-row input[placeholder="FER-123"]') : [];
  if (rows.length) rows[rows.length - 1].focus();
}
window.addResultLinked = addResultLinked;

function updateResultLinked(resultId, idx, field, value) {
  const target = resolveResultTarget(resultId);
  if (!target || !target.obj) return;
  const it = Array.isArray(target.obj.linkedWorkItems) && target.obj.linkedWorkItems[idx];
  if (!it) return;
  if (field === 'relation') it.relation = (typeof normalizeLinkRelation === 'function') ? normalizeLinkRelation(value) : value;
  else it[field] = String(value);
  if (target.onUpdate) target.onUpdate();
}
window.updateResultLinked = updateResultLinked;

function removeResultLinked(resultId, idx) {
  const target = resolveResultTarget(resultId);
  if (!target || !target.obj) return;
  if (!Array.isArray(target.obj.linkedWorkItems)) return;
  target.obj.linkedWorkItems.splice(idx, 1);
  if (target.onUpdate) target.onUpdate();
  _refreshLinkedBlock(resultId);
}
window.removeResultLinked = removeResultLinked;
