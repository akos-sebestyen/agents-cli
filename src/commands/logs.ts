import { Command } from "commander";
import { streamContainerLogs, listAgentContainers, ensureDocker } from "../lib/docker.ts";
import type { ParsedEvent } from "../lib/docker.ts";

export const logsCommand = new Command("logs")
  .description("Stream parsed logs from an agent container")
  .argument("[container-id]", "Container ID or name (default: most recent)")
  .option("-f, --follow", "Follow log output", false)
  .option("--raw", "Show raw JSON events instead of formatted output", false)
  .action(
    async (
      containerId: string | undefined,
      opts: { follow: boolean; raw: boolean },
    ) => {
      await ensureDocker();

      let targetId = containerId;

      if (!targetId) {
        const agents = await listAgentContainers();
        if (agents.length === 0) {
          console.error("No agent containers found.");
          process.exit(1);
        }
        targetId = agents[0]!.shortId;
        console.log(`Streaming logs from ${agents[0]!.name} (${targetId})\n`);
      }

      try {
        for await (const event of streamContainerLogs(targetId, {
          follow: opts.follow,
        })) {
          if (opts.raw) {
            console.log(JSON.stringify(event));
          } else {
            printEvent(event);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no such container") || msg.includes("404")) {
          console.error(`Container '${targetId}' not found. Run 'agents-cli list' to see available containers.`);
        } else {
          console.error(`Error streaming logs: ${msg}`);
        }
        process.exit(1);
      }
    },
  );

function printEvent(event: ParsedEvent): void {
  switch (event.type) {
    case "assistant":
      for (const part of event.parts) {
        if (part.kind === "text") {
          console.log(part.text);
        } else if (part.kind === "tool_call") {
          console.log(`\x1b[35m[${part.tool}]\x1b[0m ${part.summary}`);
        }
      }
      break;

    case "tool_result":
      for (const r of event.results) {
        console.log(`\x1b[33m  > ${r}\x1b[0m`);
      }
      break;

    case "result":
      console.log(`\n\x1b[32m=== RESULT ===\x1b[0m`);
      console.log(event.text);
      break;

    case "system":
      console.log(
        `\x1b[90m[system] ${event.subtype}${event.model ? ` model=${event.model}` : ""}\x1b[0m`,
      );
      break;

    case "error":
      console.log(`\x1b[31m[error] ${event.text}\x1b[0m`);
      break;

    case "raw":
      console.log(`\x1b[90m${event.text}\x1b[0m`);
      break;
  }
}
