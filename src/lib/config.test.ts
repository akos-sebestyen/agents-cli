import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveClaudeConfig } from "./config.ts";

describe("resolveClaudeConfig", () => {
  test("expands ~/ to home directory", () => {
    const result = resolveClaudeConfig({ claudeConfig: "~/.claude", defaultModel: "x" });
    expect(result).toBe(join(homedir(), ".claude"));
  });

  test("returns absolute paths unchanged", () => {
    const result = resolveClaudeConfig({ claudeConfig: "/custom/path", defaultModel: "x" });
    expect(result).toBe("/custom/path");
  });

  test("returns relative paths unchanged if not ~/", () => {
    const result = resolveClaudeConfig({ claudeConfig: "relative/path", defaultModel: "x" });
    expect(result).toBe("relative/path");
  });
});
