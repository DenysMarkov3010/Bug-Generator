# Bug Report Agent - Desktop shortcut installer (Windows)
#
# 1. Generates favicon.ico in this folder (same lime-bug design as favicon.svg)
# 2. Creates "Bug Report Agent.lnk" on the user's Desktop that:
#    - opens index.html in a new browser tab (Chrome / Edge if installed,
#      otherwise the system default browser)
#    - uses the generated favicon.ico as the shortcut icon
#
# Usage: just double-click install.bat in the project folder.

$ErrorActionPreference = 'Stop'

# --- icon generator -------------------------------------------------------
# Draws the same shape as favicon.svg (lime rounded square + dark bug with
# antennae, legs, spots) using System.Drawing, then wraps the resulting PNG
# in an .ico container.
function New-BugFavicon {
    param(
        [Parameter(Mandatory)][string]$OutPath,
        [int]$Size = 256
    )

    Add-Type -AssemblyName System.Drawing -ErrorAction Stop

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $accent      = [System.Drawing.Color]::FromArgb(212, 255, 71)  # #d4ff47
    $ink         = [System.Drawing.Color]::FromArgb(17, 24, 0)     # #111800
    $accentBrush = New-Object System.Drawing.SolidBrush $accent
    $inkBrush    = New-Object System.Drawing.SolidBrush $ink

    $scale = $Size / 64.0

    # Rounded square background (radius = 11 in 64-unit space).
    $r = 11.0 * $scale
    $d = $r * 2
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bgPath.AddArc(0,            0,            $d, $d, 180, 90)
    $bgPath.AddArc($Size - $d,   0,            $d, $d, 270, 90)
    $bgPath.AddArc($Size - $d,   $Size - $d,   $d, $d, 0,   90)
    $bgPath.AddArc(0,            $Size - $d,   $d, $d, 90,  90)
    $bgPath.CloseFigure()
    $g.FillPath($accentBrush, $bgPath)

    # Ink pen for outlines (antennae + legs).
    $inkPen = New-Object System.Drawing.Pen $ink, ([single](2.5 * $scale))
    $inkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $inkPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

    # Antennae - SVG had Q-curves; converted to cubic Bezier (C1, C2):
    #   For Q P0 -> P2 with control Q1:
    #     C1 = P0 + 2/3 (Q1 - P0)
    #     C2 = P2 + 2/3 (Q1 - P2)
    $g.DrawBezier($inkPen,
        [single](27*$scale),    [single](13*$scale),
        [single](24.333*$scale),[single](9.667*$scale),
        [single](22.0*$scale),  [single](7.333*$scale),
        [single](20*$scale),    [single](6*$scale))
    $g.DrawBezier($inkPen,
        [single](37*$scale),    [single](13*$scale),
        [single](39.667*$scale),[single](9.667*$scale),
        [single](42.0*$scale),  [single](7.333*$scale),
        [single](44*$scale),    [single](6*$scale))

    # Six legs.
    $legs = @(
        @(21, 29, 11, 25),
        @(20, 38, 10, 38),
        @(21, 47, 11, 51),
        @(43, 29, 53, 25),
        @(44, 38, 54, 38),
        @(43, 47, 53, 51)
    )
    foreach ($l in $legs) {
        $g.DrawLine($inkPen,
            [single]($l[0]*$scale), [single]($l[1]*$scale),
            [single]($l[2]*$scale), [single]($l[3]*$scale))
    }

    # Head - filled circle cx=32, cy=17, r=6, bounding box (26, 11, 12, 12).
    $g.FillEllipse($inkBrush,
        [single]((32-6)*$scale), [single]((17-6)*$scale),
        [single](12*$scale),     [single](12*$scale))

    # Body - filled ellipse cx=32, cy=38, rx=12, ry=15.
    $g.FillEllipse($inkBrush,
        [single]((32-12)*$scale), [single]((38-15)*$scale),
        [single](24*$scale),      [single](30*$scale))

    # Accent center line on body.
    $accentPen = New-Object System.Drawing.Pen $accent, ([single](1.6 * $scale))
    $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $accentPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($accentPen,
        [single](32*$scale), [single](24*$scale),
        [single](32*$scale), [single](51*$scale))

    # Four lime spots (r=1.8).
    $spots = @(@(27,32), @(37,35), @(28,44), @(37,46))
    $spotD = [single](3.6 * $scale)
    foreach ($s in $spots) {
        $g.FillEllipse($accentBrush,
            [single](($s[0]-1.8)*$scale), [single](($s[1]-1.8)*$scale),
            $spotD, $spotD)
    }

    # Save as PNG into memory.
    $pngStream = New-Object System.IO.MemoryStream
    $bmp.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngStream.ToArray()

    # Wrap the PNG inside an ICO container (Windows Vista+ supports PNG-in-ICO).
    $widthByte  = if ($Size -ge 256) { 0 } else { [byte]$Size }
    $heightByte = if ($Size -ge 256) { 0 } else { [byte]$Size }

    $fs     = [System.IO.File]::Create($OutPath)
    $writer = New-Object System.IO.BinaryWriter $fs

    # ICONDIR (6 bytes).
    $writer.Write([UInt16]0)   # reserved
    $writer.Write([UInt16]1)   # type = icon
    $writer.Write([UInt16]1)   # image count

    # ICONDIRENTRY (16 bytes).
    $writer.Write([byte]$widthByte)
    $writer.Write([byte]$heightByte)
    $writer.Write([byte]0)     # palette colors
    $writer.Write([byte]0)     # reserved
    $writer.Write([UInt16]1)   # color planes
    $writer.Write([UInt16]32)  # bits per pixel
    $writer.Write([UInt32]$pngBytes.Length)
    $writer.Write([UInt32]22)  # data offset = 6 + 16

    # PNG image data.
    $writer.Write($pngBytes)

    $writer.Close(); $fs.Close(); $pngStream.Close()
    $g.Dispose(); $bmp.Dispose()
    $accentBrush.Dispose(); $inkBrush.Dispose()
    $inkPen.Dispose(); $accentPen.Dispose()
}

