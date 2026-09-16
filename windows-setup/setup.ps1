param([switch]$RestoreDns,[switch]$DnsOnly)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'LocalSites'
function Write-PrivateText([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false))) }
try {
  if ($RestoreDns) {
    $backup = Join-Path $stateDir 'dns-backup.json'
    if (-not (Test-Path -LiteralPath $backup)) { throw 'DNS backup not found.' }
    $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy RemoteSigned -File `"$PSScriptRoot\dns.ps1`" -BackupPath `"$backup`" -Restore"
    if ($p.ExitCode -ne 0) { throw 'DNS restore failed.' }; Write-Host 'DNS restored.'; exit 0
  }
  . "$PSScriptRoot\config.ps1"
  $connection=Read-Connection "$PSScriptRoot\connection.json"
  $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
  if ($build -lt 22000) { throw 'Windows 11 is required.' }
  foreach ($name in @('node','tar')) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required. Install Node.js 22+ from https://nodejs.org/ and use Windows tar." } }
  if ([int]((& node --version).TrimStart('v').Split('.')[0]) -lt 22) { throw 'Install Node.js 22 or later: https://nodejs.org/' }
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if (-not $codex -or $codex.Path -notlike '*.exe') { $codex = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
  if (-not $codex) { throw 'Install Codex and open it once before running setup.' }
  $codexPath = if ($codex.Path) { $codex.Path } else { $codex.FullName }
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  if ((Get-Item -LiteralPath $stateDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Setup directory must not be a link.' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach ($identity in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }
  # Persist only the DACL; Set-Acl may request audit privileges on Windows PowerShell 5.1.
  (Get-Item -LiteralPath $stateDir).SetAccessControl($acl)
  $caPath = Join-Path $stateDir 'server-ca.crt'
  # Invoke-WebRequest uses Windows certificate trust. Never bypass validation.
  Invoke-WebRequest ($connection.serverUrl+'/setup/ca.crt') -UseBasicParsing -OutFile $caPath -TimeoutSec 20
  $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($caPath)
  if (-not (Test-Path "Cert:\CurrentUser\Root\$($certificate.Thumbprint)")) { throw 'Import the CA certificate supplied by your administrator into CurrentUser Root first.' }
  $savedEnv = @{}
  foreach ($name in @('NODE_EXTRA_CA_CERTS','LOCAL_SITES_TOKEN')) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name,'User') }
  $envBackup = Join-Path $stateDir ('backup-env-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
  Write-PrivateText $envBackup ($savedEnv | ConvertTo-Json)
  $combined = Join-Path $stateDir 'trusted-ca.pem'
  $oldCa = $savedEnv['NODE_EXTRA_CA_CERTS']; if (-not $oldCa) { $oldCa=$env:NODE_EXTRA_CA_CERTS }
  $caText = [IO.File]::ReadAllText($caPath)
  if ($oldCa -and $oldCa -ne $combined) { if (-not (Test-Path -LiteralPath $oldCa)) { throw 'Existing NODE_EXTRA_CA_CERTS file is missing; repair it before setup.' }; $caText = [IO.File]::ReadAllText($oldCa)+"`n"+$caText }
  elseif ((Test-Path -LiteralPath $combined)) { $caText=[IO.File]::ReadAllText($combined)+"`n"+$caText }
  Write-PrivateText $combined $caText
  $env:NODE_EXTRA_CA_CERTS = $combined
  $env:LOCAL_SITES_SETUP_DIR = $stateDir
  $env:LOCAL_SITES_CODEX = $codexPath
  $existingToken = $savedEnv['LOCAL_SITES_TOKEN']; if (-not $existingToken) { $existingToken=$env:LOCAL_SITES_TOKEN }
  if ($existingToken) { $env:LOCAL_SITES_TOKEN=$existingToken }
  if (-not $DnsOnly) {
  & node "$PSScriptRoot\setup-client.mjs"
  if ($LASTEXITCODE -ne 0) { throw 'Setup stopped. Read the message above and rerun START.cmd.' }
  [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS',$combined,'User')
  $tokenPath=Join-Path $stateDir 'device.token'
  [Environment]::SetEnvironmentVariable('LOCAL_SITES_TOKEN',([IO.File]::ReadAllText($tokenPath).Trim()),'User')
  }
  if ($connection.appDomain) {
  Write-Host ('DNS: the selected LAN adapter will use '+$connection.siteIp+'. Original settings will be saved.')
  $addresses=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { (Test-LanAddress $_.IPAddress $connection.lanCidr) -and $_.AddressState -eq 'Preferred' })
  if (-not $addresses.Count) { throw 'No active adapter on the configured LAN. Connect to the LAN and rerun.' }
  $index=0
  if ($addresses.Count -gt 1) { for ($i=0;$i -lt $addresses.Count;$i++) { Write-Host "$i : $($addresses[$i].InterfaceAlias) $($addresses[$i].IPAddress)" }; $index=[int](Read-Host 'Select adapter number'); if ($index -lt 0 -or $index -ge $addresses.Count) { throw 'Invalid adapter number.' } }
  $adapter=Get-NetAdapter -InterfaceIndex $addresses[$index].InterfaceIndex
  $dnsBackup=Join-Path $stateDir 'dns-backup.json'
  $answer=Read-Host 'Apply LAN DNS settings? Enter YES (anything else cancels; rerun to resume)'
  if ($answer -cne 'YES') { throw 'DNS setup cancelled. Credentials are saved; rerun to resume.' }
  $resultPath=$dnsBackup+'.result.json'
  if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
  $p=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy RemoteSigned -File `"$PSScriptRoot\dns.ps1`" -BackupPath `"$dnsBackup`" -AdapterGuid `"$($adapter.InterfaceGuid)`""
  if ($p.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $resultPath) {
      $result=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
      throw ('DNS failed at ['+$result.stage+']: '+$result.error+' / rollback: '+$result.rollback+' / Details: '+$resultPath)
    }
    throw ('DNS helper could not start or could not write its diagnostic. Exit code: '+$p.ExitCode+'. Check that the ZIP was unblocked before extraction and that UAC used the same Windows account.')
  }
  Invoke-WebRequest ($connection.portalUrl+'/setup') -UseBasicParsing -TimeoutSec 20 | Out-Null
  } else { Write-Host 'IP-only mode: DNS settings were not changed.' }
  Write-Host 'Setup complete. Sign out of Windows and sign in again. Open a new Codex task and ask local-sites to list apps.'
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
