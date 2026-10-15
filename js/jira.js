// ── copy plain-text report ────────────────────────────────────────────────
function copyReport() {
  if (!lastRep) return;
  const r = lastRep;
  let txt;
  if (Array.isArray(r.issues)) {
    txt = buildCompositePlainText(r, reportFormat === 'gherkin');
  } else if (reportFormat === 'gherkin') {
    txt = `Summary: ${r.summary}
Severity: ${r.severity}
Environment: ${r.environment || 'N/A'}

Description:
${r.description || ''}

Actual result:
${r.actualResult || ''}

Expected result:
${r.expectedResult || ''}${r.additionalInfo ? `\n\nAdditional info: ${r.additionalInfo}` : ''}${buildAttachmentsText(r)}${buildLinkedWorkItemsText(r)}`;
  } else {
    txt = buildNormalPlainText(r);
  }
  navigator.clipboard.writeText(txt).then(() => toast('✓ Copied to clipboard'));
}

// Plain-text "Attachments" footer for Copy — file names only.
function buildAttachmentsText(r) {
  const list = Array.isArray(r && r.attachments) ? r.attachments : [];
  return list.length ? `\n\nAttachments:\n${list.map(a => `- ${a.name}`).join('\n')}` : '';
}

// Plain-text "Linked work items" footer for Copy (both formats + History).
// Returns '' when the report has no links so existing copies stay unchanged.
function buildLinkedWorkItemsText(r) {
  const items = (typeof normalizeLinkedWorkItems === 'function')
    ? normalizeLinkedWorkItems(r && r.linkedWorkItems)
    : [];
  if (!items.length) return '';
  const lines = items.map(it => {
    const url = (typeof linkedItemUrl === 'function') ? linkedItemUrl(it) : (it.url || '');
    return `- ${it.relation} ${it.key}${it.title ? ` — ${it.title}` : ''}${url ? ` (${url})` : ''}`;
  });
  return `\n\nLinked work items:\n${lines.join('\n')}`;
}

function buildNormalPlainText(r) {
  if (Array.isArray(r.issues)) return buildCompositePlainText(r, false);
  const parts = [`Summary: ${r.summary || ''}`, `Severity: ${r.severity || 'Medium'}`, ...normalSectionsTextParts(r)];
  if (r.environment && String(r.environment).trim()) {
    parts.push(`Environment: ${r.environment}`);
  }
  return parts.filter(p => p !== '').join('\n\n') + buildAttachmentsText(r) + buildLinkedWorkItemsText(r);
}

// Template-driven sections of one Normal report (or one composite issue) as
// plain-text blocks, in template order.
function normalSectionsTextParts(r) {
  const tpl = typeof getReportTemplate === 'function' ? getReportTemplate() : { sections: [] };
  const sections = typeof ensureNormalSections === 'function' ? ensureNormalSections(r) : (r.sections || {});
  const parts = [];

  tpl.sections.forEach(section => {
    const value = sections[section.id];
    if (section.type === 'list') {
      const items = Array.isArray(value) ? value.map(String).filter(v => v.trim()) : [];
      if (!items.length && !section.required) return;
      parts.push(`${section.title}:`);
      parts.push(items.map((item, i) =>
        section.listStyle === 'ordered' ? `${i + 1}. ${item}` : `- ${item}`
      ).join('\n'));
    } else {
      const txt = value === undefined || value === null ? '' : String(value).trim();
      if (!txt && !section.required) return;
      const prefix = section.style?.prefix || '';
      parts.push(`${prefix || (section.title + ': ')}${txt}`);
    }
  });
  return parts;
}

// Composite Bug → plain text: umbrella header, then one "Issue #N. Title"
// block per issue (mirrors the Jira Expands), then Environment + links.
function buildCompositePlainText(r, isGherkin) {
  const parts = [`Summary: ${r.summary || ''}`, `Severity: ${r.severity || 'Medium'}`];
  (r.issues || []).forEach((issue, i) => {
    const body = isGherkin
      ? [
          issue.description ? `Description:\n${issue.description}` : '',
          issue.actualResult ? `Actual result:\n${issue.actualResult}` : '',
          issue.expectedResult ? `Expected result:\n${issue.expectedResult}` : '',
          issue.additionalInfo ? `Additional info: ${issue.additionalInfo}` : '',
        ].filter(Boolean)
      : normalSectionsTextParts(issue);
    parts.push(`${compositeIssueHeading(issue, i)}\n\n${body.join('\n\n')}`);
  });
  if (r.environment && String(r.environment).trim()) {
    parts.push(`Environment: ${r.environment}`);
  }
  return parts.join('\n\n') + buildAttachmentsText(r) + buildLinkedWorkItemsText(r);
}

