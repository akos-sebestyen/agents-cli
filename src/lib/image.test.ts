import { describe, test, expect } from "bun:test";
import { getImageTag } from "./image.ts";

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
