# Apply (or proof) a migration from supabase/migrations by PATH.
#
#   pwsh scripts/db/apply_supabase_migration.ps1 -Mode proof -Paths "supabase/migrations/20260908000011_ufc_fighter_status.sql"
#   pwsh scripts/db/apply_supabase_migration.ps1 -Mode apply -Paths "a.sql,b.sql"
#
# WHY THIS EXISTS ALONGSIDE apply_migration.ps1
#
# The older script addresses files in the root migrations/ directory by their
# three-digit prefix. Four of the pending migrations exist only under
# supabase/migrations (fighter status, judges, weigh-ins, referee view
# security), so there is no prefix to name them by.
#
# WHY NOT `supabase db push`
#
# The database's own ledger, supabase_migrations.schema_migrations, uses
# timestamps that do not correspond to any filename in this repository:
# production records ufc_phase1_core as 20260905230410 while the repo file is
# 20260906000001_ufc_phase1_core.sql. Every migration here was applied by
# executing SQL, not by the CLI. A `db push` would therefore consider all
# seventeen repo migrations unapplied and re-run the lot. This script keeps to
# the mechanism the schema was actually built with.
#
# Mode proof wraps the body in BEGIN ... ROLLBACK, so the statements are parsed,
# planned and executed against the real schema and then discarded. It is the
# closest thing to a dry run a database offers, and it catches a dependency on
# a column that does not exist where a file-level review cannot.
# -Chain runs every listed file inside ONE transaction. Migrations have real
# ordering dependencies - weigh-ins adds a column to the status table, store
# orders references store provisioning - and proofing them one transaction each
# rolls the dependency away before the dependent runs. A chained proof is the
# only way to prove the SEQUENCE applies, which is what will actually happen.
param([string]$Mode = "proof", [Parameter(Mandatory=$true)][string]$Paths, [switch]$Chain)
$ErrorActionPreference = "Stop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredManSb {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredManSb').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredManSb]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$ref = "tkmlnhmylqnttmnsnief"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if ($Chain) {
  $bodies = @()
  foreach ($rel in $Paths.Split(",")) {
    $path = Join-Path $root $rel.Trim()
    if (-not (Test-Path $path)) { throw "missing: $path" }
    $sql = Get-Content $path -Raw -Encoding UTF8
    $bodies += ($sql -split "`n" | Where-Object { $_ -notmatch '^\s*(begin|commit)\s*;\s*$' }) -join "`n"
  }
  $joined = $bodies -join "`n`n"
  $wrapped = if ($Mode -eq "apply") { "begin;`n$joined`ncommit;" } else { "begin;`n$joined`nrollback;" }
  $payload = @{ query = $wrapped } | ConvertTo-Json -Depth 3 -Compress
  Write-Host ("{0,-8} CHAIN of {1} file(s)" -f $Mode.ToUpper(), $Paths.Split(",").Count) -NoNewline
  try {
    $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload
    Write-Host "  OK"
  } catch {
    $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
    Write-Host "  FAILED"; Write-Host "   $msg"; throw "chain $Mode failed"
  }
  Write-Host "`n$Mode complete (chained)."
  return
}

foreach ($rel in $Paths.Split(",")) {
  $path = Join-Path $root $rel.Trim()
  if (-not (Test-Path $path)) { throw "missing: $path" }
  $sql = Get-Content $path -Raw -Encoding UTF8

  # Strip the file's own transaction control so exactly one wrapper governs the
  # run. A nested commit inside a proof would defeat the rollback.
  $body = ($sql -split "`n" | Where-Object { $_ -notmatch '^\s*(begin|commit)\s*;\s*$' }) -join "`n"
  $wrapped = if ($Mode -eq "apply") { "begin;`n$body`ncommit;" } else { "begin;`n$body`nrollback;" }

  $payload = @{ query = $wrapped } | ConvertTo-Json -Depth 3 -Compress
  Write-Host ("{0,-8} {1}" -f $Mode.ToUpper(), (Split-Path $path -Leaf)) -NoNewline
  try {
    $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload
    Write-Host "  OK"
  } catch {
    $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
    Write-Host "  FAILED"
    Write-Host "   $msg"
    throw "stopped at $rel"
  }
}
Write-Host "`n$Mode complete for all listed migrations."
