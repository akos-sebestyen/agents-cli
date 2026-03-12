import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

const EXT_IMAGE_NAME = "agents-cli-ext";

export function getExtendedImageTag(baseImageId: string, dockerfileContents: string): string {
  const hasher = createHash("sha256");
  hasher.update(baseImageId);
  hasher.update(dockerfileContents);
  return `${EXT_IMAGE_NAME}:${hasher.digest("hex").slice(0, 12)}`;
}

export function rewriteFromLine(dockerfileContents: string, baseTag: string): string {
  return dockerfileContents.replace(
    /^(FROM\s+)agents-cli-sandbox:\S+/im,
    `$1${baseTag}`,
  );
}

export async function buildExtendedImage(
  dockerfilePath: string,
  contextPath: string,
): Promise<string> {
  const dockerfileContents = readFileSync(dockerfilePath, "utf-8");
  validateDockerfile(dockerfileContents);

  const baseTag = getImageTag();
  const inspectResult = await $`docker image inspect --format={{.Id}} ${baseTag}`.quiet().nothrow();
  if (inspectResult.exitCode !== 0) {
    throw new Error(`Base image ${baseTag} not found. Run without --dockerfile first, or run 'agents-cli build' to build it.`);
  }
  const baseImageId = inspectResult.text().trim();

  const extTag = getExtendedImageTag(baseImageId, dockerfileContents);

  const cached = await $`docker image inspect ${extTag}`.quiet().nothrow();
  if (cached.exitCode === 0) {
    return extTag;
  }

  console.log(`Building extended image ${extTag}...`);

  const rewrittenDockerfile = rewriteFromLine(dockerfileContents, baseTag);

  const buildDir = mkdtempSync(join(tmpdir(), "agents-cli-ext-build-"));
  try {
    const tmpDockerfile = join(buildDir, "Dockerfile");
    writeFileSync(tmpDockerfile, rewrittenDockerfile);

    const build = await $`docker build -f ${tmpDockerfile} -t ${extTag} ${contextPath}`.nothrow();
    if (build.exitCode !== 0) {
      console.error("Failed to build extended image");
      process.exit(1);
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`Built ${extTag}`);
  return extTag;
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

/** Remove all cached agents-cli-ext images. Returns the count removed. */
export async function cleanExtensionImages(): Promise<number> {
  const result = await $`docker images --filter reference=${EXT_IMAGE_NAME} --format {{.ID}}`.quiet().nothrow();
  if (result.exitCode !== 0 || !result.text().trim()) {
    return 0;
  }

  const imageIds = result.text().trim().split("\n").filter(Boolean);
  for (const id of imageIds) {
    await $`docker rmi ${id}`.quiet().nothrow();
  }
  return imageIds.length;
}
