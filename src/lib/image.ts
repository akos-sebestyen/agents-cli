import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";

import DOCKERFILE from "../assets/Dockerfile" with { type: "text" };
import ENTRYPOINT from "../assets/entrypoint.sh" with { type: "text" };
import FIREWALL from "../assets/init-firewall.sh" with { type: "text" };
import PROXY_FILTER from "../assets/block-write-methods.py" with { type: "text" };

const IMAGE_NAME = "agents-cli-sandbox";

export function validateDockerfile(content: string): void {
  const fromLine = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toUpperCase().startsWith("FROM "));

  if (!fromLine) {
    throw new Error("Dockerfile has no FROM instruction");
  }

  const imageRef = fromLine.split(/\s+/)[1] ?? "";
  const [imageName] = imageRef.split(":");
  if (imageName !== "agents-cli-sandbox") {
    throw new Error(
      `Dockerfile must use "agents-cli-sandbox" as its base image (FROM agents-cli-sandbox:...), got: ${imageRef}`
    );
  }
}

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
  try {
    for (const asset of ASSETS) {
      writeFileSync(join(buildDir, asset.name), asset.content);
    }

    // Build
    const build = await $`docker build -t ${tag} -f ${join(buildDir, "Dockerfile")} ${buildDir}`;
    if (build.exitCode !== 0) {
      console.error("Failed to build sandbox image");
      process.exit(1);
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`Built ${tag}`);
  return tag;
}
