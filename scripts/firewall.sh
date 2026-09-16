#!/usr/bin/env bash
set -euo pipefail
source /usr/local/sbin/local-sites-config
load_config /etc/local-sites/local-sites.env
# Only original-direction traffic to local-sites' published app ports is affected.
rule=(-p tcp ! -s "$LAN_CIDR" -m conntrack --ctdir ORIGINAL --ctorigdst "$SITE_IP" --ctorigdstport 18000:18999 -j DROP)
iptables -w -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -w -I DOCKER-USER 1 "${rule[@]}"
