@echo off
title Bug Report Agent - Installer
echo.
echo  Installing Bug Report Agent shortcut on Desktop...
echo.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0install.ps1"
echo.
pause
