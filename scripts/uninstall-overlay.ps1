param([Parameter(Mandatory=$true)][string]$AppDir)
$ErrorActionPreference='Stop'
try {
  $stateFile=Join-Path $env:ProgramData 'FriendScreen\install-state.json'
  if(-not(Test-Path -LiteralPath $stateFile)){exit 0}
  $state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  if($state.appDir -ne [IO.Path]::GetFullPath($AppDir)){exit 0}
  Get-NetFirewallRule -Name 'FriendScreen-Private-Signal','FriendScreen-Private-Media','FriendScreen-Private-NativeMedia' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if($state.owned) {
    # Keep a shared component whenever ANY network remains joined. No other app's networks are touched.
    $auth=Join-Path $env:ProgramData 'ZeroTier\One\authtoken.secret'
    if(Test-Path -LiteralPath $auth) {
      $token=(Get-Content -LiteralPath $auth -Raw).Trim()
      $headers=@{'X-ZT1-Auth'=$token}
      $status=Invoke-RestMethod -Uri 'http://127.0.0.1:9993/status' -Headers $headers -TimeoutSec 5
      $networks=Invoke-RestMethod -Uri 'http://127.0.0.1:9993/network' -Headers $headers -TimeoutSec 5
      if($status.version -eq '1.14.2' -and @($networks).Count -eq 0) {
        $result=Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList '/x {0143A36C-46C6-458D-AB9B-C8843E089323} /qn /norestart' -WindowStyle Hidden -Wait -PassThru
        if($result.ExitCode -notin @(0,3010)){throw 'COMPONENT_UNINSTALL_FAILED'}
      }
    }
  }
  Remove-Item -LiteralPath $stateFile -Force
  exit 0
} catch {
  # Preserve a shared or unreachable component instead of damaging another installation.
  Write-Output 'Shared network component retained; it can be removed later in Windows Installed Apps.'
  exit 0
}
