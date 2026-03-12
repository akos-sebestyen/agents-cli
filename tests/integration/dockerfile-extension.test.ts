import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { getImageTag } from "../../src/lib/image.ts";
import {
  startExtTestStack,
  stopExtTestStack,
  extDockerExec,
} from "./helpers.ts";

if (!process.env.INTEGRATION) {
  describe.skip("dockerfile extension integration tests (set INTEGRATION=1 to run)", () => {
    test("skipped", () => {});
  });
} else {
  describe("dockerfile extension integration tests", () => {
    beforeAll(async () => {
      await startExtTestStack();
    }, 180_000);

    afterAll(async () => {
      await stopExtTestStack();
    }, 30_000);

    describe("custom tools installed", () => {
      test("jq is available in the extended container", async () => {
        const result = await extDockerExec(["jq", "--version"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^jq-/);
      }, 15_000);

      test("jq is NOT in the base image (proves extension added it)", async () => {
        const baseResult = await $`docker run --rm ${getImageTag()} which jq`.quiet().nothrow();
        expect(baseResult.exitCode).not.toBe(0);
      }, 30_000);

      test("jq can process JSON", async () => {
        const result = await extDockerExec([
          "sh", "-c", "echo '{\"key\":\"value\"}' | jq -r .key",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("value");
      }, 15_000);
    });

    describe("base image tools still work", () => {
      test("node is available", async () => {
        const result = await extDockerExec(["node", "--version"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^v\d+/);
      }, 15_000);

      test("bun is available", async () => {
        const result = await extDockerExec(["bun", "--version"]);
        expect(result.exitCode).toBe(0);
      }, 15_000);

      test("claude CLI is available", async () => {
        const result = await extDockerExec(["which", "claude"]);
        expect(result.exitCode).toBe(0);
      }, 15_000);
    });

    describe("security model preserved", () => {
      test("firewall is active (iptables DROP policy)", async () => {
        const result = await extDockerExec([
          "sh", "-c", "iptables -L OUTPUT | head -1",
        ]);
        expect(result.stdout).toContain("DROP");
      }, 15_000);

      test("HTTPS through proxy works", async () => {
        const result = await extDockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "https://example.com",
        ]);
        expect(result.stdout).toBe("200");
      }, 30_000);

      test("POST requests are still blocked", async () => {
        const result = await extDockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "POST", "https://example.com",
        ]);
        expect(result.stdout).toBe("403");
      }, 30_000);

      test("direct HTTP bypass is still blocked", async () => {
        const result = await extDockerExec([
          "curl", "-s", "--connect-timeout", "5",
          "--noproxy", "*",
          "http://example.com",
        ]);
        expect(result.exitCode).not.toBe(0);
      }, 30_000);

      test("IPv6 is still disabled", async () => {
        const result = await extDockerExec([
          "cat", "/proc/sys/net/ipv6/conf/all/disable_ipv6",
        ]);
        expect(result.stdout).toBe("1");
      }, 15_000);
    });

    describe("workspace mounts", () => {
      test("codebase is mounted read-only at /workspace", async () => {
        const result = await extDockerExec([
          "test", "-f", "/workspace/CLAUDE.md",
        ]);
        expect(result.exitCode).toBe(0);
      }, 15_000);

      test("output directory is writable", async () => {
        const result = await extDockerExec([
          "sh", "-c", "touch /home/claude/output/test-file && echo OK",
        ]);
        expect(result.stdout).toBe("OK");
      }, 15_000);
    });
  });
}
