// ── context words ───────────────────────────────────────────────────────────
// A user/template-curated glossary of unique domain terms (product names,
// features, jargon). Browser speech recognition (Web Speech API) cannot be
// told a custom vocabulary — Chrome ignores SpeechGrammarList — so instead we
// run a FUZZY POST-CORRECTION pass on every finalized phrase: each recognized
// word / short phrase is compared against the glossary, and if it is similar
// enough (≥ cfg.contextThreshold) to an entry's term OR one of its "sounds
// like" aliases, it is rewritten to the exact term spelling.
//
// Each glossary entry has the shape:
//   { term: "Follistim", aliases: ["фоллістім", "фолістім"] }
//   term    → exact spelling inserted into the transcript.
//   aliases → variants the recognizer might emit (incl. Ukrainian phonetic
//             spellings of English terms); used for matching only.
//
// The whole thing lives in cfg.contextWords (persisted to localStorage).

const CTX_MAX_PHRASE_TOKENS = 4;   // longest phrase (in words) we try to match
const CTX_MIN_CORE_LEN      = 3;   // ignore tiny terms (e.g. "ok") to avoid noise

// ── normalization helpers ─────────────────────────────────────────────────
// Lowercase, turn any non-letter/digit into a space, collapse whitespace.
// Unicode-aware so Cyrillic is preserved (needed for the alias matching).
function ctxNormalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ctxLeadingPunct(s) {
  const m = String(s).match(/^[^\p{L}\p{N}]+/u);
  return m ? m[0] : '';
}
function ctxTrailingPunct(s) {
  const m = String(s).match(/[^\p{L}\p{N}]+$/u);
  return m ? m[0] : '';
}

// ── similarity: normalized Levenshtein ratio (0..1) ─────────────────────────
// 1.0 = identical, 0 = completely different. "90% similar" → ratio ≥ 0.9.
function ctxLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function ctxSimilarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  return 1 - ctxLevenshtein(a, b) / maxLen;
}

// ── dictionary build ────────────────────────────────────────────────────────
// Flattens cfg.contextWords into a lookup grouped by token-count so the
// matcher can slide windows of the right width. Returns { byLen, maxN }.
function ctxBuildDict() {
  const byLen = {};   // tokenCount -> [{ norm, term }]
  let maxN = 0;
  const words = (typeof cfg !== 'undefined' && Array.isArray(cfg.contextWords)) ? cfg.contextWords : [];
  for (const entry of words) {
    if (!entry || typeof entry.term !== 'string') continue;
    const term = entry.term.trim();
    if (!term) continue;
    const forms = [term, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    for (const form of forms) {
      const norm = ctxNormalize(form);
      if (!norm) continue;
      const tokens = norm.split(' ');
      // Skip single tokens that are too short to match reliably.
      if (tokens.length === 1 && norm.replace(/\s/g, '').length < CTX_MIN_CORE_LEN) continue;
      const len = Math.min(tokens.length, CTX_MAX_PHRASE_TOKENS);
      (byLen[len] = byLen[len] || []).push({ norm, term });
      if (len > maxN) maxN = len;
    }
  }
  return { byLen, maxN };
}

// Best matching term for a normalized phrase of `len` tokens, or null.
function ctxBestMatch(norm, len, dict, threshold) {
  const candidates = dict.byLen[len];
  if (!candidates) return null;
  let best = null;
  let bestScore = threshold;   // must beat the threshold to win
  for (const c of candidates) {
    if (c.norm === norm) return c.term;   // exact normalized hit → instant
    const score = ctxSimilarity(norm, c.norm);
    if (score >= bestScore) { bestScore = score; best = c.term; }
  }
  return best;
}

// ── auto-replacements (cfg.autoReplacements) ───────────────────────────────
// Exact rules for KNOWN recurring mishearings, one per line:
//   "чекаут, чек аут → Checkout"
// Unlike the fuzzy glossary match these never fire on a merely similar word.
// A Cyrillic wrong form may carry a short case ending (≤3 letters) that is
// moved onto a Cyrillic target: "тегдепти" → "техдебти". Ported from the
// Meet Listener app (terms.py). Arrow may be →, ->, => or =; "#" = comment.
const CTX_CYR = "а-яіїєґА-ЯІЇЄҐ'’";
const CTX_MAX_SUFFIX = 3;

function parseAutoReplacements(text) {
  const rules = [];
  const ends = new RegExp('[' + CTX_CYR + ']$');
  String(text || '').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^(.*?)\s*(?:→|->|=>|=)\s*(.+)$/);
    if (!m) return;
    const target = m[2].trim();
    const seen = new Set();
    m[1].split(/[,;]/).map(w => w.trim()).filter(Boolean).forEach(wrong => {
      const key = wrong.toLowerCase();
      if (wrong.length < 3 || key === target.toLowerCase() || seen.has(key)) return;
      seen.add(key);
      const body = wrong.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('\\s+');
      const suffix = ends.test(wrong) ? '([' + CTX_CYR + ']{0,' + CTX_MAX_SUFFIX + '})' : '()';
      try {
        rules.push({
          wrong, target,
          rx: new RegExp('(?<![\\p{L}\\p{N}_-])' + body + suffix + '(?![\\p{L}\\p{N}_])', 'giu'),
          keepSuffix: ends.test(target),
        });
      } catch {}
    });
  });
  return rules;
}
window.parseAutoReplacements = parseAutoReplacements;

