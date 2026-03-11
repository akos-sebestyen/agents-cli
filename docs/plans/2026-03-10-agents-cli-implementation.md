# agents-cli Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the scaffolded agents-cli into a self-contained CLI that embeds all Docker infrastructure and launches sandboxed research agents against any codebase.

**Architecture:** The CLI embeds Docker assets (Dockerfile, shell scripts, proxy addon) as string imports. At launch time it: (1) ensures the sandbox image exists (content-hash tagged), (2) generates a docker-compose YAML with the user's mount points, (3) generates a layered CLAUDE.md, (4) runs `docker compose run`. Config lives at `~/.agents-cli/config.json`.

**Tech Stack:** Bun, TypeScript, Commander, Dockerode, Docker Compose CLI

**Spec:** `docs/specs/2026-03-10-agents-cli-design.md`

---

## File Structure

### New files to create

| File | Responsibility |
|------|---------------|
| `src/assets/Dockerfile` | Generic sandbox image definition (no project-specific COPY) |
| `src/assets/entrypoint.sh` | Container startup: CA trust, firewall, config copy, browser pre-launch |
| `src/assets/init-firewall.sh` | iptables rules: proxy enforcement + LAN block |
| `src/assets/block-write-methods.py` | mitmproxy addon: GET-only except Anthropic API hosts |
| `src/lib/config.ts` | `~/.agents-cli/config.json` read/write/defaults |
| `src/lib/image.ts` | Build/check sandbox image with content-hash tagging |
| `src/lib/claude-md.ts` | Generate CLAUDE.md with system header + optional user content |
| `src/commands/config.ts` | `config` and `config set` commands |

### Existing files to modify

| File | Changes |
|------|---------|
| `src/cli.ts` | Add `config` command import |
| `src/lib/compose.ts` | Complete rewrite: generate compose YAML at runtime, remove project-dir dependency |
| `src/lib/docker.ts` | Filter by `com.agents-cli.managed` label, add `codebase` field |
| `src/commands/launch.ts` | New API: `[path]`, `--output`, `--claude-md`, `--prompt`, `--model` |
| `src/commands/resume.ts` | New API: `[container-id]`, `--prompt`, `--model` (no project-dir) |
| `src/commands/list.ts` | Add `CODEBASE` column, use label-based filtering |
| `src/commands/clean.ts` | Remove project-dir arg, use label-based container cleanup with `--force` |

### Unchanged files (already working)

| File | Status |
|------|--------|
| `src/commands/logs.ts` | Already ported, works with label-based containers (uses `listAgentContainers` which we update) |
| `src/commands/dashboard.ts` | Already ported, works with label-based containers (same reason) |
| `src/dashboard/server.ts` | Already ported from science project `agent-monitor/` |
| `src/dashboard/index.html` | Already ported |

These files use `listAgentContainers()` and `streamContainerLogs()` from `docker.ts`. Once `docker.ts` is updated with label-based filtering (Task 7), they work automatically.

---

## Chunk 1: Config + Docker Assets

### Task 1: Config management (`src/lib/config.ts`)

**Files:**
- Create: `src/lib/config.ts`

- [ ] **Step 1: Create config module**

```ts
// src/lib/config.ts
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".agents-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface Config {
  claudeConfig: string;
  defaultModel: string;
}

const DEFAULTS: Config = {
  claudeConfig: join(homedir(), ".claude"),
  defaultModel: "claude-sonnet-4-6",
};

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(
      readFileSync(CONFIG_PATH, "utf-8"),
    );
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function resolveClaudeConfig(config: Config): string {
  return config.claudeConfig;
}
```

- [ ] **Step 2: Verify config module loads**

Run: `cd /home/akos/projects/agents-cli && bun -e "import { loadConfig } from './src/lib/config.ts'; console.log(loadConfig())"`

Expected: prints default config object with `claudeConfig` and `defaultModel`

- [ ] **Step 3: Commit**

```bash
git add src/lib/config.ts
git commit -m "feat: add config management for ~/.agents-cli/config.json"
```

### Task 2: Config command (`src/commands/config.ts`)

**Files:**
- Create: `src/commands/config.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create config command**

```ts
// src/commands/config.ts
import { Command } from "commander";
import { loadConfig, saveConfig } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";

const VALID_KEYS: (keyof Config)[] = ["claudeConfig", "defaultModel"];

