import { Command } from "commander";
import { listAgentContainers } from "../lib/docker.ts";

export const listCommand = new Command("list")
  .alias("ls")
  .description("List agent containers")
  .option("-a, --all", "Include exited containers", true)
  .action(async () => {
    const agents = await listAgentContainers();

    if (agents.length === 0) {
      console.log("No agent containers found.");
      return;
    }

    console.log(
      `${"ID".padEnd(14)} ${"STATUS".padEnd(12)} ${"CREATED".padEnd(22)} NAME`,
    );
    console.log("-".repeat(80));

    for (const a of agents) {
      const created = new Date(a.created).toLocaleString();
      const stateColor =
        a.state === "running" ? "\x1b[32m" : "\x1b[90m";
      console.log(
        `${a.shortId.padEnd(14)} ${stateColor}${a.state.padEnd(12)}\x1b[0m ${created.padEnd(22)} ${a.name}`,
      );
    }
  });
