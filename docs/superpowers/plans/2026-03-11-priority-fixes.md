# Priority Fixes Implementation Plan — DONE

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13 highest-priority issues from the adversarial review — broken sandbox, first-run DX, and performance landmines.

**Architecture:** Targeted fixes across existing files. No new modules except `src/commands/stop.ts` and a shared `ensureDocker()` utility in `src/lib/docker.ts`. The compose YAML generator gets rewritten to use the `yaml` npm package.

**Tech Stack:** TypeScript, Bun, Docker, iptables, yaml (new dep)

---

## Chunk 1: Sandbox Security Fixes

### Task 1: Fix firewall — invert to DROP-by-default (SEC-003)

**Files:**
- Modify: `src/assets/init-firewall.sh`

The current firewall blocks ports 80/443 then ACCEPTs everything else. This must be inverted: DROP by default, only allow loopback, DNS, and proxy.

- [ ] **Step 1: Rewrite init-firewall.sh**

Replace the entire file with:

```bash
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
```

- [ ] **Step 2: Verify no syntax errors**

Run: `bash -n src/assets/init-firewall.sh`
Expected: no output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add src/assets/init-firewall.sh
git commit -m "fix(security): invert firewall to DROP-by-default (SEC-003)

The firewall previously blocked only ports 80/443 then accepted all other
traffic, allowing direct connections on any other port. Now defaults to
DROP and only allows loopback, DNS, and proxy traffic."
```

---

### Task 2: Disable IPv6 and add block_private to mitmproxy (SEC-002, SEC-004)

**Files:**
- Modify: `src/lib/compose.ts:40-103` (the `generateComposeYaml` function)

Two 1-line changes in the compose YAML template. We'll add `sysctls` to disable IPv6 on the agent container, and add `--set block_private=true` to the mitmproxy command.

- [ ] **Step 1: Add IPv6 disable sysctl to agent service**

In `src/lib/compose.ts`, in the `generateComposeYaml` function, add after the `cap_add` block (after line 72):

```yaml
    sysctls:
      - net.ipv6.conf.all.disable_ipv6=1
```

- [ ] **Step 2: Add block_private to mitmproxy command**

In `src/lib/compose.ts`, line 54, change the mitmproxy command from:

```
command: mitmdump -s /scripts/block-write-methods.py --set block_global=false
```

to:

```
command: mitmdump -s /scripts/block-write-methods.py --set block_global=false --set block_private=true
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/compose.ts
git commit -m "fix(security): disable IPv6 and block private IPs in proxy (SEC-002, SEC-004)

Add sysctl to disable IPv6 in agent container (preventing complete
sandbox bypass via IPv6). Add --set block_private=true to mitmproxy
to prevent DNS rebinding attacks against cloud metadata endpoints."
```

---

### Task 3: Drop NET_ADMIN capability after firewall setup (SEC-015)

**Files:**
- Modify: `src/assets/entrypoint.sh`

After the firewall is initialized, drop NET_ADMIN and NET_RAW capabilities before exec-ing into Claude. Use `capsh` which is available in Debian/bookworm.

- [ ] **Step 1: Install libcap2-bin in Dockerfile**

In `src/assets/Dockerfile`, add `libcap2-bin` to the apt-get install line (line 4-11). Change the first `\` continuation to include it:

```
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables iproute2 sudo ca-certificates curl libcap2-bin \
```

- [ ] **Step 2: Modify entrypoint.sh to drop capabilities**

In `src/assets/entrypoint.sh`, change the final `exec "$@"` (line 41) to drop capabilities before exec:

Replace:
```bash
exec "$@"
```

With:
```bash
exec capsh --drop=cap_net_admin,cap_net_raw -- -c 'exec "$@"' -- "$@"
```

- [ ] **Step 3: Verify no syntax errors**

Run: `bash -n src/assets/entrypoint.sh`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/assets/Dockerfile src/assets/entrypoint.sh
git commit -m "fix(security): drop NET_ADMIN after firewall setup (SEC-015)

Install libcap2-bin and use capsh to drop cap_net_admin and cap_net_raw
before exec-ing into the main process. The agent can no longer flush
iptables rules to escape the sandbox."
```

