# Run a read-only or maintenance SQL statement through the Supabase Management
# API, using the Supabase CLI's own stored access token (Windows Credential
# Manager entry "Supabase CLI:supabase"). The token is never printed.
#
# Exists because PostgREST caches the schema: after DDL, a new table 404s until
# the cache is reloaded, which looks identical to the migration having failed.
#
#   pwsh scripts/db/run_sql.ps1 -Query "select 1"
#   pwsh scripts/db/run_sql.ps1 -ReloadSchema
param([string]$Query = "", [switch]$ReloadSchema)
$ErrorActionPreference = "Stop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredMan2 {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'CredMan2').Type) { Add-Type -TypeDefinition $sig }
$tok = [CredMan2]::Read("Supabase CLI:supabase")
if (-not $tok) { throw "Supabase CLI token not found" }
$ref = "tkmlnhmylqnttmnsnief"

if ($ReloadSchema) { $Query = "notify pgrst, 'reload schema';" }
if (-not $Query) { throw "Pass -Query or -ReloadSchema" }

$payload = @{ query = $Query } | ConvertTo-Json -Depth 3 -Compress
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } -Body $payload
  if ($null -eq $r) { "(empty result)" } else { $r | ConvertTo-Json -Depth 4 }
} catch {
  $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
  "FAILED -> $msg"
}
