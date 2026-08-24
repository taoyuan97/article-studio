# 一键启动 Article Studio 前后端服务（先启动后端，再启动前端；前端 proxy 依赖后端）。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

Write-Host "正在启动 Article Studio 全部服务..." -ForegroundColor Cyan
Write-Host ""

$backendScript = Join-Path $PSScriptRoot "start-backend.ps1"
& $backendScript
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Start-Sleep -Seconds 2

$frontendScript = Join-Path $PSScriptRoot "start-frontend.ps1"
& $frontendScript
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "全部服务已启动。" -ForegroundColor Green
Write-StatusLine -Label "后端" -Value "http://127.0.0.1:8000（API 文档 /docs）" -Color Green
Write-StatusLine -Label "前端" -Value "http://localhost:5173" -Color Green
