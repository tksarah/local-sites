#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
cd "$(dirname "$0")/.."
source scripts/load-config.sh
load_config deploy/.env
[ -n "${APP_DOMAIN:-}" ] && [ -n "${UPSTREAM_DNS:-}" ] || { echo "Set APP_DOMAIN and UPSTREAM_DNS first." >&2; exit 1; }
ip -4 addr show | grep -Fq "${SITE_IP}/"
command -v dig >/dev/null || { echo "Install dnsutils first." >&2; exit 1; }
if ss -H -lntu 'sport = :53' | awk '{print $5}' | grep -Fx -e "$SITE_IP:53" -e '0.0.0.0:53' -e '*:53' -e '[::]:53'; then
  echo 'LAN DNS port is already occupied; inspect before installing.' >&2; exit 1
fi
test ! -e /etc/local-sites/dnsmasq.conf
test ! -e /etc/systemd/system/local-sites-dns.service
dig @"$UPSTREAM_DNS" example.com A +time=3 +tries=1 +short | grep -Eq '^[0-9]+\.'
backup="/var/backups/local-sites-dns-$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "$backup"
ip -4 addr show > "$backup/ip-address.txt"
ip route > "$backup/routes.txt"
resolvectl dns > "$backup/upstream-dns.txt"
iptables-save > "$backup/iptables-before.txt"
cp -a /etc/netplan "$backup/netplan"
apt-get update
apt-get install -y dnsmasq-base
install -d -m 0755 /etc/local-sites
install -m 0600 deploy/.env /etc/local-sites/local-sites.env
install -m 0644 scripts/load-config.sh /usr/local/sbin/local-sites-config
cat > /etc/local-sites/dnsmasq.conf <<EOF
port=53
listen-address=$SITE_IP
bind-interfaces
no-resolv
no-hosts
server=$UPSTREAM_DNS
local=/$APP_DOMAIN/
address=/$APP_DOMAIN/$SITE_IP
domain-needed
cache-size=1000
EOF
/usr/sbin/dnsmasq --test --conf-file=/etc/local-sites/dnsmasq.conf
install -m 0755 scripts/dns-firewall.sh /usr/local/sbin/local-sites-dns-firewall
install -m 0644 deploy/local-sites-dns.service deploy/local-sites-dns-firewall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now local-sites-dns-firewall.service
systemctl enable --now local-sites-dns.service
test "$(dig @"$SITE_IP" "portal.$APP_DOMAIN" A +short)" = "$SITE_IP"
test "$(dig @"$SITE_IP" "portal.$APP_DOMAIN" A +tcp +short)" = "$SITE_IP"
dig @"$SITE_IP" example.com A +short | grep -Eq '^[0-9]+\.'
echo "DNS ready. Backup: $backup"
