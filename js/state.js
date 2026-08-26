// ── defaults ──────────────────────────────────────────────────────────────
// Initial configuration applied on first launch (or after a hard reset).
// Edit DEFAULTS to change the out-of-the-box experience for new users.
const DEFAULTS = {
  projectName: '', projectKey: 'QA', issueType: 'Bug',
  jiraUrl: '', jiraEmail: '', jiraToken: '', proxyUrl: '',
  openRouterModel: 'anthropic/claude-sonnet-4.5',
  template: '', templateLink: '',
  // Verbatim Environment block reused for every report. Auto-filled by
  // Analyze Template / fetchTemplateFromLink, manually editable in Setup.
  // When non-empty, generate() injects this value AS-IS — no AI rewrite.
  defaultEnvironment: '',
  voiceExamples: { uk: '', en: '' },
  // Structured sprint captured straight from the fetched template issue
  // ({ id, name, state, fieldId }) — set by fetchTemplateFromLink, used by
  // analyzeTemplate to force a VALID numeric sprint id into the Sprint
  // custom field instead of trusting the AI to copy it correctly.
  templateSprint: null,
  // Each entry: { text: string, pinned: boolean }. `pinned` protects the
  // rule from Analyze Template's wholesale replace (see analyzeTemplate in
  // template.js) — pinned rules are kept exactly as-is across re-analyses,
  // same protection customFields already has via its own `pinned` flag.
  rules: [
    { text: 'Always include numbered steps to reproduce', pinned: false },
    { text: 'Separate expected vs actual behavior clearly', pinned: false },
    { text: 'Assign severity: Critical / High / Medium / Low', pinned: false },
    { text: 'Extract environment info (browser, OS, version) if mentioned', pinned: false },
    { text: 'Write a clear concise summary title (max 80 chars)', pinned: false },
    { text: 'After any step or precondition sentence containing "Logged in" or "User logged into", append the environment name in parentheses right after that sentence — e.g. "User logged into the app (Stage env)".', pinned: true },
  ],
  customFields: [
    { name: 'Component / Module', type: 'text', jiraId: 'components', required: 'no' },
    { name: 'Assignee',           type: 'text', jiraId: 'assignee',   required: 'no' },
  ],
  // Template-driven Normal format. Analyze Template replaces this schema
  // with the project's own section names, order, list/text types and visual
  // hints. The default mirrors the old Normal layout so first-run behavior
  // stays familiar before a template has been analyzed.
  reportTemplate: {
    mode: 'template',
    sections: [
      { id: 'preconditions', title: 'Preconditions', type: 'list', listStyle: 'bullet', style: { panel: 'info' } },
      { id: 'steps', title: 'Steps', type: 'list', listStyle: 'ordered', style: { heading: 'h3' } },
      { id: 'actual', title: 'AR', type: 'text', style: { heading: 'h2', color: '#ff5630', prefix: 'AR: ' } },
      { id: 'expected', title: 'ER', type: 'text', style: { heading: 'h2', color: '#36b37e', prefix: 'ER: ' } },
    ],
  },
  // ── Context words (dictation glossary) ──────────────────────────────────
  // Unique domain terms (product names, features, jargon) used to auto-
  // correct Browser speech-recognition output. Each entry:
  //   { term: "Follistim", aliases: ["фоллістім", "фолістім"] }
  // term    = exact spelling inserted into the report.
  // aliases = "sounds like" variants (incl. Ukrainian phonetic spellings)
  //           the recognizer might emit; used for fuzzy matching only.
  // contextThreshold = similarity 0..1 required to accept a correction.
  contextWords:     [],
  contextThreshold: 0.85,
  // ── Dictation mode (Setup → Dictation) ───────────────────────────────────
  // false              → pure Web Speech API behaviour (instant live text).
  // 'gpt4o-transcribe' → record clean audio, no live draft; OpenRouter
  //                      GPT-4o Transcribe produces the text on Pause/Stop.
  // Default is OFF because the GPT-4o mode needs an OpenRouter key — a fresh
  // install must still produce text out of the box. Retired modes
  // (true / 'stop' / 'live' / 'whisper-turbo') migrate to 'gpt4o-transcribe'.
  voiceAiCleanup: false,
  // ── Linked work items (Setup → Linked work items) ────────────────────────
  // Project-default tickets every generated bug gets linked to. Auto-filled
  // by Analyze Template (when the reference bug shows linked issues) and
  // manually editable in Setup. Each entry:
  //   { relation: 'relates to', key: 'FER-123', title: '…', url: 'https://…' }
  // Every generated report receives a COPY of this list (editable per-report
  // on the result card); Push to Jira then creates real issue links.
  linkedWorkItems: [],
};

