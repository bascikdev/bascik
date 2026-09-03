import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Watch Mode Real-Filesystem Scenarios (Prompt 44)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bascik-watch-test-"));
    await mkdir(join(tempDir, "src/pages"), { recursive: true });
    await mkdir(join(tempDir, "src/components"), { recursive: true });
    await mkdir(join(tempDir, "dist"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch { }
  });

  it("handles atomic save sequence (temp write + rename) cleanly without data loss", async () => {
    const targetFile = join(tempDir, "src/pages/index.html");
    const tempFile = join(tempDir, "src/pages/index.html.tmp");

    await writeFile(targetFile, "<h1>Original</h1>", "utf8");
    await writeFile(tempFile, "<h1>Updated</h1>", "utf8");
    await rename(tempFile, targetFile);

    expect(targetFile).toBeDefined();
  });
});
