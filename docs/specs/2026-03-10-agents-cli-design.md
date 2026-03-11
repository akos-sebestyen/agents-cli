# agents-cli Design Spec

Self-contained CLI for launching sandboxed Claude research agents in Docker. Owns the entire container infrastructure — users point it at a codebase and get a sandboxed Claude with read-only access, a writable output dir, and layered CLAUDE.md instructions.

## CLI API

```
agents-cli launch [path] [options]
  [path]                Codebase to mount read-only (default: cwd)
  --output <path>       Writable output dir (default: ./agent-output)
  --claude-md <path>    CLAUDE.md override — appended after system header
  --prompt <text>       Research prompt (omit for interactive)
  --model <model>       Model override (default from config)

agents-cli resume [container-id] [options]
  [container-id]        Container to resume (default: most recent)
  --prompt <text>       Follow-up prompt (omit for interactive)
  --model <model>       Model override

agents-cli list                        # list agent containers
agents-cli logs [container-id]         # stream parsed logs
  -f, --follow
  --raw
agents-cli dashboard                   # web monitor UI
  -p, --port <port>
agents-cli clean [--force]              # stop and remove all agent containers
agents-cli config                      # show current config
agents-cli config set <key> <value>    # set a config value
```

### Examples

```bash
# Research agent against a codebase
agents-cli launch ~/projects/my-app --prompt "Find all API security issues"

# With custom instructions
agents-cli launch . --claude-md RESEARCH-CLAUDE.md

# Interactive session with Opus
agents-cli launch . --model claude-opus-4-6

# Output to a specific dir
agents-cli launch . --output ~/research-results

# Follow-up on last session
agents-cli resume --prompt "Now check the auth module specifically"

# Monitor in browser
agents-cli dashboard
```

## Config

File: `~/.agents-cli/config.json`

```json
{
  "claudeConfig": "~/.claude",
  "defaultModel": "claude-sonnet-4-6"
}
```

- `claudeConfig` — path to Claude Code profile dir (contains auth tokens). Mounted read-only into the container, copied to a writable location at startup.
- `defaultModel` — default model for `launch` and `resume` commands.

Created on first run with defaults if it doesn't exist. `agents-cli config` prints current values. `agents-cli config set <key> <value>` updates a key.

## Container Architecture

### Image

Tag: `agents-cli-sandbox:<content-hash>`

The image is generic — no project-specific content baked in. Contains:
- Node.js 22 (base)
- Claude Code + agent-browser (npm global)
- Chromium (via agent-browser install)
- Python 3 + uv (for project toolchains)
- iptables, iproute2, sudo, ca-certificates, curl
- Entrypoint script + firewall script (copied in at build)

All Docker assets (Dockerfile, entrypoint.sh, init-firewall.sh, block-write-methods.py) are embedded in the agents-cli binary as string literals. At image build time, they're written to a temp dir and `docker build` runs against it.

The image tag is a SHA256 hash (first 12 chars) of all four embedded asset files concatenated in alphabetical order by filename (block-write-methods.py, Dockerfile, entrypoint.sh, init-firewall.sh). On `agents-cli launch`, the CLI checks if `agents-cli-sandbox:<hash>` exists locally. If yes, skip build. If no, build it. This means:
- First launch builds the image (~2-3 min)
- Subsequent launches reuse the cached image instantly
- Upgrading agents-cli auto-rebuilds only if the Docker assets changed

### Two-Service Compose

Generated at runtime (written to a temp file), not a static compose file. The compose project name is `agents-cli-<short-hash>` where the hash is derived from the codebase absolute path. This gives stable container names per project for `resume` and `clean`.

**proxy** — mitmproxy sidecar
- Image: `mitmproxy/mitmproxy:11` (pinned major version)
- Runs `mitmdump` with the write-method blocker addon
- Shares cert volume with agent container
- Healthcheck: `test: ["CMD", "ls", "/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem"]` with interval 1s, retries 30

**agent** — the research agent
- Image: `agents-cli-sandbox:<hash>`
- `depends_on: proxy: condition: service_healthy`
- NET_ADMIN + NET_RAW capabilities (for iptables firewall)
- stdin_open + tty (for interactive mode)

### Container Labeling

All agent containers get Docker labels for identification:
- `com.agents-cli.managed=true`
- `com.agents-cli.codebase=<absolute-path>`
- `com.agents-cli.launched=<ISO-timestamp>`

`agents-cli list` filters on `com.agents-cli.managed=true`. `resume` finds the most recent container by `com.agents-cli.launched` label, or accepts an explicit container ID argument.

