// ── attachments ───────────────────────────────────────────────────────────
// Screenshots and screen recordings for the Single Report (incl. Composite).
//
//   1. Input   — drop / choose / paste (⌘V, Ctrl+V) files into #attachZone.
//                Videos are decoded by the browser itself: MP4 (Windows Game
//                Bar, Snipping Tool, OBS remux), MOV (macOS ⌘⇧5), WebM, and
//                MKV when its codec is supported.
//   2. AI      — images are downscaled; a video becomes a set of key frames
//                (every settled screen change + periodic ones, with
//                timestamps), because Claude takes images, not video. They
//                go along with the text as evidence; the model also says
//                after which section the files belong (per AI rules) and,
//                in a composite report, which issue each file shows.
//   3. Jira    — after Push creates the issue, the ORIGINAL files are
//                uploaded, their media ids looked up, and the description
//                re-written with every file embedded after its section
//                (falls back to a link when inline embedding isn't possible).
//
// Files live in memory only: the report keeps metadata (r.attachments) and
// an `attachmentKey` into attachmentFiles. History persists the metadata,
// so a reloaded History item can't re-upload — the push says so.

let reportAttachments = [];   // input: { id, file, name, kind, size, url, thumb, duration, error }
let attachCounter = 0;
const attachmentFiles = new Map();   // report.attachmentKey → File[]

const AI_IMAGE_MAX        = 1568;   // px, long side — Claude's sweet spot
const FRAME_WIDTH         = 1280;   // px — keeps UI text readable in frames
const MAX_AI_IMAGES       = 40;     // per request, screenshots + frames
const MAX_FRAMES_PER_VIDEO = 30;
const MIN_FRAMES_PER_VIDEO = 6;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

// How each file is shown inside the Jira description (Jira's "Edit image"
// width / height + alignment). Same defaults for every file; editable per
// file in the result card.
const MEDIA_DEFAULT_WIDTH  = 1178;
const MEDIA_DEFAULT_HEIGHT = 623;
const MEDIA_DEFAULT_ALIGN  = 'align-start';
const MEDIA_ALIGN_OPTIONS = [
  { id: 'align-start', title: 'Align left' },
  { id: 'center',      title: 'Align center' },
  { id: 'align-end',   title: 'Align right' },
  { id: 'wrap-left',   title: 'Wrap left' },
  { id: 'wrap-right',  title: 'Wrap right' },
];

