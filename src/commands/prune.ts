// src/commands/prune.ts
import { Command } from "commander";
import { ensureDocker, listAgentContainers } from "../lib/docker.ts";
import { $ } from "bun";

export const pruneCommand = new Command("prune")
  .description("Remove stopped agent containers")
  .option("--force", "Skip confirmation prompt", false)
  .action(async (opts: { force: boolean }) => {
    await ensureDocker();

    const agents = await listAgentContainers();
    const exited = agents.filter((a) => a.state !== "running");

    if (exited.length === 0) {
      console.log("No stopped agent containers to prune.");
      return;
    }

    if (!opts.force) {
      console.log(`This will remove ${exited.length} stopped container(s):`);
      for (const c of exited) {
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

    for (const c of exited) {
      await $`docker rm ${c.id}`.quiet();
      console.log(`Removed ${c.name} (${c.shortId})`);
    }

    // Clean up any lingering networks/volumes whose containers are now gone
    const networkResult = await $`docker network ls --filter name=agents-cli- --format '{{.Name}}'`.quiet().nothrow();
    if (networkResult.exitCode === 0) {
      const networks = networkResult.text().trim().split("\n").filter(Boolean);
      for (const net of networks) {
        await $`docker network rm ${net}`.quiet().nothrow();
      }
    }

    console.log(`Pruned ${exited.length} container(s).`);
  });
