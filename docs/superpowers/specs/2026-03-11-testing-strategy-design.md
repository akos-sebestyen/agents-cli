# Testing Strategy for agents-cli

## Overview

A comprehensive testing strategy covering unit tests for all valuable logic and integration tests for Docker container isolation/firewall verification. The codebase currently has zero tests across 16 source files.

## Test Infrastructure

- **Runner**: Bun's built-in test runner (`bun test`), no additional dependencies
- **Unit test location**: Colocated with source — `src/**/*.test.ts`
- **Integration test location**: `tests/integration/`, gated behind `INTEGRATION=1` env var
- **Package.json scripts**:
  - `"test"` → `bun test --ignore 'tests/integration/**'`
  - `"test:integration"` → `INTEGRATION=1 bun test tests/integration/`
  - `"test:all"` → `INTEGRATION=1 bun test`

## Refactoring for Testability

Before writing tests, extract pure logic from I/O-coupled functions. All extractions are "extract function" refactors — no behavior changes.

### Prerequisites: Export private functions

Several functions that need testing are currently module-private. These must be exported:

- `src/lib/docker.ts`: `parseStreamEvent()`, `summarizeToolInput()`, `truncate()`
- `src/lib/compose.ts`: `generateComposeYaml()`
- `src/dashboard/server.ts`: `accumulateUsage()` (already pure — just needs `export`)

### 1. `src/lib/docker.ts` — Extract frame parser

Pull the multiplexed stream frame-parsing logic (8-byte header, buffering, size validation, 16MB sanity limit) out of `streamContainerLogs()` into:

```ts
export function parseDockerFrames(buffer: Buffer): { frames: Buffer[]; remaining: Buffer }
```

`streamContainerLogs()` becomes a thin wrapper: read chunks → feed to `parseDockerFrames()` → yield decoded strings.

### 2. `src/lib/compose.ts` — Simplify `launchAgent()` extraction

`generateComposeYaml()` is already mostly pure (takes options, returns string) — export it as-is.

The `launchAgent()` function mixes config computation with file I/O tightly (temp file paths, `ensureImage()`, `loadConfig()` are interleaved). Rather than a full `buildAgentConfig()` extraction, take a lighter approach:

- Extract CLAUDE.md content assembly into `export function assembleClaudeMd(systemContent: string, userOverridePath?: string): string` — pure string logic, file reading is passed in by caller
- The rest of `launchAgent()` stays as-is — it's orchestration code best tested via integration tests

### 3. `src/lib/compose.ts` — Extract cleanup logic

Pull project-name-from-container-name regex extraction into:

```ts
export function extractProjectNames(containerNames: string[]): string[]
```

### 4. `src/dashboard/server.ts` — Export stats accumulation

`accumulateUsage()` is already a pure function (takes stats + usage, mutates stats). Just add `export` — no refactoring needed.

## Unit Tests

### `src/lib/docker.test.ts` (highest value)

- **`parseDockerFrames()`**: Valid frames, partial frames, oversized frames (>16MB), multiple frames in one buffer, empty buffer, stdout vs stderr type bytes
- **`parseStreamEvent()`**: Event types to test:
  - `type: "assistant"` → text blocks + tool call extraction
  - `type: "user"` → produces `tool_result` events. Must cover nested content variants: string content, array of strings, array of objects with `.content` (string or array), text-type objects
  - `type: "system"` → model info extraction
  - `type: "result"` → final output
  - Malformed JSON → returns null
  - Ignored types (`rate_limit`) → returns null
  - Note: there is no `"error"` branch in `parseStreamEvent` — error events are constructed by callers (`streamContainerLogs`, dashboard). Do not test "error" as an input type.
- **`summarizeToolInput()`**: Each tool type (Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, Agent); missing/empty inputs
- **`truncate()`**: Under limit, at limit, over limit, empty string

### `src/lib/compose.test.ts`

- **`projectName()`**: Determinism (same path → same name), different paths → different names, session name takes precedence over path
- **`generateComposeYaml()`**: Structural assertions — both services exist, proxy has correct image + healthcheck, agent has correct volumes/labels/env/caps, network defined, required labels present. Parse YAML back and assert on keys/values (no snapshot tests).
- **`extractProjectNames()`** (new): Regex extraction from container names, deduplication

