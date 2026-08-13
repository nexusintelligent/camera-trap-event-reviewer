$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $appRoot 'server.pid'

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host '找不到執行中的照片判讀服務。'
    exit 0
}

$serverProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
$serverProcess = Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue
if ($serverProcess -and $serverProcess.ProcessName -in @('node', 'nodejs')) {
    Stop-Process -Id $serverProcessId
    Write-Host "已停止照片判讀服務（PID $serverProcessId）。" -ForegroundColor Green
} elseif ($serverProcess) {
    Write-Host "PID $serverProcessId 不是 Node.js；為安全起見未停止該程序。" -ForegroundColor Yellow
} else {
    Write-Host '照片判讀服務已經停止。'
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
