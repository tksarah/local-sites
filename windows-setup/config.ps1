function Read-Connection([string]$Path) {
  $settings = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $ip = $null
  if (-not [Net.IPAddress]::TryParse($settings.siteIp, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Invalid server IPv4 address.' }
  if ($settings.serverUrl -cne ('https://' + $settings.siteIp)) { throw 'Invalid server URL.' }
  if ($settings.lanCidr -notmatch '^([0-9.]+)/([0-9]|[12][0-9]|3[0-2])$') { throw 'Invalid LAN CIDR.' }
  $network = $null
  if (-not [Net.IPAddress]::TryParse($Matches[1], [ref]$network) -or $network.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Invalid LAN network.' }
  if (-not (Test-LanAddress $settings.siteIp $settings.lanCidr)) { throw 'Server is outside LAN CIDR.' }
  if ($settings.appDomain) {
    if ($settings.appDomain.Length -gt 212 -or $settings.appDomain -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') { throw 'Invalid application domain.' }
    if ($settings.portalUrl -cne ('https://portal.' + $settings.appDomain)) { throw 'Invalid portal URL.' }
  } elseif ($settings.portalUrl -cne $settings.serverUrl) { throw 'Invalid portal URL.' }
  return $settings
}
function Test-LanAddress([string]$Address, [string]$Cidr) {
  $parts = $Cidr.Split('/')
  $size = [Math]::Pow(2, 32 - [int]$parts[1])
  $values = @($Address, $parts[0]) | ForEach-Object {
    $value = [double]0
    foreach ($octet in ([Net.IPAddress]::Parse($_)).GetAddressBytes()) { $value = $value * 256 + $octet }
    $value
  }
  return (($values[1] % $size -eq 0) -and ([Math]::Floor($values[0] / $size) -eq [Math]::Floor($values[1] / $size)))
}
