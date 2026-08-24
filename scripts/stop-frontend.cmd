@echo off
rem Double-click entry: stop Article Studio frontend (port 5173).
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%stop-frontend.ps1"
echo.
pause
