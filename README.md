# 🐛 Bug Report Agent

AI-powered bug report generator for QA teams. Dictate or type a bug description — get a structured, Jira-ready report in seconds.

## Features

- 🎙 **Voice input** — dictate in Ukrainian or English via the built-in Web Speech API (free, live transcript, runs entirely in the browser)
- 🔤 **Context words** — a glossary of unique terms (product names, features, jargon). Dictated words that *sound* like a glossary entry are auto-corrected to the exact spelling, so the recognizer invents less. Auto-extracted by **Analyze Template** (incl. Ukrainian phonetic variants) or added manually
- 🤖 **AI structuring** — Claude (or any OpenRouter model) writes the report in English following your rules
- 🥒 **Two formats** — **Normal** (template-driven from your analyzed bug format) or **Gherkin** (Scenario / GIVEN / WHEN / THEN)
- 📝 **Single + Batch sub-tabs** — Report tab splits into **Single Report** (one bug at a time) and **Batch Report** (multiple cards, generate all in parallel)
- 🎙 **Floating dictation controller** — a Picture-in-Picture window on Batch with `+ Add bug` / `Pause` / `Stop` — dictate Bug #1, tap `+ Add bug`, dictate Bug #2, etc., without ever leaving the floating window
- ✏️ **Inline editing** — every generated field and template-driven section is click-to-edit on Report, Batch and History. Copy / Push to Jira always use the latest edits
- 🕓 **History** — last 20 reports stored locally; expand, copy, re-push to Jira, edit inline, or delete
- 🔗 **Ticket terminology** — paste a Jira ticket URL on Report or Session and the agent mirrors that ticket's exact wording
- 📋 **Bug template** — upload an existing bug and let AI auto-extract your project's writing conventions
- ⚙️ **Per-project setup** — custom Jira fields, AI rules, project key
- 🚀 **Push to Jira** — creates the issue directly via Jira REST API
- 💾 **Export/Import config** — share setup with your team as JSON

## Requirements

- **Chrome or Edge** (desktop) — the only browsers that support the Web Speech
  API used for voice input. Typing works in any modern browser, but the mic won't.
- **An LLM API key** — Anthropic *or* OpenRouter (see Quick start for links).
- **(Optional) Node.js** — only needed if you want to deploy the Jira proxy to
  Vercel for **🚀 Push to Jira**.
- No build step and no `npm install` for the app itself — it's plain HTML/CSS/JS.

## Get it onto another device

The code is everything in this repo, but **your settings are NOT**. Project
config, LLM API key, Jira token, AI rules, custom fields, templates, context
words and history all live in the **browser's `localStorage`** on whatever
machine you used — they are *never* committed to git. So on a new device:

1. **Get the code** — clone or download the repo:
   ```bash
   git clone <your-repo-url>
   cd bug-report-agent
   ```
   (or download the ZIP from GitHub → "Code" → "Download ZIP" → unzip)
2. **Run it** (see **Quick start** below).
3. **Carry over your setup** — on the old device: **⚙️ Setup → ↗ Export JSON**;
   on the new one: **↙ Import JSON**. Export JSON does **not** include secrets,
   so you'll re-paste the LLM key and Jira token once. (Or just set everything
   up fresh — it takes a couple of minutes.)

## Quick start

1. **Open the app** — two ways:
   - **Recommended:** double-click `serve.bat` (Windows) / `serve.command` (macOS).
     It starts a local server at `http://localhost:8765` and opens the page.
     Running from `localhost` lets the browser **remember mic permission**
     (opening `index.html` via `file://` re-prompts for the mic on every reload).
   - Or just open `index.html` directly in **Chrome / Edge**.
2. **Set your LLM API key** (sidebar button at the bottom). Pick a provider:
   - **Anthropic** — create a key at https://console.anthropic.com/settings/keys
   - **OpenRouter** — create a key at https://openrouter.ai/keys (one key, many models)
