$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\windows-setup\config.ps1"
foreach ($file in Get-ChildItem "$PSScriptRoot\..\windows-setup" -Filter '*.ps1') {
  $tokens=$null; $errors=$null
  [Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors) | Out-Null
  if ($errors.Count) { throw "PowerShell parse failed: $($file.Name)" }
}
if (-not (Test-LanAddress '10.20.5.9' '10.20.0.0/16')) { throw 'Non-/24 membership failed' }
if (Test-LanAddress '10.21.5.9' '10.20.0.0/16') { throw 'Outside address accepted' }
if (Test-LanAddress '10.20.5.9' '10.20.0.1/16') { throw 'Noncanonical CIDR accepted' }
$tempFile=[IO.Path]::GetTempFileName()
try {
  $settings=@{serverUrl='https://10.20.5.9';siteIp='10.20.5.9';lanCidr='10.20.0.0/16';appDomain='';portalUrl='https://10.20.5.9'}
  $settings | ConvertTo-Json | Set-Content -LiteralPath $tempFile -Encoding UTF8
  $result=Read-Connection $tempFile
  if ($result.appDomain) { throw 'IP-only configuration changed' }
  $settings.appDomain='apps.home.arpa'; $settings.portalUrl='https://portal.apps.home.arpa'
  $settings | ConvertTo-Json | Set-Content -LiteralPath $tempFile -Encoding UTF8
  $null=Read-Connection $tempFile
  $settings.serverUrl='https://unrelated.invalid'
  $settings | ConvertTo-Json | Set-Content -LiteralPath $tempFile -Encoding UTF8
  $rejected=$false
  try { $null=Read-Connection $tempFile } catch { $rejected=$true }
  if (-not $rejected) { throw 'Unrelated connection URL accepted' }
} finally { Remove-Item -LiteralPath $tempFile }

# Exercise the actual restore function with network commands replaced by in-memory mocks.
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../windows-setup/dns.ps1'),[ref]$tokens,[ref]$errors)
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Restore-Saved'},$true)
Invoke-Expression $definition.Extent.Text
$script:changes=@(); $script:cleared=$false
function Get-NetAdapter { [pscustomobject]@{InterfaceGuid=[guid]'00000000-0000-0000-0000-000000000001';ifIndex=7} }
function Get-DnsClientServerAddress { param($InterfaceIndex,$AddressFamily) [pscustomobject]@{Family=$AddressFamily} }
function Set-DnsClientServerAddress {
  param([Parameter(ValueFromPipeline=$true)]$InputObject,[switch]$ResetServerAddresses,$ServerAddresses)
  process { $script:changes += [pscustomobject]@{Family=$InputObject.Family;Reset=[bool]$ResetServerAddresses;Addresses=@($ServerAddresses)} }
}
function Clear-DnsClientCache { $script:cleared=$true }
Restore-Saved ([pscustomobject]@{
  InterfaceGuid='00000000-0000-0000-0000-000000000001'
  IPv4=[pscustomobject]@{Automatic=$true;Addresses=@()}
  IPv6=[pscustomobject]@{Automatic=$false;Addresses=@('2001:db8::53')}
})
if ($changes.Count -ne 2 -or -not $changes[0].Reset -or $changes[1].Addresses[0] -ne '2001:db8::53' -or -not $cleared) { throw 'DNS restore regression' }
Write-Host 'Windows config, script syntax and mocked DNS restore passed; no network settings changed.'
