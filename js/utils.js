// ── utils ─────────────────────────────────────────────────────────────────
// Tiny helpers used across the app. Keep this file dependency-free.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showErr(m) {
  document.getElementById('errArea').innerHTML = `<div class="err-box">${esc(m)}</div>`;
}

function toast(m) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = m;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ── template-driven Normal report helpers ─────────────────────────────────
// Normal format is intentionally data-driven: Analyze Template writes
// cfg.reportTemplate.sections, and the generator / renderer / Jira builders
// all follow that schema. These helpers centralize compatibility with older
// reports that still have legacy keys like `steps`, `actual`, `expected`.

function slugifySectionId(title, fallback = 'section') {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function cloneDefaultReportTemplate() {
  const src = (typeof DEFAULTS !== 'undefined' && DEFAULTS.reportTemplate)
    ? DEFAULTS.reportTemplate
    : { mode: 'template', sections: [] };
  return JSON.parse(JSON.stringify(src));
}

function normalizeReportTemplate(tpl) {
  const fallback = cloneDefaultReportTemplate();
  const src = (tpl && typeof tpl === 'object') ? tpl : fallback;
  const inSections = Array.isArray(src.sections) && src.sections.length
    ? src.sections
    : fallback.sections;
  const seen = new Set();
  const sections = [];

  inSections.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const title = String(raw.title || raw.label || raw.id || `Section ${idx + 1}`).trim();
    if (!title) return;
    let id = slugifySectionId(raw.id || title, `section_${idx + 1}`);
    while (seen.has(id)) id = `${id}_${idx + 1}`;
    seen.add(id);

    const type = raw.type === 'list' ? 'list' : 'text';
    const listStyle = raw.listStyle === 'ordered' ? 'ordered' : 'bullet';
    const style = (raw.style && typeof raw.style === 'object') ? { ...raw.style } : {};
    const section = { id, title, type, style };
    if (type === 'list') section.listStyle = listStyle;
    if (raw.description) section.description = String(raw.description);
    if (raw.required !== undefined) section.required = !!raw.required;
    sections.push(section);
  });

  return { mode: 'template', sections: sections.length ? sections : fallback.sections };
}

function getReportTemplate() {
  if (typeof cfg === 'undefined') return cloneDefaultReportTemplate();
  cfg.reportTemplate = normalizeReportTemplate(cfg.reportTemplate);
  return cfg.reportTemplate;
}

function legacyReportSections(r) {
  return {
    preconditions: Array.isArray(r?.preconditions) ? r.preconditions : [],
    steps: Array.isArray(r?.steps) ? r.steps : [],
    actual: r?.actual || '',
    actual_result: r?.actual || '',
    expected: r?.expected || '',
    expected_result: r?.expected || '',
  };
}

function ensureNormalSections(r) {
  if (!r || typeof r !== 'object') return {};
  const tpl = getReportTemplate();
  const legacy = legacyReportSections(r);
  const current = (r.sections && typeof r.sections === 'object') ? r.sections : {};
  const out = {};

  tpl.sections.forEach(section => {
    let value = current[section.id];
    if (value === undefined && legacy[section.id] !== undefined) value = legacy[section.id];
    if (value === undefined) {
      const id = String(section.id || '').toLowerCase();
      const title = String(section.title || '').toLowerCase();
      if (/pre[-_\s]?condition|prerequisite/.test(id + ' ' + title)) value = legacy.preconditions;
      else if (/step|repro/.test(id + ' ' + title)) value = legacy.steps;
      else if (/actual|\bar\b/.test(id + ' ' + title)) value = legacy.actual;
      else if (/expected|\ber\b/.test(id + ' ' + title)) value = legacy.expected;
    }
    if (section.type === 'list') {
      if (Array.isArray(value)) {
        value = value.map(v => stripJiraMarkup(String(v))).filter(v => v.trim());
      } else if (typeof value === 'string' && value.trim()) {
        value = value.split(/\n+/).map(v => stripJiraMarkup(v.replace(/^[-*\d.)\s]+/, '').trim())).filter(Boolean);
      } else {
        value = [];
      }
    } else {
      value = stripJiraMarkup(value === undefined || value === null ? '' : String(value));
    }
    out[section.id] = value;
  });

  // Preserve any generated section that isn't in the current template, so a
  // user's old History item doesn't lose data after the template changes.
  Object.keys(current).forEach(id => {
    if (!(id in out)) out[id] = current[id];
  });
  r.sections = out;
  return out;
}

function sectionValueToText(value, section) {
  if (section?.type === 'list') {
    return Array.isArray(value) ? value.map(String).filter(v => v.trim()) : [];
  }
  return value === undefined || value === null ? '' : String(value);
}

