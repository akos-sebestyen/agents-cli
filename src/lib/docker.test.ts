import { describe, test, expect } from "bun:test";
import { truncate, parseDockerFrames, parseStreamEvent, summarizeToolInput } from "./docker.ts";

describe("truncate", () => {
  test("returns string unchanged when under limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("returns string unchanged when at exact limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  test("truncates and adds ellipsis when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });

  test("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("parseDockerFrames", () => {
  // Helper: build a Docker multiplexed frame
  // Format: [type(1)|0(3)|size(4)][payload]
  function makeFrame(payload: string, streamType: number = 1): Buffer {
    const data = Buffer.from(payload, "utf-8");
    const header = Buffer.alloc(8);
    header.writeUInt8(streamType, 0); // stream type (1=stdout, 2=stderr)
    header.writeUInt32BE(data.length, 4); // payload size
    return Buffer.concat([header, data]);
  }

  test("parses a single valid frame", () => {
    const frame = makeFrame("hello world");
    const result = parseDockerFrames(frame);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]!.toString("utf-8")).toBe("hello world");
    expect(result.remaining.length).toBe(0);
  });

  test("parses multiple frames in one buffer", () => {
    const buf = Buffer.concat([makeFrame("first"), makeFrame("second")]);
    const result = parseDockerFrames(buf);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]!.toString("utf-8")).toBe("first");
    expect(result.frames[1]!.toString("utf-8")).toBe("second");
    expect(result.remaining.length).toBe(0);
  });

  test("returns partial frame as remaining", () => {
    const full = makeFrame("hello world");
    // Cut off last 3 bytes so the frame is incomplete
    const partial = full.subarray(0, full.length - 3);
    const result = parseDockerFrames(partial);
    expect(result.frames).toHaveLength(0);
    expect(result.remaining.length).toBe(partial.length);
  });

  test("handles buffer too small for header", () => {
    const tiny = Buffer.alloc(4); // less than 8-byte header
    const result = parseDockerFrames(tiny);
    expect(result.frames).toHaveLength(0);
    expect(result.remaining.length).toBe(4);
  });

  test("handles empty buffer", () => {
    const result = parseDockerFrames(Buffer.alloc(0));
    expect(result.frames).toHaveLength(0);
    expect(result.remaining.length).toBe(0);
  });

  test("discards buffer on oversized frame (>16MB)", () => {
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(20 * 1024 * 1024, 4); // 20MB — exceeds 16MB limit
    const result = parseDockerFrames(header);
    expect(result.frames).toHaveLength(0);
    expect(result.remaining.length).toBe(0); // discarded
  });

  test("parses stderr frames (type 2) the same as stdout", () => {
    const frame = makeFrame("stderr output", 2);
    const result = parseDockerFrames(frame);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]!.toString("utf-8")).toBe("stderr output");
  });

  test("parses one complete frame + partial remainder", () => {
    const complete = makeFrame("done");
    const partial = makeFrame("incomplete").subarray(0, 10); // only header + 2 bytes
    const buf = Buffer.concat([complete, partial]);
    const result = parseDockerFrames(buf);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]!.toString("utf-8")).toBe("done");
    expect(result.remaining.length).toBe(partial.length);
  });
});

