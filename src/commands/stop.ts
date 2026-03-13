// src/commands/stop.ts
import { Command } from "commander";
import { listAgentContainers, ensureDocker, resolveContainerId } from "../lib/docker.ts";
import { $ } from "bun";

export const stopCommand = new Command("stop")
  .description("Stop a running agent container")
  .argument("[container-id]", "Container ID, name, or session name (default: most recent running)")
  .option("-n, --name <name>", "Look up container by session name")
  .option("-a, --all", "Stop all running agent containers")
  .action(async (containerId: string | undefined, opts: { name?: string; all?: boolean }) => {
    await ensureDocker();

    if (opts.all) {
      const agents = await listAgentContainers();
      const running = agents.filter((a) => a.state === "running");
      if (running.length === 0) {
        console.error("No running agent containers found.");
        process.exit(1);
      }
      console.log(`Stopping ${running.length} running container${running.length > 1 ? "s" : ""}...`);
      await Promise.all(
        running.map(async (a) => {
          await $`docker stop ${a.id}`.quiet();
          console.log(`  Stopped ${a.name} (${a.shortId})`);
        }),
      );
      console.log("All stopped.");
      return;
    }

    let targetId: string | undefined;
    let displayName: string | undefined;

    const identifier = opts.name ?? containerId;

    if (!identifier) {
      const agents = await listAgentContainers();
      const running = agents.filter((a) => a.state === "running");
      if (running.length === 0) {
        console.error("No running agent containers found.");
        process.exit(1);
      }
      targetId = running[0]!.id;
      displayName = `${running[0]!.name} (${running[0]!.shortId})`;
    } else {
      const resolved = await resolveContainerId(identifier);
      if (!resolved) {
        console.error(`Container '${identifier}' not found. Run 'agents-cli list' to see available containers.`);
        process.exit(1);
      }
      targetId = resolved.id;
      displayName = `${resolved.name} (${resolved.shortId})`;
    }

    console.log(`Stopping ${displayName}`);
    await $`docker stop ${targetId}`.quiet();
    console.log("Stopped.");
  });
