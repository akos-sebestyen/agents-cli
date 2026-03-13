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
  codebase: string;
  sessionName: string;
}

const MANAGED_LABEL = "com.agents-cli.managed";

export function getDocker(): Docker {
  return docker;
}

/** Check Docker is reachable. Exit with helpful message if not. */
export async function ensureDocker(): Promise<void> {
  try {
    await docker.ping();
  } catch {
    console.error(
      "Error: Cannot connect to Docker. Is Docker running?\n" +
      "  Install: https://docs.docker.com/get-docker/"
    );
    process.exit(1);
  }
}

/** List all agent containers (running or exited). */
export async function listAgentContainers(): Promise<AgentContainer[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${MANAGED_LABEL}=true`] },
  });
  const agents: AgentContainer[] = [];

  for (const c of containers) {
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    // Skip proxy sidecar containers — only show agent containers
    if (name.includes("-proxy-")) continue;
    agents.push({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name,
      status: c.Status ?? "",
      state: c.State ?? "",
      created: new Date(c.Created * 1000).toISOString(),
      image: c.Image,
      codebase: c.Labels?.["com.agents-cli.codebase"] ?? "",
      sessionName: c.Labels?.["com.agents-cli.name"] ?? "",
    });
  }

  agents.sort((a, b) => {
    if (a.state === "running" && b.state !== "running") return -1;
    if (a.state !== "running" && b.state === "running") return 1;
    return b.created.localeCompare(a.created);
  });

  return agents;
}

/** List orphaned proxy containers (matching agents-cli-*-proxy-* but missing the managed label). */
export async function listOrphanedProxyContainers(): Promise<AgentContainer[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { name: ["agents-cli-"] },
  });

  const orphans: AgentContainer[] = [];
  for (const c of containers) {
    // Skip containers that already have the managed label (handled by listAgentContainers)
    if (c.Labels?.[MANAGED_LABEL] === "true") continue;

    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    // Only pick up proxy containers
    if (!name.includes("-proxy-")) continue;

    orphans.push({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name,
      status: c.Status ?? "",
      state: c.State ?? "",
      created: new Date(c.Created * 1000).toISOString(),
      image: c.Image,
      codebase: c.Labels?.["com.agents-cli.codebase"] ?? "",
      sessionName: c.Labels?.["com.agents-cli.name"] ?? "",
    });
  }

  return orphans;
}

/**
 * Resolve a user-provided identifier to a container.
 * Tries in order: direct Docker lookup (ID/container name), then session name match.
 */
export async function resolveContainerId(identifier: string): Promise<AgentContainer | null> {
  const agents = await listAgentContainers();

  // Try matching by short ID, full ID, or Docker container name
  const byId = agents.find(a =>
    a.shortId === identifier ||
    a.id === identifier ||
    a.name === identifier
  );
  if (byId) return byId;

  // Try matching by session name (case-insensitive)
  const bySessionName = agents.find(a =>
    a.sessionName && a.sessionName.toLowerCase() === identifier.toLowerCase()
  );
  if (bySessionName) return bySessionName;

  return null;
}

const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16MB sanity limit

/**
 * Parse Docker multiplexed stream frames from a buffer.
 * Format: [type(1) | 0(3) | size(4)] then payload
 * Returns parsed frame payloads and any remaining incomplete bytes.
 */
export function parseDockerFrames(buffer: Buffer): {
  frames: Buffer[];
  remaining: Buffer;
} {
  const frames: Buffer[] = [];

  while (buffer.length >= 8) {
    const size = buffer.readUInt32BE(4);
    if (size > MAX_FRAME_SIZE) {
      // Malformed frame — discard buffer
      return { frames, remaining: Buffer.alloc(0) };
    }
    if (buffer.length < 8 + size) break;

    frames.push(buffer.subarray(8, 8 + size));
    buffer = buffer.subarray(8 + size);
  }

  return { frames, remaining: Buffer.from(buffer) };
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

  const chunks: Buffer[] = [];
  let totalLen = 0;

  for await (const chunk of logStream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    totalLen += chunk.length;

    if (totalLen < 8) continue;

    let buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    chunks.length = 0;
    totalLen = 0;

    const { frames, remaining } = parseDockerFrames(buffer);

    for (const frame of frames) {
      const text = frame.toString("utf-8");
      for (const line of text.split("\n")) {
        const parsed = parseStreamEvent(line);
        if (parsed) yield parsed;
      }
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
      totalLen = remaining.length;
    }
  }

  // Drain remaining buffer
  if (totalLen > 0) {
    const buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    const text = buffer.toString("utf-8");
    for (const line of text.split("\n")) {
      const parsed = parseStreamEvent(line);
      if (parsed) yield parsed;
    }
  }
}

// --- Event parsing (ported from Python agent-monitor/server.py) ---

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type ParsedEvent =
  | { type: "assistant"; parts: AssistantPart[]; usage?: TokenUsage }
  | { type: "tool_result"; results: string[] }
  | { type: "result"; text: string }
  | { type: "system"; subtype: string; model: string }
  | { type: "error"; text: string }
  | { type: "raw"; text: string };

type AssistantPart =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; summary: string; input: Record<string, unknown> };

export function parseStreamEvent(line: string): ParsedEvent | null {
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
          input: toolInput,
        });
      }
    }
    if (parts.length > 0) {
      const usage = (msg.usage as Record<string, unknown>) ?? {};
      const tokenUsage: TokenUsage = {
        input_tokens: (usage.input_tokens as number) ?? 0,
        output_tokens: (usage.output_tokens as number) ?? 0,
        cache_read_input_tokens: (usage.cache_read_input_tokens as number) ?? 0,
        cache_creation_input_tokens: (usage.cache_creation_input_tokens as number) ?? 0,
      };
      return { type: "assistant", parts, usage: tokenUsage };
    }
  } else if (etype === "user") {
    const msg = (ev.message as Record<string, unknown>) ?? {};
    let content = msg.content as unknown;
    if (typeof content === "string") content = [content];
    const results: string[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string" && block) {
          results.push(truncate(block, 5000));
        } else if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          const inner = b.content;
          if (typeof inner === "string" && inner) {
            results.push(truncate(inner, 5000));
          } else if (Array.isArray(inner)) {
            for (const item of inner) {
              if (typeof item === "string") results.push(truncate(item, 5000));
              else if (
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>).type === "text"
              ) {
                results.push(
                  truncate((item as Record<string, unknown>).text as string, 5000),
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

export function summarizeToolInput(
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

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
