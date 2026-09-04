/**
 * `bascik add` with several `directory.components` roots: files land in the
 * first listed root, and the result reports which root was chosen so the CLI
 * can print it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

const { configState } = vi.hoisted(() => ({
  configState: { directory: { components: [] as string[] } },
}));

vi.mock("./config.js", () => ({ BascikConfig: configState }));

import { addComponents } from "./add.ts";

describe("bascik add with multiple component roots", () => {
  let testDir: string;
  let prevCwd: string;
  let vendorRoot: string;
  let localRoot: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    testDir = realpathSync(tmpdir()) + `/bascik-add-roots-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    vendorRoot = join(testDir, "src", "vendor-components");
    localRoot = join(testDir, "src", "components");
    await mkdir(vendorRoot, { recursive: true });
    await mkdir(localRoot, { recursive: true });
    const pkgDir = join(testDir, "node_modules", "@acme", "ui");
    await mkdir(join(pkgDir, "components"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@acme/ui", version: "1.0.0", bascik: { components: "./components" } }),
    );
    await writeFile(join(pkgDir, "components", "acme-button.html"), "<button><slot></slot></button>");
    configState.directory.components = [vendorRoot, localRoot];
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  it("copies into the first listed root and reports it", async () => {
    const result = await addComponents(["@acme/ui"]);
    expect(result.targetComponentsDir).toBe(vendorRoot);
    expect(await readFile(join(vendorRoot, "acme-button.html"), "utf8")).toBe("<button><slot></slot></button>");
    await expect(access(join(localRoot, "acme-button.html"))).rejects.toThrow();
  });
});
