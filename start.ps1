# Local video review server (localhost only).
# Usage: powershell -ExecutionPolicy Bypass -File start.ps1 [-Dir "C:\videos"] [-Port 5178] [-NoBrowser]
# Review notes are saved next to each video as "<video file>.review.json".
param(
  [string]$Dir = "",
  [int]$Port = 5178,
  [switch]$NoBrowser,
  # Test only: "localhost" shares to this PC alone (no admin setup needed). Normal: "+" (all addresses).
  [string]$ShareHost = '+'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = [IO.Path]::GetFullPath((Join-Path $Root 'public'))
$LastDirFile = Join-Path $Root 'last-dir.txt'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$VideoExt = @('.mp4', '.m4v', '.mov', '.webm', '.mkv')
$ChunkMax = [int64](4 * 1024 * 1024)
# "Share" mode: coworkers on the same Wi-Fi open http://<this PC>:<SharePort>/?k=<token> (watch + mark the shared video).
# Off by default; the host turns it on/off from the page. Needs share-setup.ps1 run once (admin).
$SharePort = $Port + 2
$script:ShareToken = $null
$script:ShareVideo = $null   # the one video the share link shows
$script:Viewers = @{}        # guest page id -> last time it checked in (every 3s)

function Get-ViewerCount {
  $cut = (Get-Date).AddSeconds(-8)
  foreach ($k in @($script:Viewers.Keys)) { if ($script:Viewers[$k] -lt $cut) { $script:Viewers.Remove($k) } }
  return $script:Viewers.Count
}

if (-not $Dir -and (Test-Path -LiteralPath $LastDirFile)) {
  $Dir = ([IO.File]::ReadAllText($LastDirFile, $Utf8)).Trim()
}
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir -PathType Container)) {
  $Dir = [Environment]::GetFolderPath('MyVideos')
}
$script:VideoDir = (Resolve-Path -LiteralPath $Dir).Path
[IO.File]::WriteAllText($LastDirFile, $script:VideoDir, $Utf8)

$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

function Get-QueryParam($req, [string]$key) {
  $raw = $req.RawUrl
  $i = $raw.IndexOf('?')
  if ($i -lt 0) { return $null }
  foreach ($pair in $raw.Substring($i + 1).Split('&')) {
    $kv = $pair.Split('=', 2)
    if ($kv.Count -eq 2 -and $kv[0] -eq $key) {
      return [Uri]::UnescapeDataString($kv[1].Replace('+', ' '))
    }
  }
  return $null
}

function Resolve-Video([string]$name) {
  if (-not $name) { return $null }
  if ([IO.Path]::GetFileName($name) -ne $name) { return $null }
  $p = Join-Path $script:VideoDir $name
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  return $p
}

function Write-Bytes($res, [byte[]]$bytes, [string]$type, [int]$code = 200) {
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Write-Text($res, [string]$text, [string]$type = 'text/plain; charset=utf-8', [int]$code = 200) {
  Write-Bytes $res ($Utf8.GetBytes($text)) $type $code
}

function Write-Json($res, $obj, [int]$code = 200) {
  Write-Text $res (ConvertTo-Json -InputObject $obj -Depth 8 -Compress) 'application/json; charset=utf-8' $code
}

function Read-Body($req) {
  $sr = New-Object System.IO.StreamReader($req.InputStream, $Utf8)
  try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}

function Get-State {
  $items = @()
  $files = @(Get-ChildItem -LiteralPath $script:VideoDir -File |
      Where-Object { $VideoExt -contains $_.Extension.ToLower() } |
      Sort-Object Name)
  foreach ($f in $files) {
    $rv = $f.FullName + '.review.json'
    $status = 'new'
    $count = 0
    if (Test-Path -LiteralPath $rv) {
      try {
        $j = [IO.File]::ReadAllText($rv, $Utf8) | ConvertFrom-Json
        $status = [string]$j.status
        if ($j.markers) { $count = @($j.markers).Count }
      } catch { $status = 'broken' }
    }
    $items += , ([ordered]@{ name = $f.Name; size = $f.Length; status = $status; markers = $count })
  }
  return [ordered]@{ dir = $script:VideoDir; videos = $items }
}

function Send-Video($req, $res, [string]$path) {
  $ext = [IO.Path]::GetExtension($path).ToLower()
  $type = 'video/mp4'
  if ($ext -eq '.webm' -or $ext -eq '.mkv') { $type = 'video/webm' }
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $len = [int64]$fs.Length
    $start = [int64]0
    $end = $len - 1
    $range = $req.Headers['Range']
    if ($range -and $range -match '^bytes=(\d*)-(\d*)') {
      if ($Matches[1] -ne '') {
        $start = [int64]$Matches[1]
        if ($Matches[2] -ne '') { $end = [int64]$Matches[2] }
      } elseif ($Matches[2] -ne '') {
        $start = [Math]::Max([int64]0, $len - [int64]$Matches[2])
      }
    }
    if ($start -ge $len) {
      $res.StatusCode = 416
      $res.AddHeader('Content-Range', "bytes */$len")
      return
    }
    # Always answer with a capped partial chunk so one request never blocks the server for long.
    $end = [Math]::Min($end, [Math]::Min($start + $ChunkMax - 1, $len - 1))
    $count = $end - $start + 1
    $res.StatusCode = 206
    $res.ContentType = $type
    $res.AddHeader('Accept-Ranges', 'bytes')
    $res.AddHeader('Content-Range', "bytes $start-$end/$len")
    $res.ContentLength64 = $count
    if ($req.HttpMethod -eq 'HEAD') { return }
    [void]$fs.Seek($start, 'Begin')
    $buf = New-Object byte[] 1048576
    $left = $count
    while ($left -gt 0) {
      $n = $fs.Read($buf, 0, [int][Math]::Min([int64]$buf.Length, $left))
      if ($n -le 0) { break }
      $res.OutputStream.Write($buf, 0, $n)
      $left -= $n
    }
  } finally { $fs.Dispose() }
}

