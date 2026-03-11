import { Command } from "commander";
import { serveDashboard } from "../dashboard/server.ts";

export const dashboardCommand = new Command("dashboard")
  .description("Launch the live agent monitor web dashboard")
  .option("-p, --port <port>", "Port to listen on", "8150")
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    serveDashboard(port);
  });
