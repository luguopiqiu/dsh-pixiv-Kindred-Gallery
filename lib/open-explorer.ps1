# Open a folder (or reveal a file) in Explorer, in the foreground.
# Pure ASCII on purpose: PowerShell 5.1 reads BOM-less non-ASCII as ANSI.
# explorer.exe launched through ShellExecute with a QUOTED /select,<path> is the only
# variant that both selects the file and comes to the front - Node spawn() mangles
# the inner quotes, and a reused COM window stays behind DSH.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Select
)

$item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
if (-not $item) { Write-Output "missing"; exit 0 }
$full = $item.FullName
$isFile = -not $item.PSIsContainer

if ($isFile) {
  Start-Process -FilePath explorer.exe -ArgumentList ('/select,"' + $full + '"')
} else {
  Start-Process -FilePath explorer.exe -ArgumentList ('"' + $full + '"')
}
Write-Output ("ok " + (Split-Path -Leaf $full))
exit 0