3. Click **⚙️ Setup** → fill in project name, Jira URL, email, Jira API token → **Save**
4. (Optional) Add custom Jira fields, or use **📋 Template → 🔍 Analyze Template**
   to auto-extract AI rules, the Normal report format schema, fields and
   **context words** from an existing bug
5. Go to **📝 Report**, dictate or type a bug description → **Generate**
6. (Optional) To enable **🚀 Push to Jira**, deploy the proxy — see
   *Deploy to Vercel* below

> 💡 On a new device you start with an empty UI. To bring an existing config,
> use **↗ Export JSON / ↙ Import JSON** (see *Get it onto another device*).

## Speech recognition

The mic button uses the browser's built-in **Web Speech API**: free,
instant, with a live partial transcript as you speak, and it runs entirely
in the browser. Chrome / Edge are the only browsers that support it.
Accuracy for unique/technical terms is improved by the **Context words**
glossary (see below).

### Context words (improve recognition of unique terms)

The browser speech engine can't be told a custom vocabulary, so unique
terms (product names, drug names, feature names, jargon) are often
mis-heard. The **🔤 Context words** tab fixes this with a fuzzy
auto-correction pass: after each dictated phrase, every word / short
phrase is compared against your glossary, and anything that is ≥ the
similarity threshold (default **85%**) to an entry — or to one of its
"sounds-like" variants — is rewritten to the exact spelling.

Each glossary entry has:
- **Term** — exact spelling inserted into the report (e.g. `Follistim`, `New Leaf`).
- **Sounds like** — comma-separated variants the recognizer might emit, including how the term sounds in Ukrainian (e.g. `фоллістім, фолістім`). Used for matching only.

**How to fill it:**
1. **⚙️ Setup → 🔍 Analyze Template** — the AI extracts distinctive terms from the **Steps** and **Preconditions** of your template's Description and fills the Ukrainian phonetic variants automatically. Terms are **merged** (additive), never wiped.
2. Or open **🔤 Context words** and add / edit / remove terms by hand.
3. Tune the **similarity threshold** slider (70–98%). Higher = stricter.

Matching is Unicode-aware and supports single words *and* short phrases.
The glossary lives in `cfg.contextWords` in `localStorage` and is included
in the exported config JSON so a whole team can share one vocabulary.

## Report formats

Toggle the **Format** switch on **📝 Report** (or **🗂 Session**) to pick:

### Normal (default, template-driven)

Normal is no longer a hardcoded `Preconditions / Steps / AR / ER` layout.
After **🔍 Analyze Template**, the app stores a machine-readable
`cfg.reportTemplate` schema extracted from your reference bug:

- section names and order;
- whether each section is text, ordered list, or bullet list;
- visual hints such as heading level, colors, panels, prefixes, and dividers;
- section-specific instructions used by Generate Report.

Generate Report then asks the AI to fill exactly those sections, and the UI,
Copy, History, Batch, and Push to Jira all render the same template-driven
structure. If no template has been analyzed yet, the default schema mirrors
the old familiar layout: Preconditions, Steps, AR, ER.

`cfg.rules` remains the human-readable contract. It is replaced by Analyze
Template and should describe both content rules and visual/ordering rules.

### Gherkin

Scenario-driven shape, useful for BDD-style projects:
- **Description** = 1-2 free-text sentences, then `Scenario: <name>`,
  then `GIVEN / AND / WHEN / THEN` lines
- **Actual result** = bullet list of every wrong behavior
- **Expected result** = bullet list of every correct behavior
- Custom fields are skipped in Gherkin mode (they don't fit the
  narrative; flip to Normal if you need them)

The choice is persisted in `localStorage` (`bra_format` for Report,
`bra_session_format` for Session) so reload doesn't reset it.

## Batch Report (queue multiple bugs)

**📝 Report → 🗂 Batch Report** lets you queue multiple bug cards and
generate all reports in parallel. Useful at the end of a test pass when
you have 5-10 bugs to file without losing flow between them.

