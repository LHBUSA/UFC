# Read-only schema probe against the production project, printing the result.
#
#   pwsh scripts/db/probe.ps1 -File scripts/db/probes/news_pipeline_before.sql
#   pwsh scripts/db/probe.ps1 -Sql "select count(*) from public.ufc_news_items;"
#
# WHY THIS EXISTS ALONGSIDE apply_supabase_migration.ps1
#
# That script proves and applies migrations but discards the response body, which
# is the right shape for DDL and the wrong shape for the question "what does the
# schema look like right now?". Every migration in this repository was applied by
# executing SQL rather than through the CLI, so the applied set has to be PROBED
# rather than inferred from which files a branch happens to carry - a lesson
# already paid for once (see scripts/db/check_migration_ledger.mjs). A probe that
# prints nothing cannot answer that question.
#
# ALWAYS ROLLS BACK. The statement is wrapped in BEGIN ... ROLLBACK, so a probe
# that is accidentally a write is still not a write. This is a guard against
# operator error, not a security boundary: anyone holding the token can call the
# Management API directly.
#
# The token is the Supabase CLI's own stored access token (Windows Credential
# Manager entry "Supabase CLI:supabase"), read the same way the two sibling
# scripts read it, and never printed.
param(
  [string]$File,
  [string]$Sql,
  [int]$Depth = 8
)
$ErrorActionPreference = "Stop"
if (-not $File -and -not $Sql) { throw "give -File or -Sql" }

$sig = @'
using System; using System.Runtime.InteropServices;
public class CredManProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredManProbe').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredManProbe]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$ref = "tkmlnhmylqnttmnsnief"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if ($File) {
  $path = Join-Path $root $File
  if (-not (Test-Path $path)) { throw "missing: $path" }
  $Sql = Get-Content $path -Raw -Encoding UTF8
}

# Strip any transaction control the file carries so exactly one wrapper governs
# the run, then force the rollback wrapper on.
$body = ($Sql -split "`n" | Where-Object { $_ -notmatch '^\s*(begin|commit|rollback)\s*;\s*$' }) -join "`n"
$wrapped = "begin;`n$body`nrollback;"

$payload = @{ query = $wrapped } | ConvertTo-Json -Depth 3 -Compress
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload
} catch {
  $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
  Write-Host "PROBE FAILED"; Write-Host "  $msg"; throw "probe failed"
}
if ($null -eq $r) { "(empty result)" } else { $r | ConvertTo-Json -Depth $Depth }