// ── Gherkin block formatter ───────────────────────────────────────────────
// Used by ai.js / history.js / session.js to render the AI's gherkin
// "description" / "actualResult" / "expectedResult" strings.
//
// Recognized line shapes:
//   "- something"        → bullet point
//   "Scenario: <name>"   → bold subheading
//   "GIVEN|AND|WHEN|THEN <text>" → keyword pill + rest of line
//   "<text> `code` …"    → inline code spans (backticks)
//   everything else      → plain paragraph
//
// The model occasionally emits literal "\n" (two chars) instead of real
// newlines inside JSON string values — we normalize both forms before
// splitting so the layout always renders predictably.
function formatGherkinText(s) {
  if (!s) return '';
  let txt = String(s).replace(/\\n/g, '\n').replace(/\\t/g, ' ');
  txt = txt.replace(/\n-\s*/g, '\n- ');
  const codeStyle = 'background:var(--surface3);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:12px';
  const kwStyle   = 'background:var(--surface3);padding:2px 8px;border-radius:4px;font-family:monospace;font-size:12px;display:inline-block;margin:2px 0';
  return txt.split('\n').map(line => {
    const t = line.trim();
    if (!t) return '<br>';
    const coded = esc(t).replace(/`([^`]+)`/g, `<code style="${codeStyle}">$1</code>`);
    if (t.startsWith('- ')) return `<div style="padding:3px 0 3px 14px">• ${coded.slice(2)}</div>`;
    if (/^Scenario:/i.test(t)) return `<div style="padding:4px 0;font-weight:500">${coded}</div>`;
    const kw = t.match(/^(GIVEN|AND|WHEN|THEN)\b/);
    if (kw) {
      const kwLen = kw[0].length;
      return `<div style="padding:3px 0"><code style="${kwStyle}">${kw[0]}</code>${coded.slice(kwLen)}</div>`;
    }
    return `<div style="padding:2px 0">${coded}</div>`;
  }).join('');
}

// ── fuzzy string similarity (for de-duplicating AI rules) ─────────────────
// Jaccard similarity on STEMMED word sets, ignoring stopwords and punctuation.
// Returns a number in [0, 1] where 1 = identical token sets.
//
// Threshold tuning history:
//   0.6  — initial; too strict, "Always include numbered steps" vs.
//          "List numbered steps with clear actions" scored ~0.4 and slipped
//          past as a fresh rule even though they say the same thing.
//   0.45 — current; combined with stemming (steps == step == stepping)
//          catches most rephrasings without false positives on rules that
//          merely share a noun (e.g. "steps").

const SIMILARITY_THRESHOLD = 0.45;

const STOPWORDS = new Set([
  'the','a','an','and','or','to','of','in','on','for','with','is','are','be',
  'this','that','it','its','as','at','by','from','was','were','has','have','had',
  'will','would','should','can','could','may','might','do','does','did','if','but',
  // QA-rule filler words — these don't carry meaning so we ignore them
  // to avoid two rules looking different just because one says "always" and
  // the other says "make sure to" (both convey "do this").
  'always','never','make','sure','please','must','need','include','add',
  'use','using','when','where','what','which','one','any','each','every','also',
]);

// Strip very common English inflectional suffixes so plural/gerund/past
// variants collapse to the same root. Intentionally tiny — full Porter
// stemmer would be overkill and could over-stem ("steps" vs "step" is the
// only case that actually trips dedup in practice).
function stemWord(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4)            return w.slice(0, -3) + 'y';
  if (w.endsWith('sses'))                            return w.slice(0, -2); // "addresses" -> "address"
  if (w.endsWith('ing') && w.length > 5)            return w.slice(0, -3);
  if (w.endsWith('ed')  && w.length > 4)            return w.slice(0, -2);
  if (w.endsWith('ly')  && w.length > 4)            return w.slice(0, -2); // "clearly" -> "clear"
  if (w.endsWith('s')   && !w.endsWith('ss'))       return w.slice(0, -1);
  return w;
}

function normalizeRule(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ruleTokens(s) {
  return new Set(
    normalizeRule(s)
      .split(' ')
      .filter(w => w.length > 1 && !STOPWORDS.has(w))
      .map(stemWord)
  );
}

function ruleSimilarity(a, b) {
  const ta = ruleTokens(a);
  const tb = ruleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach(t => { if (tb.has(t)) inter++; });
  const union = ta.size + tb.size - inter;
  return inter / union;
}

function isSimilarRule(rule, existingList, threshold = SIMILARITY_THRESHOLD) {
  const n = normalizeRule(rule);
  if (!n) return true; // empty rule — treat as duplicate (skip)
  for (const e of existingList) {
    if (normalizeRule(e) === n) return true;
    if (ruleSimilarity(rule, e) >= threshold) return true;
  }
  return false;
}

// ── Jira-wiki / markdown sanitizer ────────────────────────────────────────
// AI sometimes mirrors the syntactic style of the uploaded template, which
// can produce Jira Server wiki markup (h2., {color:...}{color}, {panel...}{panel})
// that does NOT render in Jira Cloud REST API v3 (which uses ADF instead).
// We strip the most common markers as a safety net.
function stripJiraMarkup(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/^h[1-6]\.\s*/gm, '')                          // h2. headings
    .replace(/\{color\s*:\s*[^}]*\}/gi, '')                 // {color:#xxx}
    .replace(/\{color\}/gi, '')                             // {color}
    .replace(/\{panel\s*:\s*[^}]*\}/gi, '')                 // {panel:bgColor=...}
    .replace(/\{panel\}/gi, '')                             // {panel}
    .replace(/\{(info|note|warning|tip|quote|code|noformat)(\s*:\s*[^}]*)?\}/gi, '')
    .replace(/\{(info|note|warning|tip|quote|code|noformat)\}/gi, '')
    .replace(/\|\s*width\s*=\s*\d+\s*\|/gi, '')             // |width=400|
    .replace(/\|\s*thumbnail\s*\|/gi, '')                   // |thumbnail|
    .replace(/^#{1,6}\s+/gm, '')                            // markdown headings
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')                   // **bold**
    .replace(/__([^_\n]+?)__/g, '$1')                       // __bold__
    .replace(/```[a-z]*\n?/gi, '').replace(/```/g, '')      // code fences
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Detect a *rule* (instruction) that asks the AI to produce markup syntax.
// Used to drop such rules from analyzeTemplate output so they don't poison
// future generate() runs.
function isMarkupSyntaxRule(rule) {
  return /\b(h[1-6]\.|color\s*:\s*#|\{panel\b|\{color\b|bgColor|\|width=|wiki markup|markdown (syntax|formatting|bold|heading))\b/i.test(String(rule));
}
