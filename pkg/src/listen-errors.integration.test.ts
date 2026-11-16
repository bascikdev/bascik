/**
 * A server that cannot listen on its address.
 *
 * `bascik --server --port 80` as an unprivileged user printed Node's bare
 * `listen EACCES: permission denied ::1:80` (the dev server added "Server
 * startup failed:" and a stack), and a `--host` that is not this computer's
 * printed `listen EADDRNOTAVAIL` with a stack. Both now print one [bascik]
 * line with the fix, and exit 1, in dev and under --server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// Never bound: 192.0.2.0/24 is TEST-NET-1 (RFC 5737), on no interface.
const FOREIGN_HOST = "192.0.2.1";
const FREE_PORT = "24562";
let root = "";

const run = async (
  args: string[],
): Promise<{ code: number; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, ...args],
      { cwd: root, encoding: "utf8", timeout: 60_000 },
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

beforeAll(async () => {
  root = fixtureRoot("listen-errors");
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    "export default { generate: { sitemap: false, robots: false } };",
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!doctype html><html lang="en"><head><title>Books</title></head><body><h1>Books</h1></body></html>`,
  );
}, 60_000);

afterAll(async () => {
  await cleanupFixture(root);
});

// Root may listen on port 80; the test needs an unprivileged user.
const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;

// --server reads the build; dev replaces dist/, so each --server case builds.
const modes: { name: string; args: string[]; build: boolean }[] = [
  { name: "dev", args: ["--no-pin"], build: false },
  { name: "--server", args: ["--server"], build: true },
];

describe("a server that cannot listen", { timeout: 90_000 }, () => {
  for (const mode of modes) {
    it.skipIf(!unprivileged)(
      `explains a port below 1024 (${mode.name})`,
      async () => {
        if (mode.build) expect((await run(["--build"])).code).toBe(0);
        const { code, output } = await run([...mode.args, "--port", "80"]);
        expect(output).toMatch(
          /\[bascik\] error: permission denied to listen on \S+:80 \(EACCES\)\. Ports below 1024 need administrator privileges/,
        );
        expect(output.match(/permission denied/g) ?? [], output).toHaveLength(
          1,
        );
        expect(output).not.toMatch(/\n\s+at /);
        expect(code, output).toBe(1);
      },
    );

    it(`explains a host that is not this computer's (${mode.name})`, async () => {
      if (mode.build) expect((await run(["--build"])).code).toBe(0);
      const { code, output } = await run([
        ...mode.args,
        "--port",
        FREE_PORT,
        "--host",
        FOREIGN_HOST,
      ]);
      expect(output).toMatch(
        /\[bascik\] error: cannot listen on 192\.0\.2\.1:24562 \(EADDRNOTAVAIL\): "192\.0\.2\.1" is not an address of this computer/,
      );
      expect(output).not.toMatch(/\n\s+at /);
      expect(code, output).toBe(1);
    });
  }
});