### `src/lib/image.test.ts`

- **`getImageTag()`**: Deterministic (same assets → same hash), hash changes when any asset changes

### `src/lib/config.test.ts`

- **`loadConfig()`**: Returns defaults when file missing, merges user values over defaults
- **`resolveClaudeConfig()`**: Expands `~/` to home dir
- Round-trip: save then load returns same values

### `src/lib/claude-md.test.ts`

- **`generateClaudeMd()`**: System header always present, user content appended with separator, no user content → no separator

### `src/dashboard/server.test.ts`

- **`accumulateUsage()`**: Sums token metrics correctly, handles missing fields, accumulates across multiple calls

## Integration Tests

All in `tests/integration/`, gated behind `INTEGRATION=1`. These spin up actual Docker containers.

### Container Name Deconfliction

Integration tests use a dedicated project name prefix (`agents-cli-test-`) so compose stacks never collide with real agent containers. Cleanup logic scopes to this prefix only — tests never touch production containers.

### Test Lifecycle

- **Setup** (once per suite): Launch a minimal compose stack (proxy + agent container) using the real `generateComposeYaml()` with the test project prefix
- **Teardown** (once per suite): `docker compose down` with volumes and networks for the test project
- **Timeouts**: 60s+ per test to account for container startup

### `tests/integration/firewall.test.ts`

Probe commands run inside the agent container via `docker exec`.

#### 1. Outbound HTTP filtering

- `GET https://example.com` → 200 (allowed)
- `HEAD https://example.com` → 200 (allowed — HEAD and OPTIONS are in ALLOWED_METHODS alongside GET)
- `POST https://example.com` → 403 (blocked)
- `PUT https://example.com` → 403 (blocked)
- `DELETE https://example.com` → 403 (blocked)
- `POST https://api.anthropic.com/...` → not 403 (whitelisted host)

#### 2. Subdomain spoofing (proxy filter uses `.endswith()`)

- `POST https://evil.api.anthropic.com/...` → verify behavior of `.endswith()` host matching. This is a known concern: the proxy's `request.host.endswith("api.anthropic.com")` check would pass `evil.api.anthropic.com`. Tests should document whether this is exploitable and whether a fix is needed (e.g., switching to exact match or `.endswith(".api.anthropic.com")` with leading dot).

#### 3. Network isolation

- Direct HTTP bypassing proxy (`--noproxy '*'`) → connection refused/timeout
- Direct TCP to external IP → fails (iptables DROP)

#### 4. DNS resolution

- `dig @127.0.0.11 example.com` → succeeds (Docker internal DNS)
- `dig @8.8.8.8 example.com` → fails/timeout (external DNS blocked)

#### 5. IPv6 bypass prevention

- Verify IPv6 is disabled (`cat /proc/sys/net/ipv6/conf/all/disable_ipv6` → 1)
- Attempt IPv6 connection → fails (sysctl `net.ipv6.conf.all.disable_ipv6=1` is set in compose YAML, iptables rules are IPv4-only)

#### 6. Capability dropping

- `iptables -L` → permission denied (NET_ADMIN dropped)
- `ping -c1 127.0.0.1` → operation not permitted (NET_RAW dropped)
- Verify via `/proc/self/status` CapEff field that capabilities are actually absent (not just testing observable effects)

#### 7. Proxy health / TLS

- `curl https://example.com` → succeeds (mitmproxy CA installed, TLS interception works)
- CA cert file exists at expected path

### `tests/integration/lifecycle.test.ts` (stretch goal)

- Launch → list shows running → stop → list shows exited → clean removes it
- Basic smoke test of the full CLI flow, scoped to test project prefix

## Design Decisions

- **Structural assertions over snapshots** for generated YAML — avoids rubber-stamp snapshot updates, assertions document what actually matters
- **Pure function extraction over mocking** — test real logic without Docker dependency, no mock maintenance burden
- **Colocated unit tests** (`*.test.ts` next to source) — easy to find, natural pairing
- **Env-var gating for integration tests** — `bun test` stays fast (<1s), integration is opt-in
- **Test project prefix for isolation** — integration tests can't interfere with real agent containers
- **Export-only changes preferred** — where functions are already pure, just add `export` rather than restructuring