describe("parseStreamEvent", () => {
  test("returns null for empty/whitespace lines", () => {
    expect(parseStreamEvent("")).toBeNull();
    expect(parseStreamEvent("  \n  ")).toBeNull();
  });

  test("returns raw event for non-JSON lines", () => {
    const result = parseStreamEvent("not json at all");
    expect(result).toEqual({ type: "raw", text: "not json at all" });
  });

  test("returns null for rate_limit_event type", () => {
    const result = parseStreamEvent(JSON.stringify({ type: "rate_limit_event" }));
    expect(result).toBeNull();
  });

  test("returns null for unknown event type with no content", () => {
    const result = parseStreamEvent(JSON.stringify({ type: "unknown_type" }));
    expect(result).toBeNull();
  });

  test("parses assistant event with text block", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    if (result!.type === "assistant") {
      expect(result!.parts).toHaveLength(1);
      expect(result!.parts[0]).toEqual({ kind: "text", text: "Hello world" });
      expect(result!.usage!.input_tokens).toBe(10);
      expect(result!.usage!.output_tokens).toBe(5);
    }
  });

  test("parses assistant event with tool_use block", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la", description: "List files" } }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result!.type).toBe("assistant");
    if (result!.type === "assistant") {
      expect(result!.parts).toHaveLength(1);
      expect(result!.parts[0]!.kind).toBe("tool_call");
      if (result!.parts[0]!.kind === "tool_call") {
        expect(result!.parts[0]!.tool).toBe("Bash");
        expect(result!.parts[0]!.summary).toBe("List files");
      }
    }
  });

  test("returns null for assistant event with empty content", () => {
    const event = { type: "assistant", message: { content: [] } };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toBeNull();
  });

  test("returns null for assistant event with missing message", () => {
    const event = { type: "assistant" };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toBeNull();
  });

  test("parses user event with string content as tool_result", () => {
    const event = { type: "user", message: { content: "tool output text" } };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "tool_result", results: ["tool output text"] });
  });

  test("parses user event with array of strings", () => {
    const event = { type: "user", message: { content: ["result1", "result2"] } };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "tool_result", results: ["result1", "result2"] });
  });

  test("parses user event with nested object content", () => {
    const event = {
      type: "user",
      message: { content: [{ content: "nested text" }] },
    };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "tool_result", results: ["nested text"] });
  });

  test("parses user event with deeply nested array content", () => {
    const event = {
      type: "user",
      message: { content: [{ content: ["inner string"] }] },
    };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "tool_result", results: ["inner string"] });
  });

  test("parses user event with text-type objects in nested array", () => {
    const event = {
      type: "user",
      message: { content: [{ content: [{ type: "text", text: "deep text" }] }] },
    };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "tool_result", results: ["deep text"] });
  });

  test("returns null for user event with empty content", () => {
    const event = { type: "user", message: { content: [] } };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toBeNull();
  });

  test("parses result event", () => {
    const event = { type: "result", result: "Final answer" };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "result", text: "Final answer" });
  });

  test("parses result event with truncation", () => {
    const longResult = "x".repeat(3000);
    const event = { type: "result", result: longResult };
    const result = parseStreamEvent(JSON.stringify(event));
    if (result!.type === "result") {
      expect(result!.text.length).toBeLessThanOrEqual(2003); // 2000 + "..."
      expect(result!.text.endsWith("...")).toBe(true);
    }
  });

  test("parses system event", () => {
    const event = { type: "system", subtype: "init", model: "claude-sonnet-4-6" };
    const result = parseStreamEvent(JSON.stringify(event));
    expect(result).toEqual({ type: "system", subtype: "init", model: "claude-sonnet-4-6" });
  });
});

describe("summarizeToolInput", () => {
  test("Bash: returns description if present", () => {
    expect(summarizeToolInput("Bash", { description: "List files", command: "ls -la" })).toBe("List files");
  });

  test("Bash: returns truncated command if no description", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  test("Bash: truncates long commands to 120 chars", () => {
    const longCmd = "x".repeat(200);
    const result = summarizeToolInput("Bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(123); // 120 + "..."
  });

  test("Read: returns file_path", () => {
    expect(summarizeToolInput("Read", { file_path: "/src/index.ts" })).toBe("/src/index.ts");
  });

  test("Write: returns path with char count", () => {
    expect(summarizeToolInput("Write", { file_path: "/out.ts", content: "abc" })).toBe("/out.ts (3 chars)");
  });

  test("Edit: returns file_path", () => {
    expect(summarizeToolInput("Edit", { file_path: "/src/lib.ts" })).toBe("/src/lib.ts");
  });

  test("Grep: returns pattern and path", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO", path: "src/" })).toBe("pattern=TODO path=src/");
  });

  test("Glob: returns pattern in path", () => {
    expect(summarizeToolInput("Glob", { pattern: "*.ts", path: "src/" })).toBe("*.ts in src/");
  });

  test("Glob: defaults path to '.'", () => {
    expect(summarizeToolInput("Glob", { pattern: "*.ts" })).toBe("*.ts in .");
  });

  test("WebFetch: returns truncated URL", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  test("WebSearch: returns query", () => {
    expect(summarizeToolInput("WebSearch", { query: "bun test runner" })).toBe("bun test runner");
  });

  test("Agent: returns description", () => {
    expect(summarizeToolInput("Agent", { description: "Research task" })).toBe("Research task");
  });

  test("unknown tool: returns first string value", () => {
    expect(summarizeToolInput("CustomTool", { foo: "bar", baz: 123 })).toBe("bar");
  });

  test("unknown tool with no string values: returns JSON", () => {
    expect(summarizeToolInput("CustomTool", { a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  test("handles empty input gracefully", () => {
    expect(summarizeToolInput("Read", {})).toBe("");
    expect(summarizeToolInput("Bash", {})).toBe("");
  });
});
