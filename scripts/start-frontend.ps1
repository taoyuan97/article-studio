# 启动 Article Studio 前端开发服务器（Vite，端口 5173）。
# /api 与 /static 请求经 Vite proxy 转发到 127.0.0.1:8000，需后端已运行。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$Port = 5173
$Title = "ArticleStudio-Frontend"

Write-Host "正在启动前端服务..." -ForegroundColor Cyan
Write-StatusLine -Label "前端目录" -Value $script:FrontendDir -Color Yellow
Write-StatusLine -Label "目标端口" -Value $Port -Color Yellow

if (Test-PortInUse -Port $Port) {
    Write-Host "前端已在端口 ${Port} 运行，无需重复启动。" -ForegroundColor Green
    exit 0
}

$pnpm = Get-PnpmInvocation
if ($null -eq $pnpm) {
    Write-Host "未找到 'pnpm' 或 'corepack' 命令。请安装 Node.js 20.19+（自带 corepack）并启用 pnpm，参考根 README「开发工作流」。" -ForegroundColor Red
    exit 1
}
Write-StatusLine -Label "pnpm 调用方式" -Value $pnpm -Color Yellow

# 首次运行：node_modules 不存在时先安装依赖（同步执行，便于看到进度与报错）
if (-not (Test-Path (Join-Path $script:FrontendDir "node_modules"))) {
    Write-Host "检测到 frontend\node_modules 不存在，先安装依赖（首次可能需要几分钟）..." -ForegroundColor Yellow
    Push-Location $script:FrontendDir
    try {
        if ($pnpm -eq "pnpm") {
            pnpm install
        } else {
            $env:COREPACK_HOME = Join-Path $script:ProjectRoot ".corepack"
            corepack pnpm install
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "依赖安装失败（退出码 $LASTEXITCODE），请检查网络或 package.json。" -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host "依赖安装完成。" -ForegroundColor Green
}

# 服务窗口内的启动命令；corepack 路径需设置 COREPACK_HOME（与根 README 约定一致）
$devCommand = if ($pnpm -eq "pnpm") {
    "pnpm dev"
} else {
    "`$env:COREPACK_HOME = Join-Path '$($script:ProjectRoot)' '.corepack'; corepack pnpm dev"
}

$command = @"
`$host.ui.RawUI.WindowTitle = '${Title}'
Write-Host '前端启动中: http://localhost:${Port}' -ForegroundColor Cyan
Write-Host '关闭本窗口或运行 stop-frontend.cmd 即可停止前端。' -ForegroundColor Gray
Write-Host ''
${devCommand}
`$code = `$LASTEXITCODE
Write-Host ''
Write-Host "前端已退出（退出码 `$(`$code)）。" -ForegroundColor Yellow
`$null = Read-Host '按 Enter 关闭本窗口'
"@

try {
    $process = Start-ServiceWindow -WorkingDirectory $script:FrontendDir -Command $command
    Write-Host "等待前端监听端口 ${Port}..." -ForegroundColor Gray
    if (Wait-ForPort -Port $Port -TimeoutSeconds 30) {
        Write-Host "前端启动成功。" -ForegroundColor Green
        Write-StatusLine -Label "进程 ID" -Value $process.Id -Color Green
        Write-StatusLine -Label "访问地址" -Value "http://localhost:${Port}" -Color Green
        if (-not (Test-PortInUse -Port 8000)) {
            Write-Warning "后端（8000）未运行，页面 /api 请求会失败；请先运行 start-backend.cmd。"
        }
        exit 0
    } else {
        Write-Warning "前端进程已启动，但端口 ${Port} 在 30 秒内未进入监听状态，请检查前端窗口中的错误信息。"
        exit 0
    }
} catch {
    Write-Host "启动前端失败: $_" -ForegroundColor Red
    exit 1
}
