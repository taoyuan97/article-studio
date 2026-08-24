# 启动 Article Studio 后端服务（FastAPI + uvicorn，端口 8000）。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$Port = 8000
$Title = "ArticleStudio-Backend"

Write-Host "正在启动后端服务..." -ForegroundColor Cyan
Write-StatusLine -Label "后端目录" -Value $script:BackendDir -Color Yellow
Write-StatusLine -Label "目标端口" -Value $Port -Color Yellow

if (Test-PortInUse -Port $Port) {
    Write-Host "后端已在端口 ${Port} 运行，无需重复启动。" -ForegroundColor Green
    exit 0
}

if (-not (Test-CommandAvailable -Name "uv")) {
    Write-Host "未找到 'uv' 命令。请先安装 uv（https://docs.astral.sh/uv/）并加入 PATH。" -ForegroundColor Red
    exit 1
}

# 首次运行：虚拟环境不存在时先同步依赖（同步执行，便于看到进度与报错）
if (-not (Test-Path (Join-Path $script:BackendDir ".venv"))) {
    Write-Host "检测到 backend\.venv 不存在，先执行 uv sync 安装依赖..." -ForegroundColor Yellow
    Push-Location $script:BackendDir
    try {
        uv sync
        if ($LASTEXITCODE -ne 0) {
            Write-Host "uv sync 失败（退出码 $LASTEXITCODE），请检查网络或 pyproject.toml。" -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host "依赖安装完成。" -ForegroundColor Green
}

$command = @"
`$host.ui.RawUI.WindowTitle = '${Title}'
Write-Host '后端启动中: http://127.0.0.1:${Port}' -ForegroundColor Cyan
Write-Host '关闭本窗口或运行 stop-backend.cmd 即可停止后端。' -ForegroundColor Gray
Write-Host ''
uv run uvicorn app.main:app --host 127.0.0.1 --port ${Port} --log-level info
`$code = `$LASTEXITCODE
Write-Host ''
Write-Host "后端已退出（退出码 `$(`$code)）。" -ForegroundColor Yellow
`$null = Read-Host '按 Enter 关闭本窗口'
"@

try {
    $process = Start-ServiceWindow -WorkingDirectory $script:BackendDir -Command $command
    Write-Host "等待后端监听端口 ${Port}..." -ForegroundColor Gray
    if (Wait-ForPort -Port $Port -TimeoutSeconds 30) {
        Write-Host "后端启动成功。" -ForegroundColor Green
        Write-StatusLine -Label "进程 ID" -Value $process.Id -Color Green
        Write-StatusLine -Label "服务地址" -Value "http://127.0.0.1:${Port}（API 文档 /docs）" -Color Green
        exit 0
    } else {
        Write-Warning "后端进程已启动，但端口 ${Port} 在 30 秒内未进入监听状态，请检查后端窗口中的错误信息。"
        exit 0
    }
} catch {
    Write-Host "启动后端失败: $_" -ForegroundColor Red
    exit 1
}