// ── linked work item relations ─────────────────────────────────────────────
// How the NEW bug relates to the linked ticket. `jiraType` is the Jira
// issue-link type name; `side` says which side of the link the NEW bug
// occupies. Jira semantics: {inwardIssue: A, outwardIssue: B, type: T} reads
// "A <T.inward> B" and "B <T.outward> A" — so when the new bug carries the
// OUTWARD phrase (e.g. "blocks") it must be sent as outwardIssue, and when it
// carries the INWARD phrase ("is blocked by") as inwardIssue.
const LINKED_WORK_ITEM_RELATIONS = [
  { label: 'relates to',       jiraType: 'Relates',          side: 'outward' },
  { label: 'blocks',           jiraType: 'Blocks',           side: 'outward' },
  { label: 'is blocked by',    jiraType: 'Blocks',           side: 'inward'  },
  { label: 'duplicates',       jiraType: 'Duplicate',        side: 'outward' },
  { label: 'is duplicated by', jiraType: 'Duplicate',        side: 'inward'  },
  { label: 'causes',           jiraType: 'Problem/Incident', side: 'outward' },
  { label: 'is caused by',     jiraType: 'Problem/Incident', side: 'inward'  },
  { label: 'clones',           jiraType: 'Cloners',          side: 'outward' },
  { label: 'is cloned by',     jiraType: 'Cloners',          side: 'inward'  },
];
const DEFAULT_LINK_RELATION = 'relates to';

function normalizeLinkRelation(rel) {
  const norm = String(rel || '').trim().toLowerCase();
  const hit = LINKED_WORK_ITEM_RELATIONS.find(r => r.label === norm);
  return hit ? hit.label : DEFAULT_LINK_RELATION;
}

// Pull "FER-123" out of free text or a .../browse/FER-123 URL. Uppercases
// first so hand-typed "fer-123" works too. NOTE: named distinctly from
// template.js's extractIssueKey (case-sensitive URL parser) — both are
// global function declarations, so a shared name would silently collide.
function extractLinkedIssueKey(s) {
  const m = String(s || '').toUpperCase().match(/([A-Z][A-Z0-9_]+-\d+)/);
  return m ? m[1] : '';
}

// Coerce cfg.rules into the current { text, pinned } shape. Accepts legacy
// plain-string rows (pre-pinning builds, or an older exported JSON) as well
// as the current object shape; drops anything with no usable text.
function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  return list.map(r => {
    if (typeof r === 'string') return { text: r.trim(), pinned: false };
    if (r && typeof r === 'object') return { text: String(r.text || '').trim(), pinned: !!r.pinned };
    return null;
  }).filter(r => r && r.text);
}

// Coerce any stored / AI-returned list into clean rows. Drops entries with
// neither a key nor a URL; derives the key from the URL when only a URL was
// given; keeps relation within the known list.
function normalizeLinkedWorkItems(list) {
  if (!Array.isArray(list)) return [];
  return list.map(it => {
    if (!it || typeof it !== 'object') return null;
    const url = String(it.url || '').trim();
    let key = extractLinkedIssueKey(it.key) || extractLinkedIssueKey(url);
    return {
      relation: normalizeLinkRelation(it.relation),
      key,
      title: String(it.title || '').trim(),
      url,
    };
  }).filter(it => it && (it.key || it.url));
}

// Best browse URL for a linked item — explicit url wins, else derived from
// the configured Jira base URL + key.
function linkedItemUrl(item) {
  if (!item) return '';
  if (item.url) return item.url;
  const base = (cfg.jiraUrl || '').trim().replace(/\/+$/, '');
  return (item.key && base) ? `${base}/browse/${item.key}` : '';
}

// <option> list for relation dropdowns (Setup rows + result-card rows).
function linkRelationOptionsHtml(selected) {
  const sel = normalizeLinkRelation(selected);
  return LINKED_WORK_ITEM_RELATIONS
    .map(r => `<option value="${r.label}"${r.label === sel ? ' selected' : ''}>${r.label}</option>`)
    .join('');
}

// ── state ─────────────────────────────────────────────────────────────────
// Globals shared across all modules. They live in the script lexical scope
// and are accessible from every other <script> on the page.
let cfg        = JSON.parse(localStorage.getItem('bra_cfg') || 'null') || JSON.parse(JSON.stringify(DEFAULTS));
let apiKey     = localStorage.getItem('bra_key') || '';
let provider   = localStorage.getItem('bra_provider') || 'anthropic';
let recog      = null;
let isRec      = false;
let lang       = 'uk-UA';
let lastRep    = null;

// ── Report-page extensions ────────────────────────────────────────────────
// reportFormat   = 'normal' | 'gherkin' — chosen via the Format toggle on
//                  the Report page. 'normal' produces the legacy Steps /
//                  Expected / Actual schema; 'gherkin' produces Description
//                  (GIVEN/WHEN/THEN) + Actual / Expected result bullets.
let reportFormat  = localStorage.getItem('bra_format') || 'normal';

// ── Session-page state ────────────────────────────────────────────────────
// Independent mic / format / lang / cards because the Session page lets
// the user dictate MANY bugs back-to-back without interfering with the
// single-bug Report page above. sessionCards holds in-memory card objects
// of shape { id, text, result, recog, isRec }. Lives in memory only —
// not persisted to localStorage (History is the persistent store).
let sessionFormat    = localStorage.getItem('bra_session_format') || 'normal';
let sessionLang      = 'uk-UA';
let sessionCards     = [];
let cardCounter      = 0;
