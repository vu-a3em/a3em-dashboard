# Prepares a VHD the way the dashboard prepares a card, and checks every result.
# Runs elevated (GitHub's Windows runners are). Never touches a real device:
# A3EM_HELPER_VIRTUAL_ONLY hides every one.
#
#   pwsh test/integration-windows.ps1 -Helper path\to\a3em-card-helper.exe
param([Parameter(Mandatory)] [string] $Helper)
$ErrorActionPreference = 'Stop'
$Helper = (Resolve-Path $Helper).Path
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("a3em-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $work | Out-Null
$env:A3EM_HELPER_VIRTUAL_ONLY = '1'
$env:A3EM_HELPER_STATE_DIR = Join-Path $work 'state'
$reply = Join-Path $work 'reply.json'

$vhd = Join-Path $work 'card.vhdx'
"create vdisk file=`"$vhd`" maximum=2048 type=expandable`nselect vdisk file=`"$vhd`"`nattach vdisk" |
  Set-Content (Join-Path $work 'make.txt') -Encoding ascii
diskpart /s (Join-Path $work 'make.txt') | Out-Null
$disk = Get-DiskImage -ImagePath $vhd | Get-Disk
$id = [string]$disk.Number
Write-Host "card: disk $id ($($disk.BusType), $($disk.Size) bytes)"

function Invoke-Helper([hashtable] $request) {
  $file = Join-Path $work 'request.json'
  $request | ConvertTo-Json -Depth 5 | Set-Content $file -Encoding utf8NoBOM
  & $Helper call "@$file" > $reply 2> (Join-Path $work 'progress.log')
  if ($LASTEXITCODE -ne 0) { throw "the helper exited with $LASTEXITCODE" }
}
function Assert([string] $assertion, [string[]] $arguments = @()) {
  $out = & python (Join-Path $here 'check.py') $assertion $reply @arguments
  if ($LASTEXITCODE -ne 0) { $out | Write-Host; throw "check $assertion failed" }
  return $out
}

try {
  Invoke-Helper @{ op = 'listDevices' }; Assert only-device @($id)
  Invoke-Helper @{ op = 'challenge'; device = $id; operation = 'prepare' }; $token = Assert token

  $config = "DEVICE_LABEL = FIELD1`n"
  $prepare = @{ op = 'prepare'; targets = @(@{ device = $id; grant = $token; allocationUnitBytes = 32768; label = 'FIELD1'; config = $config }) }
  Invoke-Helper $prepare; Assert prepared @('32768', 'FIELD1')
  $volume = (Get-Content $reply | ConvertFrom-Json).results[0].volume
  Invoke-Helper $prepare; Assert refused @('bad-grant')

  Invoke-Helper @{ op = 'readiness'; device = $id; deep = $true }; Assert ready @($config)
  Invoke-Helper @{ op = 'diagnose'; volume = $volume }; Assert clean
  $letter = $volume.TrimEnd(':')
  $v = Get-Volume -DriveLetter $letter
  Write-Host "Windows reports: $($v.FileSystem), $($v.AllocationUnitSize)-byte clusters, label $($v.FileSystemLabel)"
  if ($v.FileSystem -ne 'exFAT' -or $v.AllocationUnitSize -ne 32768 -or $v.FileSystemLabel -ne 'FIELD1') { throw 'Windows disagrees with the helper' }
  Write-Host 'windows integration: passed'
}
finally {
  "select vdisk file=`"$vhd`"`ndetach vdisk" | Set-Content (Join-Path $work 'drop.txt') -Encoding ascii
  diskpart /s (Join-Path $work 'drop.txt') | Out-Null
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
