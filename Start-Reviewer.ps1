param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeBase = Join-Path $env:LOCALAPPDATA 'CameraTrapReviewer'
$portableNode = Join-Path $runtimeBase 'node\node.exe'
$configPath = Join-Path $appRoot 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$reviewerUrl = "http://127.0.0.1:$($config.port)/"
$healthUrl = "http://127.0.0.1:$($config.port)/api/health"

function Test-ReviewerHealth {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return [bool]($health.ok -and $health.deploymentId -eq $config.deploymentId)
    }
    catch {
        return $false
    }
}

if (Test-ReviewerHealth) {
    if (-not $NoBrowser) {
        Start-Process $reviewerUrl
    }
    Write-Host "照片判讀軟體已在執行：$reviewerUrl" -ForegroundColor Green
    exit 0
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExecutable = if (Test-Path -LiteralPath $portableNode) { $portableNode } elseif ($nodeCommand) { $nodeCommand.Source } else { $null }

if (-not $nodeExecutable) {
    Write-Host '找不到 Node.js，無法啟動照片判讀軟體。' -ForegroundColor Red
    Write-Host '請先雙擊「安裝照片辨識軟體.cmd」；安裝程式會自動準備 Node.js 與 AI。'
    Read-Host '按 Enter 關閉'
    exit 1
}

$nodeVersion = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)') {
    Write-Host "Node.js 版本不符合需求：$nodeVersion" -ForegroundColor Red
    Write-Host '請重新執行「安裝照片辨識軟體.cmd」。'
    Read-Host '按 Enter 關閉'
    exit 1
}
$nodeMajorVersion = [int]$Matches[1]
if ($nodeMajorVersion -lt 20) {
    Write-Host "Node.js 版本不符合需求：$nodeVersion" -ForegroundColor Red
    Write-Host '請重新執行「安裝照片辨識軟體.cmd」。'
    Read-Host '按 Enter 關閉'
    exit 1
}

$logFolder = Join-Path $appRoot 'logs'
New-Item -ItemType Directory -Force -Path $logFolder | Out-Null
$stdoutLog = Join-Path $logFolder 'server.stdout.log'
$stderrLog = Join-Path $logFolder 'server.stderr.log'
$serverScript = Join-Path $appRoot 'server.mjs'
$quotedServerScript = '"' + $serverScript + '"'
$serverProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList @('--', $quotedServerScript) `
    -WorkingDirectory $appRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru

$serverProcess.Id | Set-Content -LiteralPath (Join-Path $appRoot 'server.pid') -Encoding ASCII

$started = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-ReviewerHealth) {
        $started = $true
        break
    }
    if ($serverProcess.HasExited) {
        break
    }
}

if (-not $started) {
    Write-Host '伺服器未能正常啟動。' -ForegroundColor Red
    if ($serverProcess.HasExited) {
        Write-Host "Node.js 程序已結束，代碼：$($serverProcess.ExitCode)" -ForegroundColor Yellow
    }
    if ((Test-Path -LiteralPath $stderrLog) -and (Get-Item -LiteralPath $stderrLog).Length -gt 0) {
        Write-Host ''
        Write-Host '錯誤紀錄：' -ForegroundColor Yellow
        Get-Content -LiteralPath $stderrLog -Tail 30 | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    }
    else {
        Write-Host '錯誤紀錄為空白；請確認防毒軟體未封鎖 node.exe，然後重新執行安裝程式。' -ForegroundColor Yellow
    }
    Read-Host '按 Enter 關閉'
    exit 1
}

if (-not $NoBrowser) {
    Start-Process $reviewerUrl
}
Write-Host "照片判讀軟體已啟動：$reviewerUrl" -ForegroundColor Green
