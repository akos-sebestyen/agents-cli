// src/commands/resume.ts
import { Command } from "commander";
import { resumeAgent } from "../lib/compose.ts";

export const resumeCommand = new Command("resume")
  .description("Resume an agent container")
  .argument("[container-id]", "Container to resume (default: most recent)")
  .option("-p, --prompt <prompt>", "Follow-up prompt (omit for interactive)")
  .option("-m, --model <model>", "Model override")
  .action(async (containerId: string | undefined, opts: {
    prompt?: string;
    model?: string;
  }) => {
    await resumeAgent({
      containerId,
      prompt: opts.prompt,
      model: opts.model,
    });
  });
