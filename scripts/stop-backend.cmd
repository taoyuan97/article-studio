@echo off
rem Double-click entry: stop Article Studio backend (port 8000).
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%stop-backend.ps1"
echo.
pause
