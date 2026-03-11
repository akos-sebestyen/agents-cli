import Docker from "dockerode";

const docker = new Docker();

export interface AgentContainer {
  id: string;
  shortId: string;
  name: string;
  status: string;
  state: string;
  created: string;
  image: string;
}

const AGENT_SERVICE = "agent";

export function getDocker(): Docker {
  return docker;
}

/** List all agent containers (running or exited). */
export async function listAgentContainers(): Promise<AgentContainer[]> {
  const containers = await docker.listContainers({ all: true });
  const agents: AgentContainer[] = [];

  for (const c of containers) {
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    if (!name.includes(AGENT_SERVICE)) continue;
    if (name.includes("proxy")) continue;

    agents.push({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name,
      status: c.Status ?? "",
      state: c.State ?? "",
      created: new Date(c.Created * 1000).toISOString(),
      image: c.Image,
    });
  }

  // Running first, then by creation time descending
  agents.sort((a, b) => {
    if (a.state === "running" && b.state !== "running") return -1;
    if (a.state !== "running" && b.state === "running") return 1;
    return b.created.localeCompare(a.created);
  });

  return agents;
}

/** Get a container by short ID or full ID. */
export async function getContainer(
  idOrName: string,
): Promise<Docker.Container> {
  return docker.getContainer(idOrName);
}

/** Stream parsed events from a container's logs. */
export async function* streamContainerLogs(
  containerId: string,
  options?: { follow?: boolean },
): AsyncGenerator<ParsedEvent> {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const isRunning = info.State.Running;

  const logStream = await container.logs({
    stdout: true,
    stderr: true,
    follow: options?.follow ?? isRunning,
    timestamps: false,
  });

  // Docker multiplexed stream: 8-byte header per frame
  // [type(1) | 0(3) | size(4)] then payload
  let buffer = Buffer.alloc(0);

  for await (const chunk of logStream as AsyncIterable<Buffer>) {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) break;

      const payload = buffer.subarray(8, 8 + size);
      buffer = buffer.subarray(8 + size);

      const text = payload.toString("utf-8");
      const lines = text.split("\n");

      for (const line of lines) {
        const parsed = parseStreamEvent(line);
        if (parsed) yield parsed;
      }
    }
  }

  // Drain remaining buffer
  if (buffer.length > 0) {
    const text = buffer.toString("utf-8");
    for (const line of text.split("\n")) {
      const parsed = parseStreamEvent(line);
      if (parsed) yield parsed;
    }
  }
}

// --- Event parsing (ported from Python agent-monitor/server.py) ---

export type ParsedEvent =
  | { type: "assistant"; parts: AssistantPart[] }
  | { type: "tool_result"; results: string[] }
  | { type: "result"; text: string }
  | { type: "system"; subtype: string; model: string }
  | { type: "error"; text: string }
  | { type: "raw"; text: string };

type AssistantPart =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; summary: string };

function parseStreamEvent(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return { type: "raw", text: trimmed };
  }

  const etype = (ev.type as string) ?? "unknown";

  if (etype === "assistant") {
    const msg = (ev.message as Record<string, unknown>) ?? {};
    const contentBlocks = (msg.content as Array<Record<string, unknown>>) ?? [];
    const parts: AssistantPart[] = [];

    for (const block of contentBlocks) {
      if (block.type === "text") {
        parts.push({ kind: "text", text: block.text as string });
      } else if (block.type === "tool_use") {
        const toolName = (block.name as string) ?? "unknown";
        const toolInput = (block.input as Record<string, unknown>) ?? {};
        parts.push({
          kind: "tool_call",
          tool: toolName,
          summary: summarizeToolInput(toolName, toolInput),
        });
      }
    }
    if (parts.length > 0) return { type: "assistant", parts };
  } else if (etype === "user") {
    const msg = (ev.message as Record<string, unknown>) ?? {};
    let content = msg.content as unknown;
    if (typeof content === "string") content = [content];
    const results: string[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string" && block) {
          results.push(truncate(block, 500));
        } else if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          const inner = b.content;
          if (typeof inner === "string" && inner) {
            results.push(truncate(inner, 500));
          } else if (Array.isArray(inner)) {
            for (const item of inner) {
              if (typeof item === "string") results.push(truncate(item, 500));
              else if (
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>).type === "text"
              ) {
                results.push(
                  truncate((item as Record<string, unknown>).text as string, 500),
                );
              }
            }
          }
        }
      }
    }

    if (results.length > 0) return { type: "tool_result", results };
  } else if (etype === "result") {
    return { type: "result", text: truncate((ev.result as string) ?? "", 2000) };
  } else if (etype === "system") {
    return {
      type: "system",
      subtype: (ev.subtype as string) ?? "",
      model: (ev.model as string) ?? "",
    };
  } else if (etype === "rate_limit_event") {
    return null;
  }

  return null;
}

function summarizeToolInput(
  toolName: string,
  inp: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash": {
      const desc = inp.description as string;
      const cmd = inp.command as string;
      return desc || truncate(cmd ?? "", 120);
    }
    case "Read":
      return (inp.file_path as string) ?? "";
    case "Write": {
      const fp = inp.file_path as string;
      const content = (inp.content as string) ?? "";
      return `${fp} (${content.length} chars)`;
    }
    case "Edit":
      return (inp.file_path as string) ?? "";
    case "Grep":
      return `pattern=${inp.pattern ?? ""} path=${inp.path ?? ""}`;
    case "Glob":
      return `${inp.pattern ?? ""} in ${inp.path ?? "."}`;
    case "WebFetch":
      return truncate((inp.url as string) ?? "", 120);
    case "WebSearch":
      return (inp.query as string) ?? "";
    case "Agent":
      return (inp.description as string) ?? "";
    default: {
      for (const v of Object.values(inp)) {
        if (typeof v === "string" && v) return truncate(v, 100);
      }
      return truncate(JSON.stringify(inp), 100);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
