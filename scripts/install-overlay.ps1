param([Parameter(Mandatory=$true)][string]$AppDir)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$taskAppDir=[IO.Path]::GetFullPath($AppDir)
$taskStateDir=Join-Path $env:ProgramData 'FriendScreen'
$taskLogDir=Join-Path $taskStateDir 'logs'
try {
    $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ADMIN_REQUIRED'}
    New-Item -ItemType Directory -Force -Path $taskStateDir,$taskLogDir | Out-Null
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
      $identity=New-Object Security.Principal.SecurityIdentifier($sid)
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    $users=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $taskStateDir -AclObject $acl
    $stateFile=Join-Path $taskStateDir 'install-state.json'
    $previous=$null
    if(Test-Path -LiteralPath $stateFile){$previous=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json}
    $service=Get-Service -Name ZeroTierOneService -ErrorAction SilentlyContinue
    $owned=$false
    if($service) {
      # Never replace, downgrade, disable updates, or remove an existing installation.
      if($previous -and $previous.owned -and $previous.appDir -eq $taskAppDir){$owned=$true}
    } else {
      $msi=Join-Path $taskAppDir 'resources\network-component\ZeroTierOne-1.14.2.msi'
      if((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne '45A7C031E4D003512D6C08710E89BA57D9E5A0AEB6AF1D26326AD3C0B2A1755D'){throw 'MSI_INTEGRITY_FAILED'}
      $signature=Get-AuthenticodeSignature -LiteralPath $msi
      if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'ZEROTIER'){throw 'MSI_SIGNATURE_FAILED'}
      $msiLog=Join-Path $taskLogDir 'zerotier-install.log'
      $arguments='/i "'+$msi+'" /qn /norestart ZTHEADLESS=Yes /L*v "'+$msiLog+'"'
      $install=Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
      if($install.ExitCode -notin @(0,3010)){throw ('MSI_EXIT_'+$install.ExitCode)}
      $owned=$true
      # Record ownership before later steps so a failed firewall setup remains recoverable.
      @{owned=$true;appDir=$taskAppDir;componentVersion='1.14.2';productCode='{0143A36C-46C6-458D-AB9B-C8843E089323}'} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    }
    Start-Service -Name ZeroTierOneService
    $program=Join-Path $taskAppDir 'FriendScreen.exe'
    $privateRanges=@('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')
    Get-NetFirewallRule -Name 'FriendScreen-Private-Signal','FriendScreen-Private-Media','FriendScreen-Private-NativeMedia' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name 'FriendScreen-Private-Signal' -DisplayName 'FriendScreen private room signaling' -Program $program -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47873 -LocalAddress $privateRanges -RemoteAddress $privateRanges -Profile Any | Out-Null
    New-NetFirewallRule -Name 'FriendScreen-Private-Media' -DisplayName 'FriendScreen private media' -Program $program -Direction Inbound -Action Allow -Protocol UDP -LocalAddress $privateRanges -RemoteAddress $privateRanges -Profile Any | Out-Null
    $nativeProgram=Join-Path $taskAppDir 'resources\piik\piik-app.exe'
    if(-not(Test-Path -LiteralPath $nativeProgram)){throw 'NATIVE_MEDIA_COMPONENT_MISSING'}
    New-NetFirewallRule -Name 'FriendScreen-Private-NativeMedia' -DisplayName 'FriendScreen private native media' -Program $nativeProgram -Direction Inbound -Action Allow -Protocol UDP -LocalAddress $privateRanges -RemoteAddress $privateRanges -Profile Any | Out-Null
    # Application additionally binds exactly one verified overlay IP, and rejects non-overlay ICE.
    @{owned=$owned;appDir=$taskAppDir;componentVersion='1.14.2';productCode='{0143A36C-46C6-458D-AB9B-C8843E089323}'} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    'Overlay service and private-address firewall rules are ready.' | Set-Content -LiteralPath (Join-Path $taskLogDir 'setup-result.txt')
    exit 0
} catch {
    # Fixed operation/error types only; never log credentials or request bodies.
    if(Test-Path -LiteralPath $taskLogDir){('Setup failed: '+$_.Exception.GetType().Name) | Set-Content -LiteralPath (Join-Path $taskLogDir 'setup-result.txt')}
    Write-Output 'Network setup failed. Run the installer again with Windows administrator approval; inspect ProgramData\FriendScreen\logs.'
    exit 1
}
