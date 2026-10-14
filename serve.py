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
# =========================================================================
import http.server
import os
import socket
import socketserver
import sys

PORT = int(os.environ.get("BRA_PORT", "8765"))
HOST = os.environ.get("BRA_HOST", "")  # "" = every loopback family
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

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
