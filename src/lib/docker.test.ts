import { describe, test, expect } from "bun:test";
import { truncate, parseDockerFrames } from "./docker.ts";

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
