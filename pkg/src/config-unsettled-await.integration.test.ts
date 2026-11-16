/**
 * A config whose top-level await never settles.
 *
 * `await new Promise(() => {})` in bascik.config.* left nothing for the event
 * loop to do, so Node exited with code 13 and "Warning: Detected unsettled
 * top-level await at .../pkg/src/index.ts", which points at Bascik's own
 * file. These tests run the real CLI and expect one [bascik] error that names
 * the config file, and exit code 1.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cleanupFixture,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const execFileAsync = promisify(execFile);
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const run = async (
  cwd: string,
  args: string[],
): Promise<{ code: number; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, ...args],
      { cwd, encoding: "utf8", timeout: 60_000 },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (caught) {
    const error = caught as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === "number" ? error.code : -1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
};

const project = async (
  name: string,
  configFile: string,
  config: string,
): Promise<string> => {
  const root = fixtureRoot(`config-unsettled-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(root, configFile, config);
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!doctype html><html lang="en"><head><title>Books</title></head><body><h1>Books</h1></body></html>`,
  );
  return root;
};

const NEVER = "await new Promise(() => {});\nexport default {};\n";

describe(
  "a config whose top-level await never settles",
  { timeout: 60_000 },
  () => {
    for (const args of [["--build"], ["--check"], []]) {
      const label = args.length > 0 ? args.join(" ") : "dev";
      it(`exits 1 with a [bascik] error naming the config (${label})`, async () => {
        const root = await project(
          label.replace(/\W/g, ""),
          "bascik.config.js",
          NEVER,
        );
        const { code, output } = await run(root, args);
        expect(output).toMatch(
          /\[bascik\] error: bascik\.config\.js never finished loading/,
        );
        expect(output).not.toMatch(/Detected unsettled top-level await/);
        expect(output).not.toMatch(/index\.ts/);
        expect(code, output).toBe(1);
      });
    }

    it("names a TypeScript config whose imported helper never settles", async () => {
      const root = await project(
        "ts-helper",
        "bascik.config.ts",
        'import { pages } from "./config/pages.ts";\nexport default { directory: { pages } };\n',
      );
      await writeFixtureFile(
        root,
        "config/pages.ts",
        "export const pages: string = await new Promise<string>(() => {});\n",
      );
      const { code, output } = await run(root, ["--build"]);
      expect(output).toMatch(
        /\[bascik\] error: bascik\.config\.ts never finished loading/,
      );
      expect(code, output).toBe(1);
    });

    // A slow but settling await is not this error.
    it("still loads a config whose top-level await settles later", async () => {
      const root = await project(
        "settles",
        "bascik.config.js",
        "await new Promise((done) => setTimeout(done, 200));\nexport default { generate: { sitemap: false, robots: false } };\n",
      );
      const { code, output } = await run(root, ["--build"]);
      expect(output).toMatch(/Build complete/);
      expect(code, output).toBe(0);
    });
  },
);
