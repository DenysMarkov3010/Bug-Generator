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
// `opts.composite` switches to the Composite Bug schema: one umbrella
// summary + an `issues` array, each issue a self-contained mini-report
// (rendered as a Jira Expand "Issue #N. <title>" — see composite.js).
// `opts.attachments` = list of attached screenshots / recordings (text from
// prepareAttachmentsForAi) — adds the evidence rules and the placement keys.
function buildSystemPrompt(opts) {
  const { isGherkin = false, composite = false, attachments = '' } = opts || {};
  const rulesText = cfg.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');

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

  const compositeRule = composite ? `

COMPOSITE BUG REPORT — the input contains SEVERAL separate issues, labelled "Issue #1:", "Issue #2:", … They are filed together as ONE Jira ticket in which every issue gets its own collapsible block titled "Issue #N. <issue title>".
- Return exactly one entry in "issues" per input issue, in the same order. Never merge, split, drop or reorder issues, and never move details from one issue into another.
- "summary" = ONE umbrella title covering all issues together (e.g. "Issues on the Order View page on Pharmacy UI"), max ~100 chars.
- "severity" = the highest severity among the issues.
- "issues[].title" = short title of that single issue (max ~100 chars), plain text, WITHOUT an "Issue #N" prefix — the app adds the numbering.
- Every issue is self-contained: it gets its own ${isGherkin ? '"description" (with its own Scenario), "actualResult" and "expectedResult"' : '"sections"'}, even when several issues share the same preconditions.` : '';

  // Screenshots / screen recordings sent along as images. Placement keys:
  // "attachmentsAfter" (where the files are embedded in the Jira ticket)
  // and, for composite reports, issues[].attachments (which issue a file
  // shows). See applyAttachmentsToReport in attachments.js.
  const slotIds = isGherkin ? '"description", "actualResult" or "expectedResult"' : 'one of the section ids above';
  const attachmentRule = attachments ? `

ATTACHMENTS — the user attached screenshots and/or screen recordings; their images follow the user's text, each labelled with its attachment number:
${attachments}
- They are EVIDENCE of the bug. Read exact UI labels, page titles, breadcrumbs, URLs in the address bar, field values and on-screen error messages from them and use that exact wording.
- Rectangles, circles or arrows drawn in a bright colour (usually red) mark the bug area — what is shown there is the actual result.
- A screen recording comes as frames in chronological order with timestamps. Reconstruct the user's steps from the sequence (navigation, clicks, typed values, opened dialogs, changing URLs) and take the moment where things go wrong as the actual result. Frames are sampled, so a quick click between two frames may be missing — infer it from what changed.
- The written description, when present, has priority; attachments complete it. If there is no written description, build the whole report from the attachments.
- Never present a guess as fact: when a step, precondition or expected result is your inference rather than something the user wrote or the attachments visibly show, append " (inferred — verify)" to it.
- ${composite
    ? `Every "issues" entry gets "attachments": [numbers of the attachments that show THIS issue] (each attachment belongs to at most one issue) and "attachmentsAfter": ${slotIds} — the section right after which those files are embedded in the Jira ticket. Follow the project rules about where screenshots / videos go; if they say nothing, use the actual-result section.`
    : `Add "attachmentsAfter": ${slotIds} — the section right after which the attached files are embedded in the Jira ticket. Follow the project rules about where screenshots / videos go; if they say nothing, use the actual-result section.`}` : '';

  if (isGherkin) {
    const gherkinJson = composite
      ? '{"summary":"umbrella title","severity":"Critical|High|Medium|Low","environment":"...","issues":[{"title":"...","description":"sentences\\nScenario: name\\nGIVEN ...\\nWHEN ...\\nTHEN ...","actualResult":"- wrong\\n- wrong","expectedResult":"- correct\\n- correct","additionalInfo":""}],"customFields":{"Field name":"value or null"}}'
      : '{"summary":"...","severity":"Critical|High|Medium|Low","environment":"...","description":"sentences\\nScenario: name\\nGIVEN ...\\nWHEN ...\\nTHEN ...","actualResult":"- wrong\\n- wrong","expectedResult":"- correct\\n- correct","additionalInfo":"","customFields":{"Field name":"value or null"}}';
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
- "customFields"   = best-effort extraction of the listed custom fields. Use null when not present.${composite ? '\n- In a composite report "description", "actualResult", "expectedResult" and "additionalInfo" live INSIDE each "issues" entry, not at the top level.' : ''}${compositeRule}${attachmentRule}

Respond ONLY with valid JSON, no markdown fences:
${gherkinJson}`;
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
  const exampleJson = composite
    ? { summary: 'umbrella title', severity: 'Critical|High|Medium|Low', environment: '...', issues: [{ title: '...', sections: exampleSections }], customFields: { 'Field name': 'value or null' } }
    : { summary: '...', severity: 'Critical|High|Medium|Low', environment: '...', sections: exampleSections, customFields: { 'Field name': 'value or null' } };

  return `You are a senior QA engineer. Given a raw bug description (may be Ukrainian or English), write a structured bug report IN ENGLISH ONLY. ${dictationNote}

Project rules (follow them precisely — both content and any formatting / styling conventions):
${rulesText}${cfDesc}${envRule}

Template-driven Normal report sections:
${sectionSpec || '- No sections configured; return an empty sections object.'}

Output schema notes:
- "summary" = short title (max ~100 chars). Plain text.
- "severity" = Critical | High | Medium | Low.
- "environment" = where the bug was found (browser, OS, version, env name, account role). Optional; set null when a project default is configured.
- "sections" = object whose keys are EXACTLY the section ids above.${composite ? ' In a composite report "sections" lives INSIDE each "issues" entry (one sections object per issue), not at the top level.' : ''}
  * For type=list sections, return an array of plain-text strings.
  * For type=text sections, return one plain-text string.
  * NEVER include section labels/prefixes such as "AR:", "ER:", "Expected:", "Step 1:" inside values. The app adds titles, prefixes, colors and heading styles automatically from the template schema — if a project rule above asks for such labels/prefixes/colors, treat it as ALREADY SATISFIED by the app and return the bare content. Including the prefix yourself renders it doubled ("AR: AR: …").
  * Keep content in the section that matches its description; do not duplicate the same information across sections.
  * Optional sections may be [] or "" when the user's description does not provide enough information.
- "customFields" = best-effort extraction of the listed custom fields. Use null when not present.${compositeRule}${attachmentRule}

Respond ONLY with valid JSON, no markdown fences:
${JSON.stringify(exampleJson)}`;
}

// ── unified AI call ───────────────────────────────────────────────────────
// Resolves to the raw model text (the JSON the system prompt asked for).
// Throws on non-2xx responses with a human-readable message.
// `opts.maxTokens` raises the output budget — a Composite Bug carries a full
// report per issue and would be truncated (→ invalid JSON) at the default.
// `opts.images` = [{ label, dataUrl }] (attachments.js) — sent after the
// text, each image preceded by its label so the model can cite "#2 at 0:14".
async function callAi(systemPrompt, userText, opts) {
  const maxTokens = (opts && opts.maxTokens) || 1600;
  const images = (opts && opts.images) || [];
  const content = fmt => {
    if (!images.length) return userText;
    const parts = [{ type: 'text', text: userText }];
    images.forEach(img => {
      parts.push({ type: 'text', text: img.label });
      if (fmt === 'openai') {
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      } else {
        const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl) || [];
        parts.push({ type: 'image', source: { type: 'base64', media_type: m[1] || 'image/jpeg', data: m[2] || '' } });
      }
    });
    return parts;
  };
  if (provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: cfg.openRouterModel || 'openrouter/auto',
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: content('openai') }],
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
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: content('anthropic') }],
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
// Used by Setup → Dictation → "GPT Transcribe" (cfg value 'gpt4o-transcribe'
// is kept for compatibility with saved configs). Web Speech still drives the
// recording lifecycle; this turns the recorded audio into the final text
// after Pause / Stop.
//
// Request shape mirrors the Meet Listener app, which runs the same model on
// OpenRouter: multipart /audio/transcriptions with
//   • languages[] — "uk" AND "en" for Ukrainian dictation, so English UI terms
//     stay English instead of being forced into Cyrillic by language=uk;
//   • keywords[]  — Context words terms + auto-replacement targets, so the
//     model spells them right in the first place;
//   • prompt      — transcription models read it as the PRECEDING text, not
//     as an instruction: glossary first, then either the tail of what was
//     already dictated (continuity across Pause / Resume) or a style sample
//     showing English UI terms written in Latin.
// If the service rejects keywords/languages (400/422) we fall back to a plain
// language + prompt request for the rest of the session, and finally to the
// JSON body this app used before.
const TRANSCRIBE_MODEL    = 'openai/gpt-transcribe';
const TRANSCRIBE_URL      = 'https://openrouter.ai/api/v1/audio/transcriptions';
const TRANSCRIBE_TAIL     = 350;   // chars of earlier dictation passed as context
const TRANSCRIBE_PROMPT_MAX = 900;
const TRANSCRIBE_STYLE = {
  uk: 'Відкриваю page, натискаю button і бачу error message — назви з екрана пишу англійською, як на екрані.',
  en: 'Open the page, click the button and see the error message.',
};
let transcribeNativeHints = true;

function transcribeLanguages(recLang) {
  return String(recLang || '').toLowerCase().startsWith('en') ? ['en'] : ['uk', 'en'];
}

// Correct spellings the model should know: glossary terms + the right-hand
// side of every auto-replacement rule. Deduped, max 100 (service limit).
function transcribeKeywords() {
  const out = [], seen = new Set();
  const add = t => {
    t = String(t || '').trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  (cfg.contextWords || []).forEach(w => add(w && w.term));
  if (typeof parseAutoReplacements === 'function') parseAutoReplacements(cfg.autoReplacements).forEach(r => add(r.target));
  return out.slice(0, 100);
}

function transcribePrompt(prevText, en) {
  const keywords = transcribeKeywords();
  const flat = String(prevText || '').replace(/\s+/g, ' ').trim();
  let context = flat;
  if (flat.length > TRANSCRIBE_TAIL) {
    const cut = flat.slice(-TRANSCRIBE_TAIL);
    context = cut.includes(' ') ? cut.slice(cut.indexOf(' ') + 1) : cut;
  }
  if (!context) context = en ? TRANSCRIBE_STYLE.en : TRANSCRIBE_STYLE.uk;
  const hints = keywords.length ? (en ? 'Terms: ' : 'Терміни: ') + keywords.join(', ') + '.' : '';
  const budget = TRANSCRIBE_PROMPT_MAX - context.length - 1;
  return `${hints.slice(0, Math.max(0, budget))} ${context}`.trim();
}

// POST with retries on network errors and 408 / 429 / 5xx (1s, 3s, 6s
// back-off). Other statuses fail immediately; the thrown Error carries
// `.status` so callers can tell "bad request" from "service down".
async function postTranscription(makeInit) {
  const delays = [1000, 3000, 6000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let res;
    try {
      res = await fetch(TRANSCRIBE_URL, makeInit());
    } catch (e) {
      lastErr = new Error('Network error: ' + e.message);
    }
    if (res) {
      if (res.ok) {
        const data = await res.json();
        return String(data.text || data.transcription || data.output_text || '').trim();
      }
      const e = await res.json().catch(() => ({}));
      lastErr = new Error(e.error?.message || e.message || `HTTP ${res.status}`);
      lastErr.status = res.status;
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) throw lastErr;
    }
    if (attempt < delays.length) await new Promise(r => setTimeout(r, delays[attempt]));
  }
  throw lastErr;
}

// opts: { recLang: 'uk-UA' | 'en-US', prevText: text already dictated before
// this chunk }. Resolves to the transcript, or '' when the recording holds
// no speech (it is then not sent at all — models tend to invent a phrase on
// silence).
async function transcribeSpeech(audioBlob, opts) {
  const o = opts || {};
  if (!apiKey) throw new Error('Missing OpenRouter API key');
  if (provider !== 'openrouter') throw new Error('Switch AI provider to OpenRouter in Setup');
  if (!audioBlob || !audioBlob.size) throw new Error('No audio was recorded');

  if (typeof audioHasSpeech === 'function' && !(await audioHasSpeech(audioBlob))) {
    try { toast('🔇 No speech detected — nothing sent for transcription'); } catch {}
    return '';
  }

  const langs  = transcribeLanguages(o.recLang);
  const en     = langs.length === 1 && langs[0] === 'en';
  const prompt = transcribePrompt(o.prevText, en);
  const ext = audioBlob.type.includes('webm') ? 'webm'
    : audioBlob.type.includes('ogg') ? 'ogg'
      : audioBlob.type.includes('mp4') ? 'mp4'
        : audioBlob.type.includes('mpeg') || audioBlob.type.includes('mp3') ? 'mp3'
          : 'wav';
  const headers = { 'Authorization': 'Bearer ' + apiKey, 'X-Title': 'Bug Report Agent' };
  const multipart = native => () => {
    const form = new FormData();
    form.append('file', audioBlob, 'dictation.' + ext);
    form.append('model', TRANSCRIBE_MODEL);
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);
    if (native) {
      langs.forEach(l => form.append('languages[]', l));
      transcribeKeywords().forEach(k => form.append('keywords[]', k));
    } else {
      form.append('language', en ? 'en' : 'uk');
    }
    return { method: 'POST', headers, body: form };
  };
  const badRequest = e => [400, 415, 422].includes(e.status);

  if (transcribeNativeHints) {
    try {
      return await postTranscription(multipart(true));
    } catch (e) {
      if (!badRequest(e)) throw e;
      console.warn('Transcription service rejected keywords/languages, using plain prompt:', e.message);
      transcribeNativeHints = false;
    }
  }
  try {
    return await postTranscription(multipart(false));
  } catch (e) {
    if (!badRequest(e)) throw e;
    console.warn('Multipart transcription rejected, falling back to the JSON request:', e.message);
  }

  const buf = new Uint8Array(await audioBlob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  const body = JSON.stringify({
    model: TRANSCRIBE_MODEL,
    input_audio: { data: btoa(binary), format: ext },
    language: en ? 'en' : 'uk',
  });
  return postTranscription(() => ({ method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body }));
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
    return applyReportDefaults(out);
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
  return applyReportDefaults(out);
}

// Shared tail of every normalizer (Normal / Gherkin / Composite): Default
// Environment verbatim, per-field Custom Field defaults, and a COPY of the
// project-default linked work items.
function applyReportDefaults(out) {
  if (cfg.defaultEnvironment && cfg.defaultEnvironment.trim()) out.environment = cfg.defaultEnvironment;

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
  // Every report starts with a COPY of the project-default linked work
  // items (Setup → Linked work items); per-report edits on the result
  // card touch only this copy, never the defaults.
  out.linkedWorkItems = normalizeLinkedWorkItems(JSON.parse(JSON.stringify(cfg.linkedWorkItems || [])));
  return out;
}

// Composite Bug: umbrella summary/severity/environment/customFields at the
// top level + `issues: [{ title, sections }]` (Normal) or
// `issues: [{ title, description, actualResult, expectedResult,
// additionalInfo }]` (Gherkin). Each issue goes through the same cleanup as
// a standalone report so the editors and the ADF builder can treat an issue
// exactly like a mini-report.
function normalizeCompositeResult(rawText, isGherkin) {
  const raw = parseAiJson(rawText);
  const issues = (Array.isArray(raw.issues) ? raw.issues : [])
    .filter(it => it && typeof it === 'object')
    .map(it => {
      // The app numbers issues itself — drop an "Issue #2." the model added anyway.
      const title = stripJiraMarkup(it.title || it.summary || '')
        .replace(/^\s*issue\s*#?\s*\d+\s*[.:\-–—]\s*/i, '').trim();
      // Attachment placement hints — consumed by applyAttachmentsToReport.
      const hints = { attachments: it.attachments, attachmentsAfter: it.attachmentsAfter };
      if (isGherkin) {
        return {
          title,
          description:    stripJiraMarkup(it.description    || ''),
          actualResult:   stripJiraMarkup(it.actualResult   || ''),
          expectedResult: stripJiraMarkup(it.expectedResult || ''),
          additionalInfo: stripJiraMarkup(it.additionalInfo || ''),
          ...hints,
        };
      }
      const issue = { title, sections: (it.sections && typeof it.sections === 'object') ? it.sections : {}, ...hints };
      ['preconditions', 'steps', 'actual', 'expected'].forEach(k => {
        if (it[k] !== undefined && issue.sections[k] === undefined) issue.sections[k] = it[k];
      });
      if (typeof ensureNormalSections === 'function') ensureNormalSections(issue);
      return issue;
    });
  if (!issues.length) throw new Error('AI returned no issues for the composite report — try again');

  const out = {
    summary:      stripJiraMarkup(raw.summary     || ''),
    severity:     raw.severity,
    environment:  stripJiraMarkup(raw.environment || ''),
    customFields: raw.customFields,
    issues,
  };
  return applyReportDefaults(out);
}

// ── single-bug generate (Report page) ─────────────────────────────────────
async function generate() {
  if (typeof compositeMode !== 'undefined' && compositeMode) return generateComposite();
  const ticket = document.getElementById('tin').value.trim();
  const withFiles = typeof hasReportAttachments === 'function' && hasReportAttachments();
  if (!ticket && !withFiles) { showErr('Please add a description — type, dictate, or attach a screenshot / recording.'); return; }
  if (!apiKey) { promptKey(); return; }

  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  document.getElementById('errArea').innerHTML = '';
  document.getElementById('resArea').innerHTML = '';

  const isGherkin = reportFormat === 'gherkin';

  try {
    // Attachments → labelled images (video → key frames) for the model.
    const files = withFiles
      ? await prepareAttachmentsForAi(msg => { btn.innerHTML = `<span class="spinner"></span> ${esc(msg)}`; })
      : null;
    if (files) btn.innerHTML = '<span class="spinner"></span> Analyzing…';
    const sys = buildSystemPrompt({ isGherkin, attachments: files ? files.prompt : '' });
    const text = ticket || '(No written description — build the report from the attachments.)';
    const raw = await callAi(sys, text, files ? { images: files.images, maxTokens: 2400 } : undefined);
    lastRep = normalizeAiResult(raw, isGherkin);
    if (files) applyAttachmentsToReport(lastRep, files, isGherkin);
    renderResult(lastRep);
    addToHistory(lastRep, reportFormat);
  } catch (e) {
    showErr('Error: ' + e.message);
  }

  btn.disabled = false;
  btn.innerHTML = '→ Generate bug report';
}

// ── Report-page result rendering ──────────────────────────────────────────
// "🧩 Composite · N issues" pill for the result-card header ('' otherwise).
function compositeBadgeHtml(r) {
  if (!r || !Array.isArray(r.issues)) return '';
  const n = r.issues.length;
  return `<span style="font-size:10px;font-family:'IBM Plex Mono',monospace;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--muted)">🧩 Composite · ${n} issue${n === 1 ? '' : 's'}</span>`;
}

function renderResult(r) {
  if (reportFormat === 'gherkin') return renderResultGherkin(r);
  return renderResultNormal(r);
}

function renderResultNormal(r) {
  document.getElementById('resArea').innerHTML = `
    <div class="result-card" data-result-id="report" data-format="normal">
      <div class="res-top">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="res-lbl">Bug report</span>
          <span class="sev sev-edit sev-${esc(r.severity || 'Medium')}" onclick="cycleSeverity(this)" title="Click to change severity">${esc(r.severity || 'Medium')}</span>
          ${compositeBadgeHtml(r)}
          <span style="font-size:10px;color:var(--dim);font-family:'IBM Plex Mono',monospace">click anywhere to edit</span>
        </div>
        <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim)">${esc(cfg.projectKey || 'QA')} · ${esc(cfg.issueType || 'Bug')}</span>
      </div>
      <div class="res-body">${renderEditableNormalBody(r, 'report')}</div>
      ${renderAttachmentsBlock(r, 'report', false)}
      ${renderLinkedItemsBlock(r, 'report')}
      <div class="res-actions">
        <button class="btn btn-ghost btn-sm" onclick="copyReport()">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" onclick="pushToJira()">🚀 Push to Jira</button>
        <button class="btn btn-ghost btn-sm" onclick="clearReportInput()">🗑 Clear</button>
      </div>
    </div>`;
}

function renderResultGherkin(r) {
  document.getElementById('resArea').innerHTML = `
    <div class="result-card" data-result-id="report" data-format="gherkin">
      <div class="res-top">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="res-lbl">Bug report</span>
          <span class="sev sev-edit sev-${esc(r.severity || 'Medium')}" onclick="cycleSeverity(this)" title="Click to change severity">${esc(r.severity || 'Medium')}</span>
          <span style="font-size:10px;font-family:'IBM Plex Mono',monospace;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--muted)">Gherkin</span>
          ${compositeBadgeHtml(r)}
          <span style="font-size:10px;color:var(--dim);font-family:'IBM Plex Mono',monospace">click anywhere to edit</span>
        </div>
        <span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--dim)">${esc(cfg.projectKey || 'QA')} · ${esc(cfg.issueType || 'Bug')}</span>
      </div>
      <div class="res-body">${renderEditableGherkinBody(r, 'report')}</div>
      ${renderAttachmentsBlock(r, 'report', true)}
      ${renderLinkedItemsBlock(r, 'report')}
      <div class="res-actions">
        <button class="btn btn-ghost btn-sm" onclick="copyReport()">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" onclick="pushToJira()">🚀 Push to Jira</button>
        <button class="btn btn-ghost btn-sm" onclick="clearReportInput()">🗑 Clear</button>
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

