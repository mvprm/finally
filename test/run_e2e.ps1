<#
.SYNOPSIS
  Build the app image, run the Playwright E2E suite against it, then tear everything down.
  Exit code is the Playwright exit code. Report: test\playwright-report\index.html
#>
$ErrorActionPreference = 'Continue'

Set-Location (Split-Path -Parent $PSScriptRoot)
$compose = @('compose', '-f', 'test/docker-compose.test.yml')

& docker @compose down -v --remove-orphans *> $null
& docker @compose up --build --abort-on-container-exit --exit-code-from playwright
$status = $LASTEXITCODE
if ($status -ne 0) {
    Write-Host "E2E failed (exit $status). App logs:" -ForegroundColor Red
    & docker @compose logs --no-color --tail 200 finally
}
& docker @compose down -v --remove-orphans *> $null
exit $status
