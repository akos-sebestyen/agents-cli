// src/commands/explain.ts

const EXPLAIN_TEXT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  agents-cli — How It Works
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

agents-cli launches sandboxed Claude research agents inside Docker
containers with controlled network access. Below is how each piece fits
together.

┌─────────────────────────────────────────────────────┐
│                    ARCHITECTURE                     │
└─────────────────────────────────────────────────────┘

  ┌──────────────┐
  │  agents-cli  │  Your machine (host)
  └──────┬───────┘
         │ docker compose run
         ▼
  ┌─────────────────────────────────────────────┐
  │  Docker Compose Project                     │
  │                                             │
  │  ┌─────────┐      ┌──────────────────────┐  │
  │  │  proxy   │◄────►│       agent          │  │
  │  │ mitmproxy│      │  Claude CLI sandbox  │  │
  │  └────┬─────┘      └──────────────────────┘  │
  │       │                                      │
  │       │ GET only                             │
  │       ▼                                      │
  │   Internet                                   │
  └─────────────────────────────────────────────┘

Each 'launch' creates a Compose project with two services:

  1. proxy   — mitmproxy instance that filters HTTP traffic
  2. agent   — custom sandbox image running Claude CLI

┌─────────────────────────────────────────────────────┐
│                  SANDBOX IMAGE                      │
└─────────────────────────────────────────────────────┘

The sandbox Docker image is built from assets embedded directly in the
agents-cli binary (Dockerfile, shell scripts, proxy addon). The image
tag is a SHA-256 hash of all assets, so it's automatically rebuilt only
when assets change.

The image includes: Claude CLI, agent-browser (headless Chromium),
Python 3, curl, and standard shell tools.

On container start, entrypoint.sh:
  • Copies Claude config from a read-only mount
  • Installs the mitmproxy CA certificate system-wide
  • Sets up iptables firewall rules (blocks local network access)
  • Launches a headless browser in the background
  • Runs Claude CLI with your prompt or in interactive mode

┌─────────────────────────────────────────────────────┐
│                 NETWORK SECURITY                    │
└─────────────────────────────────────────────────────┘

Network access is locked down in two layers:

  Layer 1 — Proxy (mitmproxy)
    All HTTP/HTTPS traffic routes through the proxy container.
    A custom Python addon (block-write-methods.py) blocks any request
    that isn't a GET or HEAD. This means POST, PUT, DELETE, PATCH, etc.
    are rejected. The agent can read the web but cannot submit forms,
    call write APIs, or exfiltrate data via POST.

  Layer 2 — Firewall (iptables)
    Inside the agent container, iptables rules block access to:
    • Private/local networks (10.x, 172.16-31.x, 192.168.x, 169.254.x)
    • Only the proxy container is reachable
    This prevents the agent from reaching other containers, the Docker
    host, or any local services on your network.

  The proxy CA cert is installed system-wide so that curl, Python HTTP
  libraries, Node.js, and agent-browser all trust it transparently.

┌─────────────────────────────────────────────────────┐
│                  VOLUME MOUNTS                      │
└─────────────────────────────────────────────────────┘

  /workspace/          ← your codebase (READ-ONLY)
  /workspace/output/   ← writable output directory
  /workspace/CLAUDE.md ← generated system prompt (read-only)
  /home/claude/.claude  ← Claude config (copied from host, read-only source)
  /mitmproxy-certs/    ← shared CA certs from proxy (read-only)

  The codebase is always mounted read-only — the agent cannot modify
  your source code. All results go to the output directory, which maps
  to --output on the host (default: ./agent-output).

┌─────────────────────────────────────────────────────┐
│               CONTAINER TRACKING                    │
└─────────────────────────────────────────────────────┘

  Containers are tracked via Docker labels, not a database:

    com.agents-cli.managed=true      Identifies managed containers
    com.agents-cli.codebase=<path>   Which codebase was mounted
    com.agents-cli.launched=<time>   Launch timestamp

  The 'list' command queries Docker for these labels. The 'clean'
  command finds and removes all labeled containers, their volumes,
  and networks.

┌─────────────────────────────────────────────────────┐
│                 CLAUDE.MD SYSTEM PROMPT             │
└─────────────────────────────────────────────────────┘

  A CLAUDE.md file is generated at launch with:

    1. System header — explains the sandbox environment, available
       tools (agent-browser, WebSearch, curl, Python), output rules,
       and constraints (read-only codebase, GET-only network).

    2. User override (optional) — if --claude-md is provided, its
       contents are appended after the system header, letting you
       customize the agent's instructions per-task.

┌─────────────────────────────────────────────────────┐
│                    DATA FLOW                        │
└─────────────────────────────────────────────────────┘

  1. You run:  agents-cli launch ./my-project -p "Research X"
  2. agents-cli builds/reuses the sandbox Docker image
  3. Generates CLAUDE.md, compose YAML, and proxy filter to a temp dir
  4. Runs 'docker compose run agent claude ...' with your prompt
  5. Claude starts inside the container, reads the codebase, browses
     the web (GET-only), and writes findings to /workspace/output/
  6. Results appear in ./agent-output/ on your host

  For interactive mode (no -p flag), you get a live terminal session
  with Claude inside the container.

┌─────────────────────────────────────────────────────┐
│                    DASHBOARD                        │
└─────────────────────────────────────────────────────┘

  The 'dashboard' command starts a local web server that:
    • Lists all running/exited agent containers via the Docker API
    • Streams parsed logs from each container via Server-Sent Events
    • Displays real-time agent activity in a browser UI

┌─────────────────────────────────────────────────────┐
│                  CONFIGURATION                      │
└─────────────────────────────────────────────────────┘

  Config file: ~/.agents-cli/config.json

  Keys:
    claudeConfig   Path to Claude config directory (default: ~/.claude)
    defaultModel   Default model for agents (default: claude-sonnet-4-6)

  Manage with:  agents-cli config set <key> <value>
  View with:    agents-cli config
`;

export function printExplain(): void {
  console.log(EXPLAIN_TEXT);
}
