# Outer-process watchdog for the backfill queue.
#
# The queue is resilient to a worker dying: each window is its own Python
# process and every window is re-runnable, because an event whose bouts are
# all present and enriched is skipped without a fetch. The one thing it cannot
# survive is the outer PowerShell process going away - nothing then advances
# the sequence. That is the only failure this watchdog exists to repair.
#
# It does not supervise the worker, does not change concurrency, does not
# touch anything it did not start, and never raises the request rate. A tick
# where the queue is alive writes state and does nothing else.
#
#   powershell -File watchdog.ps1 [-IntervalSeconds 180]
param(
  [int]$IntervalSeconds = 180,
  [switch]$Once
)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path logs | Out-Null

$statusPath = 'logs\queue_status.txt'
$statePath  = 'logs\queue_state.json'
$lockPath   = 'logs\queue.lock'
$pidPath    = 'logs\queue.pid'
$logPath    = 'logs\watchdog.log'

function Write-Log([string]$m) {
  $line = "$(Get-Date -Format o) $m"
  $line | Add-Content $logPath
  Write-Output $line
}

# Reads the status log whichever way PowerShell happened to write it: a
# redirect produces UTF-16LE with a byte-order mark, Add-Content produces
# UTF-8. Guessing wrong yields an unreadable log and a watchdog that believes
# no window has ever completed, so all three shapes are handled explicitly.
function Read-Status {
  if (-not (Test-Path $statusPath)) { return @() }
  $bytes = [System.IO.File]::ReadAllBytes($statusPath)
  if ($bytes.Length -lt 2) { return @() }
  if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  } elseif ($bytes[1] -eq 0) {
    $text = [System.Text.Encoding]::Unicode.GetString($bytes)
  } else {
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  }
  return $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

function Get-Completed([string[]]$lines) {
  $done = New-Object System.Collections.Generic.HashSet[string]
  foreach ($l in $lines) {
    if ($l -match '^\[window_done\]\s+\S+\s+(\S+)\s+exit=(\S+)') {
      # A window counts as complete only when its worker exited cleanly. A
      # non-zero exit is left in the remaining set so a resume re-runs it;
      # re-running is cheap because finished events are skipped.
      if ($Matches[2] -eq '0') { [void]$done.Add($Matches[1]) }
    }
  }
  return $done
}

function Get-ActiveWindow([string[]]$lines) {
  $started = $null
  foreach ($l in $lines) { if ($l -match '^\[window_start\]\s+\S+\s+(\S+)') { $started = $Matches[1] } }
  return $started
}

# Any live worker for this backfill, whoever started it. Used to guarantee a
# resume never produces a second concurrent worker.
function Get-LiveWorkers {
  try {
    @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*backfill_ufcstats.py*' })
  } catch { @() }
}

# Runs once, when the sequence is genuinely finished. Guarded by a marker so
# a watchdog restart after completion does not repeat it.
function Invoke-Finalize {
  $marker = 'logs\finalize.done'
  if (Test-Path $marker) { Write-Log '[finalize_skip] already run'; return }
  if ($Once) { Write-Log '[finalize_skip] -Once mode, not running finalize'; return }
  Write-Log '[finalize_start]'
  & powershell -NoProfile -ExecutionPolicy Bypass -File finalize.ps1 *> logs\finalize.out
  "finalized $(Get-Date -Format o)" | Set-Content $marker
  Write-Log "[finalize_done] exit=$LASTEXITCODE log=logs\finalize.out"
}

