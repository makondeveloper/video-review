@echo off
rem One-time setup for the share (same Wi-Fi) feature. Windows asks for admin permission.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0share-setup.ps1"
