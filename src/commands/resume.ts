// src/commands/resume.ts
import { Command } from "commander";
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { resumeAgent, projectName } from "../lib/compose.ts";
import { ensureDocker, resolveContainerId } from "../lib/docker.ts";
import { $ } from "bun";

export const resumeCommand = new Command("resume")
  .description("Resume an agent container")
  .argument("[container-id]", "Container ID, name, or session name (default: most recent)")
  .option("-p, --prompt <prompt>", "Follow-up prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .option("-n, --name <name>", "Look up container by session name")
  .option("--output <path>", "Output dir for log files")
  .option("--log-dir <path>", "Directory for log files (defaults to --output)")
  .option("--no-logs", "Disable auto-streaming logs to output folder")
  .action(async (containerId: string | undefined, opts: {
    prompt?: string;
    model?: string;
    name?: string;
    output?: string;
    logDir?: string;
    logs: boolean;
  }) => {
    await ensureDocker();

    const identifier = opts.name ?? containerId;
    let resolvedId: string | undefined;

    if (identifier) {
      const resolved = await resolveContainerId(identifier);
      if (!resolved) {
        console.error(`Container '${identifier}' not found. Run 'agents-cli list' to see available containers.`);
        process.exit(1);
      }
      resolvedId = resolved.id;
    }

    let logFile: string | undefined;
    if (opts.prompt && opts.logs) {
      let outputPath = opts.output ? resolve(opts.output) : undefined;

      // Try to infer output path from container's bind mounts
      if (!outputPath && resolvedId) {
        outputPath = await inferOutputPath(resolvedId);
      }

      const logDirPath = opts.logDir ? resolve(opts.logDir) : outputPath;

      if (logDirPath) {
        mkdirSync(logDirPath, { recursive: true });
        const project = resolvedId
          ? await inferProjectName(resolvedId)
          : "agents-cli-unknown";
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        logFile = join(logDirPath, `logs_${project}_${timestamp}.jsonl`);
        console.error(`Logs: ${logFile}`);
      }
    }

    await resumeAgent({
      containerId: resolvedId,
      prompt: opts.prompt,
      model: opts.model,
      logFile,
    });
  });

async function inferOutputPath(containerId: string): Promise<string | undefined> {
  const result = await $`docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace/output"}}{{.Source}}{{end}}{{end}}' ${containerId}`.quiet().nothrow();
  if (result.exitCode === 0) {
    const path = result.text().trim();
    if (path) return path;
  }
  return undefined;
}

async function inferProjectName(containerId: string): Promise<string> {
  const result = await $`docker inspect -f '{{index .Config.Labels "com.agents-cli.codebase"}}' ${containerId}`.quiet().nothrow();
  if (result.exitCode === 0) {
    const codebase = result.text().trim();
    if (codebase) return projectName(codebase);
  }
  return "agents-cli-unknown";
}