function Send-Static($req, $res) {
  $rel = $req.Url.AbsolutePath.TrimStart('/')
  if (-not $rel) { $rel = 'index.html' }
  $full = [IO.Path]::GetFullPath((Join-Path $Public $rel))
  if (-not $full.StartsWith($Public, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    Write-Text $res 'not found' 'text/plain; charset=utf-8' 404
    return
  }
  $ext = [IO.Path]::GetExtension($full).ToLower()
  $type = $Mime[$ext]
  if (-not $type) { $type = 'application/octet-stream' }
  $res.AddHeader('Cache-Control', 'no-store')
  Write-Bytes $res ([IO.File]::ReadAllBytes($full)) $type
}

function Test-Mutation($req) {
  # A custom header forces a CORS preflight, so other websites cannot write here.
  return ($req.Headers['X-Review'] -eq '1')
}

# Windows "Open" dialog on this PC (host only). The server waits while it is open.
function Show-VideoPicker([string]$startDir) {
  Add-Type -AssemblyName System.Windows.Forms
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = 'Video review - open a video'
  $dlg.Filter = 'Video (*.mp4;*.m4v;*.mov;*.webm;*.mkv)|*.mp4;*.m4v;*.mov;*.webm;*.mkv|All files (*.*)|*.*'
  if ($startDir -and (Test-Path -LiteralPath $startDir -PathType Container)) { $dlg.InitialDirectory = $startDir }
  try {
    if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.FileName }
    return $null
  } finally { $dlg.Dispose(); $owner.Dispose() }
}

function Get-LanIp {
  try {
    $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($cfg) { return @($cfg.IPv4Address)[0].IPAddress }
  } catch { }
  return $null
}

function Get-ShareInfo {
  $url = $null
  if ($script:ShareToken) {
    $hostName = Get-LanIp
    if ($ShareHost -ne '+' -or -not $hostName) { $hostName = 'localhost' }
    $url = "http://${hostName}:$SharePort/?k=$($script:ShareToken)"
  }
  return [ordered]@{ sharing = [bool]$script:ShareToken; url = $url; video = $script:ShareVideo; viewers = (Get-ViewerCount) }
}

