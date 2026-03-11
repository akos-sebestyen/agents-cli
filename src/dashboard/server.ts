import { listAgentContainers, streamContainerLogs, type TokenUsage } from "../lib/docker.ts";
import INDEX_HTML from "./index.html" with { type: "text" };

interface AgentStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model: string;
  startedAt: number; // timestamp ms
  done: boolean;
  endedAt?: number;
}

/** In-memory stats per container ID (prefix-matched). */
const statsMap = new Map<string, AgentStats>();

function getOrCreateStats(containerId: string): AgentStats {
  let stats = statsMap.get(containerId);
  if (!stats) {
    stats = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: "",
      startedAt: Date.now(),
      done: false,
    };
    statsMap.set(containerId, stats);
  }
  return stats;
}

function accumulateUsage(stats: AgentStats, usage: TokenUsage): void {
  stats.input_tokens += usage.input_tokens;
  stats.output_tokens += usage.output_tokens;
  stats.cache_read_input_tokens += usage.cache_read_input_tokens;
  stats.cache_creation_input_tokens += usage.cache_creation_input_tokens;
}

export function serveDashboard(port: number): void {
  // Start background stats collection for all running agents
  collectAllAgentStats();

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 255, // max value — SSE streams are long-lived
    routes: {
      "/": new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html" },
      }),

      "/api/agents": {
        async GET() {
          const agents = await listAgentContainers();
          // Attach stats to each agent
          const enriched = agents.map((a) => {
            const stats = statsMap.get(a.shortId) ?? statsMap.get(a.id);
            return {
              ...a,
              stats: stats
                ? {
                    input_tokens: stats.input_tokens,
                    output_tokens: stats.output_tokens,
                    cache_read_input_tokens: stats.cache_read_input_tokens,
                    cache_creation_input_tokens: stats.cache_creation_input_tokens,
                    model: stats.model,
                    total_tokens: stats.input_tokens + stats.output_tokens,
                    running_seconds: Math.floor(
                      ((stats.done && stats.endedAt ? stats.endedAt : Date.now()) - stats.startedAt) / 1000,
                    ),
                  }
                : null,
            };
          });
          return Response.json(enriched);
        },
      },

      "/api/agents/:id/stream": {
        async GET(req) {
          const containerId = req.params.id;

          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();

              const send = (data: unknown) => {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                );
              };

              try {
                for await (const event of streamContainerLogs(containerId, {
                  follow: true,
                })) {
                  send(event);
                }
              } catch (err) {
                send({
                  type: "error",
                  text: err instanceof Error ? err.message : String(err),
                });
              }

              send({ type: "done" });
              controller.close();
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        },
      },
    },

    fetch(req) {
      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`Agent Monitor dashboard: http://localhost:${port}`);
}

/**
 * Background task: for every running agent, stream its logs and
 * accumulate token usage stats. Re-checks for new agents periodically.
 */
async function collectAllAgentStats(): Promise<void> {
  const tracking = new Set<string>();

  async function scan() {
    const agents = await listAgentContainers();
    for (const agent of agents) {
      const id = agent.shortId;
      if (tracking.has(id)) continue;
      tracking.add(id);

      // Use the container's created time as start time
      const stats = getOrCreateStats(id);
      stats.startedAt = new Date(agent.created).getTime();

      // Fire and forget — collect stats in background
      collectAgentStats(agent.id, id).catch(() => {});
    }
  }

  async function collectAgentStats(fullId: string, shortId: string): Promise<void> {
    const stats = getOrCreateStats(shortId);
    try {
      for await (const event of streamContainerLogs(fullId, { follow: true })) {
        if (event.type === "assistant" && event.usage) {
          accumulateUsage(stats, event.usage);
        }
        if (event.type === "system" && event.model) {
          stats.model = event.model;
        }
      }
    } catch {
      // Container may have been removed
    }
    stats.done = true;
    stats.endedAt = Date.now();
  }

  // Initial scan + periodic re-scan for new agents
  await scan();
  setInterval(scan, 10_000);
}