export const configCommand = new Command("config")
  .description("Manage agents-cli configuration")
  .action(() => {
    const config = loadConfig();
    for (const [key, value] of Object.entries(config)) {
      console.log(`${key} = ${value}`);
    }
  });

configCommand
  .command("set <key> <value>")
  .description("Set a config value")
  .action((key: string, value: string) => {
    if (!VALID_KEYS.includes(key as keyof Config)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Valid keys: ${VALID_KEYS.join(", ")}`);
      process.exit(1);
    }
    const config = loadConfig();
    (config as Record<string, string>)[key] = value;
    saveConfig(config);
    console.log(`${key} = ${value}`);
  });
```

- [ ] **Step 2: Register config command in cli.ts**

Add to `src/cli.ts`:
```ts
import { configCommand } from "./commands/config.ts";
// ... after other addCommand calls:
program.addCommand(configCommand);
```

- [ ] **Step 3: Verify commands work**

Run: `bun src/cli.ts config`
Expected: prints default config values

Run: `bun src/cli.ts config set defaultModel claude-opus-4-6`
Expected: prints `defaultModel = claude-opus-4-6`

Run: `bun src/cli.ts config`
Expected: shows updated defaultModel

Run: `rm -f ~/.agents-cli/config.json` (cleanup)

- [ ] **Step 4: Commit**

```bash
git add src/commands/config.ts src/cli.ts
git commit -m "feat: add config command for managing ~/.agents-cli/config.json"
```

### Task 3: Embed Docker assets (`src/assets/`)

**Files:**
- Create: `src/assets/Dockerfile`
- Create: `src/assets/entrypoint.sh`
- Create: `src/assets/init-firewall.sh`
- Create: `src/assets/block-write-methods.py`

The assets are adapted from `~/projects/science-immunogenecity/docker/agent/`. Key changes from the originals:

**Dockerfile changes:**
- COPY paths assume files are in the build context root (not `docker/agent/` subdirectory)

**entrypoint.sh changes:**
- Reduce cert wait from 30s to 10s (proxy healthcheck handles readiness now)
- Copy Claude config to `~/.claude` (not `~/.claude-personal`) for standard Claude Code behavior
- Remove the `CLAUDE.md` copy step (CLAUDE.md is mounted directly by compose)
- Remove the `data/agent-output` symlink (not needed — output is at `/workspace/output/` directly)
- Simplify startup message

- [ ] **Step 1: Create Dockerfile**

```dockerfile
# src/assets/Dockerfile
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
RUN mkdir -p /workspace && chown claude:claude /workspace

USER claude
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions"]
```

- [ ] **Step 2: Create entrypoint.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

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

# Trust the mitmproxy CA cert system-wide
sudo /usr/bin/cp /mitmproxy-certs/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy.crt
sudo /usr/sbin/update-ca-certificates 2>/dev/null

# Initialize firewall
sudo /usr/local/bin/init-firewall.sh

# Copy Claude config from read-only mount to writable ~/.claude
if [ -d /home/claude/.claude-config-ro ] && [ ! -f /home/claude/.claude/.copied ]; then
    mkdir -p /home/claude/.claude
    cp -a /home/claude/.claude-config-ro/. /home/claude/.claude/
    touch /home/claude/.claude/.copied
fi

# Pre-launch agent-browser with --ignore-https-errors (mitmproxy certs)
agent-browser open "about:blank" --ignore-https-errors >/dev/null 2>&1 &
sleep 2

cd /workspace

echo "Research agent ready. Output: /workspace/output/"
echo ""

exec "$@"
```

- [ ] **Step 3: Create init-firewall.sh**

Copy unchanged from science project:

```bash
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
```

- [ ] **Step 4: Create block-write-methods.py**

Copy unchanged from science project:

```python
"""mitmproxy addon: block write HTTP methods except to whitelisted hosts."""

from mitmproxy import http, ctx

ALLOWED_METHODS = {"GET", "HEAD", "OPTIONS", "CONNECT"}

WRITE_ALLOWED_HOSTS = {
    "api.anthropic.com",
    "api.claude.ai",
    "auth.anthropic.com",
    "statsig.anthropic.com",
    "sentry.io",
}


class BlockWriteMethods:
    def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.method in ALLOWED_METHODS:
            return
        if any(flow.request.host.endswith(h) for h in WRITE_ALLOWED_HOSTS):
            return
        ctx.log.warn(f"BLOCKED {flow.request.method} {flow.request.url}")
        flow.response = http.Response.make(
            403, b"Blocked by sandbox: write methods not allowed"
        )


addons = [BlockWriteMethods()]
```

- [ ] **Step 5: Verify assets are importable by Bun**

Run: `cd /home/akos/projects/agents-cli && bun -e "import df from './src/assets/Dockerfile' with { type: 'text' }; console.log(df.slice(0, 30))"`

Expected: `FROM node:22-bookworm`

- [ ] **Step 6: Commit**

```bash
git add src/assets/
git commit -m "feat: add embedded Docker assets for sandbox image"
```

---

## Chunk 2: Image Builder + CLAUDE.md Generator

### Task 4: Image builder (`src/lib/image.ts`)

**Files:**
- Create: `src/lib/image.ts`

This module computes a content hash of all four embedded assets, checks if the Docker image `agents-cli-sandbox:<hash>` exists locally, and builds it if not.

- [ ] **Step 1: Create image builder**

```ts
// src/lib/image.ts
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";

import DOCKERFILE from "../assets/Dockerfile" with { type: "text" };
import ENTRYPOINT from "../assets/entrypoint.sh" with { type: "text" };
import FIREWALL from "../assets/init-firewall.sh" with { type: "text" };
import PROXY_FILTER from "../assets/block-write-methods.py" with { type: "text" };

const IMAGE_NAME = "agents-cli-sandbox";

// Hash all assets in alphabetical order by filename
const ASSETS = [
  { name: "block-write-methods.py", content: PROXY_FILTER },
  { name: "Dockerfile", content: DOCKERFILE },
  { name: "entrypoint.sh", content: ENTRYPOINT },
  { name: "init-firewall.sh", content: FIREWALL },
];

function computeHash(): string {
  const hasher = createHash("sha256");
  for (const asset of ASSETS) {
    hasher.update(asset.content);
  }
  return hasher.digest("hex").slice(0, 12);
}

export function getImageTag(): string {
  return `${IMAGE_NAME}:${computeHash()}`;
}

export async function ensureImage(): Promise<string> {
  const tag = getImageTag();

  // Check if image exists locally
  const result = await $`docker image inspect ${tag}`.quiet().nothrow();
  if (result.exitCode === 0) {
    return tag;
  }

  console.log(`Building sandbox image ${tag}...`);

  // Write assets to temp dir
  const buildDir = mkdtempSync(join(tmpdir(), "agents-cli-build-"));
  for (const asset of ASSETS) {
    writeFileSync(join(buildDir, asset.name), asset.content);
  }

  // Build
  const build = await $`docker build -t ${tag} -f ${join(buildDir, "Dockerfile")} ${buildDir}`;
  if (build.exitCode !== 0) {
    console.error("Failed to build sandbox image");
    process.exit(1);
  }

  console.log(`Built ${tag}`);
  return tag;
}
```

- [ ] **Step 2: Verify hash computation**

Run: `bun -e "import { getImageTag } from './src/lib/image.ts'; console.log(getImageTag())"`

Expected: prints `agents-cli-sandbox:<12-char-hex>` — a stable hash that only changes if assets change

- [ ] **Step 3: Commit**

```bash
git add src/lib/image.ts
git commit -m "feat: add image builder with content-hash tagging"
```

### Task 5: CLAUDE.md generator (`src/lib/claude-md.ts`)

**Files:**
- Create: `src/lib/claude-md.ts`

Generates the CLAUDE.md that gets mounted into the container. System header is always present. User content from `--claude-md` is appended after a `---` separator.

- [ ] **Step 1: Create CLAUDE.md generator**

```ts
// src/lib/claude-md.ts
import { readFileSync } from "node:fs";

const SYSTEM_HEADER = `# Research Agent Instructions

You are a research agent running inside a sandboxed container. Your job is to conduct web research and write findings to \`/workspace/output/\`.

## Environment

- **Codebase:** \`/workspace/\` (read-only) — the mounted project you're researching
- **Output:** \`/workspace/output/\` (read-write) — write ALL results here
- **Network:** GET-only through proxy, local network blocked
- You are inside a Docker container with restricted network access

## Web Access Tools

You have several ways to access the internet:

1. **\`agent-browser\`** (primary) — headless browser via CLI. Best for navigating JS-heavy portals, multi-step interactions, and extracting structured data from complex pages.
2. **\`WebSearch\`** — quick keyword searches to find URLs or get an overview before diving deeper.
3. **\`WebFetch\`** — fetch a single URL's content. Good for simple pages or raw text.
4. **\`curl\`** — available via Bash. Good for REST API JSON responses, downloading files, and simple HTTP requests.
5. **Python \`requests\`/\`httpx\`** — available via \`python3 -c\` or scripts. Useful for scripting data extraction from APIs.

The proxy CA cert is trusted system-wide, so \`curl\`, Python HTTP libraries, and \`agent-browser\` all work through the proxy.

## How to Browse the Web

The browser is pre-launched with \`--ignore-https-errors\`. Just use \`agent-browser\` commands directly:

\`\`\`bash
# Navigate to a page
agent-browser open "https://example.com" && agent-browser wait --load networkidle && agent-browser snapshot -ic

# snapshot -ic shows interactive elements with @ref IDs (e.g., @e1, @e2)
# Use @refs to interact:
agent-browser fill @e3 "search term"
agent-browser click @e5

# Wait after navigation/clicks that trigger page loads
agent-browser wait --load networkidle && agent-browser snapshot -ic

# Get text content from an element
agent-browser get text @e7

# Download a file
agent-browser download @e12 /workspace/output/

# Run JavaScript to extract structured data
agent-browser eval "JSON.stringify([...document.querySelectorAll('tr')].map(r => r.textContent))"

# Full-page screenshot
agent-browser screenshot --full /workspace/output/page.png

# Close when done
agent-browser close
\`\`\`

**Tips:**
- Always \`wait --load networkidle\` after \`open\` on JS-heavy sites
- Use \`snapshot -ic\` (interactive + compact) to get a manageable element tree
- Chain commands with \`&&\`
- Use \`--session <name>\` to isolate concurrent browsing sessions

## Output Guidelines

- Write findings as markdown files to \`/workspace/output/\`
- Use descriptive filenames (e.g., \`api-security-audit.md\`, \`competitor-analysis.md\`)
- Include sources/URLs for all claims
- Structure output with clear headings and sections
- If you download data files, save them to \`/workspace/output/\` too

## Rules

- Do NOT modify the codebase — it is read-only
- Write ALL output to \`/workspace/output/\`
- Do NOT spawn nested agents or use the Agent tool for web research
- Only GET requests are allowed — POST/PUT/DELETE/PATCH are blocked by the proxy
- Focus on your research task`;

export function generateClaudeMd(userContentPath?: string): string {
  let content = SYSTEM_HEADER;

  if (userContentPath) {
    const userContent = readFileSync(userContentPath, "utf-8");
    content += "\n\n---\n\n" + userContent;
  }

  return content;
}
```

- [ ] **Step 2: Verify generation without user content**

Run: `bun -e "import { generateClaudeMd } from './src/lib/claude-md.ts'; console.log(generateClaudeMd().slice(0, 80))"`

Expected: `# Research Agent Instructions`

- [ ] **Step 3: Verify generation with user content**

Run: `bun -e "import { generateClaudeMd } from './src/lib/claude-md.ts'; const fs = require('fs'); fs.writeFileSync('/tmp/test-claude.md', '# My Project\nDo research on X.'); console.log(generateClaudeMd('/tmp/test-claude.md').includes('My Project'))"`

Expected: `true`

- [ ] **Step 4: Commit**

```bash
git add src/lib/claude-md.ts
git commit -m "feat: add CLAUDE.md generator with system header + user content layering"
```

---

## Chunk 3: Compose Generator + Launch Rewrite

### Task 6: Rewrite compose module (`src/lib/compose.ts`)

**Files:**
- Modify: `src/lib/compose.ts` (complete rewrite)

The new compose module generates a docker-compose YAML at runtime based on launch options. No more static compose file or project-dir dependency.

- [ ] **Step 1: Rewrite compose.ts**

Replace the entire contents of `src/lib/compose.ts` with:

```ts
// src/lib/compose.ts
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { $ } from "bun";

import { ensureImage, getImageTag } from "./image.ts";
import { generateClaudeMd } from "./claude-md.ts";
import { loadConfig, resolveClaudeConfig } from "./config.ts";
import PROXY_FILTER from "../assets/block-write-methods.py" with { type: "text" };

export interface LaunchOptions {
  /** Codebase path to mount read-only (absolute) */
  codebasePath: string;
  /** Writable output dir (absolute) */
  outputPath: string;
  /** Path to user's CLAUDE.md override (absolute, optional) */
  claudeMdPath?: string;
  /** Prompt (undefined = interactive) */
  prompt?: string;
  /** Model override */
  model?: string;
}

/** Derive a stable compose project name from the codebase path. */
function projectName(codebasePath: string): string {
  const hash = createHash("sha256")
    .update(codebasePath)
    .digest("hex")
    .slice(0, 8);
  return `agents-cli-${hash}`;
}

function generateComposeYaml(opts: {
  imageTag: string;
  codebasePath: string;
  outputPath: string;
  claudeMdFile: string;
  claudeConfigDir: string;
  proxyFilterFile: string;
  model: string;
}): string {
  const timestamp = new Date().toISOString();
  return `services:
  proxy:
    image: mitmproxy/mitmproxy:11
    command: mitmdump -s /scripts/block-write-methods.py --set block_global=false
    volumes:
      - ${opts.proxyFilterFile}:/scripts/block-write-methods.py:ro
      - mitmproxy-certs:/home/mitmproxy/.mitmproxy
    networks:
      - agent-net
    healthcheck:
      test: ["CMD", "ls", "/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem"]
      interval: 1s
      retries: 30

  agent:
    image: ${opts.imageTag}
    depends_on:
      proxy:
        condition: service_healthy
    cap_add:
      - NET_ADMIN
      - NET_RAW
    volumes:
      - ${opts.codebasePath}:/workspace:ro
      - ${opts.outputPath}:/workspace/output:rw
      - ${opts.claudeMdFile}:/workspace/CLAUDE.md:ro
      - ${opts.claudeConfigDir}:/home/claude/.claude-config-ro:ro
      - mitmproxy-certs:/mitmproxy-certs:ro
    environment:
      - http_proxy=http://proxy:8080
      - https_proxy=http://proxy:8080
      - HTTP_PROXY=http://proxy:8080
      - HTTPS_PROXY=http://proxy:8080
      - NODE_EXTRA_CA_CERTS=/mitmproxy-certs/mitmproxy-ca-cert.pem
      - REQUESTS_CA_BUNDLE=/mitmproxy-certs/mitmproxy-ca-cert.pem
      - SSL_CERT_FILE=/mitmproxy-certs/mitmproxy-ca-cert.pem
      - CLAUDE_CONFIG_DIR=/home/claude/.claude
      - CLAUDE_MODEL=${opts.model}
    labels:
      - com.agents-cli.managed=true
      - com.agents-cli.codebase=${opts.codebasePath}
      - com.agents-cli.launched=${timestamp}
    networks:
      - agent-net
    stdin_open: true
    tty: true

volumes:
  mitmproxy-certs:

networks:
  agent-net:
`;
}

/** Launch a new agent container. */
export async function launchAgent(opts: LaunchOptions): Promise<void> {
  const config = loadConfig();
  const model = opts.model ?? config.defaultModel;
  const claudeConfigDir = resolveClaudeConfig(config);

  // Ensure sandbox image exists
  const imageTag = await ensureImage();

  // Ensure output dir exists
  mkdirSync(opts.outputPath, { recursive: true });

  // Generate CLAUDE.md to a temp file
  const claudeMdContent = generateClaudeMd(opts.claudeMdPath);
  const tmpDir = mkdtempSync(join(tmpdir(), "agents-cli-"));
  const claudeMdFile = join(tmpDir, "CLAUDE.md");
  writeFileSync(claudeMdFile, claudeMdContent);

  // Write proxy filter to temp dir (needs to be a file for the volume mount)
  const proxyFilterFile = join(tmpDir, "block-write-methods.py");
  writeFileSync(proxyFilterFile, PROXY_FILTER);

  // Generate compose YAML
  const composeYaml = generateComposeYaml({
    imageTag,
    codebasePath: opts.codebasePath,
    outputPath: opts.outputPath,
    claudeMdFile,
    claudeConfigDir,
    proxyFilterFile,
    model,
  });
  const composeFile = join(tmpDir, "docker-compose.yml");
  writeFileSync(composeFile, composeYaml);

  const project = projectName(opts.codebasePath);

  // Build claude args
  const claudeArgs = [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    model,
  ];
  if (opts.prompt) {
    claudeArgs.push(
      "--output-format", "stream-json",
      "--verbose",
      "-p", opts.prompt,
    );
  }

  const proc = Bun.spawn(
    [
      "docker", "compose",
      "-f", composeFile,
      "-p", project,
      "run",
      "agent",
      ...claudeArgs,
    ],
    {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env },
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/** Resume the most recent (or specified) agent container. */
export async function resumeAgent(opts: {
  containerId?: string;
  prompt?: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  const model = opts.model ?? config.defaultModel;

  let containerId = opts.containerId;

  if (!containerId) {
    // Find most recent agents-cli container
    const { listAgentContainers } = await import("./docker.ts");
    const containers = await listAgentContainers();
    if (containers.length === 0) {
      console.error("No previous agent container found. Run 'launch' first.");
      process.exit(1);
    }
    containerId = containers[0]!.id;
    console.log(`Resuming ${containers[0]!.name} (${containers[0]!.shortId})`);
  }

  // Check state and start if exited
  const inspectResult = await $`docker inspect -f '{{.State.Status}}' ${containerId}`.quiet().nothrow();
  if (inspectResult.exitCode !== 0) {
    console.error(`Container ${containerId} not found.`);
    process.exit(1);
  }

  const state = inspectResult.text().trim();
  if (state === "exited") {
    await $`docker start ${containerId}`.quiet();
  }

  const claudeArgs = [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    model,
  ];
  if (opts.prompt) {
    claudeArgs.push(
      "--output-format", "stream-json",
      "--verbose",
      "-p", opts.prompt,
    );
  }

  const proc = Bun.spawn(
    ["docker", "exec", "-it", containerId, ...claudeArgs],
    { stdio: ["inherit", "inherit", "inherit"] },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/** Stop and remove all agents-cli managed containers + associated volumes/networks. */
export async function cleanAgents(): Promise<void> {
  const { listAgentContainers } = await import("./docker.ts");
  const containers = await listAgentContainers();

  if (containers.length === 0) {
    console.log("No agent containers to clean.");
    return;
  }

  // Collect unique compose project names from container names (e.g., "agents-cli-abcd1234-agent-run-xyz")
  const projects = new Set<string>();
  for (const c of containers) {
    // Container names follow pattern: <project>-agent-run-<id> or <project>-proxy-<n>
    const match = c.name.match(/^(agents-cli-[a-f0-9]+)/);
    if (match) projects.add(match[1]);
  }

  for (const c of containers) {
    if (c.state === "running") {
      await $`docker stop ${c.id}`.quiet();
    }
    await $`docker rm ${c.id}`.quiet();
    console.log(`Removed ${c.name} (${c.shortId})`);
  }

  // Clean up compose volumes and networks for each project
  for (const project of projects) {
    await $`docker volume rm ${project}_mitmproxy-certs`.quiet().nothrow();
    await $`docker network rm ${project}_agent-net`.quiet().nothrow();
  }

  console.log(`Cleaned ${containers.length} container(s), ${projects.size} project(s).`);
}
```

- [ ] **Step 2: Verify compose YAML generation**

Run: `bun -e "
import { createHash } from 'node:crypto';
// Just verify the module imports cleanly
import './src/lib/compose.ts';
console.log('compose module loaded');
"`

Expected: `compose module loaded`

- [ ] **Step 3: Commit**

```bash
git add src/lib/compose.ts
git commit -m "feat: rewrite compose module with runtime YAML generation and label-based tracking"
```

### Task 7: Update docker.ts for label-based filtering

**Files:**
- Modify: `src/lib/docker.ts`

- [ ] **Step 1: Update AgentContainer interface and listAgentContainers**

In `src/lib/docker.ts`, make these changes:

1. Add `codebase` field to `AgentContainer`:
```ts
export interface AgentContainer {
  id: string;
  shortId: string;
  name: string;
  status: string;
  state: string;
  created: string;
  image: string;
  codebase: string;  // ADD THIS
}
```

2. Replace `listAgentContainers` to filter by label instead of name matching:
```ts
const MANAGED_LABEL = "com.agents-cli.managed";

export async function listAgentContainers(): Promise<AgentContainer[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${MANAGED_LABEL}=true`] },
  });
  const agents: AgentContainer[] = [];

  for (const c of containers) {
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    agents.push({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name,
      status: c.Status ?? "",
      state: c.State ?? "",
      created: new Date(c.Created * 1000).toISOString(),
      image: c.Image,
      codebase: c.Labels?.["com.agents-cli.codebase"] ?? "",
    });
  }

  agents.sort((a, b) => {
    if (a.state === "running" && b.state !== "running") return -1;
    if (a.state !== "running" && b.state === "running") return 1;
    return b.created.localeCompare(a.created);
  });

  return agents;
}
```

3. Remove the unused `AGENT_SERVICE` constant and `getContainer` function.

- [ ] **Step 2: Verify it still works**

Run: `bun src/cli.ts list`

Expected: either shows containers (if any have the label) or `No agent containers found.` — no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/docker.ts
git commit -m "feat: filter agent containers by com.agents-cli.managed label"
```

