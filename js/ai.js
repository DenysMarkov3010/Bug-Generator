// ── ai ────────────────────────────────────────────────────────────────────
// Builds the system prompt from user rules + custom fields, then calls
// either Anthropic or OpenRouter, expecting a strict JSON response.
//
// Public API consumed by app.js, session.js, history.js:
//   generate()                          → Report page single-bug flow
//   buildSystemPrompt({isGherkin,ticket}) → shared prompt builder
//   callAi(systemPrompt, userText)      → Anthropic/OpenRouter call
//   normalizeAiResult(raw, isGherkin)   → post-processing (defaults, env)
//   renderResult(r)                     → Report-page card rendering

// ── shared system-prompt builder ──────────────────────────────────────────
// Both single-bug generate() and the parallel Session-mode generateSession()
// call this so prompt logic stays in one place. `opts.isGherkin` swaps
// the output schema; `opts.ticket` (optional) injects ticket terminology
// context so the AI mirrors the source ticket's exact wording.
function buildSystemPrompt(opts) {
  const { isGherkin = false } = opts || {};
  const rulesText = cfg.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

  // Environment override — same logic as the legacy single-bug prompt.
  const envHasDefault = !!(cfg.defaultEnvironment && cfg.defaultEnvironment.trim());
  const envRule = envHasDefault
    ? `\nIMPORTANT — Environment field:\n- A project default Environment is saved in the app.\n- ALWAYS set "environment" to null in your JSON response.\n- The app will substitute the saved value VERBATIM after your reply.\n- Do NOT extract, infer, summarize, or invent any environment details from the user's description.`
    : '';

  // Custom-field descriptors + strict extraction rules. Skipped entirely
  // for Gherkin reports because the AI is busy enough constructing the
  // scenario; CFs are usually irrelevant to the GIVEN/WHEN/THEN narrative.
  const cfDesc = (!isGherkin && cfg.customFields.length)
    ? '\nCustom fields to consider — extract ONLY when EXPLICITLY mentioned by the user:\n'
      + cfg.customFields.map(f => {
          const def = f.default ? ` — project default: "${f.default}"` : '';
          return `- "${f.name}" (${f.type})${def}`;
        }).join('\n')
      + `\n\nStrict extraction rules for customFields:
- Return null when the user did NOT explicitly state a value. The app
  fills the project default automatically — you do NOT need to guess.
- "Explicit mention" means the user actually names the field's value
  (e.g. "this is for the Backoffice component", "happened in sprint 110",
  "tested in Chrome 130"). Mentioning a feature, page, or UI element in
  the reproduction steps is NOT an explicit mention.
- DO NOT treat capitalised words from the steps ("Patient App", "Clinic
  Details", "Pay button", "Checkout page") as Component / Module values.
  Those are UI references inside the steps, not project taxonomy values.
- For list-type fields (Components, Labels, Fix Versions, Affects Versions),
  return AT MOST ONE value, and only if it is an explicit mention.
- Returning null is preferred over a guess. The default is almost always
  better than an invented value that won't exist in Jira.`
    : '';

  // The raw description is often dictated by voice, so it can carry
  // speech-recognition artifacts. Telling the model that explicitly lets it
  // recover the intended words from context instead of copying mishearings.
  const dictationNote = 'The description is often dictated by voice in Ukrainian with technical terms / UI labels spoken in English, so it may contain speech-recognition errors: misheard words, broken word boundaries, and English terms transliterated into Cyrillic («чекаут пейдж» = "Checkout page"). Infer the intended words from context instead of copying obvious mishearings verbatim, and restore transliterated English terms to their proper English spelling.';
  if (isGherkin) {
    return `You are a senior QA engineer. Given a raw bug description (may be Ukrainian or English), write a bug report IN ENGLISH ONLY using a Gherkin scenario style. Use plain, simple language (B2 level). ${dictationNote}

Project rules (follow them precisely):
${rulesText}${cfDesc}${envRule}

IMPORTANT:
- Do NOT invent usernames, names, or details not in the description.
- Use only information from the user description provided.
- Use \\n to separate lines inside JSON string values.
- Use backticks only for error messages shown on screen.

Schema:
- "summary"        = short title (max ~100 chars).
- "severity"       = Critical | High | Medium | Low.
- "environment"    = where the bug was found (browser, OS, version, account role). Single string. Optional.
- "description"    = 1-2 sentences about what the user cannot do and what the system shows. THEN on a new line:
                       Scenario: <name of expected behavior>
                       GIVEN <precondition>
                       AND <extra condition if needed>
                       WHEN <user action>
                       THEN <expected system behavior>
- "actualResult"   = bullet list of wrong behaviors, each line starting with "- ".
- "expectedResult" = bullet list of correct behaviors, each line starting with "- ".
- "additionalInfo" = optional extra info.
- "customFields"   = best-effort extraction of the listed custom fields. Use null when not present.

Respond ONLY with valid JSON, no markdown fences:
{"summary":"...","severity":"Critical|High|Medium|Low","environment":"...","description":"sentences\\nScenario: name\\nGIVEN ...\\nWHEN ...\\nTHEN ...","actualResult":"- wrong\\n- wrong","expectedResult":"- correct\\n- correct","additionalInfo":"","customFields":{"Field name":"value or null"}}`;
  }

  // ── Normal format (template-driven) ────────────────────────────────────
  const reportTpl = typeof getReportTemplate === 'function' ? getReportTemplate() : { sections: [] };
  const sectionSpec = reportTpl.sections.map(s => {
    const list = s.type === 'list' ? `, listStyle=${s.listStyle || 'bullet'}` : '';
    const req = s.required ? ', required' : ', optional';
    const desc = s.description ? ` — ${s.description}` : '';
    const style = s.style && Object.keys(s.style).length ? ` Style hints: ${JSON.stringify(s.style)}` : '';
    return `- id="${s.id}", title="${s.title}", type=${s.type}${list}${req}${desc}.${style}`;
  }).join('\n');
  const exampleSections = {};
  reportTpl.sections.forEach(s => { exampleSections[s.id] = s.type === 'list' ? ['...'] : '...'; });

  return `You are a senior QA engineer. Given a raw bug description (may be Ukrainian or English), write a structured bug report IN ENGLISH ONLY. ${dictationNote}

Project rules (follow them precisely — both content and any formatting / styling conventions):
${rulesText}${cfDesc}${envRule}

Template-driven Normal report sections:
${sectionSpec || '- No sections configured; return an empty sections object.'}

Output schema notes:
- "summary" = short title (max ~100 chars). Plain text.
- "severity" = Critical | High | Medium | Low.
- "environment" = where the bug was found (browser, OS, version, env name, account role). Optional; set null when a project default is configured.
- "sections" = object whose keys are EXACTLY the section ids above.
  * For type=list sections, return an array of plain-text strings.
  * For type=text sections, return one plain-text string.
  * Do not include section labels/prefixes such as "AR:", "Expected:", "Step 1:" inside values unless the user's actual content includes them.
  * Keep content in the section that matches its description; do not duplicate the same information across sections.
  * Optional sections may be [] or "" when the user's description does not provide enough information.
- "customFields" = best-effort extraction of the listed custom fields. Use null when not present.

Respond ONLY with valid JSON, no markdown fences:
${JSON.stringify({ summary: '...', severity: 'Critical|High|Medium|Low', environment: '...', sections: exampleSections, customFields: { 'Field name': 'value or null' } })}`;
}

