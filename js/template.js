// ── template ──────────────────────────────────────────────────────────────
// Lets the user store a reference bug report (file or pasted text). The
// stored text is later analyzed by AI to extract writing rules that get
// pushed into cfg.rules and used by generate() on the Report page.

// Maps common human-readable field names to Jira system field IDs. Used
// when analyzeTemplate detects a "system" field — we can fill the jiraId
// without calling /rest/api/3/field. Case- and whitespace-insensitive.
const SYSTEM_FIELD_MAP = {
  'components':           'components',
  'component':            'components',
  'component / module':   'components',
  'component/module':     'components',
  'module':               'components',
  'labels':               'labels',
  'label':                'labels',
  'assignee':             'assignee',
  'assigned to':          'assignee',
  'reporter':             'reporter',
  'reported by':          'reporter',
  'fix versions':         'fixVersions',
  'fix version':          'fixVersions',
  'fix version/s':        'fixVersions',
  'affects versions':     'versions',
  'affects version':      'versions',
  'affected version':     'versions',
  'affected version/s':   'versions',
  'environment':          'environment',
  'due date':             'duedate',
  'priority':             'priority',
  'issue type':           'issuetype',
  'issuetype':            'issuetype',
  'epic link':            'customfield_10014', // common default but not guaranteed
};

function normalizeFieldName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Environment is reserved: it lives in cfg.defaultEnvironment (verbatim,
// auto-applied at generate / push time). We deliberately keep it OUT of
// Custom Jira fields so it can't be truncated by the "list / one-value"
// rules, can't be re-extracted by AI, and so the UI shows it as a single
// authoritative block instead of a chopped CF row.
function isEnvironmentField(name, jiraId) {
  if (jiraId && String(jiraId).toLowerCase() === 'environment') return true;
  const nm = normalizeFieldName(name);
  return nm === 'environment' || nm === 'env' || nm === 'test environment';
}

// Fetches the full Jira field catalogue once (Custom + system). Used to
// resolve human-readable names returned by analyzeTemplate into the actual
// customfield_NNNNN IDs used by the REST API. Gracefully returns null when
// Jira creds / proxy are not configured.
async function fetchAllJiraFields() {
  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) return null;
  try {
    const data = await jiraRequest('/rest/api/3/field');
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// Given a list of detected field descriptors and the full Jira field
// catalogue (or null), return { jiraId, source } for each name:
//   source: "system" | "custom-exact" | "custom-partial" | null
function resolveDetectedFieldId(detected, jiraFields) {
  const norm = normalizeFieldName(detected.name);

  if (detected.system && SYSTEM_FIELD_MAP[norm]) {
    return { jiraId: SYSTEM_FIELD_MAP[norm], source: 'system' };
  }

  if (jiraFields) {
    const exact = jiraFields.find(f => f.custom && normalizeFieldName(f.name) === norm);
    if (exact) return { jiraId: exact.id, source: 'custom-exact' };
    const partial = jiraFields.find(f =>
      f.custom && (
        normalizeFieldName(f.name).includes(norm) ||
        norm.includes(normalizeFieldName(f.name))
      )
    );
    if (partial) return { jiraId: partial.id, source: 'custom-partial' };
  }

  // Last-chance system fallback even if AI flagged it as not-system.
  if (SYSTEM_FIELD_MAP[norm]) {
    return { jiraId: SYSTEM_FIELD_MAP[norm], source: 'system' };
  }

  return { jiraId: '', source: null };
}

function renderTemplate() {
  const el = document.getElementById('tplText');
  if (el) el.value = cfg.template || '';
  const linkEl = document.getElementById('tplLink');
  if (linkEl) linkEl.value = cfg.templateLink || '';
  updateTplStatus();
}

function updateTplStatus() {
  const el = document.getElementById('tplStatus');
  if (!el) return;
  const len = (cfg.template || '').length;
  if (!len) {
    el.textContent = 'No template saved yet';
    el.style.color = 'var(--dim)';
    return;
  }
  const key = extractIssueKey(cfg.templateLink || '');
  el.textContent = key
    ? `✓ Template from ${key} (${len} chars)`
    : `✓ Template saved (${len} chars)`;
  el.style.color = 'var(--green)';
}

// ── fetch a Jira issue and load it into the template textarea ─────────────
// Parses the URL (or bare key like "QA-1234") into an issue key, calls
// /rest/api/3/issue/<KEY> via proxy, then converts the response into
// readable text that preserves field structure + formatting markers so
// analyzeTemplate can extract both content rules and visual style rules.

function extractIssueKey(link) {
  if (!link) return '';
  const s = String(link).trim();
  // Match patterns like "QA-1234", supports URLs with query params/anchors.
  const m = s.match(/[A-Z][A-Z0-9_]+-\d+/);
  return m ? m[0] : '';
}

// Convert an ADF (Atlassian Document Format) document into a wiki-markup-ish
// text representation. Preserves enough syntax (bold via *…*, colors via
// {color:#…}…{color}, headings via "h2." etc.) so analyzeTemplate can pick
// up visual conventions, but readable enough that it's still a sane preview.
function adfToText(node, depth = 0) {
  if (!node || typeof node !== 'object') return '';

  // Plain text node with marks.
  if (node.type === 'text') {
    let t = String(node.text || '');
    const marks = Array.isArray(node.marks) ? node.marks : [];
    for (const m of marks) {
      if (m.type === 'strong')    t = `*${t}*`;
      else if (m.type === 'em')   t = `_${t}_`;
      else if (m.type === 'code') t = `\`${t}\``;
      else if (m.type === 'textColor' && m.attrs && m.attrs.color) {
        t = `{color:${m.attrs.color}}${t}{color}`;
      } else if (m.type === 'link' && m.attrs && m.attrs.href) {
        t = `[${t}|${m.attrs.href}]`;
      }
    }
    return t;
  }

  const inner = Array.isArray(node.content)
    ? node.content.map(c => adfToText(c, depth + 1)).join('')
    : '';

  switch (node.type) {
    case 'doc':         return inner.trim();
    case 'paragraph':   return inner + '\n\n';
    case 'heading': {
      const lvl = (node.attrs && node.attrs.level) || 3;
      return `h${lvl}. ${inner}\n\n`;
    }
    case 'hardBreak':   return '\n';
    case 'rule':        return '----\n\n';
    case 'orderedList': {
      const items = Array.isArray(node.content) ? node.content : [];
      return items.map((li, i) => `${i + 1}. ${adfToText(li, depth + 1).trim()}`).join('\n') + '\n\n';
    }
    case 'bulletList': {
      const items = Array.isArray(node.content) ? node.content : [];
      return items.map(li => `- ${adfToText(li, depth + 1).trim()}`).join('\n') + '\n\n';
    }
    case 'listItem':    return inner;
    case 'codeBlock':   return '{code}\n' + inner + '\n{code}\n\n';
    case 'blockquote':  return inner.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    case 'panel': {
      const kind = (node.attrs && node.attrs.panelType) || 'info';
      return `{panel:${kind}}\n${inner.trim()}\n{panel}\n\n`;
    }
    case 'mediaSingle':
    case 'media':       return '[attachment]\n';
    default:            return inner;
  }
}

// Jira fields that are computed / internal and should never appear in a
// human-readable template: rank, dev panel, watcher counts, time tracking,
// computed progress, etc. Matching is by display name (case-insensitive)
// because the customfield_NNNNN IDs vary across Jira instances.
const INTERNAL_FIELD_NAME_PATTERNS = [
  /^rank$/i,
  /^development$/i,
  /^worklog$/i,
  /^watchers?$/i,
  /^aggregate/i,                       // Σ Progress, Σ Time Spent, etc.
  /^subtasks?$/i,
  /^last viewed$/i,
  /^story points history$/i,
  /^time tracking$/i,
  /^σ/i,                               // some Jira UIs use the σ prefix
  /progress( %)?$/i,                   // Checklist Progress %, etc.
  /^request\s+type$/i,
  /^source$/i,
];

function isInternalFieldName(name) {
  const s = String(name || '').trim();
  return INTERNAL_FIELD_NAME_PATTERNS.some(re => re.test(s));
}

// Decide if a Jira field value is meaningful enough to surface in template
// text. Skips empty strings, empty arrays, `{}` (Dev panel placeholder).
function hasMeaningfulValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

// Heuristic: Greenhopper Sprint customfield returns
// [{ id, name, state, boardId, ... }, ...]. We surface the numeric id so
// downstream code (Push to Jira) can submit the correct value — Jira
// requires sprint IDs as numbers, not sprint names.
function isSprintValue(v) {
  return Array.isArray(v) && v.length > 0 &&
         v[0] && typeof v[0] === 'object' &&
         'id' in v[0] && ('name' in v[0] || 'state' in v[0]);
}

function formatSprintValue(arr) {
  return arr.map(s => {
    const name = s.name || `Sprint ${s.id}`;
    const state = String(s.state || 'unknown').toLowerCase();
    return `${name} [id: ${s.id}, state: ${state}]`;
  }).join(', ');
}

// Pull the structured sprint out of a fetched issue so analyzeTemplate can
// inject a GUARANTEED-valid numeric id into the Sprint custom field —
// deterministic code instead of trusting the AI to copy the id from text.
// An issue often carries its whole sprint history (closed sprints first),
// so prefer the ACTIVE sprint, then a FUTURE one, then the most recent.
function captureTemplateSprint(issue) {
  const f = issue.fields || {};
  let captured = null;
  Object.keys(f).forEach(k => {
    if (!k.startsWith('customfield_')) return;
    if (!isSprintValue(f[k])) return;
    const arr  = f[k];
    const pick = arr.find(s => String(s.state).toLowerCase() === 'active')
              || arr.find(s => String(s.state).toLowerCase() === 'future')
              || arr[arr.length - 1];
    if (pick && pick.id != null) {
      captured = {
        id:      pick.id,
        name:    pick.name || '',
        state:   String(pick.state || 'unknown').toLowerCase(),
        fieldId: k,
      };
    }
  });
  return captured;
}

// Flatten the various shapes a Jira value can take into a single string.
function jiraValueToText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isSprintValue(v)) return formatSprintValue(v);
  if (Array.isArray(v)) return v.map(jiraValueToText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    // Common Jira shapes: { name }, { value }, { displayName }, { key }, ADF doc.
    if (v.type === 'doc' && Array.isArray(v.content)) return adfToText(v);
    return v.displayName || v.name || v.value || v.key || '';
  }
  return '';
}

