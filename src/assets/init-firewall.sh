#!/usr/bin/env bash
set -euo pipefail

PROXY_PORT=8080

# Flush existing rules
iptables -F OUTPUT
iptables -F INPUT

# Default policy: DROP all outbound
iptables -P OUTPUT DROP

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS to Docker's embedded resolver
iptables -A OUTPUT -p udp --dport 53 -d 127.0.0.11 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -d 127.0.0.11 -j ACCEPT

# Allow traffic to proxy only
PROXY_IP=$(getent hosts proxy | awk '{print $1}')
if [ -n "$PROXY_IP" ]; then
    iptables -A OUTPUT -p tcp -d "$PROXY_IP" --dport "$PROXY_PORT" -j ACCEPT
fi

# Everything else is DROPped by policy

echo "Firewall initialized: proxy=$PROXY_IP:$PROXY_PORT, default=DROP"
