// src/commands/build.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { ensureImage, buildExtendedImage, validateDockerfile } from "../lib/image.ts";
import { ensureDocker } from "../lib/docker.ts";

export const buildCommand = new Command("build")
  .description("Pre-build extended sandbox image from a Dockerfile")
  .argument("[path]", "Codebase root (build context)", ".")
  .requiredOption("--dockerfile <path>", "Dockerfile extending base image")
  .action(async (path: string, opts: { dockerfile: string }) => {
    await ensureDocker();

    const contextPath = resolve(path);
    if (!existsSync(contextPath) || !statSync(contextPath).isDirectory()) {
      console.error(`Build context is not a directory: ${contextPath}`);
      process.exit(1);
    }

    const dockerfilePath = resolve(opts.dockerfile);
    if (!existsSync(dockerfilePath)) {
      console.error(`Dockerfile not found: ${dockerfilePath}`);
      process.exit(1);
    }

    // Validate Dockerfile before building base image (fast failure)
    try {
      validateDockerfile(readFileSync(dockerfilePath, "utf-8"));
    } catch (e: unknown) {
      console.error((e as Error).message);
      process.exit(1);
    }

    // Ensure base image exists first
    await ensureImage();

    const extTag = await buildExtendedImage(dockerfilePath, contextPath);
    console.log(extTag);
  });
