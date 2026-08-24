@echo off
rem Double-click entry: stop Article Studio backend + frontend.
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%stop-all.ps1"
echo.
pause
