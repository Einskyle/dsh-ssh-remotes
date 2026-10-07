<#
.SYNOPSIS
  把某台远程主机上原生运行的 DSH Web UI，通过 SSH 隧道暴露到本机浏览器。

.DESCRIPTION
  在远端执行 `dsh --profile web --port <RemotePort> --no-open`，同时建立
  `-L 127.0.0.1:<LocalPort>:127.0.0.1:<RemotePort>`。远端默认只绑 loopback
  （`--host 0.0.0.0` 会被 dsh 启动时拒绝），因此 GUI 不会暴露到网络；
  本机也只监听 127.0.0.1。

  这台远程 DSH 的工作区、会话、侧边栏、终端因此**全部是原生的** ——
  因为它们本来就是那台机器的本地工作区。

  主机信息优先复用插件已保存的 ~/.dsh/ssh-remotes/config.json；
  也可以用 `-Target user@host` 或 `~/.ssh/config` 别名直接指定。

.PARAMETER Target
  插件里配置的主机名/主机 id，或任意 SSH 目标（别名、user@host、IP）。

.PARAMETER RemotePort
  起始端口，默认 9337（避开 Windows 保留区间）。实际端口取两端都空闲的第一个候选，
  且两端使用同一个端口号。

.PARAMETER LocalPort
  起始端口的另一种写法；给出时优先于 RemotePort。两端仍使用同一个端口号。

.PARAMETER NoBrowser
  只建立隧道并打印 URL，不打开浏览器。

.PARAMETER Stop
  关闭该主机的隧道（同时结束远端 dsh web）。

.PARAMETER Status
  显示该主机的隧道状态与 URL。

.PARAMETER List
  列出插件里配置的主机，以及当前活动的隧道。

.EXAMPLE
  .\dsh-remote-web.ps1 devbox
  .\dsh-remote-web.ps1 devbox -RemotePort 9000 -NoBrowser
  .\dsh-remote-web.ps1 -List
  .\dsh-remote-web.ps1 devbox -Stop
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Target,
  [int]$RemotePort = 9337,
  [int]$LocalPort = 0,
  [switch]$NoBrowser,
  [switch]$Stop,
  [switch]$Status,
  [switch]$List,
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'

$DshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $env:DSH_HOME.Trim() } else { Join-Path $HOME '.dsh' }
$ConfigFile = Join-Path $DshHome 'ssh-remotes\config.json'
$StateDir = Join-Path $DshHome 'ssh-remotes\web-tunnels'