function attachmentKind(file) {
  if (/^image\//.test(file.type) || IMAGE_EXT.test(file.name)) return 'image';
  if (/^video\//.test(file.type) || VIDEO_EXT.test(file.name)) return 'video';
  return '';
}

function hasReportAttachments() {
  return reportAttachments.some(a => !a.error);
}

function fmtSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function fmtClock(s) {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── input ─────────────────────────────────────────────────────────────────
function addAttachmentFiles(fileList) {
  const files = [...(fileList || [])];
  const skipped = [];
  files.forEach(file => {
    const kind = attachmentKind(file);
    if (!kind) { skipped.push(file.name); return; }
    const a = { id: ++attachCounter, file, name: file.name || `pasted-${attachCounter}.png`, kind, size: file.size, url: URL.createObjectURL(file) };
    reportAttachments.push(a);
    if (kind === 'video') probeVideo(a);
  });
  if (skipped.length) toast('⚠ Not an image or video: ' + skipped.join(', '));
  renderAttachments();
}

function removeAttachment(id) {
  const a = reportAttachments.find(x => x.id === id);
  if (a) URL.revokeObjectURL(a.url);
  reportAttachments = reportAttachments.filter(x => x.id !== id);
  renderAttachments();
}

function clearAttachments() {
  reportAttachments.forEach(a => URL.revokeObjectURL(a.url));
  reportAttachments = [];
  renderAttachments();
}

function renderAttachments() {
  const list = document.getElementById('attachList');
  if (!list) return;
  list.innerHTML = reportAttachments.map((a, i) => {
    const thumb = a.kind === 'image'
      ? `<img src="${a.url}" alt="">`
      : (a.thumb ? `<img src="${a.thumb}" alt="">` : '<span class="att-icon">🎬</span>');
    const meta = a.error
      ? `<span class="att-err">${esc(a.error)}</span>`
      : `${a.kind === 'video' ? '🎬 ' + (a.duration ? fmtClock(a.duration) + ' · ' : 'reading… · ') : '🖼 '}${fmtSize(a.size)}`;
    return `<div class="att-chip${a.error ? ' att-bad' : ''}">
      <div class="att-thumb">${thumb}</div>
      <div class="att-info"><div class="att-name" title="${esc(a.name)}">#${i + 1} ${esc(a.name)}</div><div class="att-meta">${meta}</div></div>
      <button class="rule-del" onclick="removeAttachment(${a.id})" title="Remove">×</button>
    </div>`;
  }).join('');
}

// Wire paste + drag & drop. Paste only takes FILES (a screenshot in the
// clipboard) and only while the Single Report tab is visible — plain text
// paste into the textareas keeps working as before.
function initAttachmentInput() {
  document.addEventListener('paste', e => {
    const single = document.getElementById('report-single');
    const page = document.getElementById('page-report');
    if (!single || !page || !single.classList.contains('active') || !page.classList.contains('active')) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(attachmentKind);
    if (!files.length) return;
    e.preventDefault();
    addAttachmentFiles(files);
    toast(`📎 Attached ${files.length} file${files.length === 1 ? '' : 's'} from clipboard`);
  });

  const area = document.getElementById('report-single');
  const zone = document.getElementById('attachZone');
  if (!area || !zone) return;
  let depth = 0;
  const hasFiles = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  area.addEventListener('dragenter', e => { if (!hasFiles(e)) return; depth++; zone.classList.add('drag'); });
  area.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; zone.classList.remove('drag'); } });
  area.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  area.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('drag');
    addAttachmentFiles(e.dataTransfer.files);
  });
}

// ── media helpers ─────────────────────────────────────────────────────────
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The browser could not read this image'));
    img.src = url;
  });
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

async function imageDataUrl(url, maxSide, quality) {
  const img = await loadImage(url);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = canvasOf(img.naturalWidth * scale, img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';   // transparent PNG areas → white, not black JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// Re-encode an image so it fits `maxBytes` (Vercel proxy cap): JPEG at full
// size first, then progressively smaller.
async function shrinkImageForUpload(file, maxBytes) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    for (const scale of [1, 0.8, 0.6, 0.45, 0.33]) {
      const c = canvasOf(img.naturalWidth * scale, img.naturalHeight * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob && blob.size <= maxBytes) return blob;
    }
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitFor(el, okEvent, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('decode')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(okEvent, ok); el.removeEventListener('error', bad); };
    el.addEventListener(okEvent, ok);
    el.addEventListener('error', bad);
  });
}

const VIDEO_DECODE_HINT = 'The browser can’t decode this video (codec). Re-save it as MP4 (H.264) — e.g. OBS: File → Remux Recordings; Windows: Clipchamp / Photos → Export.';

async function openVideo(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  try {
    await waitFor(v, 'loadeddata', 20000);
  } catch {
    throw new Error(VIDEO_DECODE_HINT);
  }
  if (!v.videoWidth) throw new Error(VIDEO_DECODE_HINT);
  // MediaRecorder WebM files often report duration = Infinity until the
  // end has been seeked once.
  if (!isFinite(v.duration) || v.duration <= 0) {
    await seekVideo(v, 1e7);
    await seekVideo(v, 0);
  }
  return v;
}

function seekVideo(v, t) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); v.removeEventListener('seeked', done); resolve(); };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

function videoDuration(v) {
  return isFinite(v.duration) && v.duration > 0 ? v.duration : (v.currentTime || 0);
}

