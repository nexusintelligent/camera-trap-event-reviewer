param(
    [string]$BasePython = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeBase = Join-Path $env:LOCALAPPDATA 'CameraTrapReviewer'
$embeddedRoot = Join-Path $runtimeBase 'Python311'
$embeddedPython = Join-Path $embeddedRoot 'python.exe'
$venvRoot = Join-Path $runtimeBase 'venv311'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$pipCache = Join-Path $runtimeBase 'pip-cache'
$modelCache = Join-Path $runtimeBase 'model-cache'
$detectorCache = Join-Path $projectRoot 'local-data\model-cache\megadetector'
$detectorModel = Join-Path $detectorCache 'md_v1000.0.0-redwood.pt'
$requirements = Join-Path $projectRoot 'ai\requirements-ai.txt'
$pythonZip = Join-Path $env:TEMP 'python-3.11.9-embed-amd64.zip'
$getPip = Join-Path $env:TEMP 'get-pip.py'

function Invoke-Checked {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Executable $($Arguments -join ' ')"
    }
}

function Download-File {
    param(
        [string]$Uri,
        [string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) { return }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
        return
    }
    catch {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if (-not $curl) { throw }
        Invoke-Checked $curl.Source @('-L', '--fail', '--retry', '2', '--output', $Destination, $Uri)
    }
}

function Resolve-BasePython {
    $candidates = @(
        $BasePython,
        $env:CAMTRAP_AI_BASE_PYTHON,
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $version = & $candidate -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
            if ($LASTEXITCODE -eq 0 -and $version -eq '3.11') { return $candidate }
        }
    }
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand -and $pythonCommand.Source -notlike '*WindowsApps*') {
        $version = & $pythonCommand.Source -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
        if ($LASTEXITCODE -eq 0 -and $version -eq '3.11') { return $pythonCommand.Source }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path $runtimeBase, $pipCache, $modelCache, $detectorCache | Out-Null
$resolvedPython = Resolve-BasePython

if ($resolvedPython) {
    Write-Host "Using Python: $resolvedPython"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Invoke-Checked $resolvedPython @('-m', 'venv', $venvRoot)
    }
    $runtimePython = $venvPython
}
else {
    Write-Host 'Python 3.11 was not found; installing the official embeddable runtime.'
    if (-not (Test-Path -LiteralPath $embeddedPython)) {
        Download-File 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip' $pythonZip
        New-Item -ItemType Directory -Force -Path $embeddedRoot | Out-Null
        Expand-Archive -LiteralPath $pythonZip -DestinationPath $embeddedRoot -Force
        $pth = Join-Path $embeddedRoot 'python311._pth'
        (Get-Content -LiteralPath $pth -Raw).Replace('#import site', 'import site') |
            Set-Content -LiteralPath $pth -Encoding Ascii
    }
    $runtimePython = $embeddedPython
    if (-not (Test-Path -LiteralPath (Join-Path $embeddedRoot 'Lib\site-packages\pip'))) {
        Download-File 'https://bootstrap.pypa.io/get-pip.py' $getPip
        Invoke-Checked $runtimePython @($getPip)
    }
}

$env:PIP_CACHE_DIR = $pipCache
Invoke-Checked $runtimePython @('-m', 'pip', 'install', '--upgrade', 'pip')
# The upstream packages currently declare incompatible protobuf patch ranges.
# The legacy resolver installs their tested runtime combination; imports and CLI are validated below.
Invoke-Checked $runtimePython @('-m', 'pip', 'install', '--use-deprecated=legacy-resolver', '--requirement', $requirements)
Invoke-Checked $runtimePython @('-c', "import megadetector, speciesnet; print('MegaDetector + SpeciesNet imports: PASS')")
$detectorUrl = 'https://github.com/agentmorris/MegaDetector/releases/download/v1000.0/md_v1000.0.0-redwood.pt'
if ((Test-Path -LiteralPath $detectorModel) -and (Get-Item -LiteralPath $detectorModel).Length -lt 50000000) {
    Remove-Item -LiteralPath $detectorModel -Force
}
Download-File $detectorUrl $detectorModel
if ((Get-Item -LiteralPath $detectorModel).Length -lt 50000000) {
    Remove-Item -LiteralPath $detectorModel -Force
    throw 'MegaDetector model download is incomplete. Run this installer again.'
}
$env:CAMTRAP_AI_DETECTOR_MODEL_FILE = $detectorModel
Invoke-Checked $runtimePython @('-c', "import os; from megadetector.detection.run_detector import load_detector; load_detector(os.environ['CAMTRAP_AI_DETECTOR_MODEL_FILE']); print('MegaDetector model: PASS')")
$helpOutput = & $runtimePython -m megadetector.detection.run_md_and_speciesnet --help
if ($LASTEXITCODE -ne 0) { throw 'MegaDetector + SpeciesNet CLI validation failed.' }
$helpOutput | Select-Object -First 12

Write-Host ''
Write-Host "PASS: AI runtime is ready at $runtimePython" -ForegroundColor Green
Write-Host "MegaDetector model cache: $detectorModel"
