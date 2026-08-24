# Article Studio 启动/停止脚本共享函数。
# 本文件由同目录下的其他 PowerShell 脚本 dot-source 引入（参考 MVP 原型 scripts/common.ps1）。

$ErrorActionPreference = "Stop"

$script:ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$script:BackendDir = Join-Path $script:ProjectRoot "backend"
$script:FrontendDir = Join-Path $script:ProjectRoot "frontend"

function Test-CommandAvailable {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-PortInUse {
    param([int]$Port)

    try {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @("0.0.0.0", "127.0.0.1", "::", "::1") } |
            Select-Object -First 1
        return $null -ne $connection
    } catch {
        # 回退：Get-NetTCPConnection 不可用时解析 netstat 输出（兼容 IPv4/IPv6）
        $output = netstat -ano 2>$null | Out-String
        $pattern = "\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):${Port}\s+\S+\s+LISTENING\s+(\d+)"
        return $output -match $pattern
    }
}

function Get-ProcessByPort {
    param([int]$Port)

    try {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @("0.0.0.0", "127.0.0.1", "::", "::1") } |
            Select-Object -First 1
        if ($connection) {
            return Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        }
    } catch {
        $output = netstat -ano 2>$null | Out-String
        $pattern = "\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):${Port}\s+\S+\s+LISTENING\s+(\d+)"
        if ($output -match $pattern) {
            $procId = [int]$Matches[1]
            return Get-Process -Id $procId -ErrorAction SilentlyContinue
        }
    }
    return $null
}

function Stop-ProcessByPort {
    param([int]$Port)

    $process = Get-ProcessByPort -Port $Port
    if ($null -eq $process) {
        return $false
    }

    Write-StatusLine -Label "结束进程" -Value "PID $($process.Id)（$($process.ProcessName)）" -Color Yellow
    # /T 结束整个进程树（pnpm/cmd → node 等父子链），/F 强制结束
    $null = & taskkill /PID $process.Id /T /F 2>&1

    # 等待端口释放（最多 10 秒）
    $deadline = (Get-Date).AddSeconds(10)
    while ((Test-PortInUse -Port $Port) -and ((Get-Date) -lt $deadline)) {
        Start-Sleep -Milliseconds 200
    }
    return -not (Test-PortInUse -Port $Port)
}

function Start-ServiceWindow {
    param(
        [string]$Command,
        [string]$WorkingDirectory
    )

    # 用 EncodedCommand 传递命令体，避免引号转义与代码页问题（UTF-16 编码，中文提示不受影响）
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $arguments = @(
        "-NoExit"
        "-ExecutionPolicy", "Bypass"
        "-EncodedCommand", $encoded
    )

    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -PassThru
    return $process
}

function Wait-ForPort {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 15,
        [int]$IntervalMilliseconds = 500
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortInUse -Port $Port) { return $true }
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    return $false
}

function Write-StatusLine {
    param([string]$Label, [string]$Value, [string]$Color = "White")
    Write-Host "${Label}: " -NoNewline -ForegroundColor Gray
    Write-Host $Value -ForegroundColor $Color
}

function Get-PnpmInvocation {
    # 返回调用 pnpm 的命令字符串：优先 PATH 中的 pnpm，其次 corepack pnpm（Node 自带）；
    # 均不可用返回 $null（由调用方报错并给出安装指引）。
    if (Test-CommandAvailable -Name "pnpm") {
        return "pnpm"
    }
    if (Test-CommandAvailable -Name "corepack") {
        return "corepack pnpm"
    }
    return $null
}