function applyAutoReplacements(text, rules) {
  const hits = [];
  let out = text;
  for (const r of rules) {
    out = out.replace(r.rx, (match, suffix) => {
      hits.push({ from: match, to: r.target });
      // Keep a sentence-initial capital: "Тегдепти" → "Техдебти".
      const first = match.charAt(0);
      const target = (first !== first.toLowerCase() && r.target.charAt(0) === r.target.charAt(0).toLowerCase())
        ? r.target.charAt(0).toUpperCase() + r.target.slice(1)
        : r.target;
      return target + (r.keepSuffix ? suffix : '');
    });
  }
  return { text: out, hits };
}

// ── corrections log ─────────────────────────────────────────────────────────
// Every change made by an auto-replacement or a glossary match is remembered
// ("фолістім → Follistim ×3") so recurring mishearings can be promoted on the
// Context words page: a fuzzy hit becomes an alias or an exact rule. Live
// dictation re-corrects the whole transcript on every speech frame, so a
// pair counts once per recording (ctxStartCorrectionPass bumps the pass).
const CTX_LOG_KEY = 'bra_ctx_log';
const CTX_LOG_MAX = 60;
let ctxPass = 0;

function ctxStartCorrectionPass() { ctxPass++; }
window.ctxStartCorrectionPass = ctxStartCorrectionPass;

