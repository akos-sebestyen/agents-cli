import { Command } from "commander";
import { resolve } from "node:path";
import { cleanAgents } from "../lib/compose.ts";

export const cleanCommand = new Command("clean")
  .description("Remove all agent containers")
  .argument("[project-dir]", "Project directory with docker/agent/ compose file", ".")
  .action(async (projectDir: string) => {
    const dir = resolve(projectDir);
    await cleanAgents(dir);
  });
