#!/usr/bin/env bash
set -euo pipefail
source /usr/local/sbin/local-sites-config
load_config /etc/local-sites/local-sites.env
chain=LOCAL_SITES_DNS
if [ "${1:-start}" = stop ]; then
  iptables -w -C INPUT -d "$SITE_IP" -j "$chain" 2>/dev/null && iptables -w -D INPUT -d "$SITE_IP" -j "$chain"
  iptables -w -F "$chain"
  iptables -w -X "$chain"
  exit 0
fi
iptables -w -N "$chain" 2>/dev/null || true
for protocol in tcp udp; do
  iptables -w -C "$chain" -p "$protocol" --dport 53 -s "$LAN_CIDR" -j ACCEPT 2>/dev/null || iptables -w -A "$chain" -p "$protocol" --dport 53 -s "$LAN_CIDR" -j ACCEPT
  iptables -w -C "$chain" -p "$protocol" --dport 53 -j DROP 2>/dev/null || iptables -w -A "$chain" -p "$protocol" --dport 53 -j DROP
done
iptables -w -C INPUT -d "$SITE_IP" -j "$chain" 2>/dev/null || iptables -w -I INPUT 1 -d "$SITE_IP" -j "$chain"
