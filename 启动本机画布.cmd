@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-canvas.ps1" -EdgeProfile "Default"
if errorlevel 1 pause