function Test-ProcessAlive([int]$procId) {
  if (-not $procId) { return $false }
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

# Single-watchdog lock. A stale lock from a dead watchdog is reclaimed.
$myPid = $PID
if (Test-Path $lockPath) {
  $holder = 0
  [int]::TryParse((Get-Content $lockPath -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$holder) | Out-Null
  if ($holder -ne 0 -and $holder -ne $myPid -and (Test-ProcessAlive $holder)) {
    Write-Log "[watchdog_exit] another watchdog is already running (pid=$holder)"
    exit 0
  }
}
$myPid | Set-Content $lockPath
Write-Log "[watchdog_start] pid=$myPid interval=${IntervalSeconds}s"

$allWindows = (Get-Content windows.json -Raw | ConvertFrom-Json).windows
$resumes = 0

while ($true) {
  $lines = Read-Status
  $completed = Get-Completed $lines
  $active = Get-ActiveWindow $lines
  $lastDone = ($lines | Where-Object { $_ -match '^\[window_done\]' } | Select-Object -Last 1)
  $lastCompletedLabel = $null
  if ($lastDone -match '^\[window_done\]\s+\S+\s+(\S+)\s') { $lastCompletedLabel = $Matches[1] }

  $queuePid = 0
  if (Test-Path $pidPath) { [int]::TryParse((Get-Content $pidPath | Select-Object -First 1), [ref]$queuePid) | Out-Null }
  $queueAlive = Test-ProcessAlive $queuePid
  $workers = Get-LiveWorkers

  # Last real progress: the newest write to any window log, which advances
  # even mid-window, rather than only at window boundaries.
  $lastProgress = $null
  $newest = Get-ChildItem logs\*.out -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) { $lastProgress = $newest.LastWriteTime.ToUniversalTime().ToString('o') }

  $remaining = @($allWindows | Where-Object { -not $completed.Contains($_.label) })
  $finished = ($lines | Where-Object { $_ -match '^\[queue_end\]' }).Count -gt 0 -and $remaining.Count -eq 0

  [pscustomobject]@{
    checked_at            = (Get-Date).ToUniversalTime().ToString('o')
    watchdog_pid          = $myPid
    queue_pid             = $queuePid
    queue_alive           = $queueAlive
    live_workers          = @($workers | ForEach-Object { $_.ProcessId })
    active_window         = $active
    last_completed_window = $lastCompletedLabel
    completed_count       = $completed.Count
    total_windows         = $allWindows.Count
    remaining_windows     = @($remaining | ForEach-Object { $_.label })
    last_progress_at      = $lastProgress
    resumes               = $resumes
  } | ConvertTo-Json -Depth 4 | Set-Content $statePath

  if ($finished) {
    Write-Log "[watchdog_done] all $($allWindows.Count) windows complete"
    Invoke-Finalize
    break
  }
  if ($queueAlive) {
    if ($Once) { Write-Log "[tick] queue alive pid=$queuePid active=$active completed=$($completed.Count)/$($allWindows.Count)"; break }
  }
  elseif ($workers.Count -gt 0) {
    # Outer process gone but a worker is still finishing. Starting anything
    # now would double the request rate, so wait for it to drain.
    Write-Log "[watchdog_wait] outer queue dead, worker still running (pid=$($workers[0].ProcessId)); not resuming"
    if ($Once) { break }
  }
  elseif ($remaining.Count -eq 0) {
    Write-Log "[watchdog_done] no windows remaining"
    Invoke-Finalize
    break
  }
  else {
    $resumes += 1
    $labels = @($remaining | ForEach-Object { $_.label })
    Write-Log "[watchdog_resume] queue pid=$queuePid dead; resuming at $($labels[0]) with $($labels.Count) window(s) remaining (resume #$resumes)"
    $p = Start-Process powershell `
      -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run_backfill_windows.ps1', '-Labels') + ($labels -join ',')) `
      -RedirectStandardOutput logs\queue.out -RedirectStandardError logs\queue.err -WindowStyle Hidden -PassThru
    $p.Id | Set-Content $pidPath
    Write-Log "[watchdog_resumed] new queue pid=$($p.Id)"
    if ($Once) { break }
  }

  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSeconds
}

Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
Write-Log "[watchdog_stop] pid=$myPid"
