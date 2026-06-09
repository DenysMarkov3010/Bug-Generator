@echo off
REM === Bug Report Agent - serve.bat (foreground HTTP server window) ===
REM Foreground launcher for serve.ps1: stays open, you see all server logs
REM in this window, close it to stop the server. For a one-click experience
REM that runs the server in the background and just opens the browser, use
REM start.bat instead (created by install.bat as the desktop shortcut).
REM
REM ASCII-only on purpose - em-dashes / fancy quotes break CMD on locales
REM where the console codepage is not UTF-8 (CP866 / CP1251 / etc.).

chcp 65001 >nul 2>&1
title Bug Report Agent - Local Server

echo.
echo   Starting Bug Report Agent on http://localhost:8765/
echo   (Mic permission persists across reloads on this URL, unlike file://)
echo.

REM Run the PowerShell server. -ExecutionPolicy Bypass lets it run even on
REM machines where ps1 scripts are otherwise restricted; -NoProfile keeps
REM startup snappy and avoids surprises from user $PROFILE customizations.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0serve.ps1"
set EXITCODE=%errorlevel%

echo.
if %EXITCODE% NEQ 0 (
    echo   Server exited with code %EXITCODE%.
    echo.
    echo   Most common causes:
    echo     - Port 8765 is already in use (another serve.bat / start.bat running).
    echo       Fix: close the other window, then run this again.
    echo     - PowerShell was blocked by Group Policy.
    echo       Fix: run from an admin PowerShell once:
    echo            Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
    echo     - serve.ps1 file is missing or moved.
    echo       Fix: keep serve.bat and serve.ps1 in the same folder.
) else (
    echo   Server stopped cleanly.
)
echo.
pause