---

### Task 4: Build compose YAML programmatically (SEC-001)

**Files:**
- Modify: `src/lib/compose.ts:1-104`
- Modify: `package.json` (add `yaml` dependency)

Replace string-interpolated YAML with a JS object serialized via the `yaml` package. This eliminates YAML injection via malicious paths, names, or model values.

- [ ] **Step 1: Install yaml package**

Run: `bun add yaml`

- [ ] **Step 2: Rewrite generateComposeYaml**

Replace the `generateComposeYaml` function in `src/lib/compose.ts`. Add import at top:

```typescript
import { stringify as yamlStringify } from "yaml";
```

Replace the function (lines 40-103) with:

```typescript
function generateComposeYaml(opts: {
  imageTag: string;
  codebasePath: string;
  outputPath: string;
  claudeMdFile: string;
  claudeConfigDir: string;
  proxyFilterFile: string;
  model: string;
  name?: string;
}): string {
  const timestamp = new Date().toISOString();

  const labels: Record<string, string> = {
    "com.agents-cli.managed": "true",
    "com.agents-cli.codebase": opts.codebasePath,
    "com.agents-cli.launched": timestamp,
  };
  if (opts.name) {
    labels["com.agents-cli.name"] = opts.name;
  }

  const compose: Record<string, unknown> = {
    services: {
      proxy: {
        image: "mitmproxy/mitmproxy:11",
        command: "mitmdump -s /scripts/block-write-methods.py --set block_global=false --set block_private=true",
        volumes: [
          `${opts.proxyFilterFile}:/scripts/block-write-methods.py:ro`,
          "mitmproxy-certs:/home/mitmproxy/.mitmproxy",
        ],
        networks: ["agent-net"],
        healthcheck: {
          test: ["CMD", "ls", "/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem"],
          interval: "1s",
          retries: 30,
        },
      },
      agent: {
        image: opts.imageTag,
        depends_on: {
          proxy: { condition: "service_healthy" },
        },
        cap_add: ["NET_ADMIN", "NET_RAW"],
        sysctls: ["net.ipv6.conf.all.disable_ipv6=1"],
        volumes: [
          `${opts.codebasePath}:/workspace:ro`,
          `${opts.outputPath}:/home/claude/output:rw`,
          `${opts.claudeMdFile}:/workspace/CLAUDE.md:ro`,
          `${opts.claudeConfigDir}:/home/claude/.claude-config-ro:ro`,
          "mitmproxy-certs:/mitmproxy-certs:ro",
        ],
        environment: [
          "http_proxy=http://proxy:8080",
          "https_proxy=http://proxy:8080",
          "HTTP_PROXY=http://proxy:8080",
          "HTTPS_PROXY=http://proxy:8080",
          "NODE_EXTRA_CA_CERTS=/mitmproxy-certs/mitmproxy-ca-cert.pem",
          "REQUESTS_CA_BUNDLE=/mitmproxy-certs/mitmproxy-ca-cert.pem",
          "SSL_CERT_FILE=/mitmproxy-certs/mitmproxy-ca-cert.pem",
          "CLAUDE_CONFIG_DIR=/home/claude/.claude",
          `CLAUDE_MODEL=${opts.model}`,
        ],
        labels,
        networks: ["agent-net"],
        stdin_open: true,
        tty: true,
      },
    },
    volumes: {
      "mitmproxy-certs": null,
    },
    networks: {
      "agent-net": null,
    },
  };

  return yamlStringify(compose);
}
```

- [ ] **Step 3: Verify the project builds**

Run: `bun build src/cli.ts --compile --outfile /tmp/claude-1000/agents-cli-test 2>&1 | tail -5`
Expected: successful build

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/lib/compose.ts
git commit -m "fix(security): build compose YAML programmatically (SEC-001)

