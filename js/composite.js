// ── composite ─────────────────────────────────────────────────────────────
// "Composite Bug" toggle on the Single Report tab: several related issues
// (usually found on the same page) filed as ONE Jira ticket. Every issue gets
// its own input section — typed or dictated — and in the generated ticket its
// own Jira Expand titled "Issue #N. <title>" holding a full report body
// (Preconditions / Steps / AR / ER, or the Gherkin equivalent).
//
// Input sections are { id, text } objects in `compositeIssues` (state.js);
// the textarea of a section is #ci-txt-<id>. The textareas are the source of
// truth while typing / dictating — syncCompositeFromDom() pulls them back
// into the objects before every re-render.
//
// Dictation reuses the Single-Report mic (voice.js): it writes into the
// section returned by compositeDictationTargetId(), and the floating window
// gets a "+ Next issue" button that moves a live recording to a new section.
//
// Generated shape (see normalizeCompositeResult in ai.js):
//   { summary, severity, environment, customFields, linkedWorkItems,
//     issues: [{ title, sections }] }                       ← Normal
//     issues: [{ title, description, actualResult, … }]     ← Gherkin

function setCompositeMode(on, save = true) {
  on = !!on;
  // The mic may be writing into a section that is about to be hidden.
  if (on !== compositeMode && typeof isRec !== 'undefined' && isRec && typeof stopRec === 'function') stopRec();
  compositeMode = on;
  if (save) localStorage.setItem('bra_composite', on ? '1' : '0');

  const off = document.getElementById('compOff');
  const onB = document.getElementById('compOn');
  if (off) off.classList.toggle('active', !on);
  if (onB) onB.classList.toggle('active', on);
  const single = document.getElementById('tinField');
  const multi  = document.getElementById('compositeField');
  if (single) single.style.display = on ? 'none' : '';
  if (multi)  multi.style.display  = on ? '' : 'none';
  const gen = document.getElementById('genBtn');
  if (gen && !gen.disabled) gen.innerHTML = on ? '→ Generate composite bug report' : '→ Generate bug report';

  if (on && !compositeIssues.length) {
    // First switch-on: whatever was already typed in the single textarea
    // becomes Issue #1 (copied, not moved — switching back loses nothing),
    // plus an empty Issue #2 to make the multi-issue intent obvious.
    const seed = (document.getElementById('tin')?.value || '').trim();
    compositeIssues.push({ id: ++compositeIssueCounter, text: seed });
    compositeIssues.push({ id: ++compositeIssueCounter, text: '' });
    compositeActiveId = compositeIssues[seed ? 1 : 0].id;
  }
  if (on) renderCompositeIssues();
}

// ── input sections ────────────────────────────────────────────────────────
function syncCompositeFromDom() {
  compositeIssues.forEach(it => {
    const ta = document.getElementById('ci-txt-' + it.id);
    if (ta) it.text = ta.value;
  });
}

function renderCompositeIssues() {
  const box = document.getElementById('compositeIssues');
  if (!box) return;
  syncCompositeFromDom();
  if (!compositeIssues.some(it => it.id === compositeActiveId)) {
    compositeActiveId = compositeIssues.length ? compositeIssues[compositeIssues.length - 1].id : null;
  }
  box.innerHTML = compositeIssues.map((it, idx) => `
    <div class="ci-in" id="ci-${it.id}">
      <div class="ci-in-head">
        <span class="ci-in-title">Issue #${idx + 1}</span>
        <span class="ci-in-status" id="ci-st-${it.id}"></span>
        <button class="ci-mic" id="ci-mic-${it.id}" onclick="toggleCompositeIssueRec(${it.id})" title="Dictate into Issue #${idx + 1}">🎙</button>
        ${compositeIssues.length > 1 ? `<button class="rule-del" onclick="removeCompositeIssue(${it.id})" title="Remove Issue #${idx + 1}">×</button>` : ''}
      </div>
      <textarea id="ci-txt-${it.id}" rows="3" placeholder="Describe issue #${idx + 1} — what you did, what happened, what should happen…" onfocus="setCompositeActive(${it.id})">${esc(it.text)}</textarea>
    </div>`).join('');
  refreshCompositeDictationState();
}

