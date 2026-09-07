# Sequential backfill queue.
#
# One window at a time on purpose: two concurrent jobs double the request rate
# against the Internet Archive, and the whole queue is worthless if it gets
# rate-limited. Windows are re-runnable - an event whose bouts are all present
# and enriched is skipped without a fetch - so a failed window costs only the
# work it had not finished, and the queue continues past it.
#
# Lane A first (round-stat depth for years that already have bouts), then
# Lane B (structural breadth for 1994-2016, which have events but no bouts).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path logs | Out-Null
$status = 'logs\queue_status.txt'

$windows = @(
  @{ label = 'A-2025'; since = '2025-01-01'; until = '2025-12-31' },
  @{ label = 'A-2024'; since = '2024-01-01'; until = '2024-12-31' },
  @{ label = 'A-2023'; since = '2023-01-01'; until = '2023-12-31' },
  @{ label = 'A-2022'; since = '2022-01-01'; until = '2022-12-31' },
  @{ label = 'A-2021'; since = '2021-01-01'; until = '2021-12-31' },
  @{ label = 'A-2020'; since = '2020-01-01'; until = '2020-12-31' },
  @{ label = 'A-2019'; since = '2019-01-01'; until = '2019-12-31' },
  @{ label = 'A-2018'; since = '2018-01-01'; until = '2018-12-31' },
  @{ label = 'A-2017'; since = '2017-01-01'; until = '2017-12-31' }
)
foreach ($y in 2016..1994) {
  $windows += @{ label = "B-$y"; since = "$y-01-01"; until = "$y-12-31" }
}

"[queue_start] $(Get-Date -Format o) windows=$($windows.Count)" | Add-Content $status
foreach ($w in $windows) {
  $out = "logs\$($w.label).out"
  "[window_start] $(Get-Date -Format o) $($w.label) $($w.since)..$($w.until)" | Add-Content $status
  & python backfill_ufcstats.py --phase fights --since $w.since --until $w.until *> $out
  $code = $LASTEXITCODE
  $end = (Select-String -Path $out -Pattern '^\[end\]' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line
  "[window_done] $(Get-Date -Format o) $($w.label) exit=$code $end" | Add-Content $status
}
"[queue_end] $(Get-Date -Format o)" | Add-Content $status