Replace string interpolation with yaml library serialization. User inputs
(paths, names, model) are now properly escaped, preventing YAML injection
attacks like privileged: true via malicious --name values."
```

---

### Task 5: Bind dashboard to localhost (SEC-009)

**Files:**
- Modify: `src/dashboard/server.ts:46`

- [ ] **Step 1: Add hostname to Bun.serve**

In `src/dashboard/server.ts`, change line 46 from:

```typescript
  Bun.serve({
    port,
```

to:

```typescript
  Bun.serve({
    port,
    hostname: "127.0.0.1",
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "fix(security): bind dashboard to localhost only (SEC-009)

Dashboard was binding to 0.0.0.0 with no auth, exposing agent logs
to anyone on the network. Now binds to 127.0.0.1."
```

---

## Chunk 2: First-Run DX Fixes

### Task 6: Add ensureDocker() utility (DX-001)

**Files:**
- Modify: `src/lib/docker.ts:1-21`
- Modify: `src/commands/launch.ts`
- Modify: `src/commands/clean.ts`
- Modify: `src/commands/logs.ts`
- Modify: `src/commands/resume.ts`
- Modify: `src/commands/dashboard.ts`

Add a function that pings Docker and exits with a helpful message if it's not available. Call it early in every command that needs Docker.

- [ ] **Step 1: Add ensureDocker function to docker.ts**

In `src/lib/docker.ts`, add after the `getDocker` function (after line 21):

```typescript
/** Check Docker is reachable. Exit with helpful message if not. */
export async function ensureDocker(): Promise<void> {
  try {
    await docker.ping();
  } catch {
    console.error(
      "Error: Cannot connect to Docker. Is Docker running?\n" +
      "  Install: https://docs.docker.com/get-docker/"
    );
    process.exit(1);
  }
}
```

- [ ] **Step 2: Add ensureDocker to launch command**

In `src/commands/launch.ts`, add import:

```typescript
import { ensureDocker } from "../lib/docker.ts";
```

Add as the first line inside the action handler (before line 24):

```typescript
    await ensureDocker();
```

- [ ] **Step 3: Add ensureDocker to remaining commands**

Add the same import and `await ensureDocker();` as the first line of each action handler in:
- `src/commands/clean.ts` (before line 10)
- `src/commands/logs.ts` (before line 15 in the action)
- `src/commands/resume.ts` (before line 21 in the action)
- `src/commands/dashboard.ts` (read file first to find correct location)

- [ ] **Step 4: Commit**

```bash
git add src/lib/docker.ts src/commands/launch.ts src/commands/clean.ts src/commands/logs.ts src/commands/resume.ts src/commands/dashboard.ts
git commit -m "fix(dx): check Docker availability before any Docker operation (DX-001)

Instead of crashing with raw ECONNREFUSED stack traces, the CLI now
checks Docker is running upfront and exits with a helpful message."
```

---

### Task 7: Add stop command (DX-005)

**Files:**
- Create: `src/commands/stop.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create stop command**

Create `src/commands/stop.ts`:

```typescript
// src/commands/stop.ts
import { Command } from "commander";
import { listAgentContainers, ensureDocker } from "../lib/docker.ts";
import { $ } from "bun";

export const stopCommand = new Command("stop")
  .description("Stop a running agent container")
  .argument("[container-id]", "Container to stop (default: most recent running)")
  .action(async (containerId: string | undefined) => {
    await ensureDocker();

    let targetId = containerId;

    if (!targetId) {
      const agents = await listAgentContainers();
      const running = agents.filter((a) => a.state === "running");
      if (running.length === 0) {
        console.error("No running agent containers found.");
        process.exit(1);
      }
      targetId = running[0]!.id;
      console.log(`Stopping ${running[0]!.name} (${running[0]!.shortId})`);
    }

    await $`docker stop ${targetId}`.quiet();
    console.log("Stopped.");
  });
```

- [ ] **Step 2: Register stop command in cli.ts**

In `src/cli.ts`, add import:

```typescript
import { stopCommand } from "./commands/stop.ts";
```

Add after line 24:

```typescript
program.addCommand(stopCommand);
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/stop.ts src/cli.ts
git commit -m "feat(dx): add stop command to stop individual agents (DX-005)

Previously the only option was 'clean' which removes ALL containers.
Now users can stop a single agent with 'agents-cli stop [id]'."
```

---

### Task 8: Improve error messages with list suggestions (DX-006)

**Files:**
- Modify: `src/lib/compose.ts:222-226`
- Modify: `src/commands/logs.ts:27-35`

- [ ] **Step 1: Fix resume error message**

In `src/lib/compose.ts`, change lines 223-225 from:

```typescript
  if (inspectResult.exitCode !== 0) {
    console.error(`Container ${containerId} not found.`);
    process.exit(1);
  }
```

to:

```typescript
  if (inspectResult.exitCode !== 0) {
    console.error(`Container '${containerId}' not found. Run 'agents-cli list' to see available containers.`);
    process.exit(1);
  }
```

- [ ] **Step 2: Wrap logs streaming in try/catch**

In `src/commands/logs.ts`, wrap the streaming loop (lines 27-35) in a try/catch:

```typescript
      try {
        for await (const event of streamContainerLogs(targetId, {
          follow: opts.follow,
        })) {
          if (opts.raw) {
            console.log(JSON.stringify(event));
          } else {
            printEvent(event);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no such container") || msg.includes("404")) {
          console.error(`Container '${targetId}' not found. Run 'agents-cli list' to see available containers.`);
        } else {
          console.error(`Error streaming logs: ${msg}`);
        }
        process.exit(1);
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/compose.ts src/commands/logs.ts
git commit -m "fix(dx): improve error messages with 'list' suggestion (DX-006)

When a container ID is not found in resume or logs commands, suggest
running 'agents-cli list' instead of showing raw Docker API errors."
```

---

## Chunk 3: Performance Fixes

### Task 9: Rewrite log buffer parser (PERF-001)

**Files:**
- Modify: `src/lib/docker.ts:71-103`

Replace the O(n^2) `Buffer.concat` pattern with a buffer list that only concatenates when needed, and copies the remainder to free the original allocation.

- [ ] **Step 1: Rewrite the buffer parsing in streamContainerLogs**

In `src/lib/docker.ts`, replace the buffer parsing section (lines 71-103) with:

```typescript
  // Docker multiplexed stream: 8-byte header per frame
  // [type(1) | 0(3) | size(4)] then payload
  const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16MB sanity limit
  const chunks: Buffer[] = [];
  let totalLen = 0;

  for await (const chunk of logStream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    totalLen += chunk.length;

    // Only consolidate when we might have a complete frame
    if (totalLen < 8) continue;

    let buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    chunks.length = 0;
    totalLen = 0;

    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);
      if (size > MAX_FRAME_SIZE) {
        // Malformed frame — discard buffer
        buffer = Buffer.alloc(0);
        break;
      }
      if (buffer.length < 8 + size) break;

      const payload = buffer.subarray(8, 8 + size);
      buffer = buffer.subarray(8 + size);

      const text = payload.toString("utf-8");
      const lines = text.split("\n");

      for (const line of lines) {
        const parsed = parseStreamEvent(line);
        if (parsed) yield parsed;
      }
    }

    // Push remainder back (copy to release original buffer's memory)
    if (buffer.length > 0) {
      chunks.push(Buffer.from(buffer));
      totalLen = buffer.length;
    }
  }

  // Drain remaining buffer
  if (totalLen > 0) {
    const buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    const text = buffer.toString("utf-8");
    for (const line of text.split("\n")) {
      const parsed = parseStreamEvent(line);
      if (parsed) yield parsed;
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/docker.ts
git commit -m "fix(perf): rewrite log parser to avoid O(n^2) buffer concat (PERF-001)

Use a buffer list pattern that only concatenates when a frame may be
complete, copies remainders to release original allocations, and adds
a 16MB max frame size to prevent OOM from malformed streams."
```

---

### Task 10: Add SSE disconnect detection (PERF-003)

**Files:**
- Modify: `src/dashboard/server.ts:81-121`

Detect when the SSE client disconnects and stop iterating the log stream.

- [ ] **Step 1: Add abort detection to SSE endpoint**

In `src/dashboard/server.ts`, replace the `/api/agents/:id/stream` handler (lines 81-122) with:

```typescript
      "/api/agents/:id/stream": {
        async GET(req) {
          const containerId = req.params.id;
          let cancelled = false;

          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();

              const send = (data: unknown) => {
                if (cancelled) return;
                try {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                  );
                } catch {
                  cancelled = true;
                }
              };

              try {
                for await (const event of streamContainerLogs(containerId, {
                  follow: true,
                })) {
                  if (cancelled) break;
                  send(event);
                }
              } catch (err) {
                if (!cancelled) {
                  send({
                    type: "error",
                    text: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              if (!cancelled) {
                send({ type: "done" });
                controller.close();
              }
            },
            cancel() {
              cancelled = true;
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        },
      },
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "fix(perf): detect SSE client disconnect to stop zombie streams (PERF-003)

When a browser tab is closed, the ReadableStream cancel callback sets a
flag that breaks the log iteration loop. Previously, zombie streams would
accumulate indefinitely, each holding a Docker log connection and buffer."
```

---

### Task 11: Temp directory cleanup (PERF-002)

**Files:**
- Modify: `src/lib/compose.ts:119-194`
- Modify: `src/lib/image.ts:45-56`

- [ ] **Step 1: Add cleanup to image.ts**

In `src/lib/image.ts`, add import for `rmSync`:

```typescript
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
```

Wrap the build section (lines 46-56) in try/finally:

```typescript
  // Write assets to temp dir
  const buildDir = mkdtempSync(join(tmpdir(), "agents-cli-build-"));
  try {
    for (const asset of ASSETS) {
      writeFileSync(join(buildDir, asset.name), asset.content);
    }

    // Build
    const build = await $`docker build -t ${tag} -f ${join(buildDir, "Dockerfile")} ${buildDir}`;
    if (build.exitCode !== 0) {
      console.error("Failed to build sandbox image");
      process.exit(1);
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
```

- [ ] **Step 2: Add cleanup to compose.ts launchAgent**

In `src/lib/compose.ts`, add import for `rmSync`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
```

In the `launchAgent` function, wrap everything from the tmpDir creation through the process await in try/finally. After the line `const tmpDir = mkdtempSync(...)` (line 120), wrap the rest of the function body:

```typescript
  const tmpDir = mkdtempSync(join(tmpdir(), "agents-cli-"));
  try {
    // ... existing code for writing files, generating YAML, spawning process ...
    // ... all the way through the proc.exited await ...
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/compose.ts src/lib/image.ts
git commit -m "fix(perf): clean up temp directories after use (PERF-002)

Both image builds and agent launches created temp dirs in /tmp that were
never cleaned up. Now wrapped in try/finally with rmSync."
```

---

### Task 12: Signal forwarding to child processes (PERF-007)

**Files:**
- Modify: `src/lib/compose.ts:161-194`

- [ ] **Step 1: Add signal handlers around the spawn**

In `src/lib/compose.ts`, in the `launchAgent` function, after the `Bun.spawn` call and before the `if (useLogFile ...)` block, add signal forwarding:

```typescript
  const cleanup = () => { proc.kill("SIGTERM"); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
```

And in the finally block (added in Task 11), add removal of signal handlers:

```typescript
  } finally {
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    rmSync(tmpDir, { recursive: true, force: true });
  }
```

Note: the `cleanup` const and signal registration must be inside the try block, after `proc` is created. The `process.off` calls go in the finally.

- [ ] **Step 2: Add same pattern to resumeAgent**

Apply the same signal forwarding pattern to the `resumeAgent` function around its `Bun.spawn` call (lines 249-272).

- [ ] **Step 3: Commit**

```bash
git add src/lib/compose.ts
git commit -m "fix(perf): forward SIGINT/SIGTERM to child docker processes (PERF-007)

Ctrl+C now properly terminates the docker compose process instead of
orphaning the proxy container."
```

---

### Task 13: Final verification

- [ ] **Step 1: Run bun build to verify compilation**

Run: `bun build src/cli.ts --compile --outfile /tmp/claude-1000/agents-cli-test`
Expected: successful build with no type errors

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: all tests pass (or no tests fail that weren't already failing)

- [ ] **Step 3: Quick smoke test**

Run: `bun src/cli.ts --help`
Expected: shows all commands including new `stop` command

Run: `bun src/cli.ts list`
Expected: works (or shows "Cannot connect to Docker" message if Docker isn't running — either is correct behavior)