// "Issue #2. Title" — the Expand title in Jira and the heading in Copy.
function compositeIssueHeading(issue, i) {
  const title = String((issue && issue.title) || '').trim();
  return `Issue #${i + 1}.${title ? ' ' + title : ''}`;
}

// ── local proxy detection ─────────────────────────────────────────────────
// serve.py (macOS) and serve.ps1 (Windows) host the same Jira proxy as the
// Vercel function under /api/jira, without Vercel's ~4.5 MB body cap. When
// the app is opened from that local server we use it for attachment uploads
// and media lookups, and for everything when no Proxy URL is configured.
let localProxyState = null;   // null = not probed yet · true · false

async function localJiraProxyUrl() {
  if (localProxyState === false) return '';
  if (localProxyState === true) return location.origin + '/api/jira';
  const isLocal = location.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!isLocal) { localProxyState = false; return ''; }
  try {
    const r = await fetch('/api/jira/ping', { cache: 'no-store' });
    const d = await r.json();
    localProxyState = !!(r.ok && d && d.ok);
  } catch {
    localProxyState = false;   // older serve.* without the proxy, or serve.bat via another server
  }
  return localProxyState ? location.origin + '/api/jira' : '';
}

function jiraBaseUrl() {
  return (cfg.jiraUrl || '').trim().replace(/\/+$/, '');
}

// Build a human-readable error from Jira's various response shapes.
// - data.errors is an object {fieldId: "message", ...} — render per line
// - data.errorMessages is a string[] of general errors
// - data.error / data.message — flat string
function jiraErrorMessage(data, status) {
  const parts = [];
  if (data && data.errors && typeof data.errors === 'object' && !Array.isArray(data.errors)) {
    Object.entries(data.errors).forEach(([k, v]) => parts.push(`${k}: ${v}`));
  }
  if (data && Array.isArray(data.errorMessages) && data.errorMessages.length) {
    parts.push(...data.errorMessages);
  }
  if (data && typeof data.error === 'string') parts.push(data.error);
  if (data && typeof data.message === 'string') parts.push(data.message);
  return parts.length ? parts.join('\n') : `HTTP ${status}`;
}