# --- main -----------------------------------------------------------------
try {
    $WshShell     = New-Object -ComObject WScript.Shell
    $Desktop      = [System.Environment]::GetFolderPath('Desktop')
    $ShortcutPath = Join-Path $Desktop 'Bug Report Agent.lnk'
    $IndexPath    = Join-Path $PSScriptRoot 'index.html'
    $ServeBat     = Join-Path $PSScriptRoot 'serve.bat'
    $IconPath     = Join-Path $PSScriptRoot 'favicon.ico'

    if (-not (Test-Path $IndexPath)) {
        Write-Host "ERROR: index.html not found at $IndexPath" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $ServeBat)) {
        Write-Host "ERROR: serve.bat not found at $ServeBat" -ForegroundColor Red
        exit 1
    }

    # Generate the bug-logo .ico.
    $iconOk = $false
    try {
        New-BugFavicon -OutPath $IconPath -Size 256
        $iconOk = $true
        Write-Host "  Generated icon  : $IconPath" -ForegroundColor Cyan
    } catch {
        Write-Host "  Icon generation failed: $_" -ForegroundColor Yellow
    }

    # The shortcut launches serve.bat via cmd.exe /c. Pointing a .lnk
    # TargetPath directly at a .bat file is fragile on Windows when the
    # path contains spaces (e.g. "...\Bug Generator\serve.bat") - Explorer
    # sometimes misresolves it and silently falls back to opening "This PC".
    # Wrapping the call in `cmd.exe /c "<path>"` is the standard, reliable
    # pattern: cmd handles the quoting and any space-in-path nonsense for us.
    #
    # WindowStyle = 1 (Normal) so behaviour matches a manual double-click on
    # serve.bat: a visible server window with live logs, plus serve.ps1
    # auto-opens the browser tab on http://localhost:8765/index.html.
    $CmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'

    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath        = $CmdExe
    $Shortcut.Arguments         = "/c `"$ServeBat`""
    $Shortcut.WorkingDirectory  = $PSScriptRoot
    $Shortcut.Description       = 'Bug Report Agent - launches serve.bat, opens http://localhost:8765/'
    $Shortcut.WindowStyle       = 1   # Normal window

    if ($iconOk -and (Test-Path $IconPath)) {
        $Shortcut.IconLocation = "$IconPath,0"
    }

    $Shortcut.Save()

    Write-Host "  Target          : $CmdExe /c `"$ServeBat`"" -ForegroundColor Cyan
    Write-Host "  Opens           : http://localhost:8765/index.html" -ForegroundColor Cyan

    Write-Host ""
    Write-Host "  Shortcut created: $ShortcutPath" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    exit 1
}
