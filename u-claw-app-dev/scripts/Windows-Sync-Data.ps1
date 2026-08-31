Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$label = $env:SYNC_LABEL
$from = $env:SYNC_FROM
$to = $env:SYNC_TO
$timeout = [int]($env:DATA_SYNC_TIMEOUT_SECONDS)
$mode = $env:SYNC_MODE
$preserveConfig = $env:SYNC_PRESERVE_CONFIG -eq '1'

if ([string]::IsNullOrWhiteSpace($label)) { $label = 'Syncing data' }
if ([string]::IsNullOrWhiteSpace($from)) { throw 'SYNC_FROM is empty' }
if ([string]::IsNullOrWhiteSpace($to)) { throw 'SYNC_TO is empty' }
if ($timeout -le 0) { $timeout = 300 }
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'E' }

New-Item -ItemType Directory -Force -Path $to | Out-Null

$excludeDirs = @(
  (Join-Path $from '.cache\v8-compile-cache'),
  (Join-Path $from '.home\AppData\Roaming\u-claw\Cache'),
  (Join-Path $from '.home\AppData\Roaming\u-claw\Code Cache'),
  (Join-Path $from '.home\AppData\Roaming\u-claw\GPUCache'),
  (Join-Path $from '.home\AppData\Roaming\u-claw\DawnCache'),
  (Join-Path $from '.home\AppData\Roaming\u-claw\Crashpad'),
  (Join-Path $from '.openclaw\devices'),
  (Join-Path $from '.openclaw\identity'),
  (Join-Path $from 'Cache'),
  (Join-Path $from 'Code Cache'),
  (Join-Path $from 'GPUCache'),
  (Join-Path $from 'DawnGraphiteCache'),
  (Join-Path $from 'DawnWebGPUCache'),
  (Join-Path $from 'Network'),
  (Join-Path $from 'Local Storage'),
  (Join-Path $from 'Session Storage'),
  (Join-Path $from 'Service Worker'),
  (Join-Path $from 'WebStorage'),
  (Join-Path $from 'Shared Dictionary'),
  (Join-Path $from 'Dictionaries'),
  (Join-Path $from 'blob_storage')
)

$excludeFiles = @(
  '.DS_Store',
  '._*',
  'Cookies',
  'Cookies-journal',
  'DIPS',
  'DIPS-shm',
  'DIPS-wal',
  'Local State',
  'Network Persistent State',
  'Preferences',
  'SharedStorage',
  'SharedStorage-wal',
  'Trust Tokens',
  'Trust Tokens-journal',
  'LOCK',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket'
)

if ($preserveConfig) {
  $excludeFiles += @('openclaw.json', 'openclaw.json.last-good')
}

$started = Get-Date
$scriptBlock = {
  param($from, $to, $mode, $excludeDirs, $excludeFiles)

  $robocopyArgs = @($from, $to)
  if ($mode -eq 'MIR') {
    $robocopyArgs += '/MIR'
  } else {
    $robocopyArgs += '/E'
  }
  $robocopyArgs += @('/XD') + $excludeDirs
  $robocopyArgs += @('/XF') + $excludeFiles
  $robocopyArgs += @('/R:2', '/W:1', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')

  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }
  exit 0
}

$job = Start-Job -ScriptBlock $scriptBlock -ArgumentList $from, $to, $mode, $excludeDirs, $excludeFiles
while (-not (Wait-Job -Job $job -Timeout 5)) {
  $elapsed = [int]((Get-Date) - $started).TotalSeconds
  $items = @(Get-ChildItem -LiteralPath $to -Recurse -Force -File -ErrorAction SilentlyContinue)
  $files = $items.Count
  $mb = [math]::Round((($items | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
  Write-Host ('[U-Claw] {0}... {1}s elapsed, {2} files, {3} MB.' -f $label, $elapsed, $files, $mb)
  if ($elapsed -ge $timeout) {
    Stop-Job -Job $job
    Remove-Job -Job $job -Force
    Write-Error ('{0} timed out after {1}s.' -f $label, $timeout)
    exit 1
  }
}

Receive-Job -Job $job
$ok = $job.State -eq 'Completed'
Remove-Job -Job $job
if (-not $ok) { exit 1 }
