/**
 * A stylesheet listed in `assets.inlineStyles` is inlined into every page and
 * not copied to `dist/`, so a `<link rel="stylesheet">` the page still has
 * answers 404. The build used to say nothing about it. These tests run the
 * real CLI: `bascik --build` (serially and with page workers) warns with the
 * page and the link, `bascik --check` reports it, and `bascik --server`
 * answers the request with a typed 404.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cleanupFixture,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const execFileAsync = promisify(execFile);
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const SERVER_PORT = 24652;
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

const project = async (name: string, workers: boolean): Promise<string> => {
  const root = fixtureRoot(`inline-styles-link-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { assets: { inlineStyles: ["src/pages/css/styles.css"] }, pipeline: { workers: ${workers} }, generate: { sitemap: false, robots: false } };`,
  );
  await writeFixtureFile(
    root,
    "src/pages/css/styles.css",
    "body { color: rebeccapurple; }",
  );
  await writeFixtureFile(
    root,
    "src/pages/css/print.css",
    "body { color: black; }",
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!doctype html><html lang="en"><head><title>Books</title><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/css/print.css"></head><body><h1>Books</h1></body></html>`,
  );
  await writeFixtureFile(
    root,
    "src/pages/about.html",
    `<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About</h1></body></html>`,
  );
  return root;
};

const WARNING =
  /src\/pages\/index\.html: <link rel="stylesheet" href="\/css\/styles\.css"> points at a stylesheet that assets\.inlineStyles inlines/;

describe(
  "a <link> to a stylesheet assets.inlineStyles inlines",
  { timeout: 90_000 },
  () => {
    for (const workers of [false, true]) {
      it(`warns in the build with the page and the link (workers: ${workers})`, async () => {
        const root = await project(`build-${workers}`, workers);
        const { code, output } = await run(root, ["--build"]);
        expect(code).toBe(0);
        expect(output).toMatch(WARNING);
        expect(output.match(WARNING) ?? []).toHaveLength(1);
        // The page without the link, and the stylesheet still copied, say nothing.
        expect(output).not.toMatch(/about\.html: <link/);
        expect(output).not.toMatch(/print\.css"> points at/);
        expect(existsSync(join(root, "dist/css/styles.css"))).toBe(false);
        expect(existsSync(join(root, "dist/css/print.css"))).toBe(true);
      });
    }

    it("is a bascik --check warning with the page's line", async () => {
      const root = await project("check", false);
      const { output } = await run(root, ["--check", "--json"]);
      const report = JSON.parse(output.slice(output.indexOf("{"))) as {
        findings: Array<{
          category: string;
          locations: Array<{ filePath: string }>;
        }>;
      };
      const links = report.findings.filter(
        (item) => item.category === "inlined-stylesheet-link",
      );
      expect(links).toHaveLength(1);
      expect(links[0].locations[0].filePath).toMatch(/pages\/index\.html$/);
    });

    it("bascik --server answers the request with a text/plain 404", async () => {
      const root = await project("server", false);
      const built = await run(root, ["--build"]);
      expect(built.code).toBe(0);
      const server = spawn(
        process.execPath,
        [cli, "--server", "--port", String(SERVER_PORT)],
        {
          cwd: root,
          env: { ...process.env, BASCIK_ENABLE_TLS: "false" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = new Promise((done) => server.once("exit", done));
      try {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 200 && !response; attempt++) {
          try {
            response = await fetch(
              `http://localhost:${SERVER_PORT}/css/styles.css`,
            );
          } catch {
            await new Promise((wait) => setTimeout(wait, 100));
          }
        }
        expect(response?.status).toBe(404);
        expect(response?.headers.get("content-type")).toBe(
          "text/plain; charset=utf-8",
        );
        expect(await response?.text()).toBe("Not Found");
      } finally {
        server.kill("SIGTERM");
        await exited;
      }
    });
  },
);
