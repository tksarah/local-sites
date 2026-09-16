#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "${TEST_PYTHON:-}" ]; then
  python3() { "$TEST_PYTHON" "$@"; }
fi
source scripts/load-config.sh
fixture=$(mktemp)
trap 'rm -f "$fixture"' EXIT
cat > "$fixture" <<'EOF'
SITE_IP=10.20.5.9
LAN_CIDR=10.20.0.0/16
APP_DOMAIN=apps.home.arpa
UPSTREAM_DNS=10.20.0.1
EOF
load_config "$fixture"
[ "$SITE_IP" = 10.20.5.9 ] && [ "$APP_DOMAIN" = apps.home.arpa ]
cat > "$fixture" <<'EOF'
SITE_IP=10.20.5.9
LAN_CIDR=10.20.0.0/16
APP_DOMAIN=
EOF
load_config "$fixture"
[ -z "$APP_DOMAIN" ] && [ -z "${UPSTREAM_DNS:-}" ]
for invalid in 'LAN_CIDR=10.21.0.0/16' 'LAN_CIDR=10.20.0.1/16' 'LAN_CIDR=10.20.0.0/33' 'APP_DOMAIN=10.20.1.1' 'UPSTREAM_DNS=10.20.5.9' 'UNSUPPORTED=value' 'APP_DOMAIN=$(exit 99)'; do
  printf '%s\n' 'SITE_IP=10.20.5.9' 'LAN_CIDR=10.20.0.0/16' "$invalid" > "$fixture"
  if load_config "$fixture" 2>/dev/null; then
    echo 'Invalid configuration accepted' >&2; exit 1
  fi
done
echo 'Shell configuration validation passed (no system changes).'
