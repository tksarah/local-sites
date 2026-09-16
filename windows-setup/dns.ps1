param([Parameter(Mandatory=$true)][string]$BackupPath,[string]$AdapterGuid,[switch]$Restore)
$ErrorActionPreference='Stop'
function Restore-Saved($saved) {
  $adapter=Get-NetAdapter | Where-Object { $_.InterfaceGuid.ToString() -eq $saved.InterfaceGuid }
  if (-not $adapter) { throw 'Original adapter is missing.' }
  foreach ($family in @('IPv4','IPv6')) { $dns=Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family; $entry=$saved.$family; if ($entry.Automatic) { $dns | Set-DnsClientServerAddress -ResetServerAddresses } else { $dns | Set-DnsClientServerAddress -ServerAddresses @($entry.Addresses) } }
  Clear-DnsClientCache
}
$changed=$false;$saved=$null;$stage='start'
$resultPath=$BackupPath+'.result.json'
function Save-Result($ok,$errorText,$rollback) {
  [ordered]@{at=(Get-Date).ToString('o');ok=$ok;stage=$stage;error=$errorText;rollback=$rollback} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
try {
  if ($Restore) { $stage='restore'; Restore-Saved (Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json); Save-Result $true '' 'restored'; exit 0 }
  . "$PSScriptRoot\config.ps1"
  $connection=Read-Connection "$PSScriptRoot\connection.json"
  if (-not $connection.appDomain) { throw 'DNS is disabled in this configuration.' }
  $stage='find-adapter'
  $adapter=Get-NetAdapter | Where-Object { $_.InterfaceGuid.ToString() -eq $AdapterGuid }
  if (-not $adapter) { throw 'Adapter is missing.' }
  $stage='check-lan-dns'
  $resolved=Resolve-DnsName ('portal.'+$connection.appDomain) -Server $connection.siteIp -Type A -DnsOnly
  if ($connection.siteIp -notin $resolved.IPAddress) { throw 'LAN DNS is not ready.' }
  $stage='check-external-dns'
  Resolve-DnsName example.com -Server $connection.siteIp -Type A -DnsOnly | Out-Null
  $stage='backup-settings'
  if (Test-Path -LiteralPath $BackupPath) {
    $saved=Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
    if ($saved.InterfaceGuid -ne $AdapterGuid) { throw 'A backup exists for a different adapter. Restore it before changing adapters.' }
  } else {
    $saved=[ordered]@{InterfaceGuid=$adapter.InterfaceGuid.ToString();Timestamp=(Get-Date).ToString('o')}
    foreach ($family in @('IPv4','IPv6')) {
      $service=if ($family -eq 'IPv4') {'Tcpip'} else {'Tcpip6'}
      $registry="HKLM:\SYSTEM\CurrentControlSet\Services\$service\Parameters\Interfaces\$(([guid]$adapter.InterfaceGuid).ToString('B'))"
      $manual=(Get-ItemProperty -LiteralPath $registry -Name NameServer -ErrorAction SilentlyContinue).NameServer
      $dns=Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family
      $saved[$family]=@{Automatic=[string]::IsNullOrWhiteSpace($manual);Addresses=@($dns.ServerAddresses)}
    }
    $saved | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $BackupPath -Encoding UTF8
  }
  $stage='apply-dns'
  $changed=$true
  Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses $connection.siteIp
  Clear-DnsClientCache
  $stage='verify-lan-dns'
  $result=Resolve-DnsName ('portal.'+$connection.appDomain) -Type A -DnsOnly
  if ($connection.siteIp -notin $result.IPAddress) { throw 'LAN lookup failed.' }
  $stage='verify-external-dns'
  Resolve-DnsName example.com -Type A -DnsOnly | Out-Null
  Save-Result $true '' 'not-needed'
  exit 0
} catch {
  $failure=$_.Exception.Message
  $rollback='not-changed'
  if ($changed -and $saved) { try { Restore-Saved $saved; $rollback='restored' } catch { $rollback='RESTORE FAILED: '+$_.Exception.Message } }
  try { Save-Result $false $failure $rollback } catch { Write-Error ('Cannot save DNS diagnostic: '+$_.Exception.Message) -ErrorAction Continue }
  exit 1
}