1. **📝 Report** sub-tab → **🗂 Batch Report**
2. (Optional) paste a Jira ticket URL — its terminology is shared by
   every card in the batch
3. Click **+ Add bug** → a new card appears. Tap any card's **🎙 mic** to
   open the floating dictation controller (see below)
4. Each card has its own mic and textarea. Recording one card stops the
   others (only one mic is hot at a time, same as the page-level mic)
5. Repeat for as many bugs as you need
6. Tap **→ Generate all reports** — the AI is called once per card via
   `Promise.all`. The first card's result lands first, the others trickle
   in as they complete.
7. Each generated card gets its own **📋 Copy** and **🚀 Push to Jira**
   buttons; every successful result is also auto-written to History.

The Format / Language toggles at the top apply to **all** cards in the
batch. Cards live in memory only — closing the tab or refreshing
discards them (the corresponding History entries persist).

### Floating dictation controller

Tap a bug card's **🎙 mic** to open a small Picture-in-Picture window that
stays on top of every other app while you dictate. Buttons:

- **⏸ Pause** — temporarily stops the recognizer (press 🎙 Resume to
  continue, or edit any card's text inline while paused)
- **+ Add bug** — stops the current card's recording, adds a fresh
  empty card, and immediately starts dictating it. The previous card
  stays visible on the Batch tab with whatever text was captured.
- **■ Stop** — fully ends dictation and closes the floating window.
  All recorded cards remain on the Batch tab, ready for **Generate all**.

The window mirrors the live transcript as you speak, and applies the
Context-words glossary to each finalized phrase.

Requires Chrome / Edge 116+ (Document Picture-in-Picture API). On
unsupported browsers the button falls back to starting the in-page
card mic instead.

## Editing generated reports

Every field in a generated report — Summary, template-driven sections,
Environment, Description, Custom fields, even Severity — is **click-to-edit**. Just
click on the text and type. Changes are persisted live to the underlying
data object, so **📋 Copy** and **🚀 Push to Jira** always use the very
latest version.

- Click any text field → cursor lands, edit with plaintext-only
  contenteditable (no rich-text from pastes, Enter inserts a newline)
- Severity badge → click to cycle Critical → High → Medium → Low
- Template-driven list sections → click a line to edit; the **+ section**
  button appends a new item
- Works identically on **Single Report**, **Batch Report** cards and
  expanded **History** items. History edits auto-save back to localStorage.

## History

**🕓 History** keeps the last 20 generated reports in `localStorage`
(`bra_history` slot). Every successful `generate()` — on Report or
Session — auto-writes one entry.

Each history row shows severity, summary, source ticket key (if any) and
timestamp. Click the row to expand the full report; from there you can:

- **📋 Copy** — plain-text dump in the same shape as the Report-page Copy
- **🚀 Push to Jira** — re-creates the ticket via the same pipeline as
  the Report page (proxy, ADF builder, custom-field shaping, etc.)
- **🗑 Delete** — remove just that one entry

**🗑 Clear all** wipes the whole list. History stores format-aware
snapshots, so Normal and Gherkin reports are rendered correctly when
expanded.

### Auto-generate rules from an existing bug

1. Go to **📋 Template** in the sidebar
2. Pick ONE of three input methods:
   - **🔗 Fetch from Jira link** — paste a ticket URL (e.g. `https://your-co.atlassian.net/browse/QA-1234`) or just a key (`QA-1234`) and click **Fetch**. The app pulls the full issue via the proxy, including description (ADF → wiki markup), all built-in fields, and every populated `customfield_*`. Requires Jira creds + proxy URL configured in Setup.
   - **📁 Upload from file** — `.txt` / `.md` / `.json` / `.csv` / `.log` / `.xlsx` / `.xls`. For Excel every sheet is converted to CSV and prefixed with `=== Sheet: <name> ===`.
   - **Paste manually** into the textarea
3. Click **💾 Save Template** (the source link is saved too — visible in the status line as `✓ Template from QA-1234`)
4. Go to **⚙️ Setup** → in the **AI rules** card click **🔍 Analyze Template**
5. The AI does several things in a single pass:
   - Replaces **AI rules** with a complete set of content + visual/ordering rules for this template
   - Extracts `cfg.reportTemplate`, the machine-readable Normal format schema used by Generate / UI / Copy / Jira
   - Detects **bug fields** filled in the template and adds them to **Custom Jira fields**; system fields get their ID auto-mapped, custom ones are resolved against `/rest/api/3/field` via your proxy (or marked **⚠ needs ID** if not resolvable)
   - Generates **two voice-dictation examples** (Ukrainian + English) that appear on the **📝 Report** page above the input — click **↓ Use as input** to start from that text
   - Extracts **Context words** from Steps / Preconditions for browser dictation correction
6. From now on every Normal report follows the same section order, labels, styles and field set as the analyzed template

## Jira API token

Get yours at: https://id.atlassian.com/manage-profile/security/api-tokens

## Sharing with the team

1. Each teammate opens `index.html` in their browser
2. One person configures Setup and clicks **↗ Export JSON**
3. Others click **↙ Import JSON** to load the same config
4. Each person sets their own LLM API key and Jira token locally

> ⚠️ Secrets stay **local-only**. The exported JSON includes everything
> in `cfg` (project name, Jira URL/email, rules, fields, default
> environment, voice examples, **context words glossary**, templates) but
> **never** the Jira API token or the LLM API key. Each teammate sets
> their own when they first import.

## Install to Desktop

A Desktop shortcut that launches the local HTTP server in one click, then
opens the app in your default browser — so you never have to hunt through
the project folder or remember to run a server first.

Why bother? Opening `index.html` directly via `file://` makes Chrome / Edge
/ Safari re-prompt for microphone permission on **every** page reload (a
hard browser security policy). Running the same page from `http://localhost`
makes the browser persist Allow forever — same as any normal site.

### Windows

1. Double-click **`install.bat`** in this folder
2. PowerShell creates `Bug Report Agent.lnk` on your Desktop
3. Double-click the shortcut — it launches `serve.bat` (a tiny HTTP server)
   and opens `http://localhost:8765/index.html` in your default browser

The Windows installer:
- generates a `.ico` from the bug favicon (`favicon.ico`)
- targets `cmd.exe /c "serve.bat"` (reliable on paths with spaces)
- doesn't change anything globally — just one `.lnk` file on Desktop

### macOS

1. Double-click **`install-mac.command`** in this folder. *(First time:
   macOS may say "cannot verify developer" — right-click → Open → Open
   in the dialog. One-time prompt per Mac.)*
2. A `Bug Report Agent.app` bundle is created on your Desktop
3. Double-click the app — it launches `serve.command` in a new Terminal
   window (visible logs), Python's built-in `http.server` starts on port
   8765, and your default browser opens the page automatically

> **Got `"install-mac.command" is damaged and can't be opened`?**
> macOS quarantines files received via Telegram, email, AirDrop or any
> browser. Because the script isn't signed by an Apple Developer ID,
> Gatekeeper labels it "damaged". It isn't — the file is fine. To unblock
> the whole project folder once, open Terminal, `cd` into this folder
> (drag it onto Terminal to autofill the path) and run:
>
> ```bash
> xattr -dr com.apple.quarantine .
> chmod +x install-mac.command serve.command
> ```
>
> After that, double-click `install-mac.command` normally.

> **Got `The file "install-mac.command" could not be executed because you do not have appropriate access privileges`?**
> The script likely does not have execute permission. Open Terminal, `cd`
> into this folder and run:
>
> ```bash
> chmod +x install-mac.command
> ```
>
> If macOS still blocks the file after that, remove quarantine too:
>
> ```bash
> xattr -d com.apple.quarantine install-mac.command
> ```
>
> Then double-click `install-mac.command` again.

The macOS installer:
- builds a proper `.app` bundle (`Bug Report Agent.app/Contents/...`)
- auto-generates `AppIcon.icns` from `favicon.svg` if `qlmanage` + `sips`
  + `iconutil` are available (all preinstalled on macOS) — falls back to
  the generic application icon if conversion fails
- uses Python 3 (preinstalled on macOS 12.3+; older Macs may need
  `xcode-select --install`)

To uninstall on either platform: just delete the shortcut / app from
Desktop. Nothing else to clean up.

## Run the local server manually

If you'd rather not create a shortcut, you can launch the server directly:

- **Windows:** double-click `serve.bat` (uses PowerShell `HttpListener` — no
  Python / Node dependency)
- **macOS:** double-click `serve.command` (uses Python's `http.server`)

Both:
- bind to `http://localhost:8765`
- open the browser automatically once the port is up
- serve files only from the project folder (no `../` escapes)
- send `Cache-Control: no-store` so your edits show up on refresh
- run in the foreground — close the terminal window or hit Ctrl+C to stop

If port `8765` is busy: on Windows edit `$port` in `serve.ps1`; on macOS
edit `PORT=8765` near the top of `serve.command`.

## Deploy to Vercel — required for "Push to Jira"

Atlassian Cloud (`*.atlassian.net`) blocks direct browser → Jira requests
because of CORS. The repo ships with a tiny serverless proxy that solves
this. Deploy steps:

```bash
npm i -g vercel
cd /path/to/bug-report-agent
vercel deploy            # first run: link to a new project, accept defaults
vercel --prod            # production URL
```

You'll get a URL like `https://bug-report-agent.vercel.app`. Then:

1. Open the app in Chrome / Edge
2. Go to **⚙️ Setup** → paste `https://bug-report-agent.vercel.app/api/jira`
   into the **Proxy URL** field → **💾 Save**
3. Click **🔌 Test connection** — should show `✓ Connected as <your name>`
4. Generate a bug on the Report page → **🚀 Push to Jira**

Alternative: drag-and-drop the project folder to https://vercel.com/new.
The `vercel.json` + `api/jira.js` are detected automatically.

### Jira field gotchas

The proxy translates the AI-extracted custom fields into the shapes Jira
expects:

| Field jiraId       | Value format expected by Jira                            |
|--------------------|----------------------------------------------------------|
| `components`       | `[{ name: "Frontend" }]` — comma-separated input is split |
| `fixVersions`      | same as components                                       |
| `labels`           | `["bug", "ui"]` — spaces in each label become dashes      |
| `assignee`         | `{ accountId: "<id>" }` — **must be Jira accountId**, not email |
| `customfield_10xx` | passed through as-is                                     |

To find a user's `accountId`: in Jira, open their profile and check the URL
(`/jira/people/<accountId>`). Plain emails won't work for Cloud.

If your project's create-screen doesn't expose **priority**, the first
request will fail and the app will automatically retry without priority.

## Project structure

```
bug-report-agent/
├── index.html            # markup only (sidebar + Report[Single/Batch] / Template / Setup / History / Context words)
├── README.md
├── favicon.svg           # lime bug icon, used by browser tab + Desktop shortcuts
├── install.bat           # Windows one-click installer (calls install.ps1)
├── install.ps1           # creates Desktop shortcut that launches serve.bat
├── install-mac.command   # macOS installer — creates "Bug Report Agent.app" on Desktop
├── serve.bat             # Windows local HTTP server (so Chrome remembers mic Allow)
├── serve.ps1             # PowerShell HttpListener used by serve.bat (no deps)
├── serve.command         # macOS local HTTP server (uses Python's http.server)
├── start.bat             # Windows one-click launcher: starts serve.ps1 minimized + opens browser
├── sw.js                 # Service Worker — action buttons in mic notifications
├── vercel.json           # Vercel runtime config for the proxy
├── api/
│   └── jira.js           # serverless proxy that forwards browser → Jira (bypasses CORS)
├── css/
│   └── styles.css        # all visual styling (dark theme, layout, animations)
└── js/
    ├── state.js          # DEFAULTS + global state (cfg, apiKey, provider, lang, sessionCards, …)
    ├── utils.js          # esc(), showErr(), toast(), formatGherkinText() + fuzzy rule similarity
    ├── ui.js             # navigation (with lazy init for Batch/History/Context), provider switch, API key prompt
    ├── config.js         # Setup page: rules, custom fields, save / export / import
    ├── voice.js          # Web Speech API (record / stop / language) + PiP controller
    ├── template.js       # Template page + analyzeTemplate() + voice examples + context-word extraction
    ├── ai.js             # generate() — Anthropic / OpenRouter — Normal + Gherkin formats + ticket context
    ├── jira.js           # jiraRequest() + pushToJira() + testJiraConnection() + ADF builders (Normal + Gherkin)
    ├── history.js        # localStorage 'bra_history' — addToHistory, render, re-push, delete
    ├── session.js        # 🗂 Batch Report — bug cards, per-card mic, PiP, parallel generate
    ├── context.js        # 🔤 Context words glossary + correctTranscript() fuzzy auto-correction
    └── app.js            # DOMContentLoaded bootstrap + cfg migrations
```

> All `.js` files use classic `<script>` tags and share the global scope —
> functions defined in one file are reachable from `onclick="..."` in HTML
> and from other files. Load order in `index.html` matters: `state.js` first,
> `app.js` last.

### Where to make common edits

| You want to change…                       | Edit                                              |
|-------------------------------------------|---------------------------------------------------|
| Default AI rules / custom fields          | `js/state.js` → `DEFAULTS`                        |
| Default context-match threshold           | `js/state.js` → `DEFAULTS.contextThreshold`       |
| Anthropic model or request shape          | `js/ai.js` → `callAi()`                           |
| OpenRouter model                          | `js/ai.js` → `callAi()` → `model:` field          |
| AI system prompt (Normal + Gherkin)       | `js/ai.js` → `buildSystemPrompt()`                |
| JSON parsing / cleanup heuristics         | `js/ai.js` → `parseAiJson()`                      |
| Jira request body / field mapping         | `js/jira.js` → `pushToJira()`                     |
| Jira description formatting — Normal      | `js/jira.js` → `buildAdfDescription()`            |
| Jira description formatting — Gherkin     | `js/jira.js` → `buildAdfDescriptionGherkin()`     |
| Whitelisted Jira proxy endpoints          | `api/jira.js` → `allowed` regex                   |
| Result card layout — Normal               | `js/ai.js` → `renderResultNormal()`               |
| Result card layout — Gherkin              | `js/ai.js` → `renderResultGherkin()`              |
| Session card layout                       | `js/session.js` → `renderCards()` / `renderCardResult()` |
| History row layout                        | `js/history.js` → `renderHistory()` / `renderHistoryBody()` |
| Template analysis prompt                  | `js/template.js` → `analyzeTemplate()`            |
| Context-word fuzzy matching / similarity  | `js/context.js` → `correctTranscript()` / `ctxSimilarity()` |
| Context-word glossary CRUD UI             | `js/context.js` → `renderContextWords()`          |
| Colors, spacing, typography               | `css/styles.css`                                  |
| Sidebar / page markup                     | `index.html`                                      |

## Severity levels

| Level    | When to use                                      |
|----------|--------------------------------------------------|
| Critical | Data loss, security issue, crash for all users   |
| High     | Major feature broken, no workaround              |
| Medium   | Feature partially broken, workaround exists      |
| Low      | Cosmetic issue, minor inconvenience              |