// Duration + thumbnail as soon as a video is added (also tells the user
// right away when the browser can't decode the file).
async function probeVideo(a) {
  let v;
  try {
    v = await openVideo(a.url);
    a.duration = videoDuration(v);
    await seekVideo(v, Math.min(0.5, a.duration / 2));
    const c = canvasOf(96, 96 * v.videoHeight / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    a.thumb = c.toDataURL('image/jpeg', 0.7);
  } catch (e) {
    a.error = e.message;
  } finally {
    if (v) v.removeAttribute('src');
    renderAttachments();
  }
}

// Key frames of a screen recording. Pass 1 samples up to 180 tiny
// grayscale thumbnails; a frame is kept when the screen changed noticeably
// since the last kept frame AND has settled (no transition mid-animation),
// or when a long static stretch still changed a little (typing, a toast).
// First and last frames are always kept — the last one usually shows the
// bug. Over budget → drop the frames that differ least from their
// predecessor. Pass 2 renders the chosen frames at FRAME_WIDTH.
async function extractVideoFrames(a, maxFrames, onProgress) {
  const v = await openVideo(a.url);
  try {
    const duration = videoDuration(v);
    const samples = Math.min(180, Math.max(12, Math.ceil(duration / 0.5)));
    const step = duration / samples;
    const sw = 64, sh = Math.max(1, Math.round(64 * v.videoHeight / v.videoWidth));
    const small = canvasOf(sw, sh);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const cand = [];
    for (let i = 0; i < samples; i++) {
      const t = Math.max(0, Math.min(duration - 0.05, (i + 0.5) * step));
      await seekVideo(v, t);
      sctx.drawImage(v, 0, 0, sw, sh);
      const px = sctx.getImageData(0, 0, sw, sh).data;
      const sig = new Float32Array(sw * sh);
      for (let p = 0, q = 0; p < px.length; p += 4, q++) sig[q] = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) / 255;
      cand.push({ t, sig });
      if (onProgress) onProgress((i + 1) / (samples + maxFrames));
    }

    const diff = (x, y) => { let d = 0; for (let k = 0; k < x.length; k++) d += Math.abs(x[k] - y[k]); return d / x.length; };
    const T = 0.02;
    const maxGap = Math.max(2, duration / Math.max(4, maxFrames * 0.5));
    const keep = [0];
    for (let i = 1; i < cand.length; i++) {
      const last = keep[keep.length - 1];
      const dKept = diff(cand[i].sig, cand[last].sig);
      const settled = i + 1 >= cand.length || diff(cand[i].sig, cand[i + 1].sig) < T / 2;
      if ((dKept > T && settled) || (cand[i].t - cand[last].t >= maxGap && dKept > 0.002)) keep.push(i);
    }
    if (keep[keep.length - 1] !== cand.length - 1) keep.push(cand.length - 1);
    while (keep.length > maxFrames) {
      let worst = 1, wd = Infinity;
      for (let k = 1; k < keep.length - 1; k++) {
        const d = diff(cand[keep[k]].sig, cand[keep[k - 1]].sig);
        if (d < wd) { wd = d; worst = k; }
      }
      keep.splice(worst, 1);
    }

    const scale = Math.min(1, FRAME_WIDTH / v.videoWidth);
    const big = canvasOf(v.videoWidth * scale, v.videoHeight * scale);
    const bctx = big.getContext('2d');
    const frames = [];
    for (let k = 0; k < keep.length; k++) {
      const t = cand[keep[k]].t;
      await seekVideo(v, t);
      bctx.drawImage(v, 0, 0, big.width, big.height);
      frames.push({ t, dataUrl: big.toDataURL('image/jpeg', 0.8) });
      if (onProgress) onProgress((samples + k + 1) / (samples + maxFrames));
    }
    return { duration, frames };
  } finally {
    v.removeAttribute('src');
  }
}

