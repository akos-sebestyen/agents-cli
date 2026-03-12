import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { generateClaudeMd } from "./claude-md.ts";

describe("generateClaudeMd", () => {
  const tmpFile = "/tmp/claude-1000/test-claude-md-user-content.md";

  afterEach(() => {
    try { rmSync(tmpFile); } catch {}
  });

  test("returns system header when no user content path", () => {
    const result = generateClaudeMd();
    expect(result).toContain("# Research Agent Instructions");
    expect(result).not.toContain("---");
  });

  test("appends user content with separator when path provided", () => {
    writeFileSync(tmpFile, "# My Custom Instructions\n\nDo the thing.");
    const result = generateClaudeMd(tmpFile);
    expect(result).toContain("# Research Agent Instructions");
    expect(result).toContain("---");
    expect(result).toContain("# My Custom Instructions");
    expect(result).toContain("Do the thing.");
  });

  test("system header always includes key sections", () => {
    const result = generateClaudeMd();
    expect(result).toContain("/workspace/");
    expect(result).toContain("/home/claude/output/");
    expect(result).toContain("agent-browser");
  });
});
