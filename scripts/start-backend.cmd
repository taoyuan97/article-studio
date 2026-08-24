@echo off
rem Double-click entry: start Article Studio backend (uvicorn, port 8000).
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-backend.ps1"
echo.
pause
