# One-time setup so coworkers on the same Wi-Fi can open the "share" link of the review page.
# Windows will ask for administrator permission once.
#   - lets this user listen on port 5180 (netsh http urlacl)
#   - opens port 5180 in the firewall ONLY for devices on the same local network (remoteip=localsubnet)
# Undo: share-setup.ps1 -Remove
param(
  [int]$SharePort = 5180,
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Remove
)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SharePort $SharePort -User `"$User`""
  if ($Remove) { $argList += ' -Remove' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  exit
}

$rule = "VideoReview Share $SharePort"
netsh http delete urlacl url=http://+:$SharePort/ | Out-Null
netsh advfirewall firewall delete rule name="$rule" | Out-Null

if ($Remove) {
  Write-Host "Share setup removed."
} else {
  netsh http add urlacl url=http://+:$SharePort/ user="$User"
  netsh advfirewall firewall add rule name="$rule" dir=in action=allow protocol=TCP localport=$SharePort remoteip=localsubnet profile=any
  Write-Host ""
  Write-Host "Done. You can now use the share button on the review page." -ForegroundColor Green
}
Write-Host ""
Read-Host "Press Enter to close"
