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

### 1. `src/lib/docker.ts` — Extract frame parser

Pull the multiplexed stream frame-parsing logic (8-byte header, buffering, size validation, 16MB sanity limit) out of `streamContainerLogs()` into:

```ts
function parseDockerFrames(buffer: Buffer): { frames: Buffer[]; remaining: Buffer }
```

`streamContainerLogs()` becomes a thin wrapper: read chunks → feed to `parseDockerFrames()` → yield decoded strings.

### 2. `src/lib/compose.ts` — Extract config building from orchestration

`generateComposeYaml()` is already mostly pure (takes options, returns string) — keep as-is.

Extract from `launchAgent()`: the CLAUDE.md assembly and temp file setup logic into:

```ts
function buildAgentConfig(options): AgentConfig
```

Returns computed values (env vars, volumes, labels) without doing I/O. `launchAgent()` becomes: build config → write files → spawn process.

### 3. `src/lib/compose.ts` — Extract cleanup logic

Pull project-name-from-container-name regex extraction into:

```ts
function extractProjectNames(containerNames: string[]): string[]
```

### 4. `src/dashboard/server.ts` — Extract stats accumulation

Pull `accumulateUsage()` and stats aggregation into pure functions that take events and return updated stats, separate from the SSE/HTTP plumbing.

## Unit Tests

### `src/lib/docker.test.ts` (highest value)

- **`parseDockerFrames()`**: Valid frames, partial frames, oversized frames (>16MB), multiple frames in one buffer, empty buffer, stdout vs stderr type bytes
- **`parseStreamEvent()`**: All event types — assistant (text + tool calls), tool_result, system, result, error, raw; malformed JSON; ignored event types (rate_limit)
- **`summarizeToolInput()`**: Each tool type (Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, Agent); missing/empty inputs
- **`truncate()`**: Under limit, at limit, over limit, empty string

### `src/lib/compose.test.ts`

- **`projectName()`**: Determinism (same path → same name), different paths → different names, session name takes precedence over path
- **`generateComposeYaml()`**: Structural assertions — both services exist, proxy has correct image + healthcheck, agent has correct volumes/labels/env/caps, network defined, required labels present. Parse YAML back and assert on keys/values (no snapshot tests).
- **`buildAgentConfig()`** (new): Correct env var assembly, CLAUDE.md content merging, default model resolution
- **`extractProjectNames()`** (new): Regex extraction from container names, deduplication

### `src/lib/image.test.ts`

- **`getImageTag()`**: Deterministic (same assets → same hash), hash changes when any asset changes

### `src/lib/config.test.ts`

- **`loadConfig()`**: Returns defaults when file missing, merges user values over defaults
- **`resolveClaudeConfig()`**: Expands `~/` to home dir
- Round-trip: save then load returns same values

### `src/lib/claude-md.test.ts`

- **`generateClaudeMd()`**: System header always present, user content appended with separator, no user content → no separator

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
- `POST https://example.com` → 403 (blocked)
- `PUT https://example.com` → 403 (blocked)
- `DELETE https://example.com` → 403 (blocked)
- `POST https://api.anthropic.com/...` → not 403 (whitelisted host)

#### 2. Network isolation

- Direct HTTP bypassing proxy (`--noproxy '*'`) → connection refused/timeout
- Direct TCP to external IP → fails (iptables DROP)

#### 3. DNS resolution

- `dig @127.0.0.11 example.com` → succeeds (Docker internal DNS)
- `dig @8.8.8.8 example.com` → fails/timeout (external DNS blocked)

#### 4. Capability dropping

- `iptables -L` → permission denied (NET_ADMIN dropped)
- `ping -c1 127.0.0.1` → operation not permitted (NET_RAW dropped)

#### 5. Proxy health / TLS

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
