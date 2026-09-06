$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$WorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $WorkerDir "..\..")).Path
$EnvFile = Join-Path $RepoRoot ".env"
$WorkerUrl = "https://ufc-api.propbetedge.ai"

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not (Test-Path $Path)) { return $null }
    foreach ($Line in Get-Content -Path $Path -Encoding UTF8) {
        if ($Line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
            $Value = $Matches[1].Trim()
            if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or
                ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
                $Value = $Value.Substring(1, $Value.Length - 2)
            }
            return $Value
        }
    }
    return $null
}

function Invoke-ProofWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$Attempts = 12,
        [int]$DelaySeconds = 5
    )

    $LastError = $null
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ Accept = "application/json" }
        }
        catch {
            $LastError = $_
            if ($i -lt $Attempts) {
                Write-Host ("Proof attempt {0}/{1} not ready yet; retrying in {2}s..." -f $i, $Attempts, $DelaySeconds) -ForegroundColor Yellow
                Start-Sleep -Seconds $DelaySeconds
            }
        }
    }
    throw $LastError
}

$ServiceKey = $env:SUPABASE_SERVICE_ROLE_KEY
if ([string]::IsNullOrWhiteSpace($ServiceKey)) {
    $ServiceKey = Get-DotEnvValue -Path $EnvFile -Name "SUPABASE_SERVICE_ROLE_KEY"
}
if ([string]::IsNullOrWhiteSpace($ServiceKey)) {
    throw "SUPABASE_SERVICE_ROLE_KEY is not available in the process environment or repo-root .env."
}

Push-Location $WorkerDir
try {
    Write-Host "===== UFC API: INSTALL =====" -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Host "===== UFC API: UNIT TESTS =====" -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test failed" }

    Write-Host "===== UFC API: SYNTAX CHECK =====" -ForegroundColor Cyan
    npm run check
    if ($LASTEXITCODE -ne 0) { throw "npm run check failed" }

    Write-Host "===== UFC API: SET SERVICE-ROLE SECRET =====" -ForegroundColor Cyan
    $ServiceKey | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
    if ($LASTEXITCODE -ne 0) { throw "wrangler secret put failed" }

    Write-Host "===== UFC API: DEPLOY CUSTOM DOMAIN =====" -ForegroundColor Cyan
    npx wrangler deploy
    if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed" }

    Write-Host "===== UFC API: LIVE PROOF =====" -ForegroundColor Cyan
    Write-Host "Production API origin: $WorkerUrl" -ForegroundColor DarkGray

    $Health = Invoke-ProofWithRetry -Uri "$WorkerUrl/health"
    if (-not $Health.ok -or $Health.data.status -ne "ok" -or -not $Health.data.database_configured) {
        throw "Health proof failed: API or database is not healthy."
    }

    $Counts = Invoke-ProofWithRetry -Uri "$WorkerUrl/v1/ufc/counts"
    if (-not $Counts.ok) { throw "Counts proof failed." }
    if ([int]$Counts.data.events -lt 1 -or [int]$Counts.data.fighters -lt 1) {
        throw "Counts proof returned an unexpectedly empty UFC dataset."
    }

    Write-Host ""
    Write-Host "UFC API DEPLOYMENT: PASS" -ForegroundColor Green
    Write-Host "URL: $WorkerUrl" -ForegroundColor Green
    Write-Host ("Fighters: {0} | Events: {1} | Bouts: {2} | Results: {3} | Round rows: {4}" -f `
        $Counts.data.fighters, $Counts.data.events, $Counts.data.bouts, $Counts.data.results, $Counts.data.round_stat_rows) -ForegroundColor Green
}
finally {
    $ServiceKey = $null
    Pop-Location
}