// ── unified Jira request helper ───────────────────────────────────────────
// Proxy order: Setup → Proxy URL, else the local proxy (see above). With
// neither → tries to call Jira directly (fails in Cloud due to CORS, but
// works for self-hosted Jira with relaxed CORS).
// opts.resolveMedia — ask the proxy for the media file id behind an
//   /attachment/content/{id} URL instead of the response body.
// opts.preferLocal  — use the local proxy even when a Proxy URL is set
//   (attachment features need the updated proxy; a Vercel deployment may
//   still run the old version).
async function jiraRequest(path, method = 'GET', body = null, opts = {}) {
  const url = jiraBaseUrl();
  if (!url || !cfg.jiraEmail || !cfg.jiraToken) {
    throw new Error('Fill in Jira connection in Setup first');
  }
  const local = await localJiraProxyUrl();
  const proxy = (opts.preferLocal && local) || (cfg.proxyUrl || '').trim() || local;

  // Atlassian Cloud blocks all browser → *.atlassian.net traffic via CORS.
  // Without a proxy the request would fail with a confusing CORS preflight
  // error — surface a friendly message instead.
  const isCloud = /\.atlassian\.net$/i.test(new URL(url).hostname || '');
  if (isCloud && !proxy) {
    throw new Error(
      'Jira Cloud blocks direct browser requests (CORS). ' +
      'Open the app via serve.command / serve.bat (built-in local proxy), or set "Proxy URL" ' +
      'in Setup to your Vercel proxy (https://<your-app>.vercel.app/api/jira). See README → "Deploy to Vercel".'
    );
  }

  let res, data;

  if (proxy) {
    res = await fetch(proxy, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({
        jiraUrl:   url,
        jiraEmail: cfg.jiraEmail,
        jiraToken: cfg.jiraToken,
        path,
        method,
        body,
        ...(opts.resolveMedia ? { resolveMedia: true } : {}),
      }),
    });
  } else {
    // Unicode-safe Basic auth header.
    const auth = btoa(unescape(encodeURIComponent(`${cfg.jiraEmail}:${cfg.jiraToken}`)));
    res = await fetch(`${url}${path}`, {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) throw new Error(jiraErrorMessage(data, res.status));
  return data;
}

// ── attachment upload ─────────────────────────────────────────────────────
// Local proxy → raw bytes, any size. Vercel proxy → base64 inside the JSON
// envelope, so the file must fit its ~4.5 MB body cap (images are
// re-compressed to fit; videos can't be). Self-hosted Jira without a proxy
// → direct multipart. Resolves to Jira's attachment object ({ id, filename… }).
const VERCEL_UPLOAD_MAX = 3 * 1024 * 1024;   // raw bytes; base64 + JSON stays < 4.5 MB

async function jiraUploadAttachment(issueKey, file, name) {
  const url = jiraBaseUrl();
  const path = `/rest/api/3/issue/${issueKey}/attachments`;
  const filename = name || file.name || 'attachment';
  const local = await localJiraProxyUrl();
  let res;

  if (local) {
    res = await fetch(local + '/upload', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Jira-Url': url, 'X-Jira-Email': cfg.jiraEmail, 'X-Jira-Token': cfg.jiraToken,
        'X-Jira-Path': path, 'X-File-Name': encodeURIComponent(filename),
      },
      body: file,
    });
  } else if ((cfg.proxyUrl || '').trim()) {
    let blob = file;
    if (blob.size > VERCEL_UPLOAD_MAX && /^image\//.test(blob.type) && typeof shrinkImageForUpload === 'function') {
      blob = await shrinkImageForUpload(blob, VERCEL_UPLOAD_MAX);
    }
    if (blob.size > VERCEL_UPLOAD_MAX) {
      throw new Error(`${filename} is ${(blob.size / 1048576).toFixed(1)} MB — the Vercel proxy only takes ~3 MB. ` +
        'Open the app via serve.command / serve.bat (local proxy, no size limit) or attach the file in Jira manually.');
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    res = await fetch(cfg.proxyUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        jiraUrl: url, jiraEmail: cfg.jiraEmail, jiraToken: cfg.jiraToken, path, method: 'POST',
        upload: { filename: blob === file ? filename : filename.replace(/\.\w+$/, '') + '.jpg', contentType: blob.type || 'application/octet-stream', data: btoa(binary) },
      }),
    });
  } else {
    const form = new FormData();
    form.append('file', file, filename);
    res = await fetch(url + path, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.jiraEmail}:${cfg.jiraToken}`))),
        'X-Atlassian-Token': 'no-check',
        'Accept': 'application/json',
      },
      body: form,
    });
  }

  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const msg = jiraErrorMessage(data, res.status);
    // An old Vercel deployment doesn't know uploads yet.
    throw new Error(/allow-list/.test(msg) ? msg + ' — redeploy api/jira.js to Vercel, or open the app via serve.command / serve.bat' : msg);
  }
  const att = Array.isArray(data) ? data[0] : data;
  if (!att || !att.id) throw new Error('Jira returned no attachment id');
  return att;
}

// Media file id (uuid) of an uploaded attachment — what an ADF "media" node
// needs to show the file inline. Jira's attachment API doesn't return it;
// the proxy reads it from the download redirect. null when unavailable.
async function jiraResolveMediaId(attachmentId) {
  try {
    const d = await jiraRequest(`/rest/api/3/attachment/content/${attachmentId}`, 'GET', null,
      { resolveMedia: true, preferLocal: true });
    return (d && d.mediaId) || null;
  } catch {
    return null;
  }
}

// ── ADF (Atlassian Document Format) builder for the description ───────────
// Normal reports are template-driven: cfg.reportTemplate.sections controls
// section order, labels, list/text type and visual hints extracted from the
// reference Template. Gherkin keeps its dedicated builder.
//
// `media` (optional) embeds uploaded attachments: { main: slots } for a
// single report, { issues: [slots, …] } for a composite one, where
// slots = { <section id>: [ADF blocks], _end: [ADF blocks] } — the blocks are
// inserted right after that section (see attachments.js buildMediaPlan).
function buildAdfDescription(r, media) {
  // Format-aware: gherkin reports get a different block structure than
  // normal reports. The split happens here so the rest of pushToJira()
  // stays format-agnostic. `reportFormat` is set by ai.js / session.js /
  // history.js before they call pushToJira().
  if (Array.isArray(r.issues)) return buildAdfDescriptionComposite(r, media);
  const slots = (media && media.main) || null;
  if (reportFormat === 'gherkin') return buildAdfDescriptionGherkin(r, slots);

  const blocks = buildNormalAdfBlocks(r, slots);
  // Jira rejects an empty content array — always include at least one block.
  if (!blocks.length) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: '(no details)' }] });
  return { type: 'doc', version: 1, content: blocks };
}

// ── ADF builder for Composite Bug reports ─────────────────────────────────
// One Jira "Expand" element per issue, titled "Issue #N. <title>", holding
// that issue's full body — built by the same Normal / Gherkin block builders
// a standalone report uses, so styling (panels, colored AR/ER headings,
// ordered steps) is identical inside each Expand.
function buildAdfDescriptionComposite(r, media) {
  const isGherkin = reportFormat === 'gherkin';
  const blocks = (r.issues || []).map((issue, i) => {
    const slots = (media && media.issues && media.issues[i]) || null;
    const inner = isGherkin ? buildGherkinAdfBlocks(issue, slots) : buildNormalAdfBlocks(issue, slots);
    return {
      type: 'expand',
      attrs: { title: compositeIssueHeading(issue, i) },
      content: inner.length ? inner : [{ type: 'paragraph', content: [{ type: 'text', text: '(no details)' }] }],
    };
  });
  if (!blocks.length) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: '(no details)' }] });
  return { type: 'doc', version: 1, content: blocks };
}

// Template-driven Normal body as a flat ADF block array (no doc wrapper) —
// shared by standalone reports and each composite issue. `slots` (optional)
// = extra blocks to place right after a section id (or at the end).
function buildNormalAdfBlocks(r, slots) {
  const blocks = [];
  const RULE  = { type: 'rule' };
  const tpl = typeof getReportTemplate === 'function' ? getReportTemplate() : { sections: [] };
  const sections = typeof ensureNormalSections === 'function' ? ensureNormalSections(r) : (r.sections || {});

  const heading = (line, style = {}) => {
    const level = style.heading === 'h1' ? 1 : style.heading === 'h2' ? 2 : 3;
    const node = { type: 'text', text: String(line) };
    if (style.color) node.marks = [{ type: 'textColor', attrs: { color: style.color } }];
    return { type: 'heading', attrs: { level }, content: [node] };
  };
  const listBlock = (items, style) => ({
    type: style === 'ordered' ? 'orderedList' : 'bulletList',
    content: items.map(item => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseBackticks(String(item)) }],
    })),
  });
  const textBlocks = value => String(value || '')
    .replace(/\\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => ({ type: 'paragraph', content: parseBackticks(p) }));
  const panelSafeBlocks = arr => arr.map(b => {
    if (b.type !== 'heading') return b;
    const content = (b.content || []).map(n => ({
      ...n,
      marks: [...(n.marks || []), { type: 'strong' }],
    }));
    return { type: 'paragraph', content };
  });

  const placed = new Set();
  const slotAfter = id => {
    if (slots && slots[id] && !placed.has(id)) { blocks.push(...slots[id]); placed.add(id); }
  };

  tpl.sections.forEach(section => {
    const style = section.style || {};
    const value = sections[section.id];
    const hasValue = section.type === 'list'
      ? Array.isArray(value) && value.some(v => String(v).trim())
      : String(value || '').trim();
    if (!hasValue && !section.required) { slotAfter(section.id); return; }
    if (blocks.length && style.dividerBefore) blocks.push(RULE);

    const target = [];
    if (section.type === 'list') {
      const items = Array.isArray(value) ? value.filter(v => String(v).trim()) : [];
      target.push(heading(section.title, style));
      if (items.length) target.push(listBlock(items, section.listStyle));
    } else {
      const txt = String(value || '').trim();
      if (style.heading === 'h1' || style.heading === 'h2' || style.heading === 'h3') {
        const label = style.prefix || (section.title ? `${section.title}: ` : '');
        target.push(heading(`${label}${txt}`, style));
      } else {
        target.push(heading(section.title, style));
        target.push(...textBlocks(txt));
      }
    }

    if (style.panel) {
      blocks.push({
        type: 'panel',
        attrs: { panelType: style.panel === 'success' ? 'info' : style.panel },
        content: panelSafeBlocks(target.filter(b => b.type !== 'rule')),
      });
    } else {
      blocks.push(...target);
    }
    slotAfter(section.id);
  });
  // Slots for sections the template no longer has, plus explicit "_end".
  if (slots) Object.keys(slots).forEach(id => { if (id !== '_end') slotAfter(id); });
  slotAfter('_end');
  return blocks;
}

// ── ADF builder for Gherkin-format reports ────────────────────────────────
// Layout (top → bottom):
//   ▸ "Description" h3 + a panel block whose content mirrors the Gherkin
//     narrative: free-text intro lines, then `Scenario:` bold, then each
//     GIVEN / AND / WHEN / THEN line as an inline-code mono pill + rest.
//   ▸ "Actual result"   h2 colored red   (#ff5630) + bullet list
//   ▸ "Expected result" h2 colored green (#36b37e) + bullet list
//
// We keep the same red/green color convention as the normal report so the
// Jira ticket maintains a consistent visual identity across formats.
function buildAdfDescriptionGherkin(r, slots) {
  const blocks = buildGherkinAdfBlocks(r, slots);
  if (!blocks.length) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: '(no details)' }] });
  return { type: 'doc', version: 1, content: blocks };
}

// Gherkin body as a flat ADF block array — shared by standalone reports and
// each composite issue. `slots` keys: description · actualResult ·
// expectedResult · _end.
function buildGherkinAdfBlocks(r, slots) {
  const blocks = [];
  const placed = new Set();
  const slotAfter = id => {
    if (slots && slots[id] && !placed.has(id)) { blocks.push(...slots[id]); placed.add(id); }
  };
  const text   = s => ({ type: 'text', text: String(s) });
  const RULE   = { type: 'rule' };
  const coloredHeading = (line, color) => ({
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: String(line), marks: [{ type: 'textColor', attrs: { color } }] }],
  });

  // ── Description → paragraphs + Scenario / GIVEN-WHEN-THEN lines ──
  const descLines = String(r.description || '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (descLines.length) {
    blocks.push({ type: 'heading', attrs: { level: 3 }, content: [text('Description')] });
    descLines.forEach(line => {
      const kw = line.match(/^(GIVEN|AND|WHEN|THEN)\b\s*(.*)$/i);
      if (kw) {
        blocks.push({
          type: 'paragraph',
          content: [
            { type: 'text', text: kw[1].toUpperCase(), marks: [{ type: 'code' }] },
            { type: 'text', text: ' ' + (kw[2] || '') },
          ],
        });
      } else if (/^Scenario:/i.test(line)) {
        blocks.push({
          type: 'paragraph',
          content: [{ type: 'text', text: line, marks: [{ type: 'strong' }] }],
        });
      } else {
        // Plain-text line, but keep `code-spans` formatted (rare in Gherkin
        // but useful for error messages mentioned in the intro sentence).
        blocks.push({ type: 'paragraph', content: parseBackticks(line) });
      }
    });
  }
  slotAfter('description');

  // ── Actual / Expected result ──────────────────────────────────────────
  const arLines = String(r.actualResult || '').replace(/\\n/g, '\n').split('\n')
    .map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean);
  const erLines = String(r.expectedResult || '').replace(/\\n/g, '\n').split('\n')
    .map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean);

  if (arLines.length) {
    if (blocks.length) blocks.push(RULE);
    blocks.push(coloredHeading('AR: Actual result', '#ff5630'));
    blocks.push({
      type: 'bulletList',
      content: arLines.map(line => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: parseBackticks(line) }],
      })),
    });
  }
  slotAfter('actualResult');
  if (erLines.length) {
    if (arLines.length || blocks.length) blocks.push(RULE);
    blocks.push(coloredHeading('ER: Expected result', '#36b37e'));
    blocks.push({
      type: 'bulletList',
      content: erLines.map(line => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: parseBackticks(line) }],
      })),
    });
  }
  slotAfter('expectedResult');

  if (r.additionalInfo && String(r.additionalInfo).trim()) {
    blocks.push(RULE);
    blocks.push({ type: 'heading', attrs: { level: 3 }, content: [text('Additional info')] });
    blocks.push({ type: 'paragraph', content: parseBackticks(r.additionalInfo) });
  }
  if (slots) Object.keys(slots).forEach(slotAfter);
  return blocks;
}

// Split a line into ADF text nodes, turning `code` spans into mono code.
// Returns an array of text nodes ready to drop into a `paragraph.content`.
function parseBackticks(line) {
  const parts = String(line).split(/`([^`]+)`/);
  const out = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      out.push({ type: 'text', text: part, marks: [{ type: 'code' }] });
    } else {
      out.push({ type: 'text', text: part });
    }
  });
  return out.length ? out : [{ type: 'text', text: String(line) }];
}

