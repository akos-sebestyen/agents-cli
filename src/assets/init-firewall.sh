#!/usr/bin/env bash
set -euo pipefail

PROXY_PORT=8080

iptables -F OUTPUT
iptables -F INPUT

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT

iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

iptables -A OUTPUT -p udp --dport 53 -d 127.0.0.11 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -d 127.0.0.11 -j ACCEPT

PROXY_IP=$(getent hosts proxy | awk '{print $1}')
if [ -n "$PROXY_IP" ]; then
    iptables -A OUTPUT -p tcp -d "$PROXY_IP" --dport "$PROXY_PORT" -j ACCEPT
fi

iptables -A OUTPUT -d 10.0.0.0/8 -j DROP
iptables -A OUTPUT -d 172.16.0.0/12 -j DROP
iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
iptables -A OUTPUT -d 169.254.0.0/16 -j DROP

iptables -A OUTPUT -p tcp --dport 80 -j DROP
iptables -A OUTPUT -p tcp --dport 443 -j DROP

iptables -A OUTPUT -j ACCEPT

echo "Firewall initialized: proxy=$PROXY_IP:$PROXY_PORT, local network blocked"