// ── AI payload ────────────────────────────────────────────────────────────
// Returns { prompt, images: [{ label, dataUrl }], files } or null.
// `prompt` lists the attachments for the system prompt; every image is
// preceded by its label in the user message (see callAi).
async function prepareAttachmentsForAi(onStatus) {
  const usable = reportAttachments.filter(a => !a.error);
  if (!usable.length) return null;
  const imgs = usable.filter(a => a.kind === 'image');
  const vids = usable.filter(a => a.kind === 'video');
  const perVideo = vids.length
    ? Math.max(MIN_FRAMES_PER_VIDEO, Math.min(MAX_FRAMES_PER_VIDEO, Math.floor((MAX_AI_IMAGES - imgs.length) / vids.length)))
    : 0;

  const images = [];
  const lines = [];
  for (let i = 0; i < usable.length; i++) {
    const a = usable[i];
    const n = i + 1;
    if (a.kind === 'image') {
      if (onStatus) onStatus(`Reading ${a.name}…`);
      images.push({ label: `Attachment #${n} — screenshot "${a.name}"`, dataUrl: await imageDataUrl(a.url, AI_IMAGE_MAX, 0.88) });
      lines.push(`#${n} screenshot "${a.name}"`);
    } else {
      let res;
      try {
        res = await extractVideoFrames(a, perVideo, p => onStatus && onStatus(`Reading video ${a.name} — ${Math.round(p * 100)}%`));
      } catch (e) {
        throw new Error(`${a.name}: ${e.message}`);
      }
      res.frames.forEach((f, k) => images.push({
        label: `Attachment #${n} — screen recording "${a.name}", frame ${k + 1}/${res.frames.length} at ${fmtClock(f.t)}`,
        dataUrl: f.dataUrl,
      }));
      lines.push(`#${n} screen recording "${a.name}" — ${fmtClock(res.duration)} long, shown as ${res.frames.length} frames in chronological order, each labelled with its timestamp (no audio)`);
    }
  }
  return { prompt: lines.join('\n'), images, files: usable.map(a => ({ file: a.file, name: a.name, kind: a.kind, size: a.size })) };
}

// Sections a file can be embedded after, for the current format.
function attachmentSlotOptions(isGherkin) {
  if (isGherkin) {
    return [
      { id: 'description', title: 'Description' },
      { id: 'actualResult', title: 'Actual result' },
      { id: 'expectedResult', title: 'Expected result' },
      { id: '_end', title: 'End of description' },
    ];
  }
  const tpl = typeof getReportTemplate === 'function' ? getReportTemplate() : { sections: [] };
  return [...tpl.sections.map(s => ({ id: s.id, title: s.title || s.id })), { id: '_end', title: 'End of description' }];
}

function defaultAttachmentSlot(isGherkin) {
  if (isGherkin) return 'actualResult';
  const opts = attachmentSlotOptions(false);
  const ar = opts.find(o => /actual|\bar\b/i.test(o.id + ' ' + o.title));
  return ar ? ar.id : '_end';
}

// Turn the model's placement hints into per-file metadata on the report
// and park the original files under r.attachmentKey for Push to Jira.
function applyAttachmentsToReport(r, prepared, isGherkin) {
  const valid = new Set(attachmentSlotOptions(isGherkin).map(o => o.id));
  const slot = v => (valid.has(String(v || '')) ? String(v) : defaultAttachmentSlot(isGherkin));
  const files = prepared.files;
  const meta = files.map((f, i) => ({ n: i + 1, name: f.name, kind: f.kind, size: f.size, issue: 0, after: slot(r.attachmentsAfter),
    width: MEDIA_DEFAULT_WIDTH, height: MEDIA_DEFAULT_HEIGHT, align: MEDIA_DEFAULT_ALIGN }));

  if (Array.isArray(r.issues)) {
    const taken = new Set();
    r.issues.forEach((issue, k) => {
      (Array.isArray(issue.attachments) ? issue.attachments : []).forEach(num => {
        const m = meta[parseInt(num, 10) - 1];
        if (!m || taken.has(m.n)) return;
        taken.add(m.n);
        m.issue = k;
        m.after = slot(issue.attachmentsAfter);
      });
      delete issue.attachments;
      delete issue.attachmentsAfter;
    });
  }
  delete r.attachmentsAfter;

  r.attachmentKey = 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  attachmentFiles.set(r.attachmentKey, files.map(f => f.file));
  r.attachments = meta;
}

