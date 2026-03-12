// src/commands/launch.ts
import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { launchAgent, projectName } from "../lib/compose.ts";
import { ensureDocker } from "../lib/docker.ts";

export const launchCommand = new Command("launch")
  .description("Launch a new sandboxed research agent")
  .argument("[path]", "Codebase to mount read-only", ".")
  .option("--output <path>", "Writable output dir", "./agent-output")
  .option("--claude-md <path>", "CLAUDE.md override — appended after system header")
  .option("-p, --prompt <prompt>", "Research prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .option("-n, --name <name>", "Session name (for parallel agents)")
  .option("--no-logs", "Disable auto-streaming logs to output folder")
  .option("--dockerfile <path>", "Dockerfile extending base image")
  .action(async (path: string, opts: {
    output: string;
    claudeMd?: string;
    prompt?: string;
    model?: string;
    name?: string;
    logs: boolean;
    dockerfile?: string;
  }) => {
    await ensureDocker();

    const codebasePath = resolve(path);
    const outputPath = resolve(opts.output);

    if (!existsSync(codebasePath) || !statSync(codebasePath).isDirectory()) {
      console.error(`Codebase path is not a directory: ${codebasePath}`);
      process.exit(1);
    }

    let claudeMdPath: string | undefined;
    if (opts.claudeMd) {
      claudeMdPath = resolve(opts.claudeMd);
      if (!existsSync(claudeMdPath)) {
        console.error(`CLAUDE.md file not found: ${claudeMdPath}`);
        process.exit(1);
      }
    }

    let dockerfilePath: string | undefined;
    if (opts.dockerfile) {
      dockerfilePath = resolve(opts.dockerfile);
      if (!existsSync(dockerfilePath)) {
        console.error(`Dockerfile not found: ${dockerfilePath}`);
        process.exit(1);
      }
    }

    let logFile: string | undefined;
    if (opts.prompt && opts.logs) {
      mkdirSync(outputPath, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      logFile = join(outputPath, `logs_${projectName(codebasePath, opts.name)}_${timestamp}.jsonl`);
      console.error(`Logs: ${logFile}`);
    }

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
  });
