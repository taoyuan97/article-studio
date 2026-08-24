# 一键停止 Article Studio 前后端服务（先停止前端，再停止后端）。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

Write-Host "正在停止 Article Studio 全部服务..." -ForegroundColor Cyan
Write-Host ""

$frontendScript = Join-Path $PSScriptRoot "stop-frontend.ps1"
& $frontendScript

Start-Sleep -Seconds 1

$backendScript = Join-Path $PSScriptRoot "stop-backend.ps1"
& $backendScript

Write-Host ""
Write-Host "全部服务已停止。" -ForegroundColor Green
