#!/usr/bin/env python3
# =========================================================================
# Bug Report Agent - local HTTP server
#
# Replaces the bare `python3 -m http.server` that serve.command used to
# exec. Two differences, both of which were breaking the app in practice:
#
#   1. Binds explicitly to 127.0.0.1 (IPv4).
#      `python3 -m http.server` resolves the wildcard to "::" and macOS
#      sets IPV6_V6ONLY=1 on that socket, so the server accepted ONLY
#      IPv6 clients. A browser that resolved localhost to 127.0.0.1 got
#      connection-refused while the Terminal window happily showed
#      "Serving HTTP on :: port 8765".
#
#   2. Sends no-store cache headers.
#      http.server sends Last-Modified but no Cache-Control, so browsers
#      apply *heuristic* freshness (~10% of the file's age). With files a
#      month old that means ~3 days of serving index.html and js/*.js
#      straight from disk cache with zero network requests - which is why
#      the server log showed only sw.js and never index.html, and why
#      edits to the app appeared to do nothing.
#
# It also hosts a LOCAL Jira proxy under /api/jira (same contract as the
# Vercel proxy in api/jira.js). Jira Cloud blocks browser calls (CORS), and
# the Vercel proxy caps request bodies at ~4.5 MB - too small for screen
# recordings. When the app is opened from this server it detects the local
# proxy (GET /api/jira/ping) and uploads attachments through it, with no
# size limit. Only loopback clients are served.
#
# POST /api/ai-log appends one AI-call record (provider, model, tokens,
# cost - never report text) as a JSON line to logs/ai-usage.jsonl.
# =========================================================================
import base64
import http.server
import json
import os
import re
import socket
import socketserver
import sys
import threading
import urllib.error
import urllib.request
import urllib.parse
import uuid

PORT = int(os.environ.get("BRA_PORT", "8765"))
HOST = os.environ.get("BRA_HOST", "")  # "" = every loopback family
ROOT = os.path.dirname(os.path.abspath(__file__))


# Same allow-list as api/jira.js: only the Jira REST endpoints the app uses.
ALLOWED_PATH = re.compile(r"^/rest/api/3/(issue|myself|project|priority|field|search|attachment)")
UPLOAD_PATH = re.compile(r"^/rest/api/3/issue/[A-Za-z0-9_-]+/attachments$")
# Attachment downloads redirect to api.media.atlassian.com/file/<uuid>/binary;
# that uuid is what an ADF "media" node needs to show the file inline.
MEDIA_ID = re.compile(r"/file/([0-9a-fA-F-]{36})/")
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

AI_LOG = os.path.join(ROOT, "logs", "ai-usage.jsonl")
AI_LOG_FIELDS = ("ts", "purpose", "provider", "model", "inputTokens", "outputTokens",
                 "cost", "estimated", "durationMs", "images")