function Write-Info($m) { Write-Host "[remote-web] $m" }
function Write-Warn2($m) { Write-Host "[remote-web] $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "[remote-web] $m" -ForegroundColor Red }

# Read the ssh log while ssh still owns it. `Start-Process -RedirectStandardOutput`
# keeps the handle open, so a plain File.ReadAllText / Get-Content -Raw throws on
# it (and PS 5.1 returns $null for an empty file) — either way the startup line
# stays invisible until the process dies. Open it with FileShare.ReadWrite and
# never throw.
function Read-TextSafe([string]$path) {
  if (-not $path) { return '' }
  try {
    $fs = [System.IO.FileStream]::new(
      $path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite)
    try {
      $sr = New-Object System.IO.StreamReader($fs)
      try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
  } catch { }
  return ''
}

function Get-ConfiguredHosts {
  $text = Read-TextSafe $ConfigFile
  if (-not $text) { return @() }
  try {
    $parsed = $text | ConvertFrom-Json
    if ($parsed -and $parsed.hosts) { return @($parsed.hosts) }
  } catch {
    Write-Warn2 "读取 $ConfigFile 失败：$($_.Exception.Message)"
  }
  return @()
}

function Resolve-Target([string]$name) {
  $hosts = Get-ConfiguredHosts
  $match = $hosts | Where-Object { $_.name -eq $name -or $_.id -eq $name } | Select-Object -First 1
  if ($match) {
    return [pscustomobject]@{
      label        = $match.name
      sshHost      = $match.host
      user         = $match.user
      port         = if ($match.port) { [int]$match.port } else { 22 }
      identityFile = $match.identityFile
      fromPlugin   = $true
    }
  }
  return [pscustomobject]@{
    label        = $name
    sshHost      = $name
    user         = ''
    port         = 22
    identityFile = ''
    fromPlugin   = $false
  }
}

function Get-StatePaths($label) {
  $safe = ($label -replace '[^A-Za-z0-9._-]', '_')
  return [pscustomobject]@{
    json = Join-Path $StateDir "$safe.json"
    out  = Join-Path $StateDir "$safe.out.log"
    err  = Join-Path $StateDir "$safe.err.log"
  }
}

function Test-PortFree([int]$p) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch { return $false }
}

function Find-FreePort([int]$start) {
  for ($p = $start; $p -lt ($start + 200); $p++) {
    if (Test-PortFree $p) { return $p }
  }
  throw "从 $start 起找不到空闲本地端口"
}

# The launcher commits one number and uses it on both ends, so it must be free
# on the remote loopback too. /dev/tcp is a bash builtin, so this needs nothing
# installed on the server.
function Test-RemotePortFree([string[]]$optArgs, [string]$sshTarget, [int]$port) {
  $probe = "if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then echo BUSY; else echo FREE; fi"
  try {
    $out = & ssh @($optArgs + @($sshTarget, $probe)) 2>$null | Out-String
    return ($out -match 'FREE')
  } catch { return $false }
}

function Get-Tunnel($label) {
  $paths = Get-StatePaths $label
  if (-not (Test-Path -LiteralPath $paths.json)) { return $null }
  try { return (Get-Content -LiteralPath $paths.json -Raw | ConvertFrom-Json) } catch { return $null }
}

function Stop-Tunnel($label) {
  $state = Get-Tunnel $label
  if (-not $state) { Write-Info "$label ：没有活动隧道"; return }
  $proc = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
  if ($proc) {
    # Killing ssh closes the remote `dsh web` too, because its stdin/stdout are the channel.
    Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue
    Write-Info "$label ：已关闭隧道 (pid $($state.pid))"
  } else {
    Write-Info "$label ：进程已不在，清理状态"
  }
  # Closing the channel usually reaps the remote process, but a crashed run can
  # leave it orphaned and holding the port. Clean it explicitly by exact port.
  if ($state.target -and $state.remotePort) {
    try {
      & ssh -T -o BatchMode=yes -o ConnectTimeout=8 $state.target `
        "pkill -f 'dsh --profile web --port $($state.remotePort)' || true" 2>$null | Out-Null
      Write-Info "$label ：已清理远端 dsh web (端口 $($state.remotePort))"
    } catch { }
  }
  $paths = Get-StatePaths $label
  Remove-Item -LiteralPath $paths.json -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $paths.out -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $paths.err -Force -ErrorAction SilentlyContinue
}

function Show-Tunnel($label) {
  $state = Get-Tunnel $label
  if (-not $state) { Write-Info "$label ：未运行"; return }
  $alive = [bool](Get-Process -Id $state.pid -ErrorAction SilentlyContinue)
  Write-Host "host        : $($state.label)"
  Write-Host "ssh target  : $($state.target)"
  Write-Host "local port  : $($state.localPort)"
  Write-Host "remote port : $($state.remotePort)"
  Write-Host "pid         : $($state.pid)  (alive=$alive)"
  Write-Host "url         : $($state.url)"
}

# ---------------------------------------------------------------- list

if ($List) {
  $hosts = Get-ConfiguredHosts
  Write-Host '已配置的 SSH 主机（来自插件 ~/.dsh/ssh-remotes/config.json）：'
  if (-not $hosts -or $hosts.Count -eq 0) {
    Write-Host '  (无)'
  } else {
    foreach ($h in $hosts) {
      $u = if ($h.user) { "$($h.user)@" } else { '' }
      Write-Host ("  {0,-20} {1}{2}:{3}" -f $h.name, $u, $h.host, $h.port)
    }
  }
  Write-Host ''
  Write-Host '活动隧道：'
  if (-not (Test-Path -LiteralPath $StateDir)) {
    Write-Host '  (无)'
  } else {
    $found = $false
    foreach ($f in Get-ChildItem -LiteralPath $StateDir -Filter '*.json' -ErrorAction SilentlyContinue) {
      $found = $true
      $state = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
      $alive = [bool](Get-Process -Id $state.pid -ErrorAction SilentlyContinue)
      Write-Host ("  {0,-20} 127.0.0.1:{1} -> {2}:{3}  pid={4} alive={5}" -f $state.label, $state.localPort, $state.target, $state.remotePort, $state.pid, $alive)
      Write-Host ("    {0}" -f $state.url)
    }
    if (-not $found) { Write-Host '  (无)' }
  }
  exit 0
}

if (-not $Target) {
  Write-Err2 '请给出主机，例如：.\dsh-remote-web.ps1 devbox   （用 -List 查看已配置主机）'
  exit 2
}

if ($Stop) { Stop-Tunnel $Target; exit 0 }
if ($Status) { Show-Tunnel $Target; exit 0 }

# ---------------------------------------------------------------- start

$resolved = Resolve-Target $Target
if (-not $resolved.fromPlugin) {
  Write-Warn2 "插件配置里没有 $Target，按原始 SSH 目标处理"
}

$existing = Get-Tunnel $resolved.label
if ($existing) {
  Write-Info "检测到 $($resolved.label) 已有隧道，先关闭旧的"
  Stop-Tunnel $resolved.label
}

# --- SSH arguments are split so the remote end can be probed before a port is
#     committed. `ssh [options] destination [command]`: every option must come
#     BEFORE the destination, otherwise it is handed to the remote shell.
$sshOptArgs = @(
  '-T'
  '-o', 'BatchMode=yes'
  '-o', 'StrictHostKeyChecking=accept-new'
  '-o', 'ConnectTimeout=12'
  '-o', 'ServerAliveInterval=20'
  '-o', 'ServerAliveCountMax=3'
)
if ($resolved.port -and $resolved.port -ne 22) { $sshOptArgs += @('-p', "$($resolved.port)") }
if ($resolved.identityFile) { $sshOptArgs += @('-i', $resolved.identityFile) }
$sshTarget = if ($resolved.user) { "$($resolved.user)@$($resolved.sshHost)" } else { $resolved.sshHost }

# One number for both ends. Windows reserves ranges whose loopback bind is
# refused outright (for example 8707-8906), and the server may already hold the
# port, so probe until a candidate is free on BOTH ends.
$start = if ($LocalPort -gt 0) { $LocalPort } else { $RemotePort }
$port = $null
for ($i = 0; $i -lt 60; $i++) {
  $cand = $start + $i
  if ((Test-PortFree $cand) -and (Test-RemotePortFree $sshOptArgs $sshTarget $cand)) { $port = $cand; break }
}
if (-not $port) { Write-Err2 "从 $start 起 60 个端口内找不到两端都可用的端口"; exit 1 }
if ($port -ne $start) { Write-Warn2 "端口 $start 在某一端不可用（被占用，或落在 Windows 保留区间），改用 $port" }
$LocalPort = $port
$RemotePort = $port

if (-not (Test-Path -LiteralPath $StateDir)) {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
}
$paths = Get-StatePaths $resolved.label
foreach ($f in @($paths.out, $paths.err)) {
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
}

# Remote command: bind loopback only (dsh rejects 0.0.0.0 anyway) and never
# attempt to open a browser on the server.
$remoteCommand = "dsh --profile web --port $RemotePort --no-open"

# Killing a local ssh does not necessarily reap the remote `dsh web`, so a
# crashed earlier run can leave an orphan holding this exact port. Clear it.
try { & ssh @($sshOptArgs + @($sshTarget, "pkill -f 'dsh --profile web --port $RemotePort' || true")) 2>$null | Out-Null } catch { }

$sshArgs = $sshOptArgs + @(
  '-o', 'ExitOnForwardFailure=yes'
  '-L', "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}"
  $sshTarget
  $remoteCommand
)

Write-Info "目标      : $sshTarget ($($resolved.label))"
Write-Info "远端命令  : $remoteCommand"
Write-Info "隧道      : 127.0.0.1:${LocalPort} -> 127.0.0.1:${RemotePort}"

$proc = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $paths.out -RedirectStandardError $paths.err

Write-Info "ssh pid   : $($proc.Id)，等待远端 dsh web 就绪…"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$remoteUrl = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if ($proc.HasExited) {
    Write-Err2 "ssh 提前退出 (exit $($proc.ExitCode))。"
    $errText = (Read-TextSafe $paths.err).Trim()
    $outText = (Read-TextSafe $paths.out).Trim()
    if ($errText) { Write-Err2 $errText }
    if ($outText) { Write-Err2 $outText }
    exit 1
  }
  $text = Read-TextSafe $paths.out
  if ($text) {
    $m = [regex]::Match($text, 'dsh web:\s*(\S+)')
    if ($m.Success) { $remoteUrl = $m.Groups[1].Value; break }
  }
}

if (-not $remoteUrl) {
  Write-Err2 "等待 $TimeoutSec 秒仍未看到 'dsh web:' 启动行。远端日志：$($paths.out)"
  $errText = (Read-TextSafe $paths.err).Trim()
  if ($errText) { Write-Err2 $errText }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

# The printed URL names an address + port on the *remote* loopback; rewrite the
# port to the local one. The token is preserved (it is the credential the
# browser exchanges for a cookie on first load).
$localUrl = $remoteUrl -replace "(?<=://127\.0\.0\.1:)$RemotePort", "$LocalPort"
if ($LocalPort -ne $RemotePort) {
  $localUrl = $remoteUrl -replace "127\.0\.0\.1:$RemotePort", "127.0.0.1:$LocalPort"
}

$urlNoToken = ($localUrl -replace '\?token=[^&]*', '' -replace '&token=[^&]*', '')

$state = [pscustomobject]@{
  label      = $resolved.label
  target     = $sshTarget
  pid        = $proc.Id
  localPort  = $LocalPort
  remotePort = $RemotePort
  url        = $urlNoToken
  startedAt  = (Get-Date).ToString('o')
}
$state | ConvertTo-Json | Set-Content -LiteralPath $paths.json -Encoding utf8

# Best effort only: while ssh holds the redirect handle the file is not
# writable, so this normally cannot rewrite it. The log lives in the private
# ~/.dsh/ssh-remotes/web-tunnels directory, is deleted by -Stop, and its token is
# invalidated as soon as the remote `dsh web` exits.
$outText = Read-TextSafe $paths.out
if ($outText -match 'token=') {
  try {
    Set-Content -LiteralPath $paths.out -Value ($outText -replace 'token=[^&\s]+', 'token=***') -Encoding utf8 -ErrorAction Stop
  } catch { }
}

Write-Info "就绪      : $urlNoToken"
Write-Info "停止      : .\dsh-remote-web.ps1 $($resolved.label) -Stop"

if (-not $NoBrowser) {
  Write-Info '正在本机浏览器打开…'
  Start-Process $localUrl | Out-Null
} else {
  Write-Host ''
  Write-Host '在浏览器打开下面这个一次性 URL（含进程 token，仅本机可见）：'
  Write-Host $localUrl
}