### Compose Invocation

- **Interactive mode** (no `--prompt`): `docker compose run --rm agent claude --dangerously-skip-permissions --model <model>`. The `run` command attaches stdin/tty and respects `depends_on` for starting the proxy.
- **Prompted mode** (`--prompt` given): same `docker compose run` but with `--output-format stream-json --verbose -p "<prompt>"` appended to the Claude args.
- **Resume**: `docker exec -it <container> claude --dangerously-skip-permissions --model <model> [prompt args]`. If the container is stopped, `docker start` it first.

### Mount Points

```
Host                          Container                  Mode
─────────────────────────────────────────────────────────────
<codebase path>           →   /workspace/                ro
<output path>             →   /workspace/output/         rw
<generated CLAUDE.md>     →   /workspace/CLAUDE.md       ro
<claude config dir>       →   /home/claude/.claude-personal-ro  ro
mitmproxy-certs (volume)  →   /mitmproxy-certs/          ro
```

The codebase is the base layer at `/workspace/` (read-only). The output dir overlays `/workspace/output/` as a writable bind mount — if the codebase has an `output/` directory, it will be shadowed (this is intentional). The CLAUDE.md overlays any CLAUDE.md in the codebase.

**Path resolution:** `--claude-md` and `--output` paths are resolved relative to cwd at invocation time. A missing `--claude-md` file is a fatal error. The `--output` directory is created automatically if it doesn't exist.

### Environment Variables (set by compose)

```
http_proxy=http://proxy:8080
https_proxy=http://proxy:8080
HTTP_PROXY=http://proxy:8080
HTTPS_PROXY=http://proxy:8080
NODE_EXTRA_CA_CERTS=/mitmproxy-certs/mitmproxy-ca-cert.pem
REQUESTS_CA_BUNDLE=/mitmproxy-certs/mitmproxy-ca-cert.pem
SSL_CERT_FILE=/mitmproxy-certs/mitmproxy-ca-cert.pem
CLAUDE_CONFIG_DIR=/home/claude/.claude-personal
CLAUDE_MODEL=<model>
```

## Sandbox Security Model

Always-on, no escape hatch.

### Proxy (mitmproxy)

The `block-write-methods.py` addon allows only `GET`, `HEAD`, `OPTIONS`, `CONNECT` to pass through. `POST`, `PUT`, `DELETE`, `PATCH` are blocked with 403 — except to whitelisted hosts required for Claude Code to function:
- `api.anthropic.com`
- `api.claude.ai`
- `auth.anthropic.com`
- `statsig.anthropic.com`
- `sentry.io`

### Firewall (iptables)

Set up by `init-firewall.sh` at container startup:
- Allow loopback and established connections
- Allow DNS to Docker embedded DNS (127.0.0.11)
- Allow traffic to the proxy sidecar
- Block all private/local networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
- Block direct HTTP/HTTPS (must go through proxy)
- Allow everything else (proxy handles filtering)

### Entrypoint

1. Wait for mitmproxy CA cert — the proxy healthcheck ensures it exists before the agent starts (`depends_on: condition: service_healthy`), but the entrypoint still checks as a safety net (up to 10s)
2. Trust the CA cert system-wide (for Chromium, Node, Python)
3. Initialize firewall
4. Copy Claude config from read-only mount to `~/.claude` (writable)
5. Pre-launch agent-browser with `--ignore-https-errors`
6. `exec "$@"` (run Claude Code)

## CLAUDE.md Layering

The CLAUDE.md mounted into the container is generated by agents-cli. It has two sections:

### 1. System Header (always present)

Injected by agents-cli. Tells Claude:
- It's a research agent in a sandboxed container
- `/workspace/` is the mounted codebase (read-only)
- `/workspace/output/` is the writable output directory — all files must be written here
- Available web tools: agent-browser (primary), curl, WebSearch, WebFetch, Python HTTP libs
- Proxy constraints: GET-only, POST/PUT/DELETE/PATCH blocked
- Useful data portals list
- Output guidelines: write markdown to output dir, include sources, use descriptive filenames
- Behavioral rules: don't spawn nested agents, don't modify the codebase, focus on research

### 2. User Content (optional)

If `--claude-md <file>` is provided, the file's contents are appended after the system header under a `---` separator. This is where project-specific context goes — scientific background, research questions, team info, domain knowledge.

### Example Generated CLAUDE.md

