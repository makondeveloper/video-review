@echo off
rem Double-click to start. You can also drag a video folder onto this file.
rem 1) Get the latest version from GitHub (skipped if offline), 2) start the server.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
