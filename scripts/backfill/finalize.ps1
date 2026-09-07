# Post-queue steps, in dependency order.
#
# Each step exists because the backfill invalidates something upstream of it:
#
#   1. referee profile sync - the referee directory is a view over bout
#      results LEFT JOINed to a profiles table that was seeded once at
#      migration time. Every referee the backfill introduces would otherwise
#      render with a null slug, i.e. a broken profile link.
#   2. Hall of Fame resolver - inductees whose canonical fighter row only
#      exists once their era is loaded. It links; it never creates a fighter
#      to satisfy a link.
#   3. preservation guard - proves the additive work removed nothing.
#   4. coverage audits + report - the two numbers, the canaries, the HOF
#      before/after.
#
# Safe to re-run. Nothing here writes fight data.
#
#   powershell -File finalize.ps1 [-SkipPreservation]
param([switch]$SkipPreservation)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$out = Join-Path $PSScriptRoot 'logs\finalize.log'
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null

function Step([string]$name, [scriptblock]$body) {
  $banner = "`n########## $name ##########"
  Write-Output $banner; $banner | Add-Content $out
  $r = & $body 2>&1 | Out-String
  Write-Output $r; $r | Add-Content $out
}

"===== finalize $(Get-Date -Format o) =====" | Add-Content $out

Step 'referee profile sync' { node (Join-Path $repo 'scripts\referees\sync-profiles.mjs') --report }
Step 'hall of fame resolver' { node (Join-Path $repo 'scripts\hof\resolve-fighters.mjs') }

if (-not $SkipPreservation) {
  Step 'preservation guard' { Push-Location (Join-Path $repo 'web'); node scripts\preservation-check.mjs; Pop-Location }
}

Step 'structural audit' { node (Join-Path $repo 'scripts\backfill\structural_audit.mjs') --from 1994 --to 2026 }
Step 'round-stat coverage audit' { node (Join-Path $repo 'scripts\backfill\coverage_audit.mjs') }
Step 'per-window progress' { node (Join-Path $repo 'scripts\backfill\window_summary.mjs') --json (Join-Path $PSScriptRoot 'logs\windows_summary.json') }
Step 'final report' { node (Join-Path $repo 'scripts\backfill\report.mjs') --json (Join-Path $PSScriptRoot 'logs\final_report.json') }

"finalize complete -> $out"
