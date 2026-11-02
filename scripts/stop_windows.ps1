<#
.SYNOPSIS
  Stop and remove the FinAlly container (Windows PowerShell). Safe to run repeatedly.
  The "finally-data" volume is NOT removed, so portfolio data persists.
#>
$ErrorActionPreference = 'Continue'

$Container = 'finally'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Error: docker is not installed or not on PATH.' -ForegroundColor Red
    exit 1
}

& docker container inspect $Container *> $null
if ($LASTEXITCODE -eq 0) {
    & docker rm -f $Container *> $null
    Write-Host "FinAlly stopped. Data is kept in the 'finally-data' volume." -ForegroundColor Green
} else {
    Write-Host 'FinAlly is not running.'
}