```markdown
# Research Agent Instructions

You are a research agent running inside a sandboxed container.

## Environment
- **Codebase:** `/workspace/` (read-only)
- **Output:** `/workspace/output/` (read-write) — write all results here
- Network: GET-only through proxy, local network blocked

## Web Access Tools
[... agent-browser instructions, curl, WebSearch, WebFetch ...]

## Output Guidelines
[... write markdown, include sources, descriptive filenames ...]

## Rules
- Do NOT modify the codebase (it's read-only)
- Write all output to `/workspace/output/`
- Do NOT spawn nested agents
[...]

---

# Project-Specific Context

[... contents of user's --claude-md file ...]
```

## Project Structure

```
agents-cli/
├── src/
│   ├── cli.ts                    # entry point (commander)
│   ├── commands/
│   │   ├── launch.ts             # launch command
│   │   ├── resume.ts             # resume command
│   │   ├── list.ts               # list containers
│   │   ├── logs.ts               # stream parsed logs
│   │   ├── dashboard.ts          # web monitor
│   │   ├── clean.ts              # remove containers
│   │   └── config.ts             # config management
│   ├── lib/
│   │   ├── docker.ts             # dockerode: list containers, stream logs, parse events
│   │   ├── compose.ts            # generate + run docker compose
│   │   ├── image.ts              # build/check sandbox image
│   │   ├── config.ts             # ~/.agents-cli/config.json management
│   │   └── claude-md.ts          # CLAUDE.md generation + layering
│   ├── assets/
│   │   ├── Dockerfile            # embedded at compile time
│   │   ├── entrypoint.sh         # embedded at compile time
│   │   ├── init-firewall.sh      # embedded at compile time
│   │   └── block-write-methods.py # embedded at compile time
│   └── dashboard/
│       ├── server.ts             # Bun.serve() SSE dashboard
│       └── index.html            # dashboard UI (embedded)
├── install.sh                    # build + install binary
├── package.json
└── docs/
    └── specs/
        └── 2026-03-10-agents-cli-design.md  # this file
```

## What Changes from the Science Project

The science project's `docker/agent/` directory becomes dead code once agents-cli is working. Specifically:

| Science project file | Moves to | Notes |
|-----|-----|-----|
| `docker/agent/Dockerfile` | `src/assets/Dockerfile` | Genericized — no COPY from project context |
| `docker/agent/entrypoint.sh` | `src/assets/entrypoint.sh` | Minor tweaks for generic mount points |
| `docker/agent/init-firewall.sh` | `src/assets/init-firewall.sh` | Unchanged |
| `docker/agent/block-write-methods.py` | `src/assets/block-write-methods.py` | Unchanged |
| `docker/agent/docker-compose.agent.yml` | Generated at runtime | No static file |
| `scripts/run-agent.sh` | `agents-cli launch` / `agents-cli resume` | Replaced |
| `agent-monitor/` | `src/dashboard/` | Already ported |
| `monitor-agents.sh` | `agents-cli dashboard` | Replaced |
| `RESEARCH-CLAUDE.md` | User passes via `--claude-md` | Trimmed — no sandbox boilerplate |

## `list` Output

Columns: `ID`, `STATUS`, `CODEBASE`, `CREATED`, `NAME`

Filters containers by `com.agents-cli.managed=true` label. Shows running containers first, then by creation time descending.

## `clean` Behavior

Stops and removes all containers with the `com.agents-cli.managed=true` label (both running and exited). Also removes associated compose networks and cert volumes. Prints a summary of what was removed. `--force` skips the confirmation prompt.

## `dashboard`

Ported from the science project's `agent-monitor/`. Bun.serve() replaces FastAPI/uvicorn. If the port is already in use, exits with an error message.

## Installation

`./install.sh` runs `bun build src/cli.ts --compile --outfile ~/.local/bin/agents-cli`. The compiled binary is ~30MB and includes all embedded assets (Docker files, dashboard HTML). No runtime dependencies beyond Docker.

## Implementation Order

1. **Config management** — `~/.agents-cli/config.json` read/write, `config` command
2. **Embed Docker assets** — move Dockerfile + scripts to `src/assets/`, import with `{ type: "text" }`
3. **Image builder** — write assets to temp dir, `docker build`, content-hash tagging
4. **Compose generator** — generate compose YAML from launch options, write to temp file
5. **CLAUDE.md generator** — system header template + optional user content appending
6. **Rewrite launch command** — wire up image build → compose generate → docker compose run
7. **Rewrite resume command** — find latest container, docker exec
8. **Rewrite clean command** — use generated compose project name for cleanup
9. **Test end-to-end** — launch against the science project with `--claude-md RESEARCH-CLAUDE.md`
