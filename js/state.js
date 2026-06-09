// ── defaults ──────────────────────────────────────────────────────────────
// Initial configuration applied on first launch (or after a hard reset).
// Edit DEFAULTS to change the out-of-the-box experience for new users.
const DEFAULTS = {
  projectName: '', projectKey: 'QA', issueType: 'Bug',
  jiraUrl: '', jiraEmail: '', jiraToken: '', proxyUrl: '',
  template: '', templateLink: '',
  // Verbatim Environment block reused for every report. Auto-filled by
  // Analyze Template / fetchTemplateFromLink, manually editable in Setup.
  // When non-empty, generate() injects this value AS-IS — no AI rewrite.
  defaultEnvironment: '',
  voiceExamples: { uk: '', en: '' },
  rules: [
    'Always include numbered steps to reproduce',
    'Separate expected vs actual behavior clearly',
    'Assign severity: Critical / High / Medium / Low',
    'Extract environment info (browser, OS, version) if mentioned',
    'Write a clear concise summary title (max 80 chars)',
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
};

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
