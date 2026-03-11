// src/commands/stop.ts
import { Command } from "commander";
import { listAgentContainers, ensureDocker } from "../lib/docker.ts";
import { $ } from "bun";

export const stopCommand = new Command("stop")
  .description("Stop a running agent container")
  .argument("[container-id]", "Container to stop (default: most recent running)")
  .action(async (containerId: string | undefined) => {
    await ensureDocker();

    let targetId = containerId;

    if (!targetId) {
      const agents = await listAgentContainers();
      const running = agents.filter((a) => a.state === "running");
      if (running.length === 0) {
        console.error("No running agent containers found.");
        process.exit(1);
      }
      targetId = running[0]!.id;
      console.log(`Stopping ${running[0]!.name} (${running[0]!.shortId})`);
    }

    await $`docker stop ${targetId}`.quiet();
    console.log("Stopped.");
  });
