// src/commands/resume.ts
import { Command } from "commander";
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { resumeAgent, projectName } from "../lib/compose.ts";
import { $ } from "bun";

export const resumeCommand = new Command("resume")
  .description("Resume an agent container")
  .argument("[container-id]", "Container to resume (default: most recent)")
  .option("-p, --prompt <prompt>", "Follow-up prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .option("--output <path>", "Output dir for log files")
  .option("--no-logs", "Disable auto-streaming logs to output folder")
  .action(async (containerId: string | undefined, opts: {
    prompt?: string;
    model?: string;
    output?: string;
    logs: boolean;
  }) => {
    let logFile: string | undefined;
    if (opts.prompt && opts.logs) {
      let outputPath = opts.output ? resolve(opts.output) : undefined;

      // Try to infer output path from container's bind mounts
      if (!outputPath && containerId) {
        outputPath = await inferOutputPath(containerId);
      }

      if (outputPath) {
        mkdirSync(outputPath, { recursive: true });
        // Use a generic project name since we may not have the codebase path
        const project = containerId
          ? await inferProjectName(containerId)
          : "agents-cli-unknown";
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        logFile = join(outputPath, `logs_${project}_${timestamp}.jsonl`);
        console.error(`Logs: ${logFile}`);
      }
    }

    await resumeAgent({
      containerId,
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
