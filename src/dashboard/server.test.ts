import { describe, test, expect } from "bun:test";
import { accumulateUsage } from "./server.ts";
import type { TokenUsage } from "../lib/docker.ts";

describe("accumulateUsage", () => {
  function makeStats() {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: "",
      startedAt: Date.now(),
      done: false,
    };
  }

  test("accumulates token counts", () => {
    const stats = makeStats();
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    };
    accumulateUsage(stats, usage);
    expect(stats.input_tokens).toBe(100);
    expect(stats.output_tokens).toBe(50);
    expect(stats.cache_read_input_tokens).toBe(10);
    expect(stats.cache_creation_input_tokens).toBe(5);
  });

  test("accumulates across multiple calls", () => {
    const stats = makeStats();
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    accumulateUsage(stats, usage);
    accumulateUsage(stats, usage);
    expect(stats.input_tokens).toBe(200);
    expect(stats.output_tokens).toBe(100);
  });

  test("handles all-zero fields", () => {
    const stats = makeStats();
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    accumulateUsage(stats, usage);
    expect(stats.input_tokens).toBe(0);
    expect(stats.output_tokens).toBe(0);
  });
});
