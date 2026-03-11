import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".agents-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface Config {
  claudeConfig: string;
  defaultModel: string;
}

const DEFAULTS: Config = {
  claudeConfig: join(homedir(), ".claude"),
  defaultModel: "claude-sonnet-4-6",
};

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(
      readFileSync(CONFIG_PATH, "utf-8"),
    );
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function resolveClaudeConfig(config: Config): string {
  return config.claudeConfig;
}
