#!/usr/bin/env bash
set -euo pipefail

# Entrypoint runs as root to perform privileged operations,
# then drops to claude user with NET_ADMIN/NET_RAW removed.

# Safety net: wait for mitmproxy CA cert (proxy healthcheck should handle this)
echo "Waiting for mitmproxy CA cert..."
for i in $(seq 1 10); do
    if [ -f /mitmproxy-certs/mitmproxy-ca-cert.pem ]; then
        break
    fi
    sleep 1
done

if [ ! -f /mitmproxy-certs/mitmproxy-ca-cert.pem ]; then
    echo "ERROR: mitmproxy CA cert not found after 10s"
    exit 1
fi

# Trust the mitmproxy CA cert system-wide (running as root, no sudo needed)
cp /mitmproxy-certs/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy.crt
update-ca-certificates 2>/dev/null

# Initialize firewall (running as root, no sudo needed)
/usr/local/bin/init-firewall.sh

# Copy Claude config from read-only mount to writable ~/.claude
if [ -d /home/claude/.claude-config-ro ] && [ ! -f /home/claude/.claude/.copied ]; then
    su claude -c "mkdir -p /home/claude/.claude"
    su claude -c "cp -a /home/claude/.claude-config-ro/. /home/claude/.claude/"
    su claude -c "touch /home/claude/.claude/.copied"
fi

# Pre-launch agent-browser with --ignore-https-errors (mitmproxy certs)
su claude -c 'agent-browser open "about:blank" --ignore-https-errors >/dev/null 2>&1 &'
sleep 2

cd /workspace

echo "Research agent ready. Output: /home/claude/output/"
echo ""

# Drop to claude user, removing NET_ADMIN and NET_RAW capabilities
exec setpriv --reuid=claude --regid=claude --init-groups \
    --inh-caps=-cap_net_admin,-cap_net_raw \
    --bounding-set=-cap_net_admin,-cap_net_raw \
    "$@"
