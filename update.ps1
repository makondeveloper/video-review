# Auto update: start.cmd runs this first. Downloads the latest version from GitHub if there is one.
# - No git or login needed (public repository).
# - Keeps this PC's own files (last-dir.txt, version.txt). Review files live next to the videos, not here.
# - Skipped on the developer's copy (a folder with .git) so local edits are never overwritten.
# - Any problem (no internet etc.) -> prints a note and the program starts with the current version.
param(
  [string]$Repo = 'makondeveloper/video-review',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VerFile = Join-Path $Root 'version.txt'
$Keep = @('last-dir.txt', 'version.txt')

if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
  Write-Host "  (developer copy: update skipped)"
  exit 0
}

$tmp = $null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = 'video-review-updater' }
  $latest = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $headers -TimeoutSec 8).sha
  $current = ''
  if (Test-Path -LiteralPath $VerFile) { $current = ([IO.File]::ReadAllText($VerFile)).Trim() }
  if ($latest -eq $current) {
    Write-Host "  Up to date ($($latest.Substring(0, 7)))"
    exit 0
  }

  Write-Host "  Updating to $($latest.Substring(0, 7)) ..."
  $tmp = Join-Path $env:TEMP ('video-review-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'
  Invoke-WebRequest -Uri "https://github.com/$Repo/archive/$latest.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 120 -Headers $headers
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x')
  $src = Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1

  $changed = 0
  foreach ($f in (Get-ChildItem -LiteralPath $src.FullName -Recurse -File)) {
    $rel = $f.FullName.Substring($src.FullName.Length + 1)
    if ($Keep -contains $rel) { continue }
    $dst = Join-Path $Root $rel
    # Only copy files that really changed (start.cmd is being run right now; rewriting it unchanged is harmless, but skip anyway).
    if (Test-Path -LiteralPath $dst) {
      if ((Get-FileHash -LiteralPath $dst).Hash -eq (Get-FileHash -LiteralPath $f.FullName).Hash) { continue }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
    Unblock-File -LiteralPath $dst
    $changed++
  }
  [IO.File]::WriteAllText($VerFile, $latest)
  Write-Host "  Updated: $changed file(s) changed." -ForegroundColor Green
} catch {
  Write-Host "  Update skipped ($($_.Exception.Message)). Starting the current version." -ForegroundColor Yellow
} finally {
  if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
exit 0
