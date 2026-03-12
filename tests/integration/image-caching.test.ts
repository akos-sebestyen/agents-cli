import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import {
  ensureImage,
  buildExtendedImage,
  getImageTag,
} from "../../src/lib/image.ts";

if (!process.env.INTEGRATION) {
  describe.skip("image caching integration tests (set INTEGRATION=1 to run)", () => {
    test("skipped", () => {});
  });
} else {
  // NOTE: Tests are intentionally ordered — each builds on prior state
  // (building images is expensive, so we share state across tests).
  describe("image caching integration tests", () => {
    let tmpDir: string;
    const builtTags: string[] = [];

    afterAll(async () => {
      // Clean up test images
      for (const tag of builtTags) {
        await $`docker rmi ${tag}`.quiet().nothrow();
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }, 30_000);

    test("base image is built before extension tests", async () => {
      const tag = await ensureImage();
      expect(tag).toMatch(/^agents-cli-sandbox:/);
    }, 120_000);

    test("buildExtendedImage builds and returns ext tag", async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "agents-cli-cache-test-"));
      const dockerfilePath = join(tmpDir, "Dockerfile.test");
      writeFileSync(
        dockerfilePath,
        "FROM agents-cli-sandbox:latest\nRUN echo 'cache-test' > /tmp/marker\n",
      );

      const tag = await buildExtendedImage(dockerfilePath, tmpDir);
      builtTags.push(tag);

      expect(tag).toMatch(/^agents-cli-ext:[a-f0-9]{12}$/);

      // Verify image exists
      const inspect = await $`docker image inspect ${tag}`.quiet().nothrow();
      expect(inspect.exitCode).toBe(0);
    }, 120_000);

    test("second build with same Dockerfile returns same tag (cache hit)", async () => {
      const dockerfilePath = join(tmpDir, "Dockerfile.test");
      const tag1 = builtTags[0];

      const startTime = performance.now();
      const tag2 = await buildExtendedImage(dockerfilePath, tmpDir);
      const elapsed = performance.now() - startTime;

      expect(tag2).toBe(tag1);
      // Cache hit should be fast (< 5 seconds), not a full rebuild
      expect(elapsed).toBeLessThan(5_000);
    }, 30_000);

    test("different Dockerfile produces different tag (cache miss)", async () => {
      const dockerfilePath2 = join(tmpDir, "Dockerfile.test2");
      writeFileSync(
        dockerfilePath2,
        "FROM agents-cli-sandbox:latest\nRUN echo 'different-content' > /tmp/marker2\n",
      );

      const tag = await buildExtendedImage(dockerfilePath2, tmpDir);
      builtTags.push(tag);

      expect(tag).toMatch(/^agents-cli-ext:[a-f0-9]{12}$/);
      expect(tag).not.toBe(builtTags[0]);
    }, 120_000);
  });
}
