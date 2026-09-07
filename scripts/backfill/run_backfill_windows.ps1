# Runs a named subset of backfill windows.
#
# This exists so the watchdog can resume a dead queue without touching
# run_backfill_queue.ps1, which may be mid-flight. It reads the canonical
# sequence from windows.json and runs only the labels it is given, in that
# file's order, appending the same [window_start] / [window_done] lines to
# logs/queue_status.txt that the original runner writes. Resume state is
# therefore derived from one log format, not two.
#
# Concurrency is unchanged: one window at a time, one worker at a time. The
# caller is responsible for having proved that no other queue is alive.
#
#   powershell -File run_backfill_windows.ps1 -Labels B-2016,B-2015
param(
  [Parameter(Mandatory = $true)][string[]]$Labels
)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path logs | Out-Null
$status = 'logs\queue_status.txt'

$all = (Get-Content windows.json -Raw | ConvertFrom-Json).windows
$run = @($all | Where-Object { $Labels -contains $_.label })
if ($run.Count -eq 0) { "[resume_noop] $(Get-Date -Format o) no matching windows" | Add-Content $status; exit 0 }

"[resume_start] $(Get-Date -Format o) windows=$($run.Count) first=$($run[0].label)" | Add-Content $status
foreach ($w in $run) {
  $out = "logs\$($w.label).out"
  "[window_start] $(Get-Date -Format o) $($w.label) $($w.since)..$($w.until)" | Add-Content $status
  & python backfill_ufcstats.py --phase fights --since $w.since --until $w.until *> $out
  $code = $LASTEXITCODE
  $end = (Select-String -Path $out -Pattern '^\[end\]' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line
  "[window_done] $(Get-Date -Format o) $($w.label) exit=$code $end" | Add-Content $status
}
"[queue_end] $(Get-Date -Format o)" | Add-Content $status
