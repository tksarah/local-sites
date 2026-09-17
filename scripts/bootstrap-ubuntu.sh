#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo 'Run with sudo.' >&2; exit 1; fi
cd "$(dirname "$0")/.."
source scripts/load-config.sh
load_config deploy/.env
if ! ip -4 addr show | grep -Fq "${SITE_IP}/"; then echo 'SITE_IP is not assigned to this server.' >&2; exit 1; fi
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y docker.io docker-compose-v2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 is required. Install the Compose package matching your Docker distribution.' >&2; exit 1
fi
install -d -m 0755 /etc/local-sites
install -m 0600 deploy/.env /etc/local-sites/local-sites.env
install -m 0644 scripts/load-config.sh /usr/local/sbin/local-sites-config
systemctl enable --now docker
install -m 0755 scripts/firewall.sh /usr/local/sbin/local-sites-firewall
install -m 0644 deploy/local-sites-firewall.service /etc/systemd/system/local-sites-firewall.service
systemctl daemon-reload
systemctl enable local-sites-firewall.service
systemctl restart local-sites-firewall.service
mkdir -p /var/lib/local-sites
chmod 700 /var/lib/local-sites
docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml build manager preview
if [ ! -f /var/lib/local-sites/tokens.json ]; then
  docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml run --rm --no-deps --entrypoint node manager scripts/token.mjs create primary
fi
if [ -n "${SUDO_USER:-}" ] && [ -f /var/lib/local-sites/primary.token ]; then
  install -m 0600 -o "$SUDO_USER" -g "$(id -gn "$SUDO_USER")" /var/lib/local-sites/primary.token "$(getent passwd "$SUDO_USER" | cut -d: -f6)/.local-sites-primary.token"
fi
docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml up -d --build
for attempt in $(seq 1 30); do
  docker compose --env-file deploy/.env -p local-sites -f deploy/compose.yaml cp gateway:/data/caddy/pki/authorities/local/root.crt /var/lib/local-sites/public-ca.crt && break
  sleep 2
done
test -s /var/lib/local-sites/public-ca.crt
echo 'Started local-sites. Export the CA certificate as described in docs/setup-ja.md.'
