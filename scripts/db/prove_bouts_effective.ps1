# Rule proof for migrations/031_ufc_bouts_effective.sql through the Supabase Management API.
# Sends BEGIN; <migration body>; <supabase/migrations/tests/20260918120000_ufc_bouts_effective.test.sql>; ROLLBACK;
# Nothing is committed: the fixture rows and (if not yet applied) the view itself are rolled back.
#   pwsh scripts/db/prove_bouts_effective.ps1
$ErrorActionPreference = "Stop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredManBE {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredManBE').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredManBE]::Read("Supabase CLI:supabase"); if (-not $tok) { throw "Supabase CLI token not found" }; $tok = $tok.Trim([char]0)
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$mig = Get-Content (Join-Path $root "migrations/031_ufc_bouts_effective.sql") -Raw -Encoding UTF8
$mig = ($mig -replace '(?im)^\s*begin;\s*$', '' -replace '(?im)^\s*commit;\s*$', '')
$test = Get-Content (Join-Path $root "supabase/migrations/tests/20260918120000_ufc_bouts_effective.test.sql") -Raw -Encoding UTF8
$payload = @{ query = "BEGIN;`n$mig`n$test`n;ROLLBACK;" } | ConvertTo-Json -Depth 3 -Compress
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/tkmlnhmylqnttmnsnief/database/query" -Headers @{ Authorization = "Bearer $tok" } -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
  $r | ConvertTo-Json -Compress
} catch { $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }; "FAILED -> $msg"; exit 1 }
