import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestStack, stopTestStack, dockerExec } from "./helpers.ts";

// Skip unless INTEGRATION=1
if (!process.env.INTEGRATION) {
  describe.skip("firewall integration tests (set INTEGRATION=1 to run)", () => {
    test("skipped", () => {});
  });
} else {
  describe("firewall integration tests", () => {
    beforeAll(async () => {
      await startTestStack();
    }, 120_000); // 2 min for image build + stack startup

    afterAll(async () => {
      await stopTestStack();
    }, 30_000);

    // --- 1. Outbound HTTP filtering ---

    describe("outbound HTTP filtering", () => {
      test("GET requests are allowed", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "https://example.com",
        ]);
        expect(result.stdout).toBe("200");
      }, 30_000);

      test("HEAD requests are allowed", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-I", "https://example.com",
        ]);
        expect(result.stdout).toBe("200");
      }, 30_000);

      test("POST requests are blocked with 403", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "POST", "https://example.com",
        ]);
        expect(result.stdout).toBe("403");
      }, 30_000);

      test("PUT requests are blocked with 403", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "PUT", "https://example.com",
        ]);
        expect(result.stdout).toBe("403");
      }, 30_000);

      test("DELETE requests are blocked with 403", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "DELETE", "https://example.com",
        ]);
        expect(result.stdout).toBe("403");
      }, 30_000);

      test("POST to whitelisted host (api.anthropic.com) is allowed", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "POST", "https://api.anthropic.com/v1/messages",
          "-H", "Content-Type: application/json",
          "-d", "{}",
        ]);
        // Should NOT be 403 (may be 401 since we have no valid API key, but that's fine)
        expect(result.stdout).not.toBe("403");
      }, 30_000);
    });

    // --- 2. Subdomain spoofing ---

    describe("subdomain spoofing", () => {
      test("documents .endswith() behavior for subdomain spoofing", async () => {
        // evil.api.anthropic.com would match .endswith("api.anthropic.com")
        // Since traffic goes through the proxy, the proxy sees the Host header.
        // DNS may not resolve evil.api.anthropic.com, so we use --resolve to
        // point it at a real IP, letting the proxy see the spoofed host.
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "-X", "POST",
          "--resolve", "evil.api.anthropic.com:443:93.184.216.34",
          "https://evil.api.anthropic.com/v1/test",
        ]);
        // Document: this currently passes through (not 403) due to .endswith()
        // A fix should make this return 403
        console.log(`Subdomain spoof test result: HTTP ${result.stdout}`);
        // We don't assert pass/fail — this documents the vulnerability
      }, 30_000);
    });

    // --- 3. Network isolation ---

    describe("network isolation", () => {
      test("direct HTTP bypassing proxy is blocked", async () => {
        const result = await dockerExec([
          "curl", "-s", "--connect-timeout", "5",
          "--noproxy", "*",
          "http://example.com",
        ]);
        // Should fail — either connection refused or timeout
        expect(result.exitCode).not.toBe(0);
      }, 30_000);

      test("direct TCP to external IP is blocked", async () => {
        const result = await dockerExec([
          "curl", "-s", "--connect-timeout", "5",
          "--noproxy", "*",
          "http://93.184.216.34",
        ]);
        expect(result.exitCode).not.toBe(0);
      }, 30_000);
    });

    // --- 4. DNS resolution ---

    describe("DNS resolution", () => {
      test("Docker internal DNS works", async () => {
        // getent uses system resolver (Docker's 127.0.0.11)
        const result = await dockerExec([
          "getent", "hosts", "example.com",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toBe("");
      }, 30_000);

      test("external DNS (8.8.8.8) is blocked", async () => {
        // Direct TCP to 8.8.8.8:53 should be blocked by iptables
        const result = await dockerExec([
          "sh", "-c", "timeout 5 bash -c 'echo > /dev/tcp/8.8.8.8/53' 2>&1 || echo BLOCKED",
        ]);
        expect(result.stdout).toContain("BLOCKED");
      }, 30_000);
    });

    // --- 5. IPv6 bypass prevention ---

    describe("IPv6 bypass prevention", () => {
      test("IPv6 is disabled via sysctl", async () => {
        const result = await dockerExec([
          "cat", "/proc/sys/net/ipv6/conf/all/disable_ipv6",
        ]);
        expect(result.stdout).toBe("1");
      }, 15_000);
    });

    // --- 6. Capability dropping ---

    describe("capability dropping", () => {
      test("PID 1 process has NET_ADMIN and NET_RAW dropped from bounding set", async () => {
        const result = await dockerExec([
          "sh", "-c", "grep CapBnd /proc/1/status",
        ]);
        const capLine = result.stdout.trim();
        const hexMatch = capLine.match(/CapBnd:\s*([0-9a-f]+)/i);
        expect(hexMatch).not.toBeNull();
        if (hexMatch) {
          const capValue = BigInt("0x" + hexMatch[1]);
          const NET_ADMIN = BigInt(1) << BigInt(12);
          const NET_RAW = BigInt(1) << BigInt(13);
          expect(capValue & NET_ADMIN).toBe(BigInt(0)); // NET_ADMIN should be unset
          expect(capValue & NET_RAW).toBe(BigInt(0)); // NET_RAW should be unset
        }
      }, 15_000);

      test("PID 1 effective capabilities lack NET_ADMIN and NET_RAW", async () => {
        const result = await dockerExec([
          "sh", "-c", "grep CapEff /proc/1/status",
        ]);
        const capLine = result.stdout.trim();
        const hexMatch = capLine.match(/CapEff:\s*([0-9a-f]+)/i);
        expect(hexMatch).not.toBeNull();
        if (hexMatch) {
          const capValue = BigInt("0x" + hexMatch[1]);
          const NET_ADMIN = BigInt(1) << BigInt(12);
          const NET_RAW = BigInt(1) << BigInt(13);
          expect(capValue & NET_ADMIN).toBe(BigInt(0));
          expect(capValue & NET_RAW).toBe(BigInt(0));
        }
      }, 15_000);
    });

    // --- 7. Proxy health / TLS ---

    describe("proxy health and TLS", () => {
      test("HTTPS through proxy works (CA cert installed)", async () => {
        const result = await dockerExec([
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "https://example.com",
        ]);
        expect(result.stdout).toBe("200");
      }, 30_000);

      test("mitmproxy CA cert file exists", async () => {
        const result = await dockerExec([
          "test", "-f", "/mitmproxy-certs/mitmproxy-ca-cert.pem",
        ]);
        expect(result.exitCode).toBe(0);
      }, 15_000);
    });
  });
}
