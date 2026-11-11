import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
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

// Audit 159 group 03: what a user sees when they misuse the CLI, through the
// real CLI in a child process. Each case pins the first line a user reads.

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

const page = (body: string, title = "P") =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

const project = async (
  name: string,
  files: Record<string, string> = {
    "src/pages/index.html": page("<h1>Hi</h1>"),
  },
): Promise<string> => {
  const root = fixtureRoot(`misuse-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    "export default { generate: { sitemap: false, robots: false } };",
  );
  for (const [path, content] of Object.entries(files))
    await writeFixtureFile(root, path, content);
  return root;
};

// Every test spawns the CLI, which takes a few seconds under a loaded
// full integration run.
describe("CLI misuse messages", { timeout: 60_000 }, () => {
  it("names the missing pages folder, the folder it looked in, and the fix (build, finding 38)", async () => {
    const root = await project("no-pages", {});
    const { code, output } = await run(root, ["--build"]);
    expect(code).toBe(1);
    expect(output).toMatch(
      /^\[bascik\] error: pages directory "src\/pages" \(directory\.pages\) does not exist in .*misuse-no-pages.*\. Run bascik from the project root/m,
    );
    expect(output).toContain("npm create bascik@rc");
    expect(output).not.toMatch(/scandir|ENOENT|^Error: /m);
  });

  it("gives the same message from the dev server instead of an `Error:`-prefixed one (finding 49)", async () => {
    const root = await project("no-pages-dev", {});
    const { code, output } = await run(root, ["--port", "44010", "--no-pin"]);
    expect(code).toBe(1);
    expect(output).toMatch(
      /^\[bascik\] error: pages directory "src\/pages" \(directory\.pages\) does not exist/m,
    );
    expect(output).not.toMatch(/scandir|^Error: /m);
  });

  it("explains a run from a subfolder of the project (finding 139)", async () => {
    const root = await project("subfolder");
    const sub = join(root, "src/pages");
    const { code, output } = await run(sub, ["--build"]);
    expect(code).toBe(1);
    expect(output).toMatch(
      /pages directory "src\/pages" \(directory\.pages\) does not exist in .*src\/pages\. Run bascik from the project root/,
    );
  });

  it("rejects a typo'd --target before transpiling anything (finding 130)", async () => {
    const root = await project("target-typo");
    const { code, output } = await run(root, [
      "--build",
      "--target",
      "netlfy",
      "--site-url",
      "https://example.com",
    ]);
    expect(code).toBe(1);
    expect(output).toMatch(/^\[bascik\] --target/m);
    expect(output).not.toMatch(/transpiled/);
    expect(existsSync(join(root, "dist/index.html"))).toBe(false);
  });

  it("says a local adapter file is missing, without naming Bascik's own files (finding 131)", async () => {
    const root = await project("target-missing-file");
    const { code, output } = await run(root, [
      "--build",
      "--target",
      "./adapters/nope.ts",
      "--site-url",
      "https://example.com",
    ]);
    expect(code).toBe(1);
    expect(output).toMatch(
      /^\[bascik\] --target \.\/adapters\/nope\.ts: adapter file not found at .*misuse-target-missing-file.*\/adapters\/nope\.ts$/m,
    );
    expect(output).not.toMatch(/adapter-resolution|imported from|transpiled/);
  });

  it("prints the page-error summary with project-relative paths and no internal class name (finding 79)", async () => {
    const root = await project("summary", {
      "src/pages/index.html": page("<h1>ok</h1>"),
      "src/pages/c.html": page(
        '<script data-bascik-build data-bascik-server>export default () => "<p>x</p>";</script>',
      ),
    });
    const { code, output } = await run(root, ["--build"]);
    expect(code).toBe(1);
    expect(output).toMatch(/^Build failed with 1 page error:$/m);
    expect(output).toMatch(/^ {2}src\/pages\/c\.html$/m);
    expect(output).not.toMatch(
      /PageProcessingAggregateError|Build pipeline failed|^Error: /m,
    );
  });

  it("warns, located, when about.html and about/index.html split one route, and lists it once in the sitemap (finding 51)", async () => {
    const root = await project("slash-variants", {
      "src/pages/index.html": page("<h1>Home</h1>"),
      "src/pages/about.html": page("<p>flat</p>"),
      "src/pages/about/index.html": page("<p>dir</p>"),
    });
    await writeFixtureFile(root, "bascik.config.js", "export default {};");
    const { code, output } = await run(root, [
      "--build",
      "--site-url",
      "https://example.com",
    ]);
    expect(code).toBe(0);
    expect(output).toContain(
      '[bascik] warning: "/about" and "/about/" are served by different pages:',
    );
    expect(output).toMatch(/^ {2}src\/pages\/about\.html$/m);
    expect(output).toMatch(/^ {2}src\/pages\/about\/index\.html$/m);
    const { readFile } = await import("node:fs/promises");
    const sitemap = await readFile(join(root, "dist/sitemap.xml"), "utf8");
    expect(sitemap.match(/<loc>[^<]*\/about\/?<\/loc>/g)).toEqual([
      "<loc>https://example.com/about</loc>",
    ]);
  });

  it("pins Node's own refusal of a missing --env-file, which runs before Bascik starts (finding 35)", async () => {
    const root = await project("env-file");
    const { code, output } = await run(root, [
      "--env-file",
      "nope.env",
      "--build",
    ]);
    // Node 24 scans argv for --env-file before any script runs and exits 9.
    // If this starts failing, Node stopped intercepting the flag and Bascik's
    // own message (environment.ts) is what users see: update cli.md.
    expect(code).toBe(9);
    // Node prefixes its own executable path (`.../bin/node: nope.env: ...`).
    expect(output.trim()).toMatch(/^\S*node: nope\.env: not found$/);
  });
});

describe("signals a supervisor sends (finding 142)", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(process.platform === "win32")(
    "a SIGHUP to the dev server alone stops it gracefully and leaves no pipeline.exec process behind",
    async () => {
      const root = await project("sighup", {
        "src/pages/index.html": page("<h1>Hi</h1>"),
        "scripts/long.ts": `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
helper.unref();
writeFileSync("pids.json", JSON.stringify([process.pid, helper.pid]));
setInterval(() => {}, 1000);
`,
      });
      await writeFixtureFile(
        root,
        "bascik.config.js",
        `export default {
  generate: { sitemap: false, robots: false },
  pipeline: { exec: [{ script: "scripts/long.ts", phase: "parallel" }] },
};`,
      );
      const { spawn } = await import("node:child_process");
      const child = spawn(
        process.execPath,
        [cli, "--port", "44012", "--no-pin"],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((done) =>
        child.once("exit", (code, signal) => done({ code, signal })),
      );
      const pidsPath = join(root, "pids.json");
      const deadline = Date.now() + 30_000;
      while (
        (!output.includes("All tasks completed") || !existsSync(pidsPath)) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(pidsPath), output).toBe(true);
      const { readFile } = await import("node:fs/promises");
      const pids = JSON.parse(await readFile(pidsPath, "utf8")) as number[];

      child.kill("SIGHUP");
      const result = await exited;

      expect(result, output).toEqual({ code: 0, signal: null });
      await new Promise((r) => setTimeout(r, 300));
      expect(pids.filter(alive), output).toEqual([]);
    },
    60_000,
  );
});
