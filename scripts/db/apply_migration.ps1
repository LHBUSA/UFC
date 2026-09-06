# Apply a numbered migration through the Supabase Management API using the
# Supabase CLI's own stored access token (Windows Credential Manager entry
# "Supabase CLI:supabase"; never printed). No DB password is needed.
#
#   pwsh scripts/db/apply_migration.ps1 -Mode proof -Files 004   # BEGIN ... ROLLBACK: schema proof, no side effects
#   pwsh scripts/db/apply_migration.ps1 -Mode apply -Files 004   # BEGIN ... COMMIT
#
# -Files takes the numeric prefixes of files in /migrations (e.g. "002,003,004").
# Each file's own begin/commit lines are stripped; one transaction per file.
param([string]$Mode = "proof", [string]$Files = "004")
$ErrorActionPreference = "Stop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredMan').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredMan]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$ref = "tkmlnhmylqnttmnsnief"
$dir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "migrations"
$map = @{}
Get-ChildItem $dir -Filter "*.sql" | ForEach-Object { $map[$_.Name.Substring(0,3)] = $_.Name }
foreach ($k in $Files.Split(",")) {
  $path = Join-Path $dir $map[$k]
  $sql = Get-Content $path -Raw -Encoding UTF8
  # strip the file's own transaction wrapper; we control the transaction here
  $body = ($sql -replace '(?im)^\s*begin;\s*$', '' -replace '(?im)^\s*commit;\s*$', '')
  if ($Mode -eq "proof") { $q = "BEGIN;`n$body`nROLLBACK;" } else { $q = "BEGIN;`n$body`nCOMMIT;" }
  $payload = @{ query = $q } | ConvertTo-Json -Depth 3 -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload
    $s = if ($null -eq $r) { "(empty result)" } else { ($r | ConvertTo-Json -Compress -Depth 2) }; if ($s.Length -gt 120) { $s = $s.Substring(0,120) }; "$k $Mode OK ($($map[$k])) -> $s"
  } catch {
    $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
    "$k $Mode FAILED ($($map[$k])) -> $msg"
    if ($Mode -eq "apply") { break }
  }
}