### Task 8: Rewrite command files

**Files:**
- Modify: `src/commands/launch.ts`
- Modify: `src/commands/resume.ts`
- Modify: `src/commands/list.ts`
- Modify: `src/commands/clean.ts`

- [ ] **Step 1: Rewrite launch.ts**

Replace entire contents:

```ts
// src/commands/launch.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { launchAgent } from "../lib/compose.ts";

export const launchCommand = new Command("launch")
  .description("Launch a new sandboxed research agent")
  .argument("[path]", "Codebase to mount read-only", ".")
  .option("--output <path>", "Writable output dir", "./agent-output")
  .option("--claude-md <path>", "CLAUDE.md override — appended after system header")
  .option("-p, --prompt <prompt>", "Research prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .action(async (path: string, opts: {
    output: string;
    claudeMd?: string;
    prompt?: string;
    model?: string;
  }) => {
    const codebasePath = resolve(path);
    const outputPath = resolve(opts.output);

    if (!existsSync(codebasePath)) {
      console.error(`Codebase path does not exist: ${codebasePath}`);
      process.exit(1);
    }

    let claudeMdPath: string | undefined;
    if (opts.claudeMd) {
      claudeMdPath = resolve(opts.claudeMd);
      if (!existsSync(claudeMdPath)) {
        console.error(`CLAUDE.md file not found: ${claudeMdPath}`);
        process.exit(1);
      }
    }

    await launchAgent({
      codebasePath,
      outputPath,
      claudeMdPath,
      prompt: opts.prompt,
      model: opts.model,
    });
  });
```

