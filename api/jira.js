// Vercel serverless function that proxies requests to Jira Cloud.
//
// Why this exists: Atlassian Cloud does not allow browser → *.atlassian.net
// CORS, so the browser can't call Jira directly. This proxy runs server-side,
// so there's no CORS preflight against Atlassian.
//
// Security note: this is a personal-use proxy — credentials live in the
// browser, are sent to your own proxy on every request, and are NOT stored
// here. The path whitelist limits what endpoints can be hit through the
// proxy so it can't be abused as a generic forwarder.
//
// Deploy: `vercel deploy` from project root. The proxy URL will look like
// https://<your-app>.vercel.app/api/jira — paste it into Setup → "Proxy URL".

export default async function handler(req, res) {
  // CORS — allow any origin (this is a personal tool).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // upload       = { filename, contentType, data (base64) } → multipart POST
  //                to /issue/{key}/attachments. Vercel caps the request
  //                body at ~4.5 MB, so the app only sends files that fit;
  //                bigger ones go through the local proxy in serve.py /
  //                serve.ps1.
  // resolveMedia = true → GET an /attachment/content/{id} URL WITHOUT
  //                following its redirect and return the media file id from
  //                the Location header (needed to embed the file in ADF).
  const { jiraUrl, jiraEmail, jiraToken, path, method = 'GET', body, upload, resolveMedia } = req.body || {};

  if (!jiraUrl || !jiraEmail || !jiraToken || !path) {
    res.status(400).json({ error: 'Missing jiraUrl / jiraEmail / jiraToken / path' });
    return;
  }

  // Whitelist: only allow Jira REST API endpoints we actually use.
  const allowed = /^\/rest\/api\/3\/(issue|myself|project|priority|field|search|attachment)/;
  if (!allowed.test(path)) {
    res.status(400).json({ error: `Path "${path}" not in allow-list` });
    return;
  }

  const cleanUrl = String(jiraUrl).trim().replace(/\/+$/, '');
  const auth     = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

  try {
    if (resolveMedia) {
      const r = await fetch(`${cleanUrl}${path}`, {
        headers: { 'Authorization': `Basic ${auth}` },
        redirect: 'manual',
      });
      const m = /\/file\/([0-9a-fA-F-]{36})\//.exec(r.headers.get('location') || '');
      if (m) res.status(200).json({ mediaId: m[1] });
      else res.status(502).json({ error: `No media id in Jira response (HTTP ${r.status})` });
      return;
    }

    if (upload) {
      if (!/^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+\/attachments$/.test(path)) {
        res.status(400).json({ error: `Upload path "${path}" not allowed` });
        return;
      }
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(upload.data || '', 'base64')], {
        type: upload.contentType || 'application/octet-stream',
      }), upload.filename || 'attachment');
      const r = await fetch(`${cleanUrl}${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json', 'X-Atlassian-Token': 'no-check' },
        body: form,
      });
      const t = await r.text();
      let d;
      try { d = JSON.parse(t); } catch { d = { raw: t }; }
      res.status(r.status).json(d);
      return;
    }

    const upstream = await fetch(`${cleanUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Try JSON first; fall back to text for HTML error pages.
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Proxy fetch failed: ' + e.message });
  }
}
