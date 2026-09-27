param([string]$Suite = "034")
# Prove migration 033 on the production engine with zero side effects:
#   BEGIN; <033 body>; <033 behavioural tests>; -- the tests always raise
# The final RAISE aborts the transaction, so nothing can commit whether the
# tests pass ('ALLPASS n') or fail ('FAIL ...').
#
#   pwsh scripts/db/prove_034.ps1              # 033 behaviour
#   pwsh scripts/db/prove_034.ps1 -Suite 032   # 032 suite still passes on top of 033 (regression)
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredMan034 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredMan034').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredMan034]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$mig = Get-Content (Join-Path $root "migrations/034_ufc_training_reported_moves.sql") -Raw -Encoding UTF8
$mig = $mig -replace '(?im)^\s*begin;\s*$', '' -replace '(?im)^\s*commit;\s*$', ''
$testFile = switch ($Suite) { "032" { "migrations/tests/032_ufc_training_corner.test.sql" } "033" { "migrations/tests/033_ufc_training_camp_merge.test.sql" } default { "migrations/tests/034_ufc_training_reported_moves.test.sql" } }
$tests = Get-Content (Join-Path $root $testFile) -Raw -Encoding UTF8
$q = "BEGIN;`n$mig`n$tests`nROLLBACK;"
$payload = @{ query = $q } | ConvertTo-Json -Depth 3 -Compress
try {
  Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/tkmlnhmylqnttmnsnief/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload | Out-Null
  "UNEXPECTED: the test block did not raise"
} catch {
  $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
  if ($msg -match 'ALLPASS (\d+)') { "034 proof: ALL PASS ($($Matches[1]) checks); transaction rolled back" } else { "034 proof FAILED: $msg" }
}