- [ ] **Step 2: Rewrite resume.ts**

Replace entire contents:

```ts
// src/commands/resume.ts
import { Command } from "commander";
import { resumeAgent } from "../lib/compose.ts";

export const resumeCommand = new Command("resume")
  .description("Resume an agent container")
  .argument("[container-id]", "Container to resume (default: most recent)")
  .option("-p, --prompt <prompt>", "Follow-up prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .action(async (containerId: string | undefined, opts: {
    prompt?: string;
    model?: string;
  }) => {
    await resumeAgent({
      containerId,
      prompt: opts.prompt,
      model: opts.model,
    });
  });
```

- [ ] **Step 3: Rewrite list.ts**

Replace entire contents:

```ts
// src/commands/list.ts
import { Command } from "commander";
import { listAgentContainers } from "../lib/docker.ts";

export const listCommand = new Command("list")
  .alias("ls")
  .description("List agent containers")
  .action(async () => {
    const agents = await listAgentContainers();

    if (agents.length === 0) {
      console.log("No agent containers found.");
      return;
    }

    console.log(
      `${"ID".padEnd(14)} ${"STATUS".padEnd(12)} ${"CODEBASE".padEnd(30)} ${"CREATED".padEnd(22)} NAME`,
    );
    console.log("-".repeat(100));

    for (const a of agents) {
      const created = new Date(a.created).toLocaleString();
      const stateColor = a.state === "running" ? "\x1b[32m" : "\x1b[90m";
      const codebase = a.codebase.length > 28
        ? "..." + a.codebase.slice(-25)
        : a.codebase;
      console.log(
        `${a.shortId.padEnd(14)} ${stateColor}${a.state.padEnd(12)}\x1b[0m ${codebase.padEnd(30)} ${created.padEnd(22)} ${a.name}`,
      );
    }
  });
```

- [ ] **Step 4: Rewrite clean.ts**

Replace entire contents:

```ts
// src/commands/clean.ts
import { Command } from "commander";
import { cleanAgents } from "../lib/compose.ts";

export const cleanCommand = new Command("clean")
  .description("Stop and remove all agent containers")
  .option("--force", "Skip confirmation prompt", false)
  .action(async (opts: { force: boolean }) => {
    if (!opts.force) {
      const { listAgentContainers } = await import("../lib/docker.ts");
      const containers = await listAgentContainers();
      if (containers.length === 0) {
        console.log("No agent containers to clean.");
        return;
      }
      console.log(`This will remove ${containers.length} container(s):`);
      for (const c of containers) {
        console.log(`  ${c.shortId} ${c.state.padEnd(10)} ${c.name}`);
      }
      process.stdout.write("\nContinue? [y/N] ");
      const line = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
      });
      if (line.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }
    await cleanAgents();
  });
```

- [ ] **Step 5: Verify CLI help output**

Run: `bun src/cli.ts --help`

Expected: shows all commands including `config`

Run: `bun src/cli.ts launch --help`

Expected: shows `[path]`, `--output`, `--claude-md`, `--prompt`, `--model`

Run: `bun src/cli.ts resume --help`

Expected: shows `[container-id]`, `--prompt`, `--model`

- [ ] **Step 6: Commit**

```bash
git add src/commands/launch.ts src/commands/resume.ts src/commands/list.ts src/commands/clean.ts
git commit -m "feat: rewrite commands for new API (label-based, no project-dir)"
```

---

## Chunk 4: End-to-End Test + Build

### Task 9: End-to-end smoke test

This is a manual verification task — launch the agent against the science project to confirm everything works together.

- [ ] **Step 1: Verify CLI loads without errors**

Run: `cd /home/akos/projects/agents-cli && bun src/cli.ts --help`

Expected: clean help output, no import errors

- [ ] **Step 2: Test image build**

Run: `bun src/cli.ts launch ~/projects/science-immunogenecity --prompt "List the files in /workspace/ and /workspace/output/ and write a test file to /workspace/output/test.txt"`

Expected:
1. First run: builds `agents-cli-sandbox:<hash>` image (takes a few minutes)
2. Starts proxy + agent containers
3. Agent runs Claude, writes test file
4. Container exits, test.txt appears in `./agent-output/`

- [ ] **Step 3: Verify label-based listing**

Run: `bun src/cli.ts list`

Expected: shows the container from step 2 with codebase path and `com.agents-cli.managed` label

- [ ] **Step 4: Test with --claude-md**

Create a minimal test file:
```bash
echo "# Test Project\nResearch test — just list the tools you have available." > /tmp/test-research.md
```

Run: `bun src/cli.ts launch ~/projects/science-immunogenecity --claude-md /tmp/test-research.md --prompt "What tools do you have? Write a summary to /workspace/output/tools.md"`

Expected: agent sees both system header AND user content in its CLAUDE.md

- [ ] **Step 5: Test clean**

Run: `bun src/cli.ts clean --force`

Expected: removes all agents-cli containers

- [ ] **Step 6: Rebuild binary**

Run: `./install.sh`

Expected: builds and installs to `~/.local/bin/agents-cli`

Run: `agents-cli --help`

Expected: same output as `bun src/cli.ts --help`

- [ ] **Step 7: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```

### Task 10: Update CLAUDE.md for the agents-cli project

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update project CLAUDE.md**

Replace the contents of `CLAUDE.md` with project-specific instructions that reflect the new architecture:

```markdown
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Project

CLI tool for launching sandboxed Claude research agents in Docker. Compiles to a single binary via `bun build --compile`.

## Key Architecture

- Docker assets (Dockerfile, shell scripts, proxy addon) are embedded as string imports via `with { type: "text" }`
- Docker compose YAML is generated at runtime (no static compose file)
- Containers are tracked via Docker labels (`com.agents-cli.managed`)
- Config lives at `~/.agents-cli/config.json`

## Build & Install

```bash
./install.sh          # builds binary to ~/.local/bin/agents-cli
bun src/cli.ts        # run from source during development
```

## Testing

```bash
bun test              # unit tests
agents-cli launch .   # smoke test (launches agent against cwd)
```
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for new architecture"
```
