param([Parameter(Mandatory=$true)][string]$Go)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$source=Join-Path $root 'vendor\piik-source'
$output=Join-Path $root 'vendor\piik\piik-app.exe'
$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
Push-Location $source
try {
  if(-not(Test-Path -LiteralPath 'internal\server\webassets\dist\index.html')){
    & npm.cmd ci --no-audit --no-fund
    if($LASTEXITCODE -ne 0){throw 'Piik frontend dependencies failed'}
    & npm.cmd run build:web
    if($LASTEXITCODE -ne 0){throw 'Piik required launcher assets failed'}
  }
  & $Go test ./internal/app/mediaedge -run TestFriendScreen -count=1
  if($LASTEXITCODE -ne 0){throw 'Private media policy tests failed'}
  & $Go build -trimpath -ldflags '-s -w' -o $output ./cmd/piik-app
  if($LASTEXITCODE -ne 0){throw 'Private media build failed'}
} finally {Pop-Location}
