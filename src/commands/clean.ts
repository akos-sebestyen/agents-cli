// src/commands/clean.ts
import { Command } from "commander";
import { cleanAgents } from "../lib/compose.ts";
import { ensureDocker } from "../lib/docker.ts";

export const cleanCommand = new Command("clean")
  .description("Stop and remove all agent containers")
  .option("--force", "Skip confirmation prompt", false)
  .option("--images", "Also remove cached extension images", false)
  .option("--all", "Remove containers and cached extension images", false)
  .action(async (opts: { force: boolean; images: boolean; all: boolean }) => {
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

    if (opts.images || opts.all) {
      const { cleanExtensionImages } = await import("../lib/image.ts");
      const count = await cleanExtensionImages();
      if (count > 0) {
        console.log(`Removed ${count} cached extension image(s).`);
      } else {
        console.log("No cached extension images to remove.");
      }
    }
  });
