@echo off
rem Double-click entry: start Article Studio frontend (Vite dev server, port 5173).
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-frontend.ps1"
echo.
pause
