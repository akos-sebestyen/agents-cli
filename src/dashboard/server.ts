import { listAgentContainers, streamContainerLogs } from "../lib/docker.ts";
import INDEX_HTML from "./index.html" with { type: "text" };

export function serveDashboard(port: number): void {
  Bun.serve({
    port,
    routes: {
      "/": new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html" },
      }),

      "/api/agents": {
        async GET() {
          const agents = await listAgentContainers();
          return Response.json(agents);
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
