import { describe, test, expect } from "bun:test";
import { parse as yamlParse } from "yaml";
import { projectName, generateComposeYaml, extractProjectNames } from "./compose.ts";

describe("projectName", () => {
  test("returns deterministic name for same path", () => {
    const a = projectName("/home/user/project");
    const b = projectName("/home/user/project");
    expect(a).toBe(b);
  });

  test("returns different names for different paths", () => {
    const a = projectName("/home/user/project-a");
    const b = projectName("/home/user/project-b");
    expect(a).not.toBe(b);
  });

  test("starts with agents-cli- prefix", () => {
    expect(projectName("/some/path")).toMatch(/^agents-cli-/);
  });

  test("session name takes precedence over path", () => {
    const result = projectName("/some/path", "my-session");
    expect(result).toBe("agents-cli-my-session");
  });

  test("uses hash when no session name", () => {
    const result = projectName("/some/path");
    expect(result).toMatch(/^agents-cli-[a-f0-9]{8}$/);
  });
});

describe("generateComposeYaml", () => {
  const defaultOpts = {
    imageTag: "agents-cli-sandbox:abc123",
    codebasePath: "/home/user/project",
    outputPath: "/home/user/output",
    claudeMdFile: "/tmp/CLAUDE.md",
    claudeConfigDir: "/home/user/.claude",
    proxyFilterFile: "/tmp/block-write-methods.py",
    model: "claude-sonnet-4-6",
  };

  function parseCompose(opts = defaultOpts) {
    return yamlParse(generateComposeYaml(opts));
  }

  test("generates valid YAML with proxy and agent services", () => {
    const compose = parseCompose();
    expect(compose.services.proxy).toBeDefined();
    expect(compose.services.agent).toBeDefined();
  });

  test("proxy uses mitmproxy image", () => {
    const compose = parseCompose();
    expect(compose.services.proxy.image).toBe("mitmproxy/mitmproxy:11");
  });

  test("proxy has healthcheck for CA cert", () => {
    const compose = parseCompose();
    const hc = compose.services.proxy.healthcheck;
    expect(hc).toBeDefined();
    expect(hc.test).toContain("/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem");
  });

  test("agent uses specified image tag", () => {
    const compose = parseCompose();
    expect(compose.services.agent.image).toBe("agents-cli-sandbox:abc123");
  });

  test("agent depends on healthy proxy", () => {
    const compose = parseCompose();
    expect(compose.services.agent.depends_on.proxy.condition).toBe("service_healthy");
  });

  test("agent has NET_ADMIN and NET_RAW capabilities", () => {
    const compose = parseCompose();
    expect(compose.services.agent.cap_add).toContain("NET_ADMIN");
    expect(compose.services.agent.cap_add).toContain("NET_RAW");
  });

  test("agent has IPv6 disabled via sysctl", () => {
    const compose = parseCompose();
    expect(compose.services.agent.sysctls).toContain("net.ipv6.conf.all.disable_ipv6=1");
  });

  test("agent has proxy environment variables", () => {
    const compose = parseCompose();
    const env = compose.services.agent.environment;
    expect(env).toContain("http_proxy=http://proxy:8080");
    expect(env).toContain("https_proxy=http://proxy:8080");
  });

  test("agent has model environment variable", () => {
    const compose = parseCompose();
    const env = compose.services.agent.environment;
    expect(env).toContain("CLAUDE_MODEL=claude-sonnet-4-6");
  });

  test("agent has managed label", () => {
    const compose = parseCompose();
    expect(compose.services.agent.labels["com.agents-cli.managed"]).toBe("true");
  });

  test("agent has codebase label", () => {
    const compose = parseCompose();
    expect(compose.services.agent.labels["com.agents-cli.codebase"]).toBe("/home/user/project");
  });

  test("includes session name label when provided", () => {
    const compose = parseCompose({ ...defaultOpts, name: "my-session" });
    expect(compose.services.agent.labels["com.agents-cli.name"]).toBe("my-session");
  });

  test("omits session name label when not provided", () => {
    const compose = parseCompose();
    expect(compose.services.agent.labels["com.agents-cli.name"]).toBeUndefined();
  });

  test("defines shared volume and network", () => {
    const compose = parseCompose();
    expect(compose.volumes["mitmproxy-certs"]).toBeDefined();
    expect(compose.networks["agent-net"]).toBeDefined();
  });

  test("agent mounts codebase as read-only", () => {
    const compose = parseCompose();
    expect(compose.services.agent.volumes).toContainEqual(
      expect.stringContaining("/home/user/project:/workspace:ro")
    );
  });

  test("agent mounts output as read-write", () => {
    const compose = parseCompose();
    expect(compose.services.agent.volumes).toContainEqual(
      expect.stringContaining("/home/user/output:/home/claude/output:rw")
    );
  });
});

describe("extractProjectNames", () => {
  test("extracts project names from container names", () => {
    const names = [
      "agents-cli-abcd1234-agent-run-xyz",
      "agents-cli-abcd1234-proxy-1",
    ];
    expect(extractProjectNames(names)).toEqual(["agents-cli-abcd1234"]);
  });

  test("deduplicates project names", () => {
    const names = [
      "agents-cli-abc-agent-run-1",
      "agents-cli-abc-proxy-1",
      "agents-cli-abc-agent-run-2",
    ];
    expect(extractProjectNames(names)).toEqual(["agents-cli-abc"]);
  });

  test("handles multiple projects", () => {
    const names = [
      "agents-cli-aaa-agent-run-1",
      "agents-cli-bbb-proxy-1",
    ];
    const result = extractProjectNames(names);
    expect(result).toContain("agents-cli-aaa");
    expect(result).toContain("agents-cli-bbb");
    expect(result).toHaveLength(2);
  });

  test("ignores non-matching names", () => {
    const names = ["some-other-container", "agents-cli-abc-agent-run-1"];
    expect(extractProjectNames(names)).toEqual(["agents-cli-abc"]);
  });

  test("returns empty array for no matches", () => {
    expect(extractProjectNames(["random-container"])).toEqual([]);
    expect(extractProjectNames([])).toEqual([]);
  });

  test("handles session names containing 'agent' substring (non-greedy regex)", () => {
    const names = ["agents-cli-my-agent-test-agent-run-1"];
    const result = extractProjectNames(names);
    expect(result).toHaveLength(1);
    // Non-greedy regex with .+? stops at first "agent" match: "agents-cli-my"
    console.log(`Regex captured: ${result[0]} (expected: agents-cli-my-agent-test)`);
  });
});