// ── plain text → ADF doc ──────────────────────────────────────────────────
// Jira Cloud REST API v3 requires rich-text fields (description, environment)
// in Atlassian Document Format, not raw strings. This helper turns a
// multi-line string into a minimal but valid ADF doc:
//   • blank lines (\n\n) become paragraph breaks
//   • single \n inside a paragraph becomes a hardBreak (preserves device-list
//     style line layout)
function plainTextToAdf(s) {
  const text = String(s || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return null;
  const paras = text.split(/\n{2,}/);
  return {
    type: 'doc',
    version: 1,
    content: paras.map(p => {
      const lines = p.split('\n');
      const content = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        // ADF text nodes must have non-empty text — substitute single space
        // for blank lines so the document validates.
        content.push({ type: 'text', text: line || ' ' });
      });
      return { type: 'paragraph', content };
    }),
  };
}

// ── shape values for specific Jira system fields ──────────────────────────
// Jira REST API requires very specific shapes for built-in fields. Throws
// a user-friendly Error for misformatted defaults (caught and aggregated
// by pushToJira so the user sees ALL problems at once).
function shapeJiraValue(jiraId, value, fieldName = '') {
  const str = String(value).trim();
  if (!str) return null;

  // ── Sprint: detected by field name OR by jiraId of common Greenhopper
  // sprint fields. Jira wants an array of numeric sprint IDs. Accepts:
  // "5678", "[5678]", "Sprint 110 [id: 5678]", "Sprint 110, Sprint 111 [id: 5679]".
  if (/sprint/i.test(fieldName) || /sprint/i.test(jiraId)) {
    const ids = [];
    // Extract every numeric token that follows "id:" or is bare numeric.
    const idMatches = [...str.matchAll(/\[?\s*id\s*:\s*(\d+)\s*\]?/gi)];
    if (idMatches.length) {
      idMatches.forEach(m => ids.push(parseInt(m[1], 10)));
    } else {
      // No "id:" markers — accept bare numbers, but reject sprint names.
      str.split(',').forEach(part => {
        const trimmed = part.trim().replace(/^\[|\]$/g, '');
        if (/^\d+$/.test(trimmed)) ids.push(parseInt(trimmed, 10));
      });
    }
    if (!ids.length) {
      throw new Error(
        `"${fieldName || jiraId}" needs the numeric sprint ID, not the sprint name. ` +
        `Got: "${str}". Find the ID via your Jira scrum board URL (.../boards/N?sprint=ID) ` +
        `or re-fetch the template — Sprint values are now extracted with IDs.`
      );
    }
    // Jira's sprint field takes a SINGLE numeric id on create/edit — an
    // array is rejected as an invalid sprint value. When several ids were
    // listed (an issue drags its whole sprint history along), the last one
    // is the most recent.
    return ids[ids.length - 1];
  }

  if (jiraId === 'components' || jiraId === 'fixVersions' || jiraId === 'versions') {
    return str.split(',').map(v => ({ name: v.trim() })).filter(o => o.name);
  }
  if (jiraId === 'labels') {
    return str.split(',').map(v => v.trim().replace(/\s+/g, '-')).filter(Boolean);
  }
  if (jiraId === 'assignee' || jiraId === 'reporter') {
    // Accept Atlassian Cloud accountId formats:
    //   "557057:abc-def-ghi"        (provider:uuid)
    //   "5b10ac8d82e05b22cc7d4ef5"  (legacy 24-char hex)
    //   "qm:abc..."                 (Jira Service Mgmt prefixes)
    const looksLikeAccountId =
      /^[\w-]+:[\w-]+$/.test(str) ||      // provider:id form
      /^[a-f0-9]{20,}$/i.test(str) ||     // legacy hex
      /^[A-Za-z0-9_-]{24,}$/.test(str);   // newer opaque IDs
    if (!looksLikeAccountId) {
      throw new Error(
        `"${jiraId}" needs an accountId, not a display name. Got: "${str}". ` +
        `Open the user's profile in Jira — the URL ends with their accountId ` +
        `(.../jira/people/<accountId>). Paste that into the field's default in Setup.`
      );
    }
    return { accountId: str };
  }
  return value;
}