// ── result card block ─────────────────────────────────────────────────────
function renderAttachmentsBlock(r, resultId, isGherkin) {
  const list = Array.isArray(r && r.attachments) ? r.attachments : [];
  if (!list.length) return '';
  const files = attachmentFiles.get(r.attachmentKey);
  const opts = attachmentSlotOptions(isGherkin);
  const issues = Array.isArray(r.issues) ? r.issues : null;
  const rows = list.map((a, i) => {
    const issueSel = issues
      ? `<select onchange="updateResultAttachment('${esc(resultId)}', ${i}, 'issue', this.value)" title="Which issue this file shows">
          ${issues.map((_, k) => `<option value="${k}"${k === (a.issue || 0) ? ' selected' : ''}>Issue #${k + 1}</option>`).join('')}
        </select>`
      : '';
    const afterSel = `<select onchange="updateResultAttachment('${esc(resultId)}', ${i}, 'after', this.value)" title="Embedded in Jira right after this section">
        ${opts.map(o => `<option value="${esc(o.id)}"${o.id === a.after ? ' selected' : ''}>after ${esc(o.title)}</option>`).join('')}
      </select>`;
    const view = mediaViewOf(a);
    const sizeIn = (field, label) => `<label class="att-size" title="${label} in Jira, px">${label}
        <input type="number" min="1" step="1" value="${view[field]}" onchange="updateResultAttachment('${esc(resultId)}', ${i}, '${field}', this.value)"/>
      </label>`;
    const alignSel = `<select onchange="updateResultAttachment('${esc(resultId)}', ${i}, 'align', this.value)" title="Alignment in Jira">
        ${MEDIA_ALIGN_OPTIONS.map(o => `<option value="${o.id}"${o.id === view.align ? ' selected' : ''}>${o.title}</option>`).join('')}
      </select>`;
    return `<div class="att-row">
      <span class="att-row-name" title="${esc(a.name)}">${a.kind === 'video' ? '🎬' : '🖼'} ${esc(a.name)}</span>
      ${issueSel}${afterSel}${sizeIn('width', 'Width')}${sizeIn('height', 'Height')}${alignSel}
      <button class="rule-del" onclick="removeResultAttachment('${esc(resultId)}', ${i})" title="Don't attach to Jira">×</button>
    </div>`;
  }).join('');
  const status = files
    ? `${list.length} · uploaded &amp; embedded on Push to Jira`
    : 'files not kept after reload — attach them in Jira manually';
  return `<div class="linked-block" data-att-block>
    <div class="linked-block-head">
      <span class="linked-block-title">📎 Attachments</span>
      <span class="linked-block-count">${status}</span>
    </div>
    ${rows}
  </div>`;
}

function _refreshAttachmentsBlock(resultId) {
  const target = resolveResultTarget(resultId);
  const scopeEl = document.querySelector(`[data-result-id="${CSS.escape(resultId)}"]`);
  const blockEl = scopeEl && scopeEl.querySelector('[data-att-block]');
  if (!target || !blockEl) return;
  const isGherkin = (scopeEl.dataset.format || reportFormat) === 'gherkin';
  blockEl.outerHTML = renderAttachmentsBlock(target.obj, resultId, isGherkin) || '<div data-att-block></div>';
}

function updateResultAttachment(resultId, idx, field, value) {
  const target = resolveResultTarget(resultId);
  const a = target && target.obj && Array.isArray(target.obj.attachments) && target.obj.attachments[idx];
  if (!a) return;
  if (field === 'issue') a[field] = parseInt(value, 10) || 0;
  else if (field === 'width' || field === 'height') a[field] = parseInt(value, 10) > 0 ? parseInt(value, 10) : mediaViewOf({})[field];
  else a[field] = String(value);
  if (target.onUpdate) target.onUpdate();
}

// Removing from the report only (the files stay in the input list).
function removeResultAttachment(resultId, idx) {
  const target = resolveResultTarget(resultId);
  const r = target && target.obj;
  if (!r || !Array.isArray(r.attachments)) return;
  const files = attachmentFiles.get(r.attachmentKey);
  r.attachments.splice(idx, 1);
  if (files) files.splice(idx, 1);
  if (target.onUpdate) target.onUpdate();
  _refreshAttachmentsBlock(resultId);
}

// ── Push to Jira ──────────────────────────────────────────────────────────
// Width / height / alignment of a file — defaults for older History items.
function mediaViewOf(meta) {
  const w = parseInt(meta && meta.width, 10), h = parseInt(meta && meta.height, 10);
  const align = MEDIA_ALIGN_OPTIONS.some(o => o.id === (meta && meta.align)) ? meta.align : MEDIA_DEFAULT_ALIGN;
  return { width: w > 0 ? w : MEDIA_DEFAULT_WIDTH, height: h > 0 ? h : MEDIA_DEFAULT_HEIGHT, align };
}

function mediaSingleNode(mediaId, meta) {
  const v = mediaViewOf(meta);
  return {
    type: 'mediaSingle',
    attrs: { layout: v.align, width: v.width, widthType: 'pixel' },
    content: [{ type: 'media', attrs: { type: 'file', id: mediaId, collection: '', width: v.width, height: v.height } }],
  };
}

function attachmentLinkNode(att) {
  const href = `${jiraBaseUrl()}/secure/attachment/${att.id}/${encodeURIComponent(att.filename || 'attachment')}`;
  return { type: 'paragraph', content: [{ type: 'text', text: '📎 ' + (att.filename || 'attachment'), marks: [{ type: 'link', attrs: { href } }] }] };
}

// uploaded = [{ meta, att, mediaId }] → ADF slots for buildAdfDescription.
function buildMediaPlan(r, uploaded, linksOnly) {
  const plan = { main: {}, issues: [] };
  uploaded.forEach(u => {
    const node = (u.mediaId && !linksOnly) ? mediaSingleNode(u.mediaId, u.meta) : attachmentLinkNode(u.att);
    let slots = plan.main;
    if (Array.isArray(r.issues)) {
      const k = Math.min(Math.max(0, u.meta.issue || 0), r.issues.length - 1);
      slots = plan.issues[k] = plan.issues[k] || {};
    }
    const key = u.meta.after || '_end';
    (slots[key] = slots[key] || []).push(node);
  });
  return plan;
}

// Upload the report's files to the created issue and embed them. Never
// throws: returns { note, problems } for the push toast / error box.
async function pushReportAttachments(issueKey, r) {
  const files = attachmentFiles.get(r.attachmentKey);
  if (!files || !files.length) {
    return { note: '', problems: ['Attachments aren’t kept after a reload — attach them in Jira manually.'] };
  }
  const problems = [];
  const uploaded = [];
  for (let i = 0; i < r.attachments.length; i++) {
    const meta = r.attachments[i];
    const file = files[i];
    if (!file) continue;
    toast(`⏫ Uploading ${meta.name} (${i + 1}/${r.attachments.length})…`);
    try {
      const att = await jiraUploadAttachment(issueKey, file, meta.name);
      uploaded.push({ meta, att, mediaId: await jiraResolveMediaId(att.id) });
    } catch (e) {
      problems.push(`• ${meta.name}: ${e.message}`);
    }
  }
  if (!uploaded.length) return { note: '', problems };

  // Re-write the description with the files in place. Inline media first;
  // if Jira rejects that, links in the same spots.
  let embedded = 'inline';
  try {
    await jiraRequest(`/rest/api/3/issue/${issueKey}`, 'PUT', { fields: { description: buildAdfDescription(r, buildMediaPlan(r, uploaded, false)) } });
    if (uploaded.some(u => !u.mediaId)) embedded = 'mixed';
  } catch (e) {
    try {
      await jiraRequest(`/rest/api/3/issue/${issueKey}`, 'PUT', { fields: { description: buildAdfDescription(r, buildMediaPlan(r, uploaded, true)) } });
      embedded = 'links';
    } catch (e2) {
      embedded = 'none';
      problems.push(`• Files are attached, but placing them in the description failed: ${e2.message}`);
    }
  }
  const n = uploaded.length;
  const how = embedded === 'links' ? ' (linked)' : embedded === 'none' ? ' (attached only)' : '';
  return { note: ` · 📎 ${n} file${n === 1 ? '' : 's'}${how}`, problems };
}
