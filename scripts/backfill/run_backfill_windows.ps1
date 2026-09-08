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

# The worker imports the normalizers.py beside it, and the copies on this
# machine differ. Checking before a window starts turns "died six windows in on
# a label that is fixed elsewhere" into "did not start, and here is why".
$checker = Join-Path $PSScriptRoot 'check_normalizer.py'
if (Test-Path $checker) {
  & python $checker $PSScriptRoot
  if ($LASTEXITCODE -ne 0) {
    "[preflight_fail] $(Get-Date -Format o) normaliser beside this script is missing required capabilities" | Add-Content $status
    Write-Output "[queue] refusing to start: see the normaliser check above."
    exit 4
  }
} else {
  "[preflight_skip] $(Get-Date -Format o) check_normalizer.py not present" | Add-Content $status
}

# Normalise the labels before matching. Invoked as "powershell -File this.ps1
# -Labels A,B,C" every argument arrives as a literal string, so the list lands
# as the single element "A,B,C" rather than three elements, and every match
# then fails silently. Splitting here makes the script behave the same however
# it is called.
$Labels = @($Labels | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

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
