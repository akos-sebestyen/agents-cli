// src/commands/launch.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { launchAgent } from "../lib/compose.ts";

export const launchCommand = new Command("launch")
  .description("Launch a new sandboxed research agent")
  .argument("[path]", "Codebase to mount read-only", ".")
  .option("--output <path>", "Writable output dir", "./agent-output")
  .option("--claude-md <path>", "CLAUDE.md override — appended after system header")
  .option("-p, --prompt <prompt>", "Research prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .action(async (path: string, opts: {
    output: string;
    claudeMd?: string;
    prompt?: string;
    model?: string;
  }) => {
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

    await launchAgent({
      codebasePath,
      outputPath,
      claudeMdPath,
      prompt: opts.prompt,
      model: opts.model,
    });
  });
