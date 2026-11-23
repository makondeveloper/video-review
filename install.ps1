# One-line install on a new PC (paste into PowerShell):
#   irm https://raw.githubusercontent.com/makondeveloper/video-review/main/install.ps1 | iex
# Puts the program in Documents\video-review, makes a desktop shortcut, and starts it.
# Running it again is safe (it just updates and starts).

$ErrorActionPreference = 'Stop'
$Repo = 'makondeveloper/video-review'
$Dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'video-review'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'video-review-installer' }

if (-not (Test-Path -LiteralPath (Join-Path $Dest 'start.cmd'))) {
  Write-Host "Installing to $Dest ..."
  $tmp = Join-Path $env:TEMP ('video-review-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $sha = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/main" -Headers $headers -TimeoutSec 15).sha
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest -Uri "https://github.com/$Repo/archive/$sha.zip" -OutFile $zip -UseBasicParsing -Headers $headers
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x')
    $src = Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Copy-Item -Path (Join-Path $src.FullName '*') -Destination $Dest -Recurse -Force
    Get-ChildItem -LiteralPath $Dest -Recurse -File | Unblock-File
    [IO.File]::WriteAllText((Join-Path $Dest 'version.txt'), $sha)
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
} else {
  Write-Host "Already installed in $Dest (start.cmd updates it automatically)."
}

# Desktop shortcut named in Korean ("video review"), built from char codes to keep this file ASCII.
$name = -join ([char[]](0xC601, 0xC0C1, 0x20, 0xAC80, 0xC218))
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($name + '.lnk')
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $Dest 'start.cmd'
$sc.WorkingDirectory = $Dest
$sc.Save()
Write-Host "Desktop shortcut: $lnk" -ForegroundColor Green

Start-Process -FilePath (Join-Path $Dest 'start.cmd') -WorkingDirectory $Dest
