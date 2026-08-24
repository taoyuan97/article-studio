@echo off
rem Double-click entry: start Article Studio backend + frontend.
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-all.ps1"
echo.
pause
