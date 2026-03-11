import { Command } from "commander";
import { resolve } from "node:path";
import { resumeAgent } from "../lib/compose.ts";

export const resumeCommand = new Command("resume")
  .description("Resume the most recent agent container")
  .argument("[project-dir]", "Project directory with docker/agent/ compose file", ".")
  .option("-p, --prompt <prompt>", "Follow-up prompt (omit for interactive mode)")
  .option("-m, --model <model>", "Claude model to use", "claude-sonnet-4-6")
  .action(async (projectDir: string, opts: { prompt?: string; model: string }) => {
    const dir = resolve(projectDir);
    await resumeAgent({
      projectDir: dir,
      prompt: opts.prompt,
      model: opts.model,
    });
  });
