#!/usr/bin/env bun
import { program } from "commander";
import { dashboardCommand } from "./commands/dashboard.ts";
import { launchCommand } from "./commands/launch.ts";
import { listCommand } from "./commands/list.ts";
import { resumeCommand } from "./commands/resume.ts";
import { logsCommand } from "./commands/logs.ts";
import { cleanCommand } from "./commands/clean.ts";

program
  .name("agents-cli")
  .description("CLI for managing sandboxed Claude research agents")
  .version("0.1.0");

program.addCommand(dashboardCommand);
program.addCommand(launchCommand);
program.addCommand(listCommand);
program.addCommand(resumeCommand);
program.addCommand(logsCommand);
program.addCommand(cleanCommand);

program.parse();
