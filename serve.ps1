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

# ---- local Jira proxy (/api/jira) ------------------------------------------
# Same contract as api/jira.js (Vercel) and serve.py (macOS). Jira Cloud
# blocks browser calls (CORS) and the Vercel proxy caps request bodies at
# ~4.5 MB - too small for screen recordings. The app detects this proxy via
# GET /api/jira/ping and uploads attachments through it with no size limit.
# HttpListener is bound to localhost only, so only this computer can use it.
Add-Type -AssemblyName System.Net.Http
$allowedPath = '^/rest/api/3/(issue|myself|project|priority|field|search|attachment)'
$uploadPath  = '^/rest/api/3/issue/[A-Za-z0-9_-]+/attachments$'

function New-JiraClient([string]$email, [string]$token, [bool]$follow) {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $follow
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    $auth = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${email}:${token}"))
    $client.DefaultRequestHeaders.Add('Authorization', "Basic $auth")
    $client.DefaultRequestHeaders.Add('Accept', 'application/json')
    return $client
}

function Send-Json($res, [int]$status, [string]$json) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $res.StatusCode = $status
    $res.ContentType = 'application/json; charset=utf-8'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Upstream($res, $resp) {
    $text = $resp.Content.ReadAsStringAsync().Result
    if ([string]::IsNullOrWhiteSpace($text)) { $text = '{}' }
    $t = $text.TrimStart()
    if (-not ($t.StartsWith('{') -or $t.StartsWith('['))) {
        $text = (@{ raw = $text.Substring(0, [Math]::Min(2000, $text.Length)) } | ConvertTo-Json -Compress)
    }
    Send-Json $res ([int]$resp.StatusCode) $text
}

function Test-JiraBase([string]$base) {
    return ($base -match '^https?://')
}

function Invoke-LocalProxy($req, $res) {
    $route = $req.Url.AbsolutePath
    if ($req.HttpMethod -eq 'GET' -and $route -eq '/api/jira/ping') {
        Send-Json $res 200 '{"ok":true,"proxy":"local"}'; return
    }
    if ($req.HttpMethod -ne 'POST') { Send-Json $res 405 '{"error":"POST only"}'; return }

    if ($route -eq '/api/jira/upload') {
        $base  = [string]$req.Headers['X-Jira-Url']
        $email = [string]$req.Headers['X-Jira-Email']
        $token = [string]$req.Headers['X-Jira-Token']
        $path  = [string]$req.Headers['X-Jira-Path']
        if (-not (Test-JiraBase $base) -or -not $email -or -not $token) { Send-Json $res 400 '{"error":"Missing jiraUrl / jiraEmail / jiraToken"}'; return }
        if ($path -notmatch $uploadPath) { Send-Json $res 400 '{"error":"Upload path not allowed"}'; return }
        $name = [System.Uri]::UnescapeDataString([string]$req.Headers['X-File-Name'])
        if (-not $name) { $name = 'attachment' }
        $ctype = if ($req.ContentType) { $req.ContentType } else { 'application/octet-stream' }
        # Multipart body built by hand: MultipartFormDataContent would
        # RFC2047-encode a non-ASCII filename ("=?utf-8?B?...?="), which Jira
        # shows verbatim. Browsers (and serve.py) send plain UTF-8 instead.
        $boundary = [Guid]::NewGuid().ToString('N')
        $utf8 = [System.Text.Encoding]::UTF8
        $head = $utf8.GetBytes("--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"" + ($name -replace '"', "'") + "`"`r`nContent-Type: $ctype`r`n`r`n")
        $tail = $utf8.GetBytes("`r`n--$boundary--`r`n")
        $ms = New-Object System.IO.MemoryStream
        $ms.Write($head, 0, $head.Length)
        $req.InputStream.CopyTo($ms)
        $ms.Write($tail, 0, $tail.Length)
        $form = New-Object System.Net.Http.ByteArrayContent(,$ms.ToArray())
        $form.Headers.TryAddWithoutValidation('Content-Type', "multipart/form-data; boundary=$boundary") | Out-Null
        $client = New-JiraClient $email $token $true
        $client.DefaultRequestHeaders.Add('X-Atlassian-Token', 'no-check')
        $resp = $client.PostAsync($base.TrimEnd('/') + $path, $form).Result
        Send-Upstream $res $resp; return
    }

    if ($route -ne '/api/jira') { Send-Json $res 404 '{"error":"Not found"}'; return }
    $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
    $payload = $reader.ReadToEnd() | ConvertFrom-Json
    $base = [string]$payload.jiraUrl
    if (-not (Test-JiraBase $base) -or -not $payload.jiraEmail -or -not $payload.jiraToken) { Send-Json $res 400 '{"error":"Missing jiraUrl / jiraEmail / jiraToken"}'; return }
    $path = [string]$payload.path
    if ($path -notmatch $allowedPath) { Send-Json $res 400 ('{"error":"Path not in allow-list: ' + ($path -replace '"', '') + '"}'); return }
    $url = $base.TrimEnd('/') + $path

    if ($payload.resolveMedia) {
        $client = New-JiraClient $payload.jiraEmail $payload.jiraToken $false
        $resp = $client.GetAsync($url).Result
        $loc = if ($resp.Headers.Location) { $resp.Headers.Location.ToString() } else { '' }
        if ($loc -match '/file/([0-9a-fA-F-]{36})/') { Send-Json $res 200 ('{"mediaId":"' + $Matches[1] + '"}'); return }
        Send-Json $res 502 ('{"error":"No media id in Jira response (HTTP ' + [int]$resp.StatusCode + ')"}'); return
    }

    $method = if ($payload.method) { [string]$payload.method } else { 'GET' }
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($method), $url)
    if ($null -ne $payload.body) {
        $json = $payload.body | ConvertTo-Json -Depth 100 -Compress
        $msg.Content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
    }
    $client = New-JiraClient $payload.jiraEmail $payload.jiraToken $true
    $resp = $client.SendAsync($msg).Result
    Send-Upstream $res $resp
}

while ($listener.IsListening) {
    $ctx = $null
    try { $ctx = $listener.GetContext() } catch { break }
    if (-not $ctx) { break }

    $req = $ctx.Request
    $res = $ctx.Response

    try {
        if ($req.Url.AbsolutePath.StartsWith('/api/jira')) {
            try { Invoke-LocalProxy $req $res }
            catch {
                $err = ($_.Exception.Message -replace '[\\"]', "'")
                try { Send-Json $res 502 ('{"error":"Local proxy failed: ' + $err + '"}') } catch {}
            }
            continue
        }

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
