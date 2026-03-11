/**
 * Docker Compose operations for launching agent containers.
 *
 * Wraps `docker compose` CLI commands since dockerode doesn't support compose natively.
 */
import { $ } from "bun";
import { resolve, dirname } from "node:path";

export interface LaunchOptions {
  /** Path to the project root containing docker/agent/docker-compose.agent.yml */
  projectDir: string;
  /** Prompt to pass to the agent (undefined = interactive mode) */
  prompt?: string;
  /** Model override (default: claude-sonnet-4-6) */
  model?: string;
}

function composeFile(projectDir: string): string {
  return resolve(projectDir, "docker/agent/docker-compose.agent.yml");
}

/** Launch a new agent container via docker compose run. */
export async function launchAgent(opts: LaunchOptions): Promise<void> {
  const file = composeFile(opts.projectDir);
  const model = opts.model ?? "claude-sonnet-4-6";

  const args: string[] = [
    "docker",
    "compose",
    "-f",
    file,
    "run",
    "--rm",
  ];

  const claudeArgs = [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    model,
  ];

  if (opts.prompt) {
    claudeArgs.push("--output-format", "stream-json", "--verbose", "-p", opts.prompt);
  }

  args.push("agent", ...claudeArgs);

  // Run interactively — inherit stdio
  const proc = Bun.spawn(args, {
    cwd: dirname(file),
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      CLAUDE_MODEL: model,
    },
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/** Resume an existing agent container. */
export async function resumeAgent(opts: {
  projectDir: string;
  prompt?: string;
  model?: string;
}): Promise<void> {
  const file = composeFile(opts.projectDir);
  const model = opts.model ?? "claude-sonnet-4-6";

  // Find the most recent agent container
  const result =
    await $`docker compose -f ${file} ps -a --format '{{.Name}}'`.text();

  const containers = result
    .trim()
    .split("\n")
    .filter((n) => n.includes("agent") && !n.includes("proxy"));

  if (containers.length === 0) {
    console.error("No previous agent container found. Run 'launch' first.");
    process.exit(1);
  }

  const container = containers[0]!;

  // Check state and start if exited
  const state =
    await $`docker inspect -f '{{.State.Status}}' ${container}`.text();

  if (state.trim() === "exited") {
    await $`docker start ${container}`.quiet();
  } else if (state.trim() === "missing") {
    console.error(`Container ${container} no longer exists.`);
    process.exit(1);
  }

  const claudeArgs = [
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    model,
  ];

  if (opts.prompt) {
    claudeArgs.push("--output-format", "stream-json", "--verbose", "-p", opts.prompt);
  }

  const proc = Bun.spawn(
    ["docker", "exec", "-it", container, ...claudeArgs],
    {
      stdio: ["inherit", "inherit", "inherit"],
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/** Clean up agent containers. */
export async function cleanAgents(projectDir: string): Promise<void> {
  const file = composeFile(projectDir);
  await $`docker compose -f ${file} down`.quiet();
  console.log("Cleaned up agent containers.");
}