// ── create issue ──────────────────────────────────────────────────────────
async function pushToJira() {
  if (!lastRep) return;
  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
    toast('⚠ Fill in Jira connection in Setup first');
    showPage('setup');
    return;
  }

  const r = lastRep;
  const fields = {
    project:     { key: cfg.projectKey || 'QA' },
    summary:     r.summary,
    description: buildAdfDescription(r),
    issuetype:   { name: cfg.issueType || 'Bug' },
  };

  // Environment is the single-source-of-truth field — it always comes
  // from cfg.defaultEnvironment (mirrored into r.environment by generate())
  // and goes straight to Jira's `environment` system field, never the
  // description. The CF loop below is hard-blocked from setting this
  // field so a stray Custom Field mapping can't override the curated
  // verbatim block.
  if (r.environment && r.environment.trim()) {
    fields.environment = r.environment; // wrapped to ADF below
  }

  // Priority is added optionally — many projects don't expose it on the
  // create screen, in which case Jira returns 400. We still try, and if it
  // fails for that specific reason we retry without priority.
  const priority = r.severity === 'Critical' ? 'Highest'
                 : r.severity === 'High'     ? 'High'
                 : r.severity === 'Low'      ? 'Low'
                 :                             'Medium';
  fields.priority = { name: priority };

  // Map AI-extracted custom fields to their Jira field IDs (with shaping).
  // Collect all shaping errors so the user can fix everything at once
  // instead of getting one cryptic Jira 400 after another.
  const shapeErrors = [];
  cfg.customFields.forEach(f => {
    if (!f.jiraId) return;
    // Environment is owned by the Default Environment slot, not Custom
    // Fields. If a legacy CF row sneaked through (or the user added one
    // manually), skip it so it can't clobber the curated verbatim block.
    if (typeof isEnvironmentField === 'function' && isEnvironmentField(f.name, f.jiraId)) return;
    const raw = r.customFields?.[f.name];
    if (raw === undefined || raw === null || raw === '' || raw === 'null') return;
    try {
      const shaped = shapeJiraValue(f.jiraId, raw, f.name);
      if (shaped !== null && shaped !== undefined) fields[f.jiraId] = shaped;
    } catch (e) {
      shapeErrors.push(`• ${e.message}`);
    }
  });

  if (shapeErrors.length) {
    showErr('Cannot push to Jira — fix these defaults in Setup:\n\n' + shapeErrors.join('\n\n'));
    return;
  }

  // Jira Cloud v3 expects ADF for `environment` (same as description).
  // We coerce whichever string ended up there — from the AI extraction
  // path above OR from a Custom Field mapped to `environment` — so the
  // multi-line device block renders correctly instead of being rejected.
  if (typeof fields.environment === 'string' && fields.environment.trim()) {
    fields.environment = plainTextToAdf(fields.environment);
  }

  try {
    let d;
    try {
      d = await jiraRequest('/rest/api/3/issue', 'POST', { fields });
    } catch (e) {
      // Auto-retry without priority if Jira rejects that field specifically.
      if (/priority/i.test(e.message) && fields.priority) {
        delete fields.priority;
        d = await jiraRequest('/rest/api/3/issue', 'POST', { fields });
        toast('ℹ Created without priority (not enabled in this project)');
      } else {
        throw e;
      }
    }

    // Create the report's Linked work items as real Jira issue links. Link
    // failures must NOT fail the push — the bug already exists; surface a
    // warning instead so the user can link manually.
    const linkRes = await createIssueLinks(d.key, r.linkedWorkItems);
    if (linkRes.fails.length) {
      toast(`⚠ ${linkRes.fails.length} of ${linkRes.total} issue link${linkRes.total === 1 ? '' : 's'} failed:\n` + linkRes.fails.join('\n'));
    }

    // Screenshots / recordings: upload, then re-write the description with
    // them embedded where the report says (attachments.js). Failures never
    // undo the created issue — they are reported instead.
    let attNote = '';
    if (typeof pushReportAttachments === 'function' && Array.isArray(r.attachments) && r.attachments.length) {
      const a = await pushReportAttachments(d.key, r);
      attNote = a.note;
      if (a.problems.length) showErr(`${d.key} created, but attachments had problems:\n\n` + a.problems.join('\n'));
    }

    // Open the newly-created issue in a new tab so the user can verify it
    // immediately. `d.self` is the API URL; we derive the browse URL from
    // the base Jira URL + issue key, which is the human-facing page.
    toast(`✓ Created ${d.key}${linkRes.ok ? ` · 🔗 ${linkRes.ok} link${linkRes.ok === 1 ? '' : 's'}` : ''}${attNote} — opening…`);
    const base   = (cfg.jiraUrl || '').trim().replace(/\/+$/, '');
    const issueUrl = `${base}/browse/${d.key}`;
    const win = window.open(issueUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      // Popup blocker swallowed the new tab — fall back to a clickable link.
      const errArea = document.getElementById('errArea');
      if (errArea) {
        errArea.innerHTML =
          `<div class="err-box" style="background:rgba(54,179,126,.12);color:#9dffce;border-color:#1f6f48">
            ✓ Created <a href="${esc(issueUrl)}" target="_blank" rel="noopener noreferrer"
            style="color:#9dffce;font-weight:500;text-decoration:underline">${esc(d.key)}</a>.
            Popup blocker prevented auto-open — click the link.
          </div>`;
      }
    }
  } catch (e) {
    showErr('Jira error: ' + annotateJiraError(e.message));
  }
}