// Convert a full /rest/api/3/issue response into a readable plain-text
// bug report that mirrors how the ticket would appear in Jira.
function formatIssueAsText(issue) {
  const f = issue.fields || {};
  const lines = [];
  lines.push(`Key: ${issue.key || ''}`);
  if (f.issuetype)         lines.push(`Type: ${jiraValueToText(f.issuetype)}`);
  if (f.status)            lines.push(`Status: ${jiraValueToText(f.status)}`);
  if (f.priority)          lines.push(`Priority: ${jiraValueToText(f.priority)}`);
  if (f.summary)           lines.push(`Summary: ${f.summary}`);
  if (f.components?.length) lines.push(`Components: ${jiraValueToText(f.components)}`);
  if (f.labels?.length)     lines.push(`Labels: ${f.labels.join(', ')}`);
  if (f.fixVersions?.length)lines.push(`Fix Versions: ${jiraValueToText(f.fixVersions)}`);
  if (f.versions?.length)   lines.push(`Affects Versions: ${jiraValueToText(f.versions)}`);
  // For Assignee/Reporter we include the accountId in brackets so the AI
  // (and the user) can copy it as a default. Jira Cloud requires accountId,
  // not display name, when creating an issue via REST API.
  if (f.assignee) {
    const a = f.assignee;
    const aid = a && a.accountId ? ` [${a.accountId}]` : '';
    lines.push(`Assignee: ${jiraValueToText(a)}${aid}`);
  }
  if (f.reporter) {
    const r = f.reporter;
    const rid = r && r.accountId ? ` [${r.accountId}]` : '';
    lines.push(`Reporter: ${jiraValueToText(r)}${rid}`);
  }
  if (f.environment)        lines.push(`Environment: ${jiraValueToText(f.environment)}`);
  if (f.duedate)            lines.push(`Due Date: ${f.duedate}`);

  // Linked issues — one line per link, phrased from THIS issue's perspective
  // ("relates to FER-123 — Checkout redesign (https://…)"), exactly the
  // shape analyzeTemplate's linkedWorkItems extraction expects. Jira returns
  // each link with either inwardIssue or outwardIssue relative to the
  // current issue; the matching type.inward / type.outward phrase describes
  // the relation in that direction.
  if (Array.isArray(f.issuelinks) && f.issuelinks.length) {
    const base = (cfg.jiraUrl || '').trim().replace(/\/+$/, '');
    const linkLines = f.issuelinks.map(l => {
      const other  = l.outwardIssue || l.inwardIssue;
      if (!other || !other.key) return '';
      const phrase = l.outwardIssue ? (l.type && l.type.outward) : (l.type && l.type.inward);
      const title  = other.fields && other.fields.summary ? ` — ${other.fields.summary}` : '';
      const url    = base ? ` (${base}/browse/${other.key})` : '';
      return `- ${phrase || 'relates to'} ${other.key}${title}${url}`;
    }).filter(Boolean);
    if (linkLines.length) {
      lines.push('Linked Issues:');
      lines.push(...linkLines);
    }
  }

  // Custom fields: include any non-empty `customfield_*` so analyzeTemplate
  // can detect them. Use the `names` block if present (returned when
  // expand=names is in the query), otherwise show the raw ID.
  // Skip Jira-internal / computed fields (Rank, Development, Checklist
  // Progress %, etc.) — they pollute the template and AI can't extract
  // them from a free-form bug description anyway.
  const names = issue.names || {};
  Object.keys(f).forEach(k => {
    if (!k.startsWith('customfield_')) return;
    if (!hasMeaningfulValue(f[k])) return;
    const label = names[k] || k;
    if (isInternalFieldName(label)) return;
    const val = jiraValueToText(f[k]);
    if (!val) return;
    lines.push(`${label}: ${val}`);
  });

  // Description goes at the end as a free-form block.
  if (f.description) {
    lines.push('');
    lines.push('Description:');
    if (typeof f.description === 'string') {
      lines.push(f.description);
    } else {
      lines.push(adfToText(f.description));
    }
  }

  return lines.join('\n');
}