function loadCorrectionLog() {
  try {
    const list = JSON.parse(localStorage.getItem(CTX_LOG_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function ctxLogCorrections(hits, kind) {
  if (!hits.length) return;
  const log = loadCorrectionLog();
  let changed = false;
  hits.forEach(h => {
    const from = String(h.from).trim();
    if (!from || from === h.to) return;
    let e = log.find(x => x.from.toLowerCase() === from.toLowerCase() && x.to === h.to);
    if (e && e.pass === ctxPass && e.session === ctxSessionId) return;   // same recording
    if (!e) { e = { from, to: h.to, kind, count: 0 }; log.push(e); }
    e.count++;
    e.pass = ctxPass;
    e.session = ctxSessionId;
    e.last = Date.now();
    changed = true;
  });
  if (!changed) return;
  log.sort((a, b) => b.last - a.last);
  try { localStorage.setItem(CTX_LOG_KEY, JSON.stringify(log.slice(0, CTX_LOG_MAX))); } catch {}
}
// Pass numbers restart on reload; the session id keeps an old entry's pass
// from colliding with a fresh one.
const ctxSessionId = Date.now();

// ── the public correction pass ──────────────────────────────────────────────
// First the exact auto-replacements, then the fuzzy glossary: words/phrases
// that fuzzily match the glossary are swapped for the exact term spelling.
// Original whitespace + punctuation around the matched span is preserved.
// Safe no-op when both are empty.
function correctTranscript(input) {
  if (!input || typeof input !== 'string') return input;
  const rules = parseAutoReplacements(typeof cfg !== 'undefined' ? cfg.autoReplacements : '');
  const replaced = rules.length ? applyAutoReplacements(input, rules) : { text: input, hits: [] };
  ctxLogCorrections(replaced.hits, 'rule');
  const raw = replaced.text;
  const dict = ctxBuildDict();
  if (!dict.maxN) return raw;
  const threshold = (typeof cfg !== 'undefined' && cfg.contextThreshold > 0) ? cfg.contextThreshold : 0.85;

  // Collect word spans (runs of non-whitespace) with their offsets so we can
  // splice the original string and keep its spacing intact.
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(raw))) words.push({ text: m[0], start: m.index, end: re.lastIndex });

  const n = words.length;
  if (!n) return raw;

  const out = [];
  const fuzzyHits = [];
  let i = 0;
  let lastPos = 0;
  while (i < n) {
    let matched = null;
    const maxLen = Math.min(dict.maxN, n - i);
    for (let len = maxLen; len >= 1; len--) {
      const slice = words.slice(i, i + len);
      const norm  = ctxNormalize(slice.map(w => w.text).join(' '));
      if (!norm) continue;
      const term = ctxBestMatch(norm, len, dict, threshold);
      if (term) { matched = { len, term }; break; }
    }
    if (matched) {
      const first = words[i];
      const last  = words[i + matched.len - 1];
      out.push(raw.slice(lastPos, first.start));            // gap before the span
      out.push(ctxLeadingPunct(first.text) + matched.term + ctxTrailingPunct(last.text));
      const spoken = words.slice(i, i + matched.len).map(w => w.text).join(' ');
      if (ctxNormalize(spoken) !== ctxNormalize(matched.term)) {
        fuzzyHits.push({ from: ctxNormalize(spoken), to: matched.term });
      }
      lastPos = last.end;
      i += matched.len;
    } else {
      i += 1;
    }
  }
  out.push(raw.slice(lastPos));
  ctxLogCorrections(fuzzyHits, 'glossary');
  return out.join('');
}
window.correctTranscript = correctTranscript;

// ── glossary editing (cfg.contextWords) ─────────────────────────────────────
function _ctxSave() {
  try { localStorage.setItem('bra_cfg', JSON.stringify(cfg)); } catch {}
}

function renderContextWords() {
  const list = document.getElementById('ctxList');
  if (!Array.isArray(cfg.contextWords)) cfg.contextWords = [];
  const words = cfg.contextWords;

  const count = document.getElementById('ctxCount');
  if (count) count.textContent = words.length + (words.length === 1 ? ' word' : ' words');

  // Threshold slider mirror.
  const slider = document.getElementById('ctxThreshold');
  const valEl  = document.getElementById('ctxThresholdVal');
  const pct = Math.round(((cfg.contextThreshold > 0 ? cfg.contextThreshold : 0.85)) * 100);
  if (slider) slider.value = String(pct);
  if (valEl)  valEl.textContent = String(pct);

  if (list) {
    if (!words.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:10px 0">No context words yet. Add one below, or run <strong>Analyze Template</strong> to auto-extract.</div>`;
    } else {
      list.innerHTML = words.map((w, i) => {
        const term    = esc(w.term || '');
        const aliases = esc(Array.isArray(w.aliases) ? w.aliases.join(', ') : '');
        return `<div class="ctx-row" data-idx="${i}">
          <input class="ctx-term" type="text" value="${term}" placeholder="Term (e.g. Follistim)"
                 oninput="updateContextWord(${i}, 'term', this.value)"/>
          <input class="ctx-aliases" type="text" value="${aliases}" placeholder="sounds like: фоллістім, фолістім"
                 oninput="updateContextWord(${i}, 'aliases', this.value)"/>
          <button class="ctx-del" onclick="removeContextWord(${i})" title="Remove">×</button>
        </div>`;
      }).join('');
    }
  }

  renderAutoReplacements();
  renderCorrectionLog();

  const restoreBtn = document.getElementById('ctxRestoreBtn');
  if (restoreBtn) {
    let backup = null;
    try { backup = JSON.parse(localStorage.getItem('bra_ctx_backup') || 'null'); } catch {}
    if (Array.isArray(backup) && backup.length) {
      restoreBtn.style.display = '';
      const cnt = document.getElementById('ctxRestoreCount');
      if (cnt) cnt.textContent = String(backup.length);
    } else {
      restoreBtn.style.display = 'none';
    }
  }
}

function addContextWord() {
  if (!Array.isArray(cfg.contextWords)) cfg.contextWords = [];
  cfg.contextWords.push({ term: '', aliases: [] });
  _ctxSave();
  renderContextWords();
  // Focus the freshly added term input.
  const list = document.getElementById('ctxList');
  const inputs = list ? list.querySelectorAll('.ctx-term') : [];
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// field = 'term' | 'aliases'. Edits update cfg in place WITHOUT re-rendering
// (so the input keeps focus / caret position while typing).
function updateContextWord(idx, field, value) {
  const w = cfg.contextWords && cfg.contextWords[idx];
  if (!w) return;
  if (field === 'term') {
    w.term = value;
  } else {
    w.aliases = String(value)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  _ctxSave();
  const count = document.getElementById('ctxCount');
  if (count) count.textContent = cfg.contextWords.length + (cfg.contextWords.length === 1 ? ' word' : ' words');
}

function removeContextWord(idx) {
  if (!Array.isArray(cfg.contextWords)) return;
  cfg.contextWords.splice(idx, 1);
  _ctxSave();
  renderContextWords();
}

function clearContextWords() {
  if (!cfg.contextWords || !cfg.contextWords.length) { toast('⚠ Glossary already empty'); return; }
  localStorage.setItem('bra_ctx_backup', JSON.stringify(cfg.contextWords));
  const had = cfg.contextWords.length;
  cfg.contextWords = [];
  _ctxSave();
  renderContextWords();
  toast(`✓ Cleared ${had} context word${had === 1 ? '' : 's'}`);
}

function restorePreviousContextWords() {
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem('bra_ctx_backup') || 'null'); } catch {}
  if (!Array.isArray(backup) || !backup.length) { toast('⚠ No backup to restore'); renderContextWords(); return; }
  cfg.contextWords = backup.slice();
  localStorage.removeItem('bra_ctx_backup');
  _ctxSave();
  renderContextWords();
  toast(`✓ Restored ${cfg.contextWords.length} context words`);
}

function setContextThreshold(v) {
  const pct = Math.max(70, Math.min(98, parseInt(v, 10) || 85));
  cfg.contextThreshold = pct / 100;
  _ctxSave();
  const valEl = document.getElementById('ctxThresholdVal');
  if (valEl) valEl.textContent = String(pct);
}

// ── merge from Analyze Template ─────────────────────────────────────────────
// Adds AI-extracted terms to the glossary. Case-insensitive de-dup by term;
// when a term already exists we union its aliases. Returns count of new terms.
function mergeContextWords(incoming) {
  if (!Array.isArray(incoming)) return 0;
  if (!Array.isArray(cfg.contextWords)) cfg.contextWords = [];

  const byTerm = new Map();
  cfg.contextWords.forEach(w => {
    if (w && typeof w.term === 'string') byTerm.set(w.term.trim().toLowerCase(), w);
  });

  let added = 0;
  for (const raw of incoming) {
    let term = '', aliases = [];
    if (typeof raw === 'string') {
      term = raw.trim();
    } else if (raw && typeof raw === 'object') {
      term = String(raw.term || '').trim();
      if (Array.isArray(raw.aliases)) aliases = raw.aliases.map(a => String(a).trim()).filter(Boolean);
    }
    if (!term) continue;
    const key = term.toLowerCase();
    const existing = byTerm.get(key);
    if (existing) {
      const have = new Set((existing.aliases || []).map(a => a.toLowerCase()));
      aliases.forEach(a => { if (!have.has(a.toLowerCase())) { existing.aliases = existing.aliases || []; existing.aliases.push(a); } });
    } else {
      const entry = { term, aliases };
      cfg.contextWords.push(entry);
      byTerm.set(key, entry);
      added++;
    }
  }
  if (added || incoming.length) _ctxSave();
  return added;
}
window.mergeContextWords = mergeContextWords;

// ── auto-replacements editor ────────────────────────────────────────────────
function renderAutoReplacements() {
  const ta = document.getElementById('ctxReplacements');
  if (ta && document.activeElement !== ta) ta.value = cfg.autoReplacements || '';
  renderAutoReplacementsStatus();
}

function renderAutoReplacementsStatus() {
  const el = document.getElementById('ctxReplCount');
  if (!el) return;
  const lines = String(cfg.autoReplacements || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const bad = lines.filter(l => !/(→|->|=>|=)\s*\S/.test(l)).length;
  const n = parseAutoReplacements(cfg.autoReplacements).length;
  el.textContent = `${n} rule${n === 1 ? '' : 's'}` + (bad ? ` · ${bad} line${bad === 1 ? '' : 's'} without "→" ignored` : '');
  el.style.color = bad ? 'var(--amber)' : 'var(--dim)';
}

function setAutoReplacements(v) {
  cfg.autoReplacements = String(v || '');
  _ctxSave();
  renderAutoReplacementsStatus();
}

// ── corrections log view ────────────────────────────────────────────────────
function renderCorrectionLog() {
  const box = document.getElementById('ctxLogList');
  if (!box) return;
  const log = loadCorrectionLog();
  const cnt = document.getElementById('ctxLogCount');
  if (cnt) cnt.textContent = log.length ? `${log.length} recent` : 'empty';
  if (!log.length) {
    box.innerHTML = `<div style="font-size:12px;color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:4px 0">Nothing corrected yet. Dictate something that uses your context words — every fix shows up here.</div>`;
    return;
  }
  box.innerHTML = log.map((e, i) => {
    const actions = e.kind === 'glossary'
      ? `<button class="btn btn-ghost btn-sm" onclick="promoteCorrection(${i}, 'alias')" title="Add “${esc(e.from)}” to the aliases of ${esc(e.to)}">+ Alias</button>
         <button class="btn btn-ghost btn-sm" onclick="promoteCorrection(${i}, 'rule')" title="Always replace “${esc(e.from)}” with ${esc(e.to)}, regardless of the similarity threshold">+ Rule</button>`
      : '';
    return `<div class="ctx-log-row">
      <span class="ctx-log-pair"><span class="ctx-log-from">${esc(e.from)}</span> → <strong>${esc(e.to)}</strong></span>
      <span class="ctx-log-meta">${e.kind === 'rule' ? 'rule' : 'glossary match'} · ×${e.count || 1}</span>
      ${actions}
      <button class="ctx-del" onclick="removeCorrection(${i})" title="Remove from log">×</button>
    </div>`;
  }).join('');
}

function promoteCorrection(idx, how) {
  const log = loadCorrectionLog();
  const e = log[idx];
  if (!e) return;
  if (how === 'alias') {
    const w = (cfg.contextWords || []).find(x => x && x.term === e.to);
    if (!w) { toast('⚠ “' + e.to + '” is no longer in the glossary'); return; }
    w.aliases = Array.isArray(w.aliases) ? w.aliases : [];
    if (!w.aliases.some(a => a.toLowerCase() === e.from.toLowerCase())) w.aliases.push(e.from);
    toast(`✓ “${e.from}” added as an alias of ${e.to}`);
  } else {
    const line = `${e.from} → ${e.to}`;
    const cur = String(cfg.autoReplacements || '').replace(/\s+$/, '');
    cfg.autoReplacements = cur ? cur + '\n' + line : line;
    toast(`✓ Rule added: ${line}`);
  }
  log.splice(idx, 1);
  try { localStorage.setItem(CTX_LOG_KEY, JSON.stringify(log)); } catch {}
  _ctxSave();
  renderContextWords();
}

function removeCorrection(idx) {
  const log = loadCorrectionLog();
  log.splice(idx, 1);
  try { localStorage.setItem(CTX_LOG_KEY, JSON.stringify(log)); } catch {}
  renderCorrectionLog();
}

function clearCorrectionLog() {
  localStorage.removeItem(CTX_LOG_KEY);
  renderCorrectionLog();
}