// Returns the new section's id (the PiP "+ Next issue" needs it).
function addCompositeIssue(opts) {
  const o = opts || {};
  syncCompositeFromDom();
  const id = ++compositeIssueCounter;
  compositeIssues.push({ id, text: '' });
  // While recording, the active section follows the mic (see
  // refreshCompositeDictationState) — only move it when idle.
  if (typeof isRec === 'undefined' || !isRec) compositeActiveId = id;
  renderCompositeIssues();
  if (o.focus !== false) {
    const ta = document.getElementById('ci-txt-' + id);
    if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
  return id;
}

function removeCompositeIssue(id) {
  if (typeof isRec !== 'undefined' && isRec && typeof dictTargetId !== 'undefined' && dictTargetId === 'ci-txt-' + id) stopRec();
  syncCompositeFromDom();
  compositeIssues = compositeIssues.filter(it => it.id !== id);
  renderCompositeIssues();
}

function setCompositeActive(id) {
  compositeActiveId = id;
  refreshCompositeDictationState();
}

// Per-section 🎙: start dictating into this section, stop it if it is the
// one being dictated, or move a running recording over to it.
function toggleCompositeIssueRec(id) {
  const targetId = 'ci-txt-' + id;
  if (isRec && dictTargetId === targetId) { stopRec(); return; }
  compositeActiveId = id;
  if (isRec) { switchDictationTarget(targetId); return; }
  startRec();
}

// voice.js hook: which textarea the Single-Report mic should write into.
// null when Composite is off → voice.js falls back to #tin.
function compositeDictationTargetId() {
  if (!compositeMode) return null;
  if (!compositeIssues.length) addCompositeIssue({ focus: false });
  if (!compositeIssues.some(it => it.id === compositeActiveId)) {
    compositeActiveId = compositeIssues[compositeIssues.length - 1].id;
  }
  return 'ci-txt-' + compositeActiveId;
}

// "ci-txt-7" → its 1-based position ("Issue #2"), 0 when not a section.
function compositeIssueNumberFor(targetId) {
  const idx = compositeIssues.findIndex(it => 'ci-txt-' + it.id === targetId);
  return idx + 1;
}

// voice.js hook: repaint which section is recording / transcribing without
// re-rendering the textareas (that would steal focus and the caret).
function refreshCompositeDictationState() {
  const recTarget = (typeof isRec !== 'undefined' && isRec && typeof dictTargetId !== 'undefined') ? dictTargetId : '';
  const recIssue = compositeIssues.find(it => 'ci-txt-' + it.id === recTarget);
  if (recIssue) compositeActiveId = recIssue.id;
  compositeIssues.forEach(it => {
    const tid = 'ci-txt-' + it.id;
    const box = document.getElementById('ci-' + it.id);
    const mic = document.getElementById('ci-mic-' + it.id);
    const st  = document.getElementById('ci-st-' + it.id);
    const recording = tid === recTarget;
    const transcribing = typeof transcribingTargets !== 'undefined' && transcribingTargets.has(tid);
    if (box) {
      box.classList.toggle('active', it.id === compositeActiveId);
      box.classList.toggle('rec', recording);
    }
    if (mic) { mic.classList.toggle('rec', recording); mic.textContent = recording ? '⏹' : '🎙'; }
    if (st)  st.textContent = recording ? '🔴 dictating' : (transcribing ? '⏳ transcribing…' : '');
  });
}

// ── generate ──────────────────────────────────────────────────────────────
// One AI call for all issues: the model sees "Issue #1: …", "Issue #2: …"
// and returns an umbrella summary + one entry per issue (buildSystemPrompt
// with composite:true spells out the schema).
async function generateComposite() {
  syncCompositeFromDom();
  const filled = compositeIssues.map(it => (it.text || '').trim()).filter(Boolean);
  const withFiles = typeof hasReportAttachments === 'function' && hasReportAttachments();
  if (!filled.length && !withFiles) { showErr('Describe at least one issue — type or dictate into the Issue sections, or attach screenshots / recordings.'); return; }
  if (!apiKey) { promptKey(); return; }

  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Analyzing ${filled.length || ''} issue${filled.length === 1 ? '' : 's'}…`;
  document.getElementById('errArea').innerHTML = '';
  document.getElementById('resArea').innerHTML = '';

  const isGherkin = reportFormat === 'gherkin';
  // Without written issues the model splits the attachments into issues
  // itself (one per highlighted area / separate problem).
  const userText = filled.length
    ? filled.map((t, i) => `Issue #${i + 1}:\n${t}`).join('\n\n')
    : 'No written issues — identify each separate issue shown in the attachments (one per highlighted area or distinct problem) and number them Issue #1, Issue #2, …';

  try {
    const files = withFiles
      ? await prepareAttachmentsForAi(msg => { btn.innerHTML = `<span class="spinner"></span> ${esc(msg)}`; })
      : null;
    if (files) btn.innerHTML = '<span class="spinner"></span> Analyzing…';
    const sys = buildSystemPrompt({ isGherkin, composite: true, attachments: files ? files.prompt : '' });
    // Every issue is a full report body — scale the output budget so the
    // JSON isn't cut off mid-way.
    let usage = null;
    const raw = await callAi(sys, userText, {
      maxTokens: Math.min(8000, 1600 * Math.max(2, filled.length)),
      images: files ? files.images : [],
      purpose: 'composite',
      onUsage: u => { usage = u; },
    });
    lastRep = normalizeCompositeResult(raw, isGherkin);
    lastRep.aiUsage = usage;
    if (files) applyAttachmentsToReport(lastRep, files, isGherkin);
    renderResult(lastRep);
    addToHistory(lastRep, reportFormat);
    if (filled.length && lastRep.issues.length !== filled.length) {
      toast(`⚠ You described ${filled.length} issues but the AI returned ${lastRep.issues.length} — check the report`);
    }
  } catch (e) {
    showErr('Error: ' + e.message);
  }

  btn.disabled = false;
  btn.innerHTML = '→ Generate composite bug report';
}

// Result card "🗑 Clear": empties the input (single textarea or the issue
// sections) and the generated report.
function clearReportInput() {
  document.getElementById('tin').value = '';
  document.getElementById('resArea').innerHTML = '';
  if (typeof clearAttachments === 'function') clearAttachments();
  if (!compositeMode) return;
  if (typeof isRec !== 'undefined' && isRec && String(dictTargetId).startsWith('ci-txt-')) stopRec();
  compositeIssues = [{ id: ++compositeIssueCounter, text: '' }, { id: ++compositeIssueCounter, text: '' }];
  compositeActiveId = compositeIssues[0].id;
  renderCompositeIssues();
}
