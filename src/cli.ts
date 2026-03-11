#!/usr/bin/env bun
import { program } from "commander";
import { dashboardCommand } from "./commands/dashboard.ts";
import { launchCommand } from "./commands/launch.ts";
import { listCommand } from "./commands/list.ts";
import { resumeCommand } from "./commands/resume.ts";
import { logsCommand } from "./commands/logs.ts";
import { cleanCommand } from "./commands/clean.ts";
import { configCommand } from "./commands/config.ts";
import { printExplain } from "./commands/explain.ts";

program
  .name("agents-cli")
  .description("CLI for managing sandboxed Claude research agents")
  .version("0.1.0")
  .option("--explain", "In-depth explanation of how agents-cli works");

program.addCommand(dashboardCommand);
program.addCommand(launchCommand);
program.addCommand(listCommand);
program.addCommand(resumeCommand);
program.addCommand(logsCommand);
program.addCommand(cleanCommand);
program.addCommand(configCommand);

// Intercept --explain before Commander shows default help
const args = process.argv.slice(2);
if (args.includes("--explain")) {
  printExplain();
  process.exit(0);
}

program.parse();
