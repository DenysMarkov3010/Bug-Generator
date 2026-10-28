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
// Keys and models are configured in Setup → AI provider; the sidebar is only
// a quick switch between providers that already have a key (a provider with
// no key has its button disabled).
const PROVIDER_NAMES = { anthropic: 'Anthropic', openrouter: 'OpenRouter' };

function setProvider(p, save = true) {
  provider = p === 'openrouter' ? 'openrouter' : 'anthropic';
  apiKey   = apiKeys[provider] || '';
  if (save) localStorage.setItem('bra_provider', provider);
  updateApiBtn();
  if (typeof renderAiProviderSetup === 'function') renderAiProviderSetup();
}

// ── api key ───────────────────────────────────────────────────────────────
// Called wherever an AI action needs a key that isn't set: jump to the
// Setup card and focus the active provider's key field.
function promptKey() {
  showPage('setup');
  const card = document.getElementById('aiProviderCard');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const input = document.getElementById(provider === 'openrouter' ? 'aiKeyOpenRouter' : 'aiKeyAnthropic');
  if (input) setTimeout(() => input.focus(), 300);
  toast(`⚠ Add your ${PROVIDER_NAMES[provider]} API key in Setup → AI provider`);
}

function activeModelLabel() {
  return provider === 'openrouter'
    ? (cfg.openRouterModel || 'openrouter/auto')
    : (cfg.anthropicModel || DEFAULTS.anthropicModel);
}

function updateApiBtn() {
  ['anthropic', 'openrouter'].forEach(p => {
    const b = document.getElementById(p === 'openrouter' ? 'pOpenRouter' : 'pAnthropic');
    if (!b) return;
    b.disabled = !apiKeys[p];
    b.title = apiKeys[p] ? '' : `No ${PROVIDER_NAMES[p]} key — add it in Setup → AI provider`;
    b.classList.toggle('active', p === provider && !!apiKeys[p]);
  });
  const btn = document.getElementById('apiBtn');
  if (apiKey) {
    document.getElementById('apiIcon').textContent = '●';
    document.getElementById('apiLbl').textContent  = activeModelLabel();
    btn.title = `${PROVIDER_NAMES[provider]} · ${activeModelLabel()} — open Setup → AI provider`;
    btn.classList.add('set');
  } else {
    document.getElementById('apiIcon').textContent = '○';
    document.getElementById('apiLbl').textContent  = 'Set up AI provider';
    btn.title = 'Open Setup → AI provider';
    btn.classList.remove('set');
  }
}

function openAiProviderSetup() {
  showPage('setup');
  const card = document.getElementById('aiProviderCard');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