function Set-Share([bool]$on, [string]$video) {
  $prefix = "http://${ShareHost}:$SharePort/"
  if ($on) {
    $script:ShareVideo = $video
    if ($script:ShareToken) { return $true }
    try { $listener.Prefixes.Add($prefix) } catch {
      try { [void]$listener.Prefixes.Remove($prefix) } catch { }
      return $false
    }
    $script:ShareToken = -join ((48..57) + (97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
    Write-Host "  Sharing ON: $((Get-ShareInfo).url)" -ForegroundColor Green
  } else {
    if ($script:ShareToken) { try { [void]$listener.Prefixes.Remove($prefix) } catch { } }
    $script:ShareToken = $null
    $script:ShareVideo = $null
    $script:Viewers = @{}
    Write-Host "  Sharing OFF"
  }
  return $true
}

# Guests come in on the share port. They need the token (from ?k= once, then a cookie).
# They can read the shared video and save its markers; nothing else.
function Test-Guest($req, $res) {
  $path = $req.Url.AbsolutePath
  $deny = {
    param($code)
    if ($path.StartsWith('/api/') -or $path -eq '/video') { Write-Json $res ([ordered]@{ error = 'share closed' }) $code }
    else { Write-Bytes $res ([IO.File]::ReadAllBytes((Join-Path $Public 'closed.html'))) 'text/html; charset=utf-8' $code }
  }
  if (-not $script:ShareToken) { & $deny 403; return $false }
  $k = Get-QueryParam $req 'k'
  $c = $req.Cookies['vrk']
  if ($k -eq $script:ShareToken) {
    $res.AppendHeader('Set-Cookie', "vrk=$k; Path=/; SameSite=Strict; HttpOnly")
  } elseif (-not ($c -and $c.Value -eq $script:ShareToken)) {
    & $deny 403; return $false
  }
  # Guests may read everything about the shared video and save its review (markers). Nothing else.
  if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD' -and $path -ne '/api/review') { & $deny 403; return $false }
  if ($path -eq '/api/dir' -or $path -eq '/api/share') { & $deny 403; return $false }
  # Guests may only open the shared video.
  if (($path -eq '/api/review' -or $path -eq '/video') -and (Get-QueryParam $req 'name') -ne $script:ShareVideo) { & $deny 403; return $false }
  return $true
}

function Invoke-Request($ctx) {
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod
    $isGuest = ($req.LocalEndPoint.Port -eq $SharePort)
    if ($isGuest -and -not (Test-Guest $req $res)) { return }
    if ($path -eq '/api/state' -and $method -eq 'GET') {
      $st = Get-State
      if ($isGuest) {
        $vid = [string]$req.Headers['X-Viewer']
        if ($vid -match '^[a-z0-9]{4,24}$') { $script:Viewers[$vid] = Get-Date }
        $st.dir = ''; $st.role = 'guest'; $st.shareVideo = $script:ShareVideo; $st.viewers = (Get-ViewerCount)
        $st.videos = @($st.videos | Where-Object { $_.name -eq $script:ShareVideo })
      }
      else { $st.role = 'host'; $st.share = Get-ShareInfo }
      Write-Json $res $st
    }
    elseif ($path -eq '/api/share') {
      if ($method -eq 'POST') {
        if (-not (Test-Mutation $req)) { Write-Text $res 'forbidden' 'text/plain' 403; return }
        $body = Read-Body $req | ConvertFrom-Json
        $video = [string]$body.video
        if ($body.on -and -not (Resolve-Video $video)) {
          Write-Json $res ([ordered]@{ error = 'pick a video first' }) 400
          return
        }
        if (-not (Set-Share ([bool]$body.on) $video)) {
          Write-Json $res ([ordered]@{ error = 'setup needed' }) 409
          return
        }
      }
      Write-Json $res (Get-ShareInfo)
    }
    elseif ($path -eq '/api/dir' -and $method -eq 'POST') {
      if (-not (Test-Mutation $req)) { Write-Text $res 'forbidden' 'text/plain' 403; return }
      $body = Read-Body $req | ConvertFrom-Json
      $d = ([string]$body.dir).Trim().Trim('"')
      # A video file path also works: open its folder and that video.
      $open = $null
      if ($d -and (Test-Path -LiteralPath $d -PathType Leaf) -and ($VideoExt -contains [IO.Path]::GetExtension($d).ToLower())) {
        $open = [IO.Path]::GetFileName($d)
        $d = [IO.Path]::GetDirectoryName($d)
      }
      if (-not $d -or -not (Test-Path -LiteralPath $d -PathType Container)) {
        Write-Json $res ([ordered]@{ error = 'folder not found' }) 400
        return
      }
      $script:VideoDir = (Resolve-Path -LiteralPath $d).Path
      [IO.File]::WriteAllText($LastDirFile, $script:VideoDir, $Utf8)
      $st = Get-State
      $st.open = $open
      Write-Json $res $st
    }
    elseif ($path -eq '/api/pick' -and $method -eq 'POST') {
      if (-not (Test-Mutation $req)) { Write-Text $res 'forbidden' 'text/plain' 403; return }
      $picked = Show-VideoPicker $script:VideoDir
      Write-Json $res ([ordered]@{ path = $picked })
    }
    elseif ($path -eq '/api/review') {
      $vp = Resolve-Video (Get-QueryParam $req 'name')
      if (-not $vp) { Write-Json $res ([ordered]@{ error = 'video not found' }) 404; return }
      $rv = $vp + '.review.json'
      if ($method -eq 'GET') {
        if (Test-Path -LiteralPath $rv) {
          Write-Text $res ([IO.File]::ReadAllText($rv, $Utf8)) 'application/json; charset=utf-8'
        } else {
          Write-Json $res ([ordered]@{ error = 'no review yet' }) 404
        }
      }
      elseif ($method -eq 'PUT' -or $method -eq 'POST') {
        if (-not (Test-Mutation $req)) { Write-Text $res 'forbidden' 'text/plain' 403; return }
        $text = Read-Body $req
        try { $nj = $text | ConvertFrom-Json } catch {
          Write-Json $res ([ordered]@{ error = 'invalid json' }) 400
          return
        }
        # Several people can edit at once. Each save must be based on the latest version (rev + 1);
        # otherwise the page pulls the newer file, merges marker by marker, and tries again.
        $cur = 0
        if (Test-Path -LiteralPath $rv) {
          try { $cj = [IO.File]::ReadAllText($rv, $Utf8) | ConvertFrom-Json; if ($cj.rev) { $cur = [int]$cj.rev } } catch { }
        }
        $new = 0
        if ($nj.rev) { $new = [int]$nj.rev }
        if ($new -ne $cur + 1) {
          Write-Json $res ([ordered]@{ error = 'conflict'; rev = $cur }) 409
          return
        }
        $tmp = $rv + '.tmp'
        [IO.File]::WriteAllText($tmp, $text, $Utf8)
        # [NullString]::Value: plain $null becomes "" in .NET calls and Replace() then fails.
        if (Test-Path -LiteralPath $rv) { [IO.File]::Replace($tmp, $rv, [NullString]::Value) } else { [IO.File]::Move($tmp, $rv) }
        Write-Json $res ([ordered]@{ ok = $true; path = $rv; savedAt = (Get-Date).ToString('o') })
      }
      else { Write-Text $res 'method not allowed' 'text/plain' 405 }
    }
    elseif ($path -eq '/api/summary' -and ($method -eq 'PUT' -or $method -eq 'POST')) {
      # Review summary for the edit office's re-edit session: "<video>.검수정리.md" next to the video.
      # (Host only: guests are stopped in Test-Guest.) The file name is built from char codes to keep this script ASCII.
      if (-not (Test-Mutation $req)) { Write-Text $res 'forbidden' 'text/plain' 403; return }
      $vp = Resolve-Video (Get-QueryParam $req 'name')
      if (-not $vp) { Write-Json $res ([ordered]@{ error = 'video not found' }) 404; return }
      $suffix = '.' + (-join ([char[]](0xAC80, 0xC218, 0xC815, 0xB9AC))) + '.md'
      $sp = $vp + $suffix
      [IO.File]::WriteAllText($sp, (Read-Body $req), $Utf8)
      Write-Json $res ([ordered]@{ ok = $true; path = $sp })
    }
    elseif ($path -eq '/video') {
      $vp = Resolve-Video (Get-QueryParam $req 'name')
      if (-not $vp) { Write-Text $res 'not found' 'text/plain' 404; return }
      Send-Video $req $res $vp
    }
    elseif ($method -eq 'GET') {
      Send-Static $req $res
    }
    else { Write-Text $res 'not found' 'text/plain' 404 }
  } catch {
    try { Write-Text $res ('error: ' + $_.Exception.Message) 'text/plain; charset=utf-8' 500 } catch { }
  } finally {
    try { $res.Close() } catch { }
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$url = "http://localhost:$Port/"
try { $listener.Start() } catch {
  # Already running? Then just open the browser instead of failing silently.
  $alive = $false
  try { $alive = ((Invoke-WebRequest -UseBasicParsing "$($url)api/state" -TimeoutSec 3).StatusCode -eq 200) } catch { }
  if ($alive) {
    Write-Host "Review server is already running. Opening $url"
    if (-not $NoBrowser) { Start-Process $url }
    exit 0
  }
  Write-Host "Port $Port is used by another program. Try: start.cmd -Port 5179" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "  Video review server running: $url" -ForegroundColor Cyan
Write-Host "  Video folder: $script:VideoDir"
Write-Host "  Stop: Ctrl+C (or close this window)"
Write-Host ""
if (-not $NoBrowser) { Start-Process $url }

try {
  while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(300)) { }
    $ctx = $listener.EndGetContext($async)
    Invoke-Request $ctx
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
