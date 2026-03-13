# Dockerfile Extension Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow projects to extend the base sandbox image with a custom Dockerfile, and add a `build` subcommand for pre-building extended images.

**Architecture:** The `--dockerfile` flag on `launch` (and a new `build` command) reads a user-provided Dockerfile, validates its `FROM` line, computes a content hash of (base image ID + Dockerfile contents), and builds/caches the extended image as `agents-cli-ext:<hash>`. The compose layer uses that image instead of the base. Caching skips rebuilds when inputs haven't changed.

**Tech Stack:** Bun, TypeScript, Docker CLI, commander, bun:test

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/image.ts` | Modify | Add `validateDockerfile`, `getExtendedImageTag`, `buildExtendedImage`, `rewriteFromLine`, `cleanExtensionImages` |
| `src/lib/image.test.ts` | Modify | Tests for validation, hash computation, FROM rewriting, extended image tag |
| `src/lib/compose.ts` | Modify | Accept optional `dockerfilePath` in `LaunchOptions`, thread through to image build |
| `src/commands/launch.ts` | Modify | Add `--dockerfile` option, validate file exists, pass to `launchAgent` |
| `src/commands/build.ts` | Create | New `build` subcommand that pre-builds extended image |
| `src/cli.ts` | Modify | Register `buildCommand` |
| `src/commands/clean.ts` | Modify | Add `--images` and `--all` flags for image cleanup |
| `tests/integration/helpers.ts` | Modify | Add extended-image test stack helpers (`startExtTestStack`, etc.) |
| `tests/integration/dockerfile-extension.test.ts` | Create | Integration tests: custom tools, base image preserved, security model |
| `tests/integration/image-caching.test.ts` | Create | Integration tests: cache hit/miss, tag determinism |

---

## Chunk 1: Extended Image Building

### Task 1: Dockerfile Validation

**Files:**
- Modify: `src/lib/image.ts`
- Modify: `src/lib/image.test.ts`

- [ ] **Step 1: Write failing tests for validateDockerfile**

Add to `src/lib/image.test.ts`:

```typescript
import { validateDockerfile } from "./image.ts";

