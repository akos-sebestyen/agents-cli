import { $ } from "bun";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateComposeYaml } from "../../src/lib/compose.ts";
import { getImageTag, ensureImage } from "../../src/lib/image.ts";

const TEST_PROJECT = "agents-cli-test-" + Math.random().toString(36).slice(2, 8);

let composeFile: string;
let tmpDir: string;
let agentContainerId: string;

export function getTestProject(): string {
  return TEST_PROJECT;
}

export function getAgentContainerId(): string {
  return agentContainerId;
}

/**
 * Run a command inside the agent container via docker exec.
 * Returns { stdout, stderr, exitCode }.
 */
export async function dockerExec(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await $`docker exec ${agentContainerId} ${cmd}`
    .quiet()
    .nothrow();
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/**
 * Start the test compose stack. Call once in beforeAll().
 */
export async function startTestStack(): Promise<void> {
  // Ensure image is built
  const imageTag = await ensureImage();

  tmpDir = mkdtempSync(join(tmpdir(), "agents-cli-test-"));

  // Write proxy filter
  const { default: PROXY_FILTER } = await import(
    "../../src/assets/block-write-methods.py"
  );
  const proxyFilterFile = join(tmpDir, "block-write-methods.py");
  writeFileSync(proxyFilterFile, PROXY_FILTER);

  // Create a minimal codebase and output dir
  const codebasePath = join(tmpDir, "codebase");
  const outputPath = join(tmpDir, "output");
  mkdirSync(codebasePath, { recursive: true });
  mkdirSync(outputPath, { recursive: true });

  // Write CLAUDE.md inside codebase so mount overlay works on read-only /workspace
  const claudeMdFile = join(codebasePath, "CLAUDE.md");
  writeFileSync(claudeMdFile, "# Test agent");

  // Create claude config dir
  const claudeConfigDir = join(tmpDir, "claude-config");
  mkdirSync(claudeConfigDir, { recursive: true });

  // Generate compose YAML
  const yaml = generateComposeYaml({
    imageTag,
    codebasePath,
    outputPath,
    claudeMdFile,
    claudeConfigDir,
    proxyFilterFile,
    model: "claude-sonnet-4-6",
  });

  composeFile = join(tmpDir, "docker-compose.yml");
  writeFileSync(composeFile, yaml);

  // Bring up the stack — start proxy first
  await $`docker compose -f ${composeFile} -p ${TEST_PROJECT} up -d proxy`.quiet();

  // Wait for proxy to be healthy
  for (let i = 0; i < 30; i++) {
    const health = await $`docker inspect --format='{{.State.Health.Status}}' ${TEST_PROJECT}-proxy-1`
      .quiet().nothrow();
    if (health.stdout.toString().trim() === "healthy") break;
    await Bun.sleep(1000);
  }

  // Start agent with sleep infinity so we can exec into it
  await $`docker compose -f ${composeFile} -p ${TEST_PROJECT} run -d --name ${TEST_PROJECT}-agent-test agent sleep infinity`.quiet();
  agentContainerId = `${TEST_PROJECT}-agent-test`;

  // Wait for agent container to be running and entrypoint to finish
  for (let i = 0; i < 30; i++) {
    const state = await $`docker inspect -f '{{.State.Status}}' ${agentContainerId}`.quiet().nothrow();
    if (state.stdout.toString().trim() === "running") break;
    await Bun.sleep(1000);
  }

  // Poll for firewall readiness (entrypoint sets iptables DROP policy)
  for (let i = 0; i < 30; i++) {
    const result = await $`docker exec ${agentContainerId} iptables -L OUTPUT`.quiet().nothrow();
    if (result.stdout.toString().includes("DROP")) break;
    await Bun.sleep(1000);
  }
}

/**
 * Tear down the test compose stack. Call in afterAll().
 */
export async function stopTestStack(): Promise<void> {
  await $`docker compose -f ${composeFile} -p ${TEST_PROJECT} down -v --remove-orphans`.quiet().nothrow();
  // Also force-remove the named agent container if it exists
  await $`docker rm -f ${agentContainerId}`.quiet().nothrow();
  rmSync(tmpDir, { recursive: true, force: true });
}