async function fetchTemplateFromLink() {
  const linkEl = document.getElementById('tplLink');
  const link   = (linkEl?.value || '').trim();
  if (!link) { toast('⚠ Paste a Jira issue link first'); return; }

  const key = extractIssueKey(link);
  if (!key) {
    toast('⚠ Could not extract issue key from link (e.g. QA-1234)');
    return;
  }

  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
    toast('⚠ Configure Jira connection in Setup first');
    showPage('setup');
    return;
  }

  const btn = document.getElementById('fetchTplBtn');
  const orig = btn?.innerHTML || '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-green"></span> Fetching…';
  }

  try {
    // expand=names returns a `names` map so we know human-readable labels
    // for customfield_* keys; renderedFields gives HTML-rendered values for
    // some fields but we stick with the structured payload + adfToText.
    const issue = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=names`);
    const text  = formatIssueAsText(issue);

    document.getElementById('tplText').value = text;
    cfg.templateLink = link;

    // Stash the structured sprint (persisted with the rest of cfg on Save
    // Template) so Analyze Template can set a valid numeric Sprint default.
    cfg.templateSprint = captureTemplateSprint(issue);

    const sprintNote = cfg.templateSprint
      ? ` · Sprint id ${cfg.templateSprint.id}${cfg.templateSprint.state !== 'active' ? ` (⚠ ${cfg.templateSprint.state})` : ''}`
      : '';
    toast(`✓ Loaded ${key}${sprintNote} — click Save Template`);
  } catch (e) {
    toast('⚠ Fetch failed: ' + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }
}

function loadTemplateFile(e) {
  const f = e.target.files[0];
  if (!f) return;

  const ext    = (f.name.split('.').pop() || '').toLowerCase();
  const isXlsx = ext === 'xlsx' || ext === 'xls';

  const r = new FileReader();
  r.onload = ev => {
    try {
      let text;
      if (isXlsx) {
        if (typeof XLSX === 'undefined') {
          toast('⚠ XLSX library not loaded — check your internet connection');
          return;
        }
        // Convert every sheet to CSV and concatenate with a sheet header.
        // CSV is readable both for humans and for the AI.
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        text = wb.SheetNames.map(name => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
          return `=== Sheet: ${name} ===\n${csv}`;
        }).join('\n\n');
      } else {
        text = ev.target.result;
      }
      document.getElementById('tplText').value = text;
      toast(`✓ ${isXlsx ? 'XLSX' : 'File'} loaded — click Save Template`);
    } catch (err) {
      toast('⚠ Failed to read file: ' + err.message);
    }
  };

  if (isXlsx) {
    r.readAsArrayBuffer(f);
  } else {
    r.readAsText(f);
  }
  e.target.value = '';
}

function saveTemplate() {
  cfg.template     = document.getElementById('tplText').value.trim();
  cfg.templateLink = (document.getElementById('tplLink')?.value || '').trim();
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  updateTplStatus();
  toast(cfg.template ? '✓ Template saved' : '✓ Template cleared');
}

function clearTemplate() {
  document.getElementById('tplText').value = '';
  const linkEl = document.getElementById('tplLink');
  if (linkEl) linkEl.value = '';
  cfg.templateSprint = null;   // sprint belongs to the cleared template
  saveTemplate();
}

// ── analyze ───────────────────────────────────────────────────────────────
// Sends the saved template to AI and asks it to reverse-engineer the
// writing conventions. Parses a JSON array of rule strings and merges
// them into cfg.rules (skipping duplicates, case-insensitive).

async function analyzeTemplate() {
  const tpl = (cfg.template || '').trim();
  if (!tpl) {
    toast('⚠ No template saved. Go to Template page first.');
    showPage('template');
    return;
  }
  if (!apiKey) { promptKey(); return; }

  const btn = document.getElementById('analyzeBtn');
  if (!btn) return;
  const origHtml = btn.innerHTML;
  btn.disabled = true;

  // Rotate through a few fake "stages" so the user sees motion even though
  // the underlying request is a single API call. Uses the green spinner
  // variant so it's visible on the ghost button.
  const stages = [
    'Sending template to AI…',
    'Reading bug report…',
    'Extracting writing rules…',
    'Generating voice examples…',
  ];
  let stageIdx = 0;
  const renderStage = () => {
    btn.innerHTML = '<span class="spinner spinner-green"></span> ' + stages[stageIdx];
  };
  renderStage();
  const stageTimer = setInterval(() => {
    stageIdx = (stageIdx + 1) % stages.length;
    renderStage();
  }, 1800);

  // Pinned custom fields are off-limits for re-analysis. We block them
  // again in code (see the detectedFields loop below), but mentioning
  // them in the prompt also nudges the model to skip them up-front —
  // smaller response, less likely to confuse the user with stale dups.
  const pinnedNames = cfg.customFields.filter(f => f.pinned).map(f => f.name);
  const pinnedBlock = pinnedNames.length
    ? `\nThe user has PINNED these custom fields — they are already perfectly configured and must NOT be re-detected. Do NOT include any of them in detectedFields, even if they appear in the template: ${pinnedNames.map(n => `"${n}"`).join(', ')}.\n`
    : '';

  const sys = `You are a senior QA engineer reverse-engineering a project's bug-reporting conventions.
${pinnedBlock}
Given the bug report below, reverse-engineer the project's report format and conventions:

1. Extract a COMPLETE set of 6-14 writing rules that fully describe how a bug report for this project should look. This list will REPLACE the project's existing rules wholesale — so it must be self-contained: cover every convention a teammate would need to reproduce the template's style from scratch. Capture BOTH content conventions AND visual style conventions.

   Content rules (semantic):
   - Which FIELDS are present (environment, browser, OS, steps, expected/actual, attachments…)
   - Tone and detail level (concise vs detailed, technical vs user-facing)
   - Project-specific patterns (ticket ID format, links to docs, severity scheme, user roles…)

   Visual / formatting rules (presentation):
   - Heading style for labels (e.g. "h2. for AR / ER", "bold green for Expected", "bold red for Actual")
   - Color codes used (e.g. "#ff5630 for Actual label", "#36b37e for Expected label")
   - Dividers between sections (horizontal rule, blank line, panel)
   - Font emphasis (bold for field labels, italic for notes, monospace for IDs)
   - Block decorations (panels with bgColor for preconditions / notes)
   - Image / attachment formatting (width annotations, captions)
   - Spacing between sections

   It is OK and encouraged to produce rules that reference Jira wiki markup (h2., {color:#...}, {panel:bgColor=...}, |width=N|) when the template uses them — that is exactly the style we want to preserve.

   The order of fields the template uses is also a rule (e.g. "Steps section comes before Environment").

   EXCEPTION — do NOT create rules about the report-body sections' own labels, prefixes, heading levels, colors, or order (e.g. "Prefix actual result with 'AR:'", "Format ER as a green h2 heading", "Steps come before AR"). Those exact conventions are captured machine-readably in reportTemplate (step 2) and the app applies them automatically; a duplicate rule makes the generator emit the prefix INSIDE the section value, rendering it doubled ("AR: AR: …"). Such conventions belong ONLY in reportTemplate.style.

2. Extract reportTemplate — a MACHINE-READABLE schema that describes the Normal report body format shown in the template. This schema will drive Generate Report, the editable UI, Copy, and Jira formatting. Rules:
   - Include ONLY sections that belong to the bug report body / description format, in the exact order shown in the template.
   - Exclude universal top-level fields that the app owns separately: Summary, Severity/Priority, Jira status, created/updated dates, assignee/reporter, and custom Jira metadata.
   - Include Environment ONLY if the template clearly shows Environment as part of the description body. If Environment is a Jira/system field or reusable device block, leave it out of reportTemplate; the app stores it separately.
   - Each section object must have:
       * "id": stable snake_case identifier (e.g. "preconditions", "steps", "actual_result", "expected_result", "notes")
       * "title": exact human label from the template (e.g. "Preconditions", "Steps to reproduce", "AR", "Expected result")
       * "type": "text" | "list"
       * "listStyle": "ordered" | "bullet" for list sections only
       * "description": short instruction for what content belongs in this section
       * "required": true if this section should normally appear in every generated report
       * "style": object with visual hints copied from the template when present:
           - "heading": "h1" | "h2" | "h3" | "label" | "none"
           - "color": hex color when the label / heading is colored
           - "panel": "info" | "note" | "warning" | "success" when shown as a panel/callout
           - "dividerBefore": true when a horizontal divider / strong break appears before the section
           - "prefix": exact prefix shown before the generated value if any (e.g. "AR: ", "ER: ")
   - For classic templates, examples are:
       { "id": "preconditions", "title": "Preconditions", "type": "list", "listStyle": "bullet", "description": "Setup or state that must be true before reproduction.", "required": false, "style": { "panel": "info" } }
       { "id": "steps", "title": "Steps", "type": "list", "listStyle": "ordered", "description": "User actions to reproduce the bug.", "required": true, "style": { "heading": "h3" } }
       { "id": "actual_result", "title": "AR", "type": "text", "description": "What actually happens.", "required": true, "style": { "heading": "h2", "color": "#ff5630", "prefix": "AR: ", "dividerBefore": true } }
       { "id": "expected_result", "title": "ER", "type": "text", "description": "What should happen.", "required": true, "style": { "heading": "h2", "color": "#36b37e", "prefix": "ER: " } }

3. Detect which BUG FIELDS appear filled in this template — fields a tester populated, NOT the writing-style rules. For each, return an object with:
   - "name": human-readable label as it appears in the template (e.g. "Component / Module", "Test Environment", "Browser", "Reporter", "Fix Version", "Affected Module")
   - "system": true if it is a standard Jira field (Components, Labels, Priority, Assignee, Reporter, Fix Versions, Affects Versions, Environment, Due Date, Issue Type), false otherwise
   - "type": "text" | "list" | "number" — best guess based on the value(s) seen
   - "defaultValue": the VALUE of this field in the template, as a plain string. Rules per field type:
       * Multi-value list fields → comma-separate (e.g. "Frontend, API")
       * Assignee / Reporter → use ONLY the accountId from the brackets (e.g. "557057:abc-def" from "Andrii Mysliuk [557057:abc-def]"), NEVER the display name
       * Sprint fields → use ONLY the numeric ID from the brackets (e.g. "5678" from "Sprint 110 [id: 5678, state: active]"), NEVER the sprint name or sprint number-as-name
       * Long multi-line values (e.g. a multi-device "Environment" listing) → keep a single-line representative summary
       * Empty string ("") if you cannot reliably extract

   SKIP all of these — do NOT include in detectedFields:
   - Universal core fields: Summary, Description, Steps, Expected, Actual, Severity, Status, Created, Updated, Resolved, Comments
   - Jira-internal / computed (a tester cannot meaningfully populate these): Rank, Development, Watchers, Subtasks, Aggregate Progress / Σ Progress / Σ Time Spent, Worklog, Time Tracking, Last Viewed, Story Points History, Checklist Progress %, Request Type, Source, Linked Issues, Parent Link

   Also skip any field whose value in this template is empty ({}, [], blank). We only want fields a tester filled in with meaningful data.

4. Extract the "Environment" (or "Env", "Test Environment") block VERBATIM. This is the reused device / OS / build context for the project. Strict rules:
   - Copy the EXACT text the template uses — every line, every device entry, every key like "Device:", "Display:", "App_version:", "iOS_version:", "Android_version:", "Network connection:", etc.
   - Preserve line breaks (use \n) and blank-line separators between multiple devices.
   - DO NOT rewrite, summarize, paraphrase, reorder, deduplicate, normalize formatting, "fix" typos, or expand abbreviations.
   - DO NOT include the "Environment:" label itself — only the value.
   - Return empty string ("") if the template has no Environment block.

5. Generate TWO voice-dictation examples (Ukrainian and English) showing how a tester might VERBALLY describe a similar bug — informal, conversational, 3-5 sentences. Imagine the tester just hit "record" on a microphone and is thinking out loud. NOT a structured report — just natural spoken thoughts. Plain text only.

   TONE: relaxed and conversational, like a junior QA telling a colleague over coffee, BUT keep it workplace-appropriate.
   - It is fine to use everyday connectors ("ну от", "так от", "коротше", "взагалі", "по суті" / "so", "basically", "kind of", "I mean", "looks like").
   - It is fine to mention uncertainty ("здається", "схоже", "не зрозуміло чому" / "seems", "looks like", "not sure why").
   - DO NOT use slang, profanity, or dismissive words. Forbidden examples (do not output any of these or close variants):
     UK:  "фігня", "хрень", "херня", "блін", "капець", "капец", "жесть", "лажа", "стрьом", "ппц", "ппзц", "ппзд", "до біса"
     EN:  "wtf", "shit", "crap", "damn", "bullshit", "fuck", "this thing", "this crap", "freaking", "frigging"
   - Refer to UI elements and features by their actual names (e.g. "the Pay button", "the date picker"), NOT by dismissive nouns ("ця штука", "ця фігня" / "this thing", "this stuff").
   - Stay matter-of-fact about what is broken — describe behavior, do not vent about it.

6. Extract LINKED WORK ITEMS — tickets this bug is linked to. Look for a "Linked Issues" / "Linked work items" / "Issue Links" section, relation phrases ("relates to", "blocks", "is blocked by", "duplicates", "is caused by", "clones"…), and inline ticket references / URLs (https://…/browse/KEY-123). For each linked ticket return:
   - "relation": how THIS bug relates to that ticket — exactly one of: "relates to", "blocks", "is blocked by", "duplicates", "is duplicated by", "causes", "is caused by", "clones", "is cloned by". Pick the closest match; use "relates to" when unclear.
   - "key": the issue key (e.g. "FER-123"). Empty string if only a URL with no visible key.
   - "title": the linked ticket's summary/title if shown, else "".
   - "url": the full URL if shown, else "".
   Do NOT include the bug's own key, sub-tasks, or the parent epic. Return [] if the template shows no linked tickets.

7. Extract CONTEXT WORDS — a glossary of UNIQUE / distinctive terms a tester would speak when dictating bugs for this project. These are used to auto-correct speech-to-text. STRICT SOURCE rule:
   - Look ONLY inside the DESCRIPTION section — specifically the STEPS (numbered steps / "Step Action" / "Step Expected") and the PRECONDITIONS text. Ignore every other section (Summary, field labels, Environment, metadata, Assignee, etc.) when picking terms.
   - From that Steps + Preconditions text, pull the MOST distinctive terms: product names, feature names, module / screen / page names, button & control names, brand or drug names, acronyms, camelCase identifiers, hyphenated terms, and other domain-specific jargon (e.g. "OTB Calendar", "Batch Add", "Follistim", "Group event", "Backoffice").
   - SKIP generic English/QA words ("button", "page", "error", "login", "save", "user", "click", "screen", "open", "select").
   - Pick up to 25 such terms (fewer is fine — only what actually appears in Steps / Preconditions). Return [] if Steps / Preconditions contain nothing distinctive.
   - For each, return an object:
       * "term": the exact spelling as it appears in the Steps / Preconditions (e.g. "Follistim", "New Leaf", "OTB Calendar", "Gonal-F").
       * "aliases": an array of 1-3 "sounds-like" variants — how a Ukrainian-speaking tester dictating the term would have it transcribed by a Ukrainian speech recognizer, written in CYRILLIC (e.g. for "Follistim" → ["фоллістім", "фолістім"]; for "Gonal-F" → ["гонал еф", "гонал-ф"]). Include common mis-hearings. If the term is a plain Ukrainian word, aliases may be [].

Respond ONLY with valid JSON, no markdown fences:
{
  "rules": ["rule 1", "rule 2", ...],
  "reportTemplate": {
    "mode": "template",
    "sections": [
      { "id": "preconditions", "title": "Preconditions", "type": "list", "listStyle": "bullet", "description": "Setup or state needed before reproduction.", "required": false, "style": { "panel": "info" } },
      { "id": "steps", "title": "Steps", "type": "list", "listStyle": "ordered", "description": "Actions to reproduce the bug.", "required": true, "style": { "heading": "h3" } },
      { "id": "actual_result", "title": "AR", "type": "text", "description": "What actually happens.", "required": true, "style": { "heading": "h2", "color": "#ff5630", "prefix": "AR: ", "dividerBefore": true } },
      { "id": "expected_result", "title": "ER", "type": "text", "description": "What should happen.", "required": true, "style": { "heading": "h2", "color": "#36b37e", "prefix": "ER: " } }
    ]
  },
  "detectedFields": [
    { "name": "Component / Module", "system": true,  "type": "text", "defaultValue": "MOBILE" },
    { "name": "Test Environment",   "system": false, "type": "text", "defaultValue": "QA-stage-2" },
    { "name": "Affected Browser",   "system": false, "type": "list", "defaultValue": "Chrome" }
  ],
  "templateEnvironment": "Device: iPhone 13\nDisplay: 6.1 (2532x1170)\nApp_version: 3.41.0 (399) QA\niOS_version: 26.2\nNetwork connection: Wi-fi\n\nDevice: Samsung Galaxy M33 5G\nDisplay: 6.6 (1080 x 2400)\nApp_version: 3.41.0 (451) QA\nAndroid_version: 16\nNetwork connection: Wi-fi",
  "linkedWorkItems": [
    { "relation": "relates to", "key": "FER-123", "title": "Checkout redesign", "url": "https://company.atlassian.net/browse/FER-123" }
  ],
  "voiceExamples": {
    "uk": "Так от, я зайшов на сторінку оплати, ввів дані картки, але кнопка Pay не реагує на клік. Здається, що форма не валідується — помилка теж не показується. Перевіряв у Chrome на Windows.",
    "en": "So I went to the checkout page, entered my card details, but the Pay button doesn't respond when I click it. Looks like the form isn't validating — no error shows up either. I tested in Chrome on Windows."
  },
  "contextWords": [
    { "term": "Follistim",    "aliases": ["фоллістім", "фолістім"] },
    { "term": "OTB Calendar", "aliases": ["оті бі календар", "отб календар"] }
  ]
}

Each rule must be a single imperative sentence (max 140 chars), starting with a verb like "Always", "Include", "Mention", "Capture", "Describe", "Format", "Order", "Use". Rules should cover both content semantics and visible formatting conventions from the template.`;

  try {
    let txt = '';
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: cfg.openRouterModel || 'openrouter/auto',
          max_tokens: 2300,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: tpl }],
        }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
      const data = await res.json();
      txt = data.choices?.[0]?.message?.content || '';
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2300,
          system: sys,
          messages: [{ role: 'user', content: tpl }],
        }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
      const data = await res.json();
      txt = data.content.map(i => i.text || '').join('');
    }

    const parsed = typeof parseAiJson === 'function'
      ? parseAiJson(txt)
      : JSON.parse(txt.replace(/```json|```/g, '').trim());

    // Accept either the new object shape {rules, voiceExamples, detectedFields, templateEnvironment}
    // or a plain array (legacy single-purpose responses).
    let arr, examples, detected, tplEnv, ctxWords, reportTpl, linkedItems;
    if (Array.isArray(parsed)) {
      arr = parsed;
      examples = null;
      detected = [];
      tplEnv   = '';
      ctxWords = [];
      reportTpl = null;
      linkedItems = [];
    } else if (parsed && typeof parsed === 'object') {
      arr      = Array.isArray(parsed.rules)          ? parsed.rules          : [];
      examples = parsed.voiceExamples || null;
      detected = Array.isArray(parsed.detectedFields) ? parsed.detectedFields : [];
      tplEnv   = typeof parsed.templateEnvironment === 'string' ? parsed.templateEnvironment : '';
      ctxWords = Array.isArray(parsed.contextWords)   ? parsed.contextWords   : [];
      reportTpl = parsed.reportTemplate && typeof parsed.reportTemplate === 'object' ? parsed.reportTemplate : null;
      linkedItems = Array.isArray(parsed.linkedWorkItems) ? parsed.linkedWorkItems : [];
    } else {
      throw new Error('Unexpected AI response shape');
    }

    // REPLACE mode: the AI returns a fresh, self-contained rule set that
    // overrides whatever was saved before. Rationale — when the user
    // re-runs Analyze Template (often after changing the source template),
    // additive merging produces a stale Frankenstein list. Replace keeps
    // rules tightly aligned with the current template.
    //
    // We still de-dup within THIS batch (AI sometimes outputs near-clones),
    // so the final list is clean even if the model gets verbose.
    const candidates = arr
      .filter(r => typeof r === 'string' && r.trim())
      .map(r => r.trim());

    const newRules = [];
    let dupIntra   = 0;
    for (const r of candidates) {
      if (isSimilarRule(r, newRules)) { dupIntra++; continue; }
      newRules.push(r);
    }

    // Save the previous list so the user can undo the wholesale replace
    // (e.g. if they had hand-tweaked rules they didn't want to lose).
    // Only kept in localStorage — never exported with cfg JSON.
    const previousRules = cfg.rules.slice();
    const replacedCount = previousRules.length;
    localStorage.setItem('bra_rules_backup', JSON.stringify(previousRules));

    cfg.rules = newRules;

    let templateSections = 0;
    if (reportTpl && typeof normalizeReportTemplate === 'function') {
      cfg.reportTemplate = normalizeReportTemplate(reportTpl);
      templateSections = cfg.reportTemplate.sections.length;
    }

    if (examples && (typeof examples.uk === 'string' || typeof examples.en === 'string')) {
      cfg.voiceExamples = {
        uk: stripJiraMarkup((typeof examples.uk === 'string' ? examples.uk : '').trim()),
        en: stripJiraMarkup((typeof examples.en === 'string' ? examples.en : '').trim()),
      };
    }

    // Verbatim Environment block. Always overwrite when AI returned a
    // non-empty value — re-running Analyze Template should refresh the
    // saved default. Skipped if AI returned "" so we don't wipe a value
    // the user already curated (e.g. fetched from Jira link earlier).
    // No stripJiraMarkup here: Environment is preserved EXACTLY as in
    // the template, formatting markers and all.
    let envWritten = false;
    if (tplEnv && tplEnv.trim()) {
      cfg.defaultEnvironment = tplEnv.trim();
      envWritten = true;
      // Mirror into the Setup textarea if the user is currently looking at it.
      const envEl = document.getElementById('sDefEnv');
      if (envEl) envEl.value = cfg.defaultEnvironment;
      if (typeof renderDefaultEnvStatus === 'function') renderDefaultEnvStatus();
    }

    // ── REPLACE non-pinned custom fields ───────────────────────────────
    // Old behavior was "merge & backfill": existing fields stayed forever
    // and only NEW detections were appended. That left stale fields from
    // an older template lingering in Setup → and AI then tried to populate
    // them in every new bug report.
    //
    // New behavior:
    //   • PINNED fields are sacred — preserved exactly across re-analyses
    //     (jiraId, default, required, type, position).
    //   • All non-pinned fields are REPLACED wholesale with the freshly
    //     detected ones from this template.
    //   • A one-shot backup of the full previous list is stashed in
    //     localStorage so the user can undo via "Restore previous fields".
    const detectedClean = (detected || []).filter(df => {
      if (!df || typeof df.name !== 'string') return false;
      const nm = df.name.trim();
      if (!nm) return false;
      if (isInternalFieldName(nm)) return false;   // Rank, Development, etc.
      if (isEnvironmentField(nm)) return false;    // owned by Default Environment
      return true;
    });

    const previousFields    = cfg.customFields.slice();
    const previousNonPinned = previousFields.filter(f => !f.pinned).length;
    const pinnedKeep        = previousFields.filter(f =>  f.pinned);
    const pinnedNamesNorm   = new Set(pinnedKeep.map(f => normalizeFieldName(f.name)));

    // Only fetch Jira fields if at least one non-system detection needs
    // resolving — saves an API roundtrip when the template is system-only.
    const needsJiraLookup = detectedClean.some(f => !f.system);
    const jiraFields      = needsJiraLookup ? await fetchAllJiraFields() : null;

    let addedFields   = 0;
    let resolvedIds   = 0;
    let unresolved    = 0;
    let defaultsOnNew = 0;
    let skippedPinned = 0;   // detection matched a pinned name → ignored
    const seenInBatch = new Set();

    const newFields = [];
    for (const df of detectedClean) {
      const norm = normalizeFieldName(df.name);

      // Pinned wins: AI may re-detect a pinned field anyway; we skip it
      // here so the pinned row stays exactly as the user curated it.
      if (pinnedNamesNorm.has(norm)) { skippedPinned++; continue; }

      // De-dup within THIS detection batch (AI sometimes lists the same
      // field twice with slightly different labels).
      if (seenInBatch.has(norm)) continue;
      seenInBatch.add(norm);

      const { jiraId, source } = resolveDetectedFieldId(df, jiraFields);
      const def = typeof df.defaultValue === 'string' ? df.defaultValue.trim() : '';
      newFields.push({
        name:     df.name.trim(),
        type:     (df.type === 'list' || df.type === 'number') ? df.type : 'text',
        jiraId:   jiraId || '',
        required: 'no',
        default:  def,
      });
      addedFields++;
      if (source) resolvedIds++; else unresolved++;
      if (def)    defaultsOnNew++;
    }

    // Pinned first so they stay at the top of the list (visually anchored
    // user-curated rows), then the fresh detections in AI's order.
    cfg.customFields = [...pinnedKeep, ...newFields];

    // Stash the previous list ONLY if the replacement actually changed
    // something (any non-pinned existed OR the new list differs). Avoids
    // offering a useless "restore" right after a no-op run.
    const replacedCountFields = previousNonPinned;
    if (replacedCountFields > 0) {
      localStorage.setItem('bra_fields_backup', JSON.stringify(previousFields));
    }

    // ── deterministic Sprint default ─────────────────────────────────────
    // The AI sometimes copies the sprint NAME ("Sprint 110") or mangles the
    // id, which Jira then rejects on push. fetchTemplateFromLink captured
    // the structured sprint straight from the issue (cfg.templateSprint) —
    // force that guaranteed-valid numeric id into the Sprint row, creating
    // the row if the AI missed it. Guarded by a template-text check so a
    // stale sprint from a previously fetched issue can't leak into a
    // template that was later pasted manually. Pinned rows stay untouched.
    let sprintForced = null;
    const tplSprint = cfg.templateSprint;
    if (tplSprint && tplSprint.id != null &&
        (cfg.template || '').includes(`id: ${tplSprint.id}`)) {
      const isSprintRow = f => /sprint/i.test(f.name || '') || /sprint/i.test(f.jiraId || '') ||
                               (tplSprint.fieldId && f.jiraId === tplSprint.fieldId);
      let row = cfg.customFields.find(isSprintRow);
      if (!row) {
        row = { name: 'Sprint', type: 'number', jiraId: tplSprint.fieldId || '', required: 'no', default: '' };
        cfg.customFields.push(row);
      }
      if (!row.pinned) {
        row.default = String(tplSprint.id);
        // The structured fieldId from the issue beats any name-based guess.
        if (tplSprint.fieldId) row.jiraId = tplSprint.fieldId;
        sprintForced = tplSprint;
      }
    }

    // Linked work items: ADDITIVE merge, de-duplicated by issue key. The
    // template's links become project defaults shown in Setup → Linked work
    // items; a key the user already curated keeps its row (we only backfill
    // a missing title/url), so re-running Analyze never stomps manual edits.
    let linkedAdded = 0;
    const linkedClean = normalizeLinkedWorkItems(linkedItems);
    if (linkedClean.length) {
      if (!Array.isArray(cfg.linkedWorkItems)) cfg.linkedWorkItems = [];
      const byKey = new Map(cfg.linkedWorkItems.filter(it => it.key).map(it => [it.key, it]));
      for (const it of linkedClean) {
        const existing = it.key ? byKey.get(it.key) : null;
        if (existing) {
          if (!existing.title && it.title) existing.title = it.title;
          if (!existing.url   && it.url)   existing.url   = it.url;
        } else {
          cfg.linkedWorkItems.push(it);
          if (it.key) byKey.set(it.key, it);
          linkedAdded++;
        }
      }
      if (typeof renderLinkedWorkItems === 'function') renderLinkedWorkItems();
    }

    // Context words: ADDITIVE merge (union of terms + aliases). Unlike rules
    // and fields, the glossary accumulates across templates / manual edits —
    // the user curates it over time, so we never wipe what's already there.
    let ctxAdded = 0;
    if (typeof mergeContextWords === 'function') {
      ctxAdded = mergeContextWords(ctxWords);
    }

    localStorage.setItem('bra_cfg', JSON.stringify(cfg));
    renderRules();
    renderFields();
    renderVoiceExamples();
    if (typeof renderContextWords    === 'function') renderContextWords();
    if (typeof refreshRestoreRulesUI  === 'function') refreshRestoreRulesUI();
    if (typeof refreshRestoreFieldsUI === 'function') refreshRestoreFieldsUI();

    // Rules-replaced summary leads the toast; field/example deltas follow.
    const parts = [];
    if (replacedCount) {
      parts.push(`Replaced ${replacedCount} rule${replacedCount === 1 ? '' : 's'} → ${newRules.length}`);
    } else {
      parts.push(`${newRules.length} rule${newRules.length === 1 ? '' : 's'} set`);
    }
    if (dupIntra) parts.push(`(${dupIntra} AI dup${dupIntra === 1 ? '' : 's'} skipped)`);
    if (addedFields || replacedCountFields) {
      const bits = [];
      if (replacedCountFields) {
        bits.push(`Replaced ${replacedCountFields} field${replacedCountFields === 1 ? '' : 's'} → ${addedFields}`);
      } else {
        bits.push(`${addedFields} field${addedFields === 1 ? '' : 's'} set`);
      }
      if (resolvedIds)   bits.push(`${resolvedIds} with ID`);
      if (defaultsOnNew) bits.push(`${defaultsOnNew} with default`);
      if (unresolved)    bits.push(`${unresolved} need manual ID`);
      parts.push('+ ' + bits.join(', '));
    }
    if (skippedPinned) parts.push(`📌 ${skippedPinned} pinned untouched`);
    if (examples) parts.push('+ voice examples');
    if (envWritten) parts.push('+ default environment');
    if (templateSections) parts.push(`+ ${templateSections} report section${templateSections === 1 ? '' : 's'}`);
    if (ctxAdded) parts.push(`+ ${ctxAdded} context word${ctxAdded === 1 ? '' : 's'}`);
    if (linkedAdded) parts.push(`+ 🔗 ${linkedAdded} linked item${linkedAdded === 1 ? '' : 's'}`);
    if (sprintForced) {
      parts.push(`+ Sprint id ${sprintForced.id}${sprintForced.state !== 'active' ? ` (⚠ ${sprintForced.state} — pick a current sprint before pushing)` : ''}`);
    }
    toast('✓ ' + parts.join(' '));
  } catch (e) {
    toast('⚠ Analyze error: ' + e.message);
  } finally {
    clearInterval(stageTimer);
  }

  btn.disabled = false;
  btn.innerHTML = origHtml;
}

// ── voice examples on Report page ─────────────────────────────────────────
// After analyzeTemplate() runs, cfg.voiceExamples contains UK + EN samples
// of how a tester might dictate a similar bug. They're shown on the Report
// page between the mic and the textarea.

let exLang = 'uk';

function renderVoiceExamples() {
  const card = document.getElementById('voiceExamples');
  if (!card) return;
  const ex = cfg.voiceExamples || { uk: '', en: '' };
  if (!ex.uk && !ex.en) { card.style.display = 'none'; return; }
  card.style.display = '';
  // Default to whichever language has content.
  if (!ex[exLang]) exLang = ex.uk ? 'uk' : 'en';
  showVoiceExample(exLang);
}

function showVoiceExample(l) {
  exLang = l;
  const ex = cfg.voiceExamples || {};
  const txt = ex[l] || '';
  const body = document.getElementById('exText');
  if (body) body.textContent = txt || '(empty)';
  const ukBtn = document.getElementById('exUk');
  const enBtn = document.getElementById('exEn');
  if (ukBtn) ukBtn.classList.toggle('active', l === 'uk');
  if (enBtn) enBtn.classList.toggle('active', l === 'en');
}

function useExample() {
  const ex = cfg.voiceExamples || {};
  const txt = (ex[exLang] || '').trim();
  if (!txt) { toast('⚠ No example to copy'); return; }
  document.getElementById('tin').value = txt;
  toast('✓ Example copied to input');
}