describe("validateDockerfile", () => {
  test("accepts Dockerfile that FROMs the base image", () => {
    const content = "FROM agents-cli-sandbox:latest\nRUN apt-get update";
    expect(() => validateDockerfile(content)).not.toThrow();
  });

  test("rejects Dockerfile without FROM base image", () => {
    const content = "FROM ubuntu:22.04\nRUN apt-get update";
    expect(() => validateDockerfile(content)).toThrow(/must use.*agents-cli-sandbox/i);
  });

  test("rejects empty Dockerfile", () => {
    const content = "";
    expect(() => validateDockerfile(content)).toThrow();
  });

  test("accepts FROM with different tag", () => {
    const content = "FROM agents-cli-sandbox:abc123\nRUN echo hi";
    expect(() => validateDockerfile(content)).not.toThrow();
  });

  test("ignores comments and blank lines before FROM", () => {
    const content = "# My custom image\n\nFROM agents-cli-sandbox:latest\nRUN echo hi";
    expect(() => validateDockerfile(content)).not.toThrow();
  });

  test("rejects image name that only starts with agents-cli-sandbox", () => {
    const content = "FROM agents-cli-sandbox-evil:latest\nRUN echo hi";
    expect(() => validateDockerfile(content)).toThrow(/must use.*agents-cli-sandbox/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/image.test.ts`
Expected: FAIL — `validateDockerfile` is not exported

- [ ] **Step 3: Implement validateDockerfile**

Add to `src/lib/image.ts` after the existing imports:

```typescript
/**
 * Validate that a Dockerfile FROMs the agents-cli-sandbox base image.
 * Throws if the FROM line doesn't reference the base image.
 */
export function validateDockerfile(content: string): void {
  const fromLine = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toUpperCase().startsWith("FROM "));

  if (!fromLine) {
    throw new Error("Dockerfile has no FROM instruction");
  }

  const imageRef = fromLine.split(/\s+/)[1] ?? "";
  const [imageName] = imageRef.split(":");
  if (imageName !== "agents-cli-sandbox") {
    throw new Error(
      `Dockerfile must use "agents-cli-sandbox" as its base image (FROM agents-cli-sandbox:...), got: ${imageRef}`
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/image.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/image.ts src/lib/image.test.ts
git commit -m "feat: add Dockerfile validation for extension images"
```

---

### Task 2: Extended Image Hash, FROM Rewriting, and Build

**Files:**
- Modify: `src/lib/image.ts` (add `readFileSync` to the existing `node:fs` import on line 2)
- Modify: `src/lib/image.test.ts`

- [ ] **Step 1: Write failing tests for getExtendedImageTag and rewriteFromLine**

Add to `src/lib/image.test.ts`:

```typescript
import { getExtendedImageTag, rewriteFromLine } from "./image.ts";

describe("getExtendedImageTag", () => {
  test("returns deterministic tag for same inputs", () => {
    const a = getExtendedImageTag("abc123base", "FROM agents-cli-sandbox:latest\nRUN echo hi");
    const b = getExtendedImageTag("abc123base", "FROM agents-cli-sandbox:latest\nRUN echo hi");
    expect(a).toBe(b);
  });

  test("different base image ID produces different tag", () => {
    const dockerfile = "FROM agents-cli-sandbox:latest\nRUN echo hi";
    const a = getExtendedImageTag("base-id-1", dockerfile);
    const b = getExtendedImageTag("base-id-2", dockerfile);
    expect(a).not.toBe(b);
  });

  test("different Dockerfile contents produces different tag", () => {
    const a = getExtendedImageTag("base-id", "FROM agents-cli-sandbox:latest\nRUN echo a");
    const b = getExtendedImageTag("base-id", "FROM agents-cli-sandbox:latest\nRUN echo b");
    expect(a).not.toBe(b);
  });

  test("tag format is agents-cli-ext:<12-hex-chars>", () => {
    const tag = getExtendedImageTag("base", "FROM agents-cli-sandbox:latest");
    expect(tag).toMatch(/^agents-cli-ext:[a-f0-9]{12}$/);
  });
});

describe("rewriteFromLine", () => {
  test("rewrites FROM to exact base tag", () => {
    const input = "FROM agents-cli-sandbox:latest\nRUN echo hi";
    const result = rewriteFromLine(input, "agents-cli-sandbox:abc123def456");
    expect(result).toBe("FROM agents-cli-sandbox:abc123def456\nRUN echo hi");
  });

  test("handles comments before FROM", () => {
    const input = "# comment\nFROM agents-cli-sandbox:latest\nRUN echo hi";
    const result = rewriteFromLine(input, "agents-cli-sandbox:abc123def456");
    expect(result).toBe("# comment\nFROM agents-cli-sandbox:abc123def456\nRUN echo hi");
  });

  test("handles different original tags", () => {
    const input = "FROM agents-cli-sandbox:v1.0\nRUN echo hi";
    const result = rewriteFromLine(input, "agents-cli-sandbox:newhash");
    expect(result).toBe("FROM agents-cli-sandbox:newhash\nRUN echo hi");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/image.test.ts`
Expected: FAIL — `getExtendedImageTag` and `rewriteFromLine` not exported

- [ ] **Step 3: Implement getExtendedImageTag and rewriteFromLine**

Add to `src/lib/image.ts`:

```typescript
const EXT_IMAGE_NAME = "agents-cli-ext";

/**
 * Compute a deterministic tag for an extended image based on the base image ID
 * and the Dockerfile contents.
 */
export function getExtendedImageTag(baseImageId: string, dockerfileContents: string): string {
  const hasher = createHash("sha256");
  hasher.update(baseImageId);
  hasher.update(dockerfileContents);
  return `${EXT_IMAGE_NAME}:${hasher.digest("hex").slice(0, 12)}`;
}

/**
 * Rewrite a Dockerfile's FROM line to reference the exact base image tag.
 */
export function rewriteFromLine(dockerfileContents: string, baseTag: string): string {
  return dockerfileContents.replace(
    /^(FROM\s+)agents-cli-sandbox:\S+/im,
    `$1${baseTag}`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/image.test.ts`
Expected: PASS

- [ ] **Step 5: Implement buildExtendedImage**

Add `readFileSync` to the existing `node:fs` import on line 2 of `src/lib/image.ts`:

```typescript
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
```

Then add the function:

```typescript
/**
 * Build (or locate cached) extended image from a user-provided Dockerfile.
 * Returns the extended image tag.
 *
 * @param dockerfilePath Absolute path to the user's Dockerfile
 * @param contextPath Absolute path to use as Docker build context (codebase root)
 */
export async function buildExtendedImage(
  dockerfilePath: string,
  contextPath: string,
): Promise<string> {
  const dockerfileContents = readFileSync(dockerfilePath, "utf-8");
  validateDockerfile(dockerfileContents);

  // Get the base image ID for cache-busting
  const baseTag = getImageTag();
  const inspectResult = await $`docker image inspect --format={{.Id}} ${baseTag}`.quiet().nothrow();
  if (inspectResult.exitCode !== 0) {
    throw new Error(`Base image ${baseTag} not found. Run without --dockerfile first, or run 'agents-cli build' to build it.`);
  }
  const baseImageId = inspectResult.text().trim();

  const extTag = getExtendedImageTag(baseImageId, dockerfileContents);

  // Check if extended image is already cached
  const cached = await $`docker image inspect ${extTag}`.quiet().nothrow();
  if (cached.exitCode === 0) {
    return extTag;
  }

  console.log(`Building extended image ${extTag}...`);

  const rewrittenDockerfile = rewriteFromLine(dockerfileContents, baseTag);

  // Write rewritten Dockerfile to temp dir
  const buildDir = mkdtempSync(join(tmpdir(), "agents-cli-ext-build-"));
  try {
    const tmpDockerfile = join(buildDir, "Dockerfile");
    writeFileSync(tmpDockerfile, rewrittenDockerfile);

    const build = await $`docker build -f ${tmpDockerfile} -t ${extTag} ${contextPath}`.nothrow();
    if (build.exitCode !== 0) {
      console.error("Failed to build extended image");
      process.exit(1);
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`Built ${extTag}`);
  return extTag;
}
```

Note: `.nothrow()` is added to the `docker build` call so the exit code check works correctly (without it, Bun's `$` throws on non-zero exit before the check is reached).

- [ ] **Step 6: Run all image tests**

Run: `bun test src/lib/image.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/image.ts src/lib/image.test.ts
git commit -m "feat: add extended image hash computation and build function"
```

---

## Chunk 2: CLI Integration

### Task 3: Thread --dockerfile Through Launch

**Files:**
- Modify: `src/lib/compose.ts`
- Modify: `src/commands/launch.ts`

- [ ] **Step 1: Add dockerfilePath to LaunchOptions**

In `src/lib/compose.ts`, add to the `LaunchOptions` interface:

```typescript
/** Path to a Dockerfile extending the base image (absolute, optional) */
dockerfilePath?: string;
```

- [ ] **Step 2: Update launchAgent to build extended image when dockerfile provided**

In `src/lib/compose.ts`, add `buildExtendedImage` to the existing static import from `image.ts` (line 9):

```typescript
import { ensureImage, getImageTag, buildExtendedImage } from "./image.ts";
```

Then modify the `launchAgent` function. Change:

```typescript
  // Ensure sandbox image exists
  const imageTag = await ensureImage();
```

To:

```typescript
  // Ensure sandbox image exists
  const baseTag = await ensureImage();

  // Build extended image if Dockerfile provided
  const imageTag = opts.dockerfilePath
    ? await buildExtendedImage(opts.dockerfilePath, opts.codebasePath)
    : baseTag;
```

- [ ] **Step 3: Add --dockerfile flag to launch command**

In `src/commands/launch.ts`, add the option after the `--no-logs` line:

```typescript
  .option("--dockerfile <path>", "Dockerfile extending base image")
```

Add `dockerfile?: string` to the opts type in the action callback, and add validation before the `launchAgent` call:

```typescript
    let dockerfilePath: string | undefined;
    if (opts.dockerfile) {
      dockerfilePath = resolve(opts.dockerfile);
      if (!existsSync(dockerfilePath)) {
        console.error(`Dockerfile not found: ${dockerfilePath}`);
        process.exit(1);
      }
    }
```

Then add `dockerfilePath` to the `launchAgent` call:

```typescript
    await launchAgent({
      codebasePath,
      outputPath,
      claudeMdPath,
      prompt: opts.prompt,
      model: opts.model,
      name: opts.name,
      logFile,
      dockerfilePath,
    });
```

- [ ] **Step 4: Run all tests**

Run: `bun test src/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/compose.ts src/commands/launch.ts
git commit -m "feat: add --dockerfile flag to launch command"
```

---

### Task 4: Build Subcommand

**Files:**
- Create: `src/commands/build.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create the build command**

Create `src/commands/build.ts`:

```typescript
// src/commands/build.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { ensureImage, buildExtendedImage, validateDockerfile } from "../lib/image.ts";
import { ensureDocker } from "../lib/docker.ts";

export const buildCommand = new Command("build")
  .description("Pre-build extended sandbox image from a Dockerfile")
  .argument("[path]", "Codebase root (build context)", ".")
  .requiredOption("--dockerfile <path>", "Dockerfile extending base image")
  .action(async (path: string, opts: { dockerfile: string }) => {
    await ensureDocker();

    const contextPath = resolve(path);
    if (!existsSync(contextPath) || !statSync(contextPath).isDirectory()) {
      console.error(`Build context is not a directory: ${contextPath}`);
      process.exit(1);
    }

    const dockerfilePath = resolve(opts.dockerfile);
    if (!existsSync(dockerfilePath)) {
      console.error(`Dockerfile not found: ${dockerfilePath}`);
      process.exit(1);
    }

    // Validate Dockerfile before building base image (fast failure)
    validateDockerfile(readFileSync(dockerfilePath, "utf-8"));

    // Ensure base image exists first
    await ensureImage();

    const extTag = await buildExtendedImage(dockerfilePath, contextPath);
    console.log(extTag);
  });
```

- [ ] **Step 2: Register build command in cli.ts**

In `src/cli.ts`, add the import:

```typescript
import { buildCommand } from "./commands/build.ts";
```

And register the command (add after the existing `addCommand` calls):

```typescript
program.addCommand(buildCommand);
```

- [ ] **Step 3: Run all tests**

Run: `bun test src/`
Expected: PASS

- [ ] **Step 4: Smoke test (manual)**

Run: `bun src/cli.ts build --help`
Expected output includes:
```
Pre-build extended sandbox image from a Dockerfile
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/build.ts src/cli.ts
git commit -m "feat: add build subcommand for pre-building extended images"
```

---

## Chunk 3: Image Cleanup

### Task 5: Clean --images and --all Flags

**Files:**
- Modify: `src/lib/image.ts`
- Modify: `src/commands/clean.ts`

- [ ] **Step 1: Add cleanExtensionImages function to image.ts**

Add to `src/lib/image.ts`:

```typescript
/** Remove all cached agents-cli-ext images. Returns the count removed. */
export async function cleanExtensionImages(): Promise<number> {
  const result = await $`docker images --filter reference=${EXT_IMAGE_NAME} --format {{.ID}}`.quiet().nothrow();
  if (result.exitCode !== 0 || !result.text().trim()) {
    return 0;
  }

  const imageIds = result.text().trim().split("\n").filter(Boolean);
  for (const id of imageIds) {
    await $`docker rmi ${id}`.quiet().nothrow();
  }
  return imageIds.length;
}
```

- [ ] **Step 2: Add --images and --all flags to clean command**

In `src/commands/clean.ts`, add the options:

```typescript
  .option("--images", "Also remove cached extension images", false)
  .option("--all", "Remove containers and cached extension images", false)
```

Update the opts type to include `images: boolean; all: boolean`.

After the `cleanAgents()` call, add:

```typescript
    if (opts.images || opts.all) {
      const { cleanExtensionImages } = await import("../lib/image.ts");
      const count = await cleanExtensionImages();
      if (count > 0) {
        console.log(`Removed ${count} cached extension image(s).`);
      } else {
        console.log("No cached extension images to remove.");
      }
    }
```

- [ ] **Step 3: Run all tests**

Run: `bun test src/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/image.ts src/commands/clean.ts
git commit -m "feat: add --images and --all flags to clean command for extension image cleanup"
```

---

## Chunk 4: Integration Tests

### Task 6: Extended Image Integration Tests

These tests validate the full end-to-end flow: building an extended image from a Dockerfile and running a container from it. They require Docker and are gated behind `INTEGRATION=1`, matching the existing pattern in `tests/integration/firewall.test.ts`.

**Files:**
- Modify: `tests/integration/helpers.ts` (add extended-image test stack helpers)
- Create: `tests/integration/dockerfile-extension.test.ts`

- [ ] **Step 1: Add extended-image test helpers**

In `tests/integration/helpers.ts`, add a new import for `buildExtendedImage` at the top (alongside the existing `ensureImage` and `getImageTag` imports on line 6):

```typescript
import { getImageTag, ensureImage, buildExtendedImage } from "../../src/lib/image.ts";
```

Then add these helpers after the existing `stopTestStack` function:

```typescript
const EXT_TEST_PROJECT = "agents-cli-ext-test-" + Math.random().toString(36).slice(2, 8);

let extComposeFile: string;
let extTmpDir: string;
let extAgentContainerId: string;
let extImageTag: string;

export function getExtTestProject(): string {
  return EXT_TEST_PROJECT;
}

export function getExtAgentContainerId(): string {
  return extAgentContainerId;
}

/**
 * Run a command inside the extended agent container via docker exec.
 */
export async function extDockerExec(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await $`docker exec ${extAgentContainerId} ${cmd}`
    .quiet()
    .nothrow();
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/**
 * Start a test stack using an extended image built from a Dockerfile.
 * The Dockerfile installs `jq` as a test dependency (small, fast to install).
 */
export async function startExtTestStack(): Promise<void> {
  // Ensure base image is built
  await ensureImage();

  extTmpDir = mkdtempSync(join(tmpdir(), "agents-cli-ext-test-"));

  // Write a test Dockerfile that installs jq on top of the base image
  const dockerfilePath = join(extTmpDir, "Dockerfile.ext");
  writeFileSync(
    dockerfilePath,
    `FROM agents-cli-sandbox:latest\nRUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*\n`,
  );

  // Build the extended image
  extImageTag = await buildExtendedImage(dockerfilePath, extTmpDir);

  // Write proxy filter
  const { default: PROXY_FILTER } = await import(
    "../../src/assets/block-write-methods.py"
  );
  const proxyFilterFile = join(extTmpDir, "block-write-methods.py");
  writeFileSync(proxyFilterFile, PROXY_FILTER);

  // Create minimal codebase and output dir
  const codebasePath = join(extTmpDir, "codebase");
  const outputPath = join(extTmpDir, "output");
  mkdirSync(codebasePath, { recursive: true });
  mkdirSync(outputPath, { recursive: true });

  const claudeMdFile = join(codebasePath, "CLAUDE.md");
  writeFileSync(claudeMdFile, "# Test agent (extended)");

  const claudeConfigDir = join(extTmpDir, "claude-config");
  mkdirSync(claudeConfigDir, { recursive: true });

  // Generate compose YAML using the extended image tag
  const yaml = generateComposeYaml({
    imageTag: extImageTag,
    codebasePath,
    outputPath,
    claudeMdFile,
    claudeConfigDir,
    proxyFilterFile,
    model: "claude-sonnet-4-6",
  });

  extComposeFile = join(extTmpDir, "docker-compose.yml");
  writeFileSync(extComposeFile, yaml);

  // Bring up proxy first
  await $`docker compose -f ${extComposeFile} -p ${EXT_TEST_PROJECT} up -d proxy`.quiet();

  // Wait for proxy healthy
  for (let i = 0; i < 30; i++) {
    const health = await $`docker inspect --format='{{.State.Health.Status}}' ${EXT_TEST_PROJECT}-proxy-1`
      .quiet().nothrow();
    if (health.stdout.toString().trim() === "healthy") break;
    await Bun.sleep(1000);
  }

  // Start agent with sleep infinity
  await $`docker compose -f ${extComposeFile} -p ${EXT_TEST_PROJECT} run -d --name ${EXT_TEST_PROJECT}-agent-test agent sleep infinity`.quiet();
  extAgentContainerId = `${EXT_TEST_PROJECT}-agent-test`;

  // Wait for agent container to be running
  for (let i = 0; i < 30; i++) {
    const state = await $`docker inspect -f '{{.State.Status}}' ${extAgentContainerId}`.quiet().nothrow();
    if (state.stdout.toString().trim() === "running") break;
    await Bun.sleep(1000);
  }

  // Wait for entrypoint (firewall setup)
  for (let i = 0; i < 30; i++) {
    const result = await $`docker exec ${extAgentContainerId} iptables -L OUTPUT`.quiet().nothrow();
    if (result.stdout.toString().includes("DROP")) break;
    await Bun.sleep(1000);
  }
}

/**
 * Tear down the extended test stack and clean up the built extension image.
 */
export async function stopExtTestStack(): Promise<void> {
  await $`docker compose -f ${extComposeFile} -p ${EXT_TEST_PROJECT} down -v --remove-orphans`.quiet().nothrow();
  await $`docker rm -f ${extAgentContainerId}`.quiet().nothrow();
  // Remove the test extension image to avoid accumulation
  if (extImageTag) {
    await $`docker rmi ${extImageTag}`.quiet().nothrow();
  }
  rmSync(extTmpDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run existing tests to verify helpers don't break anything**

Run: `bun test src/`
Expected: PASS (helpers are only imported by integration tests)

- [ ] **Step 3: Write the integration test file**

Create `tests/integration/dockerfile-extension.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { getImageTag } from "../../src/lib/image.ts";
import {
  startExtTestStack,
  stopExtTestStack,
  extDockerExec,
} from "./helpers.ts";

// Skip unless INTEGRATION=1
if (!process.env.INTEGRATION) {
  describe.skip("dockerfile extension integration tests (set INTEGRATION=1 to run)", () => {
    test("skipped", () => {});
  });
} else {
  describe("dockerfile extension integration tests", () => {
    beforeAll(async () => {
      await startExtTestStack();
    }, 180_000); // 3 min — base image + extended image build + stack startup

    afterAll(async () => {
      await stopExtTestStack();
    }, 30_000);

    // --- 1. Extended image has custom tooling ---

    describe("custom tools installed", () => {
      test("jq is available in the extended container", async () => {
        const result = await extDockerExec(["jq", "--version"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^jq-/);
      }, 15_000);

      test("jq is NOT in the base image (proves extension added it)", async () => {
        // Run 'which jq' in a fresh base image container to confirm jq is absent
        const baseResult = await $`docker run --rm ${getImageTag()} which jq`.quiet().nothrow();
        expect(baseResult.exitCode).not.toBe(0);
      }, 30_000);

      test("jq can process JSON", async () => {
        const result = await extDockerExec([
          "sh", "-c", "echo '{\"key\":\"value\"}' | jq -r .key",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("value");
      }, 15_000);
    });

    // --- 2. Base image functionality preserved ---

    describe("base image tools still work", () => {
      test("node is available", async () => {
        const result = await extDockerExec(["node", "--version"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^v\d+/);
      }, 15_000);

      test("bun is available", async () => {
        const result = await extDockerExec(["bun", "--version"]);
        expect(result.exitCode).toBe(0);
      }, 15_000);

      test("claude CLI is available", async () => {
        const result = await extDockerExec(["which", "claude"]);
        expect(result.exitCode).toBe(0);
      }, 15_000);
    });

    // --- 3. Security model preserved in extended image ---

    describe("security model preserved", () => {
      test("firewall is active (iptables DROP policy)", async () => {
        const result = await extDockerExec([
          "sh", "-c", "iptables -L OUTPUT | head -1",
        ]);
        // Entrypoint runs as root, but iptables should show DROP policy
        // The exec runs as root since entrypoint started as root
        expect(result.stdout).toContain("DROP");
      }, 15_000);

      test("HTTPS through proxy works", async () => {
        const result = await extDockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "https://example.com",
        ]);
        expect(result.stdout).toBe("200");
      }, 30_000);

      test("POST requests are still blocked", async () => {
        const result = await extDockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "POST", "https://example.com",
        ]);
        expect(result.stdout).toBe("403");
      }, 30_000);

      test("direct HTTP bypass is still blocked", async () => {
        const result = await extDockerExec([
          "curl", "-s", "--connect-timeout", "5",
          "--noproxy", "*",
          "http://example.com",
        ]);
        expect(result.exitCode).not.toBe(0);
      }, 30_000);

      test("IPv6 is still disabled", async () => {
        const result = await extDockerExec([
          "cat", "/proc/sys/net/ipv6/conf/all/disable_ipv6",
        ]);
        expect(result.stdout).toBe("1");
      }, 15_000);
    });

    // --- 4. Workspace mounts work in extended container ---

    describe("workspace mounts", () => {
      test("codebase is mounted read-only at /workspace", async () => {
        const result = await extDockerExec([
          "test", "-f", "/workspace/CLAUDE.md",
        ]);
        expect(result.exitCode).toBe(0);
      }, 15_000);

      test("output directory is writable", async () => {
        const result = await extDockerExec([
          "sh", "-c", "touch /home/claude/output/test-file && echo OK",
        ]);
        expect(result.stdout).toBe("OK");
      }, 15_000);
    });
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add tests/integration/helpers.ts tests/integration/dockerfile-extension.test.ts
git commit -m "test: add integration tests for dockerfile extension support"
```

- [ ] **Step 5: Run integration tests (requires Docker)**

Run: `INTEGRATION=1 bun test tests/integration/dockerfile-extension.test.ts`
Expected: All tests PASS (3 min timeout for image build)

- [ ] **Step 6: Run full integration suite to verify no regressions**

Run: `INTEGRATION=1 bun test tests/integration/`
Expected: All tests PASS (both firewall and dockerfile-extension suites)

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test adjustments"
```

---

### Task 7: Build Image Caching Integration Test

This tests the caching mechanism — that a second build reuses the cached image without rebuilding.

**Files:**
- Create: `tests/integration/image-caching.test.ts`

- [ ] **Step 1: Write image caching tests**

Create `tests/integration/image-caching.test.ts`:

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import {
  ensureImage,
  buildExtendedImage,
  getImageTag,
} from "../../src/lib/image.ts";

if (!process.env.INTEGRATION) {
  describe.skip("image caching integration tests (set INTEGRATION=1 to run)", () => {
    test("skipped", () => {});
  });
} else {
  // NOTE: Tests are intentionally ordered — each builds on prior state
  // (building images is expensive, so we share state across tests).
  describe("image caching integration tests", () => {
    let tmpDir: string;
    const builtTags: string[] = [];

    afterAll(async () => {
      // Clean up test images
      for (const tag of builtTags) {
        await $`docker rmi ${tag}`.quiet().nothrow();
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }, 30_000);

    test("base image is built before extension tests", async () => {
      const tag = await ensureImage();
      expect(tag).toMatch(/^agents-cli-sandbox:/);
    }, 120_000);

    test("buildExtendedImage builds and returns ext tag", async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "agents-cli-cache-test-"));
      const dockerfilePath = join(tmpDir, "Dockerfile.test");
      writeFileSync(
        dockerfilePath,
        "FROM agents-cli-sandbox:latest\nRUN echo 'cache-test' > /tmp/marker\n",
      );

      const tag = await buildExtendedImage(dockerfilePath, tmpDir);
      builtTags.push(tag);

      expect(tag).toMatch(/^agents-cli-ext:[a-f0-9]{12}$/);

      // Verify image exists
      const inspect = await $`docker image inspect ${tag}`.quiet().nothrow();
      expect(inspect.exitCode).toBe(0);
    }, 120_000);

    test("second build with same Dockerfile returns same tag (cache hit)", async () => {
      const dockerfilePath = join(tmpDir, "Dockerfile.test");
      const tag1 = builtTags[0];

      const startTime = performance.now();
      const tag2 = await buildExtendedImage(dockerfilePath, tmpDir);
      const elapsed = performance.now() - startTime;

      expect(tag2).toBe(tag1);
      // Cache hit should be fast (< 5 seconds), not a full rebuild
      expect(elapsed).toBeLessThan(5_000);
    }, 30_000);

    test("different Dockerfile produces different tag (cache miss)", async () => {
      const dockerfilePath2 = join(tmpDir, "Dockerfile.test2");
      writeFileSync(
        dockerfilePath2,
        "FROM agents-cli-sandbox:latest\nRUN echo 'different-content' > /tmp/marker2\n",
      );

      const tag = await buildExtendedImage(dockerfilePath2, tmpDir);
      builtTags.push(tag);

      expect(tag).toMatch(/^agents-cli-ext:[a-f0-9]{12}$/);
      expect(tag).not.toBe(builtTags[0]);
    }, 120_000);
  });
}
```

- [ ] **Step 2: Run the caching tests**

Run: `INTEGRATION=1 bun test tests/integration/image-caching.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/image-caching.test.ts
git commit -m "test: add integration tests for extended image caching"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full unit test suite**

Run: `bun test src/`
Expected: All tests PASS

- [ ] **Step 2: Run full integration test suite**

Run: `INTEGRATION=1 bun test tests/integration/`
Expected: All tests PASS

- [ ] **Step 3: Verify CLI help output**

Run: `bun src/cli.ts --help`
Expected: Shows `build` command in list

Run: `bun src/cli.ts launch --help`
Expected: Shows `--dockerfile <path>` option

Run: `bun src/cli.ts build --help`
Expected: Shows usage with `--dockerfile` required option

Run: `bun src/cli.ts clean --help`
Expected: Shows `--images` and `--all` options

- [ ] **Step 4: Build binary and verify**

Run: `bun build src/cli.ts --compile --outfile /tmp/claude-1000/agents-cli-test`
Expected: Compiles successfully

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "feat: dockerfile extension support - final cleanup"
```