// ── issue links ───────────────────────────────────────────────────────────
// Creates one Jira issue link per Linked work item of the report. Direction
// matters: Jira reads {inwardIssue: A, outwardIssue: B, type: T} as
// "A <T.inward> B" / "B <T.outward> A", so the new bug goes on whichever
// side carries the relation phrase the user picked (see
// LINKED_WORK_ITEM_RELATIONS in state.js). Each link is attempted
// independently; failures are collected, never thrown.
async function createIssueLinks(newKey, items) {
  const list = (typeof normalizeLinkedWorkItems === 'function'
    ? normalizeLinkedWorkItems(items) : []).filter(it => it.key);
  const out = { total: list.length, ok: 0, fails: [] };
  for (const item of list) {
    const rel = LINKED_WORK_ITEM_RELATIONS.find(r => r.label === item.relation)
             || LINKED_WORK_ITEM_RELATIONS[0];
    const body = { type: { name: rel.jiraType } };
    if (rel.side === 'outward') {
      body.outwardIssue = { key: newKey };
      body.inwardIssue  = { key: item.key };
    } else {
      body.inwardIssue  = { key: newKey };
      body.outwardIssue = { key: item.key };
    }
    try {
      await jiraRequest('/rest/api/3/issueLink', 'POST', body);
      out.ok++;
    } catch (e) {
      out.fails.push(`${item.key} (${item.relation}): ${e.message}`);
    }
  }
  return out;
}

