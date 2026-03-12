import { describe, test, expect } from "bun:test";
import { getImageTag, validateDockerfile, getExtendedImageTag, rewriteFromLine } from "./image.ts";

describe("validateDockerfile", () => {
  test("accepts Dockerfile that FROMs the base image", () => {
    const content = "FROM agents-cli-sandbox:latest\nRUN apt-get update";
    expect(() => validateDockerfile(content)).not.toThrow();
  });

  test("rejects Dockerfile without FROM base image", () => {
    const content = "FROM ubuntu:22.04\nRUN apt-get update";
    expect(() => validateDockerfile(content)).toThrow(/must use.*agents-cli-sandbox/i);
  });

  test("rejects empty Dockerfile", () => {
    const content = "";
    expect(() => validateDockerfile(content)).toThrow();
  });

  test("accepts FROM with different tag", () => {
    const content = "FROM agents-cli-sandbox:abc123\nRUN echo hi";
    expect(() => validateDockerfile(content)).not.toThrow();
  });

  test("ignores comments and blank lines before FROM", () => {
    const content = "# My custom image\n\nFROM agents-cli-sandbox:latest\nRUN echo hi";
    expect(() => validateDockerfile(content)).not.toThrow();
  });

  test("rejects image name that only starts with agents-cli-sandbox", () => {
    const content = "FROM agents-cli-sandbox-evil:latest\nRUN echo hi";
    expect(() => validateDockerfile(content)).toThrow(/must use.*agents-cli-sandbox/i);
  });
});

describe("getExtendedImageTag", () => {
  test("returns deterministic tag for same inputs", () => {
    const a = getExtendedImageTag("abc123base", "FROM agents-cli-sandbox:latest\nRUN echo hi");
    const b = getExtendedImageTag("abc123base", "FROM agents-cli-sandbox:latest\nRUN echo hi");
    expect(a).toBe(b);
  });

  test("different base image ID produces different tag", () => {
    const dockerfile = "FROM agents-cli-sandbox:latest\nRUN echo hi";
    const a = getExtendedImageTag("base-id-1", dockerfile);
    const b = getExtendedImageTag("base-id-2", dockerfile);
    expect(a).not.toBe(b);
  });

  test("different Dockerfile contents produces different tag", () => {
    const a = getExtendedImageTag("base-id", "FROM agents-cli-sandbox:latest\nRUN echo a");
    const b = getExtendedImageTag("base-id", "FROM agents-cli-sandbox:latest\nRUN echo b");
    expect(a).not.toBe(b);
  });

  test("tag format is agents-cli-ext:<12-hex-chars>", () => {
    const tag = getExtendedImageTag("base", "FROM agents-cli-sandbox:latest");
    expect(tag).toMatch(/^agents-cli-ext:[a-f0-9]{12}$/);
  });
});

describe("rewriteFromLine", () => {
  test("rewrites FROM to exact base tag", () => {
    const input = "FROM agents-cli-sandbox:latest\nRUN echo hi";
    const result = rewriteFromLine(input, "agents-cli-sandbox:abc123def456");
    expect(result).toBe("FROM agents-cli-sandbox:abc123def456\nRUN echo hi");
  });

  test("handles comments before FROM", () => {
    const input = "# comment\nFROM agents-cli-sandbox:latest\nRUN echo hi";
    const result = rewriteFromLine(input, "agents-cli-sandbox:abc123def456");
    expect(result).toBe("# comment\nFROM agents-cli-sandbox:abc123def456\nRUN echo hi");
  });

  test("handles different original tags", () => {
    const input = "FROM agents-cli-sandbox:v1.0\nRUN echo hi";
    const result = rewriteFromLine(input, "agents-cli-sandbox:newhash");
    expect(result).toBe("FROM agents-cli-sandbox:newhash\nRUN echo hi");
  });
});

describe("getImageTag", () => {
  test("returns deterministic tag", () => {
    const a = getImageTag();
    const b = getImageTag();
    expect(a).toBe(b);
  });

  test("starts with agents-cli-sandbox:", () => {
    expect(getImageTag()).toMatch(/^agents-cli-sandbox:/);
  });

  test("hash portion is 12 hex characters", () => {
    const tag = getImageTag();
    const hash = tag.split(":")[1];
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });
});