// ── unified AI call ───────────────────────────────────────────────────────
// Resolves to the raw model text (the JSON the system prompt asked for).
// Throws on non-2xx responses with a human-readable message.
async function callAi(systemPrompt, userText) {
  if (provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: cfg.openRouterModel || 'openrouter/auto',
        max_tokens: 1600,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calling the Anthropic API straight from a browser page
      // (no backend in between) — opts in to CORS-enabled direct access.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content.map(i => i.text || '').join('');
}

// ── OpenRouter speech-to-text ─────────────────────────────────────────────
// Used by Setup → Dictation → "GPT-4o Transcribe". Browser Web Speech still
// provides the instant live preview; this runs after Stop and replaces the
// dictated chunk with a higher-accuracy transcription from the recorded
// audio. GPT-4o Transcribe is natively multilingual, so a Ukrainian
// dictation peppered with English terms ("Checkout page", "crash") comes
// back with the English words spelled in English rather than the Cyrillic
// transliteration a monolingual recognizer produces.
async function transcribeWithGpt4o(audioBlob, languageHint) {
  if (!apiKey) throw new Error('Missing OpenRouter API key');
  if (provider !== 'openrouter') throw new Error('Switch AI provider to OpenRouter in Setup');
  if (!audioBlob || !audioBlob.size) throw new Error('No audio was recorded');
  const fmt = audioBlob.type.includes('webm') ? 'webm'
    : audioBlob.type.includes('ogg') ? 'ogg'
      : audioBlob.type.includes('mp4') ? 'mp4'
        : audioBlob.type.includes('mpeg') || audioBlob.type.includes('mp3') ? 'mp3'
          : 'wav';
  const buf = await audioBlob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const body = {
    model: 'openai/gpt-4o-transcribe',
    input_audio: {
      data: btoa(binary),
      format: fmt,
    },
    temperature: 0,
  };
  if (languageHint) body.language = languageHint;

  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || e.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return String(data.text || data.transcription || data.output_text || '').trim();
}

// ── robust JSON extraction ────────────────────────────────────────────────
// Models occasionally wrap JSON in ``` fences, add trailing prose, or emit
// raw newlines / tabs inside string values. This helper survives all of
// those; lifted from the single-file prototype but tightened a bit.
function parseAiJson(raw) {
  let s = String(raw).replace(/```[\w]*\s*/g, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in AI response');
  s = s.slice(start, end + 1);

  // Quick path: try as-is. Most modern models return valid JSON now.
  try { return JSON.parse(s); } catch {}

  // Slow path: escape unescaped newlines/tabs inside string values.
  s = s.replace(/\\n/g, '\\\\n').replace(/\\t/g, '\\\\t');
  let out = '', inStr = false, escNext = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escNext) { out += c; escNext = false; continue; }
    if (c === '\\') { escNext = true; out += c; continue; }
    if (c === '"')  { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') continue;
      if (c === '\t') { out += '\\t'; continue; }
    }
    out += c;
  }
  out = out.replace(/,([\s\n\r]*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ── post-process raw AI JSON ──────────────────────────────────────────────
// Two responsibilities:
//   1. strip stray wiki/markdown markup the model may have copied from
//      an analyzed template (handled by stripJiraMarkup);
//   2. apply Default Environment + per-field CF defaults so the rendered
//      card / Jira issue use the curated values.
function normalizeAiResult(rawText, isGherkin) {
  const raw = parseAiJson(rawText);
  const envHasDefault = !!(cfg.defaultEnvironment && cfg.defaultEnvironment.trim());

  if (isGherkin) {
    const out = {
      ...raw,
      summary:        stripJiraMarkup(raw.summary        || ''),
      environment:    stripJiraMarkup(raw.environment    || ''),
      description:    stripJiraMarkup(raw.description    || ''),
      actualResult:   stripJiraMarkup(raw.actualResult   || ''),
      expectedResult: stripJiraMarkup(raw.expectedResult || ''),
      additionalInfo: stripJiraMarkup(raw.additionalInfo || ''),
    };
    if (envHasDefault) out.environment = cfg.defaultEnvironment;
    if (cfg.customFields.length) {
      const cfOut = (out.customFields && typeof out.customFields === 'object') ? out.customFields : {};
      cfg.customFields.forEach(f => {
        const v = cfOut[f.name];
        const isEmpty = v === undefined || v === null || v === '' || v === 'null';
        if (isEmpty && f.default) cfOut[f.name] = f.default;
      });
      out.customFields = cfOut;
    }
    // Every report starts with a COPY of the project-default linked work
    // items (Setup → Linked work items); per-report edits on the result
    // card touch only this copy, never the defaults.
    out.linkedWorkItems = normalizeLinkedWorkItems(JSON.parse(JSON.stringify(cfg.linkedWorkItems || [])));
    return out;
  }

  const out = {
    ...raw,
    summary:       stripJiraMarkup(raw.summary     || ''),
    environment:   stripJiraMarkup(raw.environment || ''),
    sections:      (raw.sections && typeof raw.sections === 'object') ? raw.sections : {},
  };
  // Accept old model output / old History shape and fold it into the
  // current template-driven `sections` object.
  ['preconditions', 'steps', 'actual', 'expected'].forEach(k => {
    if (raw[k] !== undefined && out.sections[k] === undefined) out.sections[k] = raw[k];
  });
  if (typeof ensureNormalSections === 'function') {
    ensureNormalSections(out);
  }

  if (envHasDefault) out.environment = cfg.defaultEnvironment;

  // Apply per-field defaults (same logic as before).
  if (cfg.customFields.length) {
    const cfOut = (out.customFields && typeof out.customFields === 'object') ? out.customFields : {};
    cfg.customFields.forEach(f => {
      const v = cfOut[f.name];
      const isEmpty = v === undefined || v === null || v === '' || v === 'null';
      if (isEmpty && f.default) cfOut[f.name] = f.default;
    });
    out.customFields = cfOut;
  }
  // Copy of the project-default linked work items — see the gherkin branch.
  out.linkedWorkItems = normalizeLinkedWorkItems(JSON.parse(JSON.stringify(cfg.linkedWorkItems || [])));
  return out;
}

// ── single-bug generate (Report page) ─────────────────────────────────────
async function generate() {
  const ticket = document.getElementById('tin').value.trim();
  if (!ticket) { showErr('Please add a description — type or dictate.'); return; }
  if (!apiKey) { promptKey(); return; }

  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  document.getElementById('errArea').innerHTML = '';
  document.getElementById('resArea').innerHTML = '';

  const isGherkin = reportFormat === 'gherkin';
  const sys = buildSystemPrompt({ isGherkin });

  try {
    const raw = await callAi(sys, ticket);
    lastRep = normalizeAiResult(raw, isGherkin);
    renderResult(lastRep);
    addToHistory(lastRep, reportFormat);
  } catch (e) {
    showErr('Error: ' + e.message);
  }

  btn.disabled = false;
  btn.innerHTML = '→ Generate bug report';
}

// ── Report-page result rendering ──────────────────────────────────────────
function renderResult(r) {
  if (reportFormat === 'gherkin') return renderResultGherkin(r);
  return renderResultNormal(r);
}

function renderResultNormal(r) {
  document.getElementById('resArea').innerHTML = `
    <div class="result-card" data-result-id="report">
      <div class="res-top">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="res-lbl">Bug report</span>
          <span class="sev sev-edit sev-${esc(r.severity || 'Medium')}" onclick="cycleSeverity(this)" title="Click to change severity">${esc(r.severity || 'Medium')}</span>
          <span style="font-size:10px;color:var(--dim);font-family:'IBM Plex Mono',monospace">click anywhere to edit</span>
        </div>
        <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim)">${esc(cfg.projectKey || 'QA')} · ${esc(cfg.issueType || 'Bug')}</span>
      </div>
      <div class="res-body">${renderEditableNormalBody(r, 'report')}</div>
      ${renderLinkedItemsBlock(r, 'report')}
      <div class="res-actions">
        <button class="btn btn-ghost btn-sm" onclick="copyReport()">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" onclick="pushToJira()">🚀 Push to Jira</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('tin').value='';document.getElementById('resArea').innerHTML=''">🗑 Clear</button>
      </div>
    </div>`;
}

function renderResultGherkin(r) {
  document.getElementById('resArea').innerHTML = `
    <div class="result-card" data-result-id="report">
      <div class="res-top">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="res-lbl">Bug report</span>
          <span class="sev sev-edit sev-${esc(r.severity || 'Medium')}" onclick="cycleSeverity(this)" title="Click to change severity">${esc(r.severity || 'Medium')}</span>
          <span style="font-size:10px;font-family:'IBM Plex Mono',monospace;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--muted)">Gherkin</span>
          <span style="font-size:10px;color:var(--dim);font-family:'IBM Plex Mono',monospace">click anywhere to edit</span>
        </div>
        <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim)">${esc(cfg.projectKey || 'QA')} · ${esc(cfg.issueType || 'Bug')}</span>
      </div>
      <div class="res-body">${renderEditableGherkinBody(r)}</div>
      ${renderLinkedItemsBlock(r, 'report')}
      <div class="res-actions">
        <button class="btn btn-ghost btn-sm" onclick="copyReport()">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" onclick="pushToJira()">🚀 Push to Jira</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('tin').value='';document.getElementById('resArea').innerHTML=''">🗑 Clear</button>
      </div>
    </div>`;
}

// ── format toggle (Report page) ───────────────────────────────────────────
function setReportFormat(f) {
  reportFormat = f;
  localStorage.setItem('bra_format', f);
  const a = document.getElementById('fmtNormal');
  const b = document.getElementById('fmtGherkin');
  if (a) a.classList.toggle('active', f === 'normal');
  if (b) b.classList.toggle('active', f === 'gherkin');
}

