$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $appRoot 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$reviewerUrl = "http://127.0.0.1:$($config.port)/"
$healthUrl = "http://127.0.0.1:$($config.port)/api/health"

try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) {
        Start-Process $reviewerUrl
        Write-Host "照片判讀軟體已在執行：$reviewerUrl" -ForegroundColor Green
        exit 0
    }
} catch {
    # Server is not running yet; continue with startup.
}

$bundledNode = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } elseif (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { $null }

if (-not $nodeExecutable) {
    Write-Host '找不到 Node.js，無法啟動照片判讀軟體。' -ForegroundColor Red
    Write-Host '請安裝 Node.js 20 以上版本，或從 Codex 工作環境啟動。'
    Read-Host '按 Enter 關閉'
    exit 1
}

$logFolder = Join-Path $appRoot 'logs'
New-Item -ItemType Directory -Force -Path $logFolder | Out-Null
$stdoutLog = Join-Path $logFolder 'server.stdout.log'
$stderrLog = Join-Path $logFolder 'server.stderr.log'
$serverScript = Join-Path $appRoot 'server.mjs'
$serverProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList @($serverScript) `
    -WorkingDirectory $appRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru

$serverProcess.Id | Set-Content -LiteralPath (Join-Path $appRoot 'server.pid') -Encoding ASCII

$started = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.ok) {
            $started = $true
            break
        }
    } catch {
        # Keep waiting for the local server.
    }
}

if (-not $started) {
    Write-Host '伺服器未能正常啟動。請查看 logs\server.stderr.log。' -ForegroundColor Red
    Read-Host '按 Enter 關閉'
    exit 1
}

Start-Process $reviewerUrl
Write-Host "照片判讀軟體已啟動：$reviewerUrl" -ForegroundColor Green
