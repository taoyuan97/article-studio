# 停止 Article Studio 后端服务（按端口 8000 定位进程并结束进程树）。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$Port = 8000

Write-Host "正在停止后端服务..." -ForegroundColor Cyan

if (-not (Test-PortInUse -Port $Port)) {
    Write-Host "后端未在运行（端口 ${Port} 无监听进程）。" -ForegroundColor Yellow
    exit 0
}

if (Stop-ProcessByPort -Port $Port) {
    Write-Host "后端已停止（端口 ${Port} 已释放）。" -ForegroundColor Green
    exit 0
} else {
    Write-Warning "停止后端失败：端口 ${Port} 仍被占用，可能需要管理员权限，或进程不属当前用户。"
    exit 1
}