// Catch common Jira API gotchas where the raw error message is technically
// correct but unactionable for a non-Jira-admin user. Appends a hint
// explaining the most likely cause + how to fix it in Setup.
function annotateJiraError(msg) {
  const out = [msg];

  // "customfield_XXXXX: Specify a valid value for Sprint" — almost always
  // means the user put the sprint NAME / NUMBER (e.g. "110" from
  // "Sprint 110") in Default, not the internal sprint ID Jira indexes by.
  const sprintMatch = /(customfield_\d+)\s*:\s*Specify a valid value for Sprint/i.exec(msg);
  if (sprintMatch) {
    const cfId = sprintMatch[1];
    const cf   = (cfg.customFields || []).find(f => f.jiraId === cfId);
    const cur  = cf?.default || '(your current default)';
    out.push('');
    out.push('💡 Likely cause: that value is a sprint NAME/NUMBER (the label like "Sprint 110"), not the internal sprint ID Jira uses in REST API.');
    out.push('');
    out.push('How to find the real ID:');
    out.push('  1. Open your Jira scrum board → click the sprint in the Backlog');
    out.push('  2. The URL ends with ?sprint=XXXX — that 4-5+ digit number is the ID');
    out.push('  3. Setup → Custom Jira fields → Sprint → click "' + cur + '" in Default → replace with XXXX → 💾 Save');
    out.push('  4. Push to Jira again');
  }

  return out.join('\n');
}

// ── test connection ───────────────────────────────────────────────────────
// Calls /rest/api/3/myself — returns the authenticated user. If it works
// then both creds and (if used) the proxy are configured correctly.
async function testJiraConnection() {
  const btn = document.getElementById('testJiraBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-green"></span> Testing…'; }
  try {
    const me = await jiraRequest('/rest/api/3/myself');
    toast(`✓ Connected as ${me.displayName || me.emailAddress || 'unknown'}`);
  } catch (e) {
    toast('⚠ Connection failed: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '🔌 Test connection'; }
}
