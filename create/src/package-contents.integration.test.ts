import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const createRoot = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * The files `npm publish` would put in the create-bascik tarball, from npm's
 * own packer (`--dry-run`, so nothing is written; `--ignore-scripts`, so
 * no build runs).
 */
const packedFiles = async (): Promise<string[]> => {
  const { stdout } = await run(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: createRoot, shell: process.platform === "win32" },
  );
  const [result] = JSON.parse(stdout) as [{ files: { path: string }[] }];
  return result.files.map((file) => file.path.replace(/\\/g, "/"));
};

describe("create-bascik tarball", () => {
  it("ships the sources next to their source maps but none of the tests", async () => {
    const files = await packedFiles();
    const tests = files.filter((file) => /\.test\.ts$/.test(file));
    expect(tests).toEqual([]);
    // Every non-test source is still there, so dist/*.js.map resolves.
    const sources = readdirSync(join(createRoot, "src"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => `src/${name}`);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(files).toContain(source);
    expect(files).toContain("README.md");
    expect(files).toContain("package.json");
  }, 60_000);
});
