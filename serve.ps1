# Bug Report Agent - Local HTTP server (Windows, no extra dependencies)
#
# Why this exists:
#   When index.html is opened via file://, Chrome / Edge reset microphone
#   permission on EVERY page load - there is no "Remember" option for
#   file:// origins. Running the app from http://localhost makes the
#   browser persist the mic permission like for any normal site.
#
# What it does:
#   1. Spins up a minimal HttpListener bound to http://localhost:8765/
#   2. Serves files from this script's folder (the project root)
#   3. Opens the page in the user's default browser
#   4. Keeps running until you close this window or hit Ctrl+C
#
# Usage:
#   Double-click serve.bat in the project folder.
#   Or run directly:  powershell -ExecutionPolicy Bypass -File serve.ps1
#
# NOTE: this file is ASCII-only on purpose. Windows PowerShell 5.1 (the
# default on Win10/11) reads .ps1 files using the system ANSI codepage
# unless they have a UTF-8 BOM, so any em-dash / smart-quote here would
# arrive as mojibake on non-Western locales (CP1251 etc.).

# Port is overridable (serve.ps1 -Port 8080) for cases where 8765 is taken
# or lands in a Windows excluded-port range. Default stays 8765 so the
# desktop shortcut / serve.bat keep working unchanged.
param([int]$Port = 8765)

$ErrorActionPreference = 'Stop'

$port = $Port
$root = $PSScriptRoot

# Mime map - keep it small but cover everything index.html actually loads
# (html, css, js, json, svg, ico, png, woff2 from the Google Fonts CDN
# do NOT pass through here - only local assets do).
$mime = @{
  '.html'='text/html; charset=utf-8'
  '.htm' ='text/html; charset=utf-8'
  '.css' ='text/css; charset=utf-8'
  '.js'  ='text/javascript; charset=utf-8'
  '.mjs' ='text/javascript; charset=utf-8'
  '.json'='application/json; charset=utf-8'
  '.svg' ='image/svg+xml'
  '.ico' ='image/x-icon'
  '.png' ='image/png'
  '.jpg' ='image/jpeg'
  '.jpeg'='image/jpeg'
  '.gif' ='image/gif'
  '.webp'='image/webp'
  '.txt' ='text/plain; charset=utf-8'
  '.md'  ='text/markdown; charset=utf-8'
  '.xml' ='application/xml; charset=utf-8'
  '.woff'='font/woff'
  '.woff2'='font/woff2'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
    $listener.Start()
} catch {
    Write-Host ""
    Write-Host "  ERROR: Could not bind http://localhost:$port/" -ForegroundColor Red
    Write-Host "  Reason: $_" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Usually this means the port is already in use." -ForegroundColor Gray
    Write-Host "  Edit serve.ps1 and change `$port to a different value (e.g. 8000)." -ForegroundColor Gray
    Write-Host ""
    pause
    exit 1
}

$url = "http://localhost:$port/index.html"

Write-Host ""
Write-Host "  Bug Report Agent - running locally" -ForegroundColor Green
Write-Host "  ---------------------------------------" -ForegroundColor DarkGray
Write-Host "  URL : $url" -ForegroundColor Cyan
Write-Host "  Root: $root" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Keep this window open while you use the app." -ForegroundColor Yellow
Write-Host "  Close it or press Ctrl+C to stop the server." -ForegroundColor Yellow
Write-Host ""

# Open the page in the default browser. -ErrorAction SilentlyContinue so a
# missing browser doesn't kill the server - the user can still open the URL
# manually.
Start-Process $url -ErrorAction SilentlyContinue

# Resolve the root once for path-traversal checks.
$rootFull = [System.IO.Path]::GetFullPath($root)

while ($listener.IsListening) {
    $ctx = $null
    try { $ctx = $listener.GetContext() } catch { break }
    if (-not $ctx) { break }

    $req = $ctx.Request
    $res = $ctx.Response

    try {
        $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
        if ($rel -eq '/' -or [string]::IsNullOrEmpty($rel)) { $rel = '/index.html' }

        $candidate = Join-Path $root ($rel.TrimStart('/'))
        $resolved  = [System.IO.Path]::GetFullPath($candidate)

        # Prevent ../ escapes - only serve files under the project root.
        if (-not $resolved.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403
            continue
        }

        # If a directory was requested, serve its index.html.
        if (Test-Path $resolved -PathType Container) {
            $resolved = Join-Path $resolved 'index.html'
        }

        if (Test-Path $resolved -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
            $ct  = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($resolved)
            $res.ContentType = $ct
            $res.ContentLength64 = $bytes.Length
            # No-cache so the user always sees the latest edit without Ctrl+F5.
            $res.Headers.Add('Cache-Control', 'no-store, must-revalidate')
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - $rel not found")
            $res.ContentType = 'text/plain; charset=utf-8'
            $res.ContentLength64 = $msg.Length
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch {
        try {
            $res.StatusCode = 500
            $msg = [System.Text.Encoding]::UTF8.GetBytes("500 - $_")
            $res.OutputStream.Write($msg, 0, $msg.Length)
        } catch {}
    } finally {
        try { $res.Close() } catch {}
    }
}
