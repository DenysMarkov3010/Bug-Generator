@echo off
REM ===========================================================================
REM Bug Report Agent - one-click launcher (target of the desktop shortcut)
REM
REM What this does:
REM   1. Checks if http://localhost:8765 is already up.
REM      Yes -> just opens the browser on it and exits.
REM      No  -> starts serve.ps1 in a separate MINIMIZED window so it
REM             keeps running after this batch exits, then opens the
REM             browser once the port is reachable.
REM
REM Why: opening index.html from file:// makes Chrome/Edge re-prompt for
REM microphone permission on every reload (a hard browser policy). Opening
REM the same page via http://localhost makes the browser persist Allow
REM forever - exactly what the user wants.
REM
REM ASCII-only on purpose - non-ASCII characters in comments break CMD on
REM locales where the console codepage is not UTF-8 (CP866 / CP1251 / etc.)
REM and the entire batch silently fails before reaching the launch line.
REM ===========================================================================

title Bug Report Agent

set "PORT=8765"
set "URL=http://localhost:%PORT%/index.html"

REM Probe the port - quick TcpClient ping, no PowerShell start-up storm.
powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% EQU 0 (
    start "" "%URL%"
    exit /b 0
)

REM Server not running - launch serve.ps1 in a separate minimized window.
REM The /MIN flag tucks it into the taskbar; user can click it later to stop.
start "Bug Report Agent Server" /MIN powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0serve.ps1"

REM Wait for the server to bind, up to ~5s, polling every 250ms.
set /a TRIES=0
:WAIT
powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% EQU 0 goto OPEN
set /a TRIES+=1
if %TRIES% GEQ 20 goto FAIL
REM ping -n is the standard "sleep" hack on Windows.
REM -w 250 -> roughly 250ms timeout regardless of network.
ping -n 1 -w 250 127.0.0.1 >nul
goto WAIT

:OPEN
start "" "%URL%"
exit /b 0

:FAIL
echo.
echo  ERROR: server did not start within 5 seconds.
echo  Run serve.bat manually to see the underlying error.
echo.
pause
exit /b 1
