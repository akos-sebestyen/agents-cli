// src/commands/clean.ts
import { Command } from "commander";
import { cleanAgents } from "../lib/compose.ts";
import { ensureDocker } from "../lib/docker.ts";

export const cleanCommand = new Command("clean")
  .description("Stop and remove all agent containers")
  .option("--force", "Skip confirmation prompt", false)
  .action(async (opts: { force: boolean }) => {
    await ensureDocker();

    if (!opts.force) {
      const { listAgentContainers } = await import("../lib/docker.ts");
      const containers = await listAgentContainers();
      if (containers.length === 0) {
        console.log("No agent containers to clean.");
        return;
      }
      console.log(`This will remove ${containers.length} container(s):`);
      for (const c of containers) {
        console.log(`  ${c.shortId} ${c.state.padEnd(10)} ${c.name}`);
      }
      process.stdout.write("\nContinue? [y/N] ");
      const line = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
      });
      if (line.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }
    await cleanAgents();
  });
