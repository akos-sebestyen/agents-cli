FROM node:22-bookworm

# System deps: iptables, Chromium deps, Python, CA certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables iproute2 sudo ca-certificates curl \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 libwayland-client0 \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx

# Install Claude Code and agent-browser globally
RUN npm install -g @anthropic-ai/claude-code agent-browser

# Non-root user
RUN usermod -l claude -d /home/claude -m node \
    && groupmod -n claude node \
    && echo "claude ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/sbin/update-ca-certificates, /usr/bin/cp" >> /etc/sudoers.d/claude

# Install Chromium
USER claude
RUN agent-browser install --with-deps
USER root

# Copy scripts
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/entrypoint.sh

# Writable workspace
RUN mkdir -p /workspace /home/claude/output && chown claude:claude /workspace /home/claude/output

WORKDIR /workspace

# Entrypoint runs as root for firewall setup, drops to claude user at the end
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions"]
