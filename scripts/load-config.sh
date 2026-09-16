#!/usr/bin/env bash
# Shared by installers and systemd helpers. Never execute the configuration as shell code.
load_config() {
  local config_file="$1" line key value
  unset SITE_IP LAN_CIDR APP_DOMAIN UPSTREAM_DNS METRICS_NETWORK_INTERFACE
  [ -f "$config_file" ] || { echo "Configuration missing: $config_file" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || { echo 'Expected KEY=value in configuration.' >&2; return 1; }
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in SITE_IP|LAN_CIDR|APP_DOMAIN|UPSTREAM_DNS|METRICS_NETWORK_INTERFACE) ;; *) echo "Unknown configuration key: $key" >&2; return 1;; esac
    [[ "$value" =~ ^[a-zA-Z0-9./:_-]*$ ]] || { echo "Invalid configuration value for $key" >&2; return 1; }
    export "$key=$value"
  done < "$config_file"
  python3 - <<'PY'
import ipaddress, os, re
try:
    ip = ipaddress.IPv4Address(os.environ['SITE_IP'])
    net = ipaddress.IPv4Network(os.environ['LAN_CIDR'], strict=True)
    assert ip in net and not ip.is_unspecified and not ip.is_multicast
    domain = os.environ.get('APP_DOMAIN', '')
    if domain:
        assert len(domain) <= 212 and '.' in domain
        assert all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', p) for p in domain.split('.'))
        try: ipaddress.ip_address(domain)
        except ValueError: pass
        else: raise ValueError('Domain cannot be an IP')
    upstream = os.environ.get('UPSTREAM_DNS', '')
    if upstream:
        assert ipaddress.IPv4Address(upstream) != ip
except (KeyError, ValueError, AssertionError):
    raise SystemExit('Invalid SITE_IP, LAN_CIDR, APP_DOMAIN or UPSTREAM_DNS; check deploy/.env.')
PY
}
