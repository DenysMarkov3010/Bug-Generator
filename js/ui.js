// ── nav ───────────────────────────────────────────────────────────────────
// Top-level pages. The legacy "session" target is kept as an alias that
// jumps to Report → Batch sub-tab so any external bookmark / call site
// keeps working after the sub-tab refactor.
function showPage(n) {
  if (n === 'session') {
    showPage('report');
    showReportSubTab('batch');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + n);
  const nav  = document.getElementById('nav-' + n);
  if (page) page.classList.add('active');
  if (nav)  nav.classList.add('active');

  if (n === 'history' && typeof renderHistory === 'function') {
    renderHistory();
  }
  if (n === 'context' && typeof renderContextWords === 'function') {
    renderContextWords();
  }
}

// ── Report sub-tabs (Single Report / Batch Report) ────────────────────────
// "Single" = the classic one-bug Report flow (mic, textarea, Generate).
// "Batch" = the former Session page — multiple bug cards + Generate all.
//
// Lazy-init the batch sub-tab the first time it's opened: create a fresh
// card so the user sees an actionable form instead of an empty stub.
function showReportSubTab(name) {
  document.querySelectorAll('.report-sub').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  const sub = document.getElementById('report-' + name);
  const btn = document.getElementById('sub-' + name);
  if (sub) sub.classList.add('active');
  if (btn) btn.classList.add('active');

  if (name === 'batch' && typeof renderCards === 'function') {
    if (typeof sessionCards !== 'undefined' && !sessionCards.length && typeof addBugCard === 'function') {
      addBugCard();
    } else {
      renderCards();
    }
  }
}

// ── provider ──────────────────────────────────────────────────────────────
function setProvider(p, save = true) {
  provider = p;
  if (save) localStorage.setItem('bra_provider', p);
  document.getElementById('pAnthropic').classList.toggle('active',  p === 'anthropic');
  document.getElementById('pOpenRouter').classList.toggle('active', p === 'openrouter');
  updateApiBtn();
}

// ── api key ───────────────────────────────────────────────────────────────
function promptKey() {
  const label = provider === 'openrouter'
    ? 'OpenRouter API key (openrouter.ai/keys):'
    : 'Anthropic API key (console.anthropic.com):';
  const k = prompt(label, apiKey);
  if (k !== null) {
    apiKey = k.trim();
    localStorage.setItem('bra_key', apiKey);
    updateApiBtn();
  }
}

function updateApiBtn() {
  const btn  = document.getElementById('apiBtn');
  const name = provider === 'openrouter' ? 'OpenRouter key' : 'Anthropic key';
  if (apiKey) {
    document.getElementById('apiIcon').textContent = '●';
    document.getElementById('apiLbl').textContent  = name + ' set';
    btn.classList.add('set');
  } else {
    document.getElementById('apiIcon').textContent = '○';
    document.getElementById('apiLbl').textContent  = 'Set ' + name;
    btn.classList.remove('set');
  }
}
