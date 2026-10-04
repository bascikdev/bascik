/**
 * example.integration.test.ts
 *
 * Boundary: the built CLI (`dist/index.js`) as a real child process -> real HTTP to a local archive
 * server (CREATE_BASCIK_ARCHIVE_BASE) -> real file system. Covers what unit tests cannot: argument
 * handling through the shell boundary, exit codes, stdout/stderr, a process without a terminal, and
 * cleanup when the process is killed mid-download.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type FixtureServer, githubArchive, startFixtureServer, tarGz } from "./archive-fixtures.js";

const execFileAsync = promisify(execFile);
const CREATE_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ENTRY = join(CREATE_ROOT, "dist/index.js");

let server: FixtureServer;
let work: string;

// Build first so the process under test is the compiled entry point that gets published.
beforeAll(async () => {
  const tsc = resolve(CREATE_ROOT, "../node_modules/typescript/bin/tsc");
  await execFileAsync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: CREATE_ROOT });
}, 120_000);

beforeEach(async () => {
  server = await startFixtureServer();
  work = await mkdtemp(join(tmpdir(), "create-bascik-cli-test-"));
});

afterEach(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((accept, reject) => {
    // No terminal is attached (stdin is a pipe), which is how CI and scripts run the CLI.
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: work,
      env: { ...process.env, CREATE_BASCIK_ARCHIVE_BASE: server.base, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => accept({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

const GITHUB = "https://github.com/acme/starter/tree/main/app";
const starter = () => githubArchive({ "app/package.json": JSON.stringify({ name: "x", scripts: { dev: "echo hi" } }), "app/src/pages/index.html": "<h1>hi</h1>" }, "starter-main");

describe("create-bascik --example, as a process", () => {
  it("copies a GitHub folder, exits 0, and runs nothing", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: starter() });
    const result = await cli(["site", "--example", GITHUB]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("third-party repository");
    expect(result.stdout).toContain("npm install");
    expect(JSON.parse(await readFile(join(work, "site/package.json"), "utf8")).name).toBe("site");
    expect((await readdir(join(work, "site"))).sort()).toEqual(["package.json", "src"]);
    expect(server.requests).toEqual(["/acme/starter/tar.gz/main"]);
  });

  it("does not install after --yes for a third-party example (nothing is spawned, so nothing is slow)", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: starter() });
    const result = await cli(["site", "-e", GITHUB, "--yes"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Installing dependencies");
    await expect(lstat(join(work, "site/node_modules"))).rejects.toThrow();
  });

  it("supports the --example=value form", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { body: starter() });
    expect((await cli(["site", `--example=${GITHUB}`])).code).toBe(0);
  });

  it("fails with exit 1 and a clear message for an unknown official id, before any request", async () => {
    const result = await cli(["site", "--example", "nope"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not an official example");
    expect(server.requests).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  it("fails with exit 1 and usage for an unknown option", async () => {
    const result = await cli(["site", "--exmaple", "blog"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown option "--exmaple"');
    expect(result.stderr).toContain("Usage: create-bascik");
  });

  it("fails with exit 1 when the repository has no archive, creating nothing", async () => {
    const result = await cli(["site", "-e", GITHUB]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nothing was created.");
    expect(await readdir(work)).toEqual([]);
  });

  it("fails with exit 1 for a malicious archive and leaves no files or staging folder", async () => {
    server.routes.set("/acme/starter/tar.gz/main", {
      body: tarGz([{ path: "starter-main", type: "dir" }, { path: "starter-main/app/package.json", type: "file", content: "{}" }, { path: "starter-main/app/../../escape", type: "file", content: "x" }]),
    });
    const result = await cli(["site", "-e", GITHUB]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("climbs out");
    expect(await readdir(work)).toEqual([]);
  });

  it("fails with exit 1 and leaves existing files alone when the folder is not empty", async () => {
    expect((await cli(["site"])).code).toBe(0);
    server.routes.set("/acme/starter/tar.gz/main", { body: starter() });
    const before = (await readdir(join(work, "site"), { recursive: true })).sort();
    const result = await cli(["site", "-e", GITHUB]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not empty");
    expect((await readdir(join(work, "site"), { recursive: true })).sort()).toEqual(before);
    expect(server.requests).toEqual([]);
  });

  it("removes its staging folder when it is killed during the download", async () => {
    server.routes.set("/acme/starter/tar.gz/main", { hang: true });
    const child = spawn(process.execPath, [ENTRY, "site", "-e", GITHUB], {
      cwd: work,
      env: { ...process.env, CREATE_BASCIK_ARCHIVE_BASE: server.base },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<number | null>((accept) => child.once("close", accept));
    for (let attempt = 0; attempt < 100 && server.requests.length === 0; attempt++) await new Promise((accept) => setTimeout(accept, 50));
    expect(server.requests).toHaveLength(1);
    expect((await readdir(work)).some((name) => name.startsWith(".create-bascik-"))).toBe(true);
    child.kill("SIGTERM");
    expect(await closed).toBe(143);
    expect(await readdir(work)).toEqual([]);
  });
});

describe("the default starter, as a process", () => {
  it("scaffolds without a terminal and without installing", async () => {
    const result = await cli(["plain"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Next steps");
    expect(await readFile(join(work, "plain/package.json"), "utf8")).toContain('"name": "plain"');
    expect(await readFile(join(work, "plain/src/pages/index.html"), "utf8")).toContain("<!DOCTYPE html>");
    await expect(lstat(join(work, "plain/node_modules"))).rejects.toThrow();
    expect(server.requests).toEqual([]);
  });
});
