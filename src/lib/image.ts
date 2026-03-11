import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";

import DOCKERFILE from "../assets/Dockerfile" with { type: "text" };
import ENTRYPOINT from "../assets/entrypoint.sh" with { type: "text" };
import FIREWALL from "../assets/init-firewall.sh" with { type: "text" };
import PROXY_FILTER from "../assets/block-write-methods.py" with { type: "text" };

const IMAGE_NAME = "agents-cli-sandbox";

// Hash all assets in alphabetical order by filename
const ASSETS = [
  { name: "block-write-methods.py", content: PROXY_FILTER },
  { name: "Dockerfile", content: DOCKERFILE },
  { name: "entrypoint.sh", content: ENTRYPOINT },
  { name: "init-firewall.sh", content: FIREWALL },
];

function computeHash(): string {
  const hasher = createHash("sha256");
  for (const asset of ASSETS) {
    hasher.update(asset.content);
  }
  return hasher.digest("hex").slice(0, 12);
}

export function getImageTag(): string {
  return `${IMAGE_NAME}:${computeHash()}`;
}

export async function ensureImage(): Promise<string> {
  const tag = getImageTag();

  // Check if image exists locally
  const result = await $`docker image inspect ${tag}`.quiet().nothrow();
  if (result.exitCode === 0) {
    return tag;
  }

  console.log(`Building sandbox image ${tag}...`);

  // Write assets to temp dir
  const buildDir = mkdtempSync(join(tmpdir(), "agents-cli-build-"));
  for (const asset of ASSETS) {
    writeFileSync(join(buildDir, asset.name), asset.content);
  }

  // Build
  const build = await $`docker build -t ${tag} -f ${join(buildDir, "Dockerfile")} ${buildDir}`;
  if (build.exitCode !== 0) {
    console.error("Failed to build sandbox image");
    process.exit(1);
  }

  console.log(`Built ${tag}`);
  return tag;
}