AI_LOG_LOCK = threading.Lock()   # ThreadingTCPServer - keep lines whole


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def jira_call(base, email, token, path, method="GET", json_body=None, data=None, headers=None, follow=True):
    """One Jira REST call. Returns (status, body_bytes, headers)."""
    auth = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
    h = {"Authorization": "Basic " + auth, "Accept": "application/json"}
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method, headers=h)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=300) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:   # 4xx/5xx, and 3xx when not following
        return e.code, e.read(), e.headers


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- local Jira proxy ------------------------------------------------
    def do_GET(self):
        if self.path.split("?")[0] == "/api/jira/ping":
            return self._json(200, {"ok": True, "proxy": "local"})
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/api/jira", "/api/jira/upload", "/api/ai-log"):
            return self._json(404, {"error": "Not found"})
        if self.client_address[0] not in LOOPBACK:
            return self._json(403, {"error": "Local proxy serves this computer only"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if route == "/api/ai-log":
                return self._ai_log(json.loads(raw or b"{}"))
            if route == "/api/jira/upload":
                return self._upload(raw)
            return self._envelope(json.loads(raw or b"{}"))
        except Exception as exc:   # never let one bad request kill the server
            return self._json(502, {"error": f"Local proxy failed: {exc}"})

    def _creds(self, src):
        base = str(src.get("jiraUrl") or "").strip()
        email, token = src.get("jiraEmail"), src.get("jiraToken")
        if not base.startswith(("https://", "http://")) or not email or not token:
            raise ValueError("Missing jiraUrl / jiraEmail / jiraToken")
        return base, email, token

    def _envelope(self, env):
        base, email, token = self._creds(env)
        path = str(env.get("path") or "")
        if not ALLOWED_PATH.match(path):
            return self._json(400, {"error": f'Path "{path}" not in allow-list'})
        method = env.get("method") or "GET"
        if env.get("resolveMedia"):
            status, body, headers = jira_call(base, email, token, path, "GET", follow=False)
            m = MEDIA_ID.search(headers.get("Location") or "")
            if m:
                return self._json(200, {"mediaId": m.group(1)})
            return self._json(502 if status < 400 else status,
                              {"error": f"No media id in Jira response (HTTP {status})"})
        status, body, _ = jira_call(base, email, token, path, method, json_body=env.get("body"))
        return self._relay(status, body)

    def _upload(self, raw):
        h = self.headers
        base, email, token = self._creds({"jiraUrl": h.get("X-Jira-Url"), "jiraEmail": h.get("X-Jira-Email"),
                                          "jiraToken": h.get("X-Jira-Token")})
        path = h.get("X-Jira-Path") or ""
        if not UPLOAD_PATH.match(path):
            return self._json(400, {"error": f'Upload path "{path}" not allowed'})
        name = urllib.parse.unquote(h.get("X-File-Name") or "attachment").replace('"', "'")
        ctype = h.get("Content-Type") or "application/octet-stream"
        boundary = uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n").encode("utf-8") + raw + f"\r\n--{boundary}--\r\n".encode("ascii")
        status, resp, _ = jira_call(base, email, token, path, "POST", data=body, headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-Atlassian-Token": "no-check",
        })
        return self._relay(status, resp)

    def _ai_log(self, src):
        # Known scalar fields only - the log never grows arbitrary payloads.
        entry = {k: src[k] for k in AI_LOG_FIELDS if isinstance(src.get(k), (str, int, float, bool))}
        os.makedirs(os.path.dirname(AI_LOG), exist_ok=True)
        with AI_LOG_LOCK, open(AI_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return self._json(200, {"ok": True})

    def _relay(self, status, body):
        try:
            data = json.loads(body or b"null")
        except ValueError:
            data = {"raw": body.decode("utf-8", "replace")[:2000]}
        return self._json(status, data if data is not None else {})

    def _json(self, status, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # Never answer 304 from If-Modified-Since: a stale cached bundle is
    # exactly the failure mode this server exists to avoid.
    def send_head(self):
        for header in ("If-Modified-Since", "If-None-Match"):
            while header in self.headers:
                del self.headers[header]
        return super().send_head()


class DualStackServer(socketserver.ThreadingTCPServer):
    """Accepts both 127.0.0.1 and ::1.

    `python3 -m http.server` binds "::" and macOS leaves IPV6_V6ONLY=1 on
    that socket, so IPv4 clients were refused outright. Clearing the flag
    makes one socket serve both families, which keeps the browser on the
    SAME origin (http://localhost:8765) no matter which address it picks -
    important, because the app keeps its settings in localStorage and
    http://127.0.0.1:8765 would be a different origin with empty storage.
    """

    allow_reuse_address = True
    daemon_threads = True
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


class IPv4Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    address_family = socket.AF_INET


if __name__ == "__main__":
    os.chdir(ROOT)

    if HOST:
        attempts = [(IPv4Server, HOST)]
    else:
        # Dual-stack first; fall back to plain IPv4 on hosts with IPv6 off.
        attempts = [(DualStackServer, "::"), (IPv4Server, "127.0.0.1")]

    httpd = None
    last_error = None
    for server_cls, bind_addr in attempts:
        try:
            httpd = server_cls((bind_addr, PORT), NoCacheHandler)
            break
        except OSError as exc:
            last_error = exc

    if httpd is None:
        print(f"  ERROR: cannot bind port {PORT} - {last_error}", file=sys.stderr)
        print("  Another server is probably still holding it.", file=sys.stderr)
        sys.exit(1)

    with httpd:
        families = "IPv4 + IPv6" if httpd.address_family == socket.AF_INET6 else "IPv4"
        print(f"  Serving {ROOT}", flush=True)
        print(f"  on http://localhost:{PORT}/  ({families}, no-store)", flush=True)
        print("", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")
