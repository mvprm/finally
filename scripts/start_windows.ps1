<#
.SYNOPSIS
  Start FinAlly in Docker (Windows PowerShell). Safe to run repeatedly.

.EXAMPLE
  .\scripts\start_windows.ps1            # build the image if missing, start the container
  .\scripts\start_windows.ps1 -Build     # rebuild the image and recreate the container
  .\scripts\start_windows.ps1 -NoOpen    # don't open the browser

  The SQLite database lives in the named volume "finally-data" and survives restarts.
  If script execution is blocked, run:
  powershell -ExecutionPolicy Bypass -File .\scripts\start_windows.ps1
#>
param(
    [switch]$Build,
    [switch]$NoOpen,
    # Also accept the mac-style spellings --build / --no-open
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
foreach ($arg in $Rest) {
    switch ($arg) {
        '--build'   { $Build = [switch]$true }
        '--no-open' { $NoOpen = [switch]$true }
        default     { Write-Host "Unknown option: $arg (use -Build / -NoOpen)" -ForegroundColor Red; exit 2 }
    }
}

# Native docker commands write progress to stderr; don't let that abort the script.
$ErrorActionPreference = 'Continue'

$Image = 'finally'
$Container = 'finally'
$Volume = 'finally-data'
$Port = if ($env:FINALLY_PORT) { $env:FINALLY_PORT } else { '8000' }
$Url = "http://localhost:$Port"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Test-DockerCommand {
    # Runs a docker command silently; returns $true when it exits with code 0.
    & docker @args *> $null
    return ($LASTEXITCODE -eq 0)
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Error: docker is not installed or not on PATH.' -ForegroundColor Red
    exit 1
}
if (-not (Test-DockerCommand info)) {
    Write-Host 'Error: the Docker daemon is not running. Start Docker Desktop and try again.' -ForegroundColor Red
    exit 1
}

# .env is optional for the app but required by --env-file: create it from the template.
if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example.'
}
$envText = Get-Content '.env' -Raw
if (($envText -match '(?m)^OPENROUTER_API_KEY=(your-openrouter-api-key-here)?\s*$') -and
    ($envText -notmatch '(?mi)^LLM_MOCK=true')) {
    Write-Host 'Warning: OPENROUTER_API_KEY is not set in .env, so AI chat will reply with an error message.' -ForegroundColor Yellow
    Write-Host '         Set it in .env (or LLM_MOCK=true for mock replies) and run this script again.' -ForegroundColor Yellow
}

if ($Build -or -not (Test-DockerCommand image inspect $Image)) {
    Write-Host "Building image '$Image'..."
    & docker build -t $Image .
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Error: docker build failed.' -ForegroundColor Red
        exit 1
    }
}

if (Test-DockerCommand container inspect $Container) {
    $running = (& docker container inspect -f '{{.State.Running}}' $Container).Trim()
    if ($running -eq 'true' -and -not $Build) {
        Write-Host "FinAlly is already running at $Url" -ForegroundColor Green
        exit 0
    }
    Write-Host "Replacing existing container '$Container'..."
    & docker rm -f $Container *> $null
}

& docker run -d `
    --name $Container `
    -v "${Volume}:/app/db" `
    -p "${Port}:8000" `
    --env-file .env `
    --restart unless-stopped `
    $Image | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Error: docker run failed.' -ForegroundColor Red
    exit 1
}

Write-Host -NoNewline 'Waiting for FinAlly to become healthy'
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 1
}
Write-Host ''

if ($healthy) {
    Write-Host "FinAlly is running at $Url" -ForegroundColor Green
    if (-not $NoOpen) { Start-Process $Url }
} else {
    Write-Host "Warning: no healthy response from $Url/api/health after 60 s." -ForegroundColor Yellow
    Write-Host "         Check the logs with: docker logs $Container" -ForegroundColor Yellow
}
