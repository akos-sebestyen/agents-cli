import { describe, test, expect } from "bun:test";
import { getImageTag, validateDockerfile } from "./image.ts";

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
