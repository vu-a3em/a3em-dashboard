# Builds the Windows helper for x64 and ARM64, and the installer around them.
#
#   pwsh packaging/windows/build.ps1 -Version 0.2.0 [-Stage binaries|installer|all]
#
# The release workflow runs the two stages separately so that SignPath can sign the executables
# before they are sealed into the installer, and then sign the installer.
param(
  [Parameter(Mandatory)] [string] $Version,
  [ValidateSet('binaries', 'installer', 'all')] [string] $Stage = 'all'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$out = Join-Path $root 'dist\windows'
New-Item -ItemType Directory -Force $out | Out-Null

# Windows keeps a file's version as four numbers; "0.2.0-dev.7" becomes 0.2.0.
$numeric = ($Version -split '[-+]')[0]

if ($Stage -in 'binaries', 'all') {
  Push-Location $root
  try {
    # Product name and version in every executable: SignPath signs nothing without them, and
    # they are what Windows shows under Properties > Details. go-winres writes them as a
    # resource that go build links in, one per architecture, deleted again afterwards.
    Push-Location cmd/a3em-card-helper
    go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64,arm64 --manifest cli `
      --product-name 'A3EM Card Helper' --file-description 'A3EM card helper' `
      --product-version $numeric --file-version $numeric `
      --copyright 'Copyright (c) 2026 vu-a3em. MIT License.' --original-filename a3em-card-helper.exe --out rsrc
    if ($LASTEXITCODE -ne 0) { throw 'go-winres failed' }
    Pop-Location
    foreach ($arch in 'amd64', 'arm64') {
      $env:CGO_ENABLED = '0'; $env:GOOS = 'windows'; $env:GOARCH = $arch
      go build -trimpath -ldflags "-s -w -X main.version=$Version" -o (Join-Path $out "a3em-card-helper-$arch.exe") ./cmd/a3em-card-helper
      if ($LASTEXITCODE -ne 0) { throw "go build failed for $arch" }
    }
  } finally {
    Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
    Remove-Item cmd/a3em-card-helper/*.syso -ErrorAction SilentlyContinue
    Pop-Location
  }
}

if ($Stage -in 'installer', 'all') {
  $iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
  if (-not $iscc) { $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
  if (-not (Test-Path $iscc)) {
    choco install innosetup --no-progress -y | Out-Null
    $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  }
  & $iscc "/DVersion=$Version" "/DNumericVersion=$numeric" "/DSource=$out" (Join-Path $PSScriptRoot 'a3em-card-helper.iss')
  if ($LASTEXITCODE -ne 0) { throw 'iscc failed' }
  Get-FileHash (Join-Path $root 'dist\A3EM-Card-Helper-Windows.exe') -Algorithm SHA256 | Format-List
}
