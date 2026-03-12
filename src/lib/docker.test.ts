import { describe, test, expect } from "bun:test";
import { truncate } from "./docker.ts";

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
