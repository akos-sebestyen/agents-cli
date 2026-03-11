// src/lib/compose.ts
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { $ } from "bun";
import { stringify as yamlStringify } from "yaml";

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
  /** Path to write JSONL log file (when streaming logs to file) */
  logFile?: string;
  /** Session name for parallel agents */
  name?: string;
}

/** Derive a stable compose project name from the codebase path (or session name). */
export function projectName(codebasePath: string, name?: string): string {
  if (name) return `agents-cli-${name}`;
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
          // Pass through API key if set in host environment
          ...(process.env.ANTHROPIC_API_KEY
            ? [`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`]
            : []),
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
  try {
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
      name: opts.name,
    });
    const composeFile = join(tmpDir, "docker-compose.yml");
    writeFileSync(composeFile, composeYaml);

    const project = projectName(opts.codebasePath, opts.name);

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

    const useLogFile = opts.prompt && opts.logFile;

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
        stdio: ["inherit", useLogFile ? "pipe" : "inherit", "inherit"],
        env: { ...process.env },
      },
    );

    // Forward signals to child process
    const forwardSignal = () => { proc.kill("SIGTERM"); };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    try {
      if (useLogFile && proc.stdout) {
        const writer = Bun.file(opts.logFile!).writer();
        const reader = proc.stdout.getReader();
        const drain = (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
            writer.flush();
          }
          writer.end();
        })();
        const exitCode = await proc.exited;
        await drain;
        if (exitCode !== 0) process.exit(exitCode);
      } else {
        const exitCode = await proc.exited;
        if (exitCode !== 0) process.exit(exitCode);
      }
    } finally {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Resume the most recent (or specified) agent container. */
export async function resumeAgent(opts: {
  containerId?: string;
  prompt?: string;
  model?: string;
  logFile?: string;
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
    console.error(`Container '${containerId}' not found. Run 'agents-cli list' to see available containers.`);
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

  const useLogFile = opts.prompt && opts.logFile;

  const proc = Bun.spawn(
    ["docker", "exec", useLogFile ? "-i" : "-it", containerId, ...claudeArgs],
    { stdio: ["inherit", useLogFile ? "pipe" : "inherit", "inherit"] },
  );

  // Forward signals to child process
  const forwardSignal = () => { proc.kill("SIGTERM"); };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  try {
    if (useLogFile && proc.stdout) {
      const writer = Bun.file(opts.logFile!).writer();
      const reader = proc.stdout.getReader();
      const drain = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
          writer.flush();
        }
        writer.end();
      })();
      const exitCode = await proc.exited;
      await drain;
      if (exitCode !== 0) process.exit(exitCode);
    } else {
      const exitCode = await proc.exited;
      if (exitCode !== 0) process.exit(exitCode);
    }
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
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
    const match = c.name.match(/^(agents-cli-.+?)-(agent|proxy)-/);
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
