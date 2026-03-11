import { Command } from "commander";
import { resolve } from "node:path";
import { launchAgent } from "../lib/compose.ts";

export const launchCommand = new Command("launch")
  .description("Launch a new sandboxed research agent")
  .argument("[project-dir]", "Project directory with docker/agent/ compose file", ".")
  .option("-p, --prompt <prompt>", "Research prompt (omit for interactive mode)")
  .option("-m, --model <model>", "Claude model to use", "claude-sonnet-4-6")
  .action(async (projectDir: string, opts: { prompt?: string; model: string }) => {
    const dir = resolve(projectDir);
    await launchAgent({
      projectDir: dir,
      prompt: opts.prompt,
      model: opts.model,
    });
  });
