import { Command } from "commander";
import { loadConfig, saveConfig } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";

const VALID_KEYS: (keyof Config)[] = ["claudeConfig", "defaultModel"];

export const configCommand = new Command("config")
  .description("Manage agents-cli configuration")
  .action(() => {
    const config = loadConfig();
    for (const [key, value] of Object.entries(config)) {
      console.log(`${key} = ${value}`);
    }
  });

configCommand
  .command("set <key> <value>")
  .description("Set a config value")
  .action((key: string, value: string) => {
    if (!VALID_KEYS.includes(key as keyof Config)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Valid keys: ${VALID_KEYS.join(", ")}`);
      process.exit(1);
    }
    const config = loadConfig();
    (config as Record<string, string>)[key] = value;
    saveConfig(config);
    console.log(`${key} = ${value}`);
  });
