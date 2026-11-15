/**
 * A signal sent to the CLI alone never leaves a `pipeline.exec` script
 * running.
 *
 * Only a running server had SIGINT / SIGTERM / SIGHUP handling. A build has
 * no server, and a dev boot has none until its `pre` scripts have finished,
 * so a signal that reached only the `bascik` process there (`kill`, a
 * supervisor, a CI runner cancelling a step; a terminal's Ctrl-C signals the
 * whole process group and hid this) ended it at once and orphaned the exec
 * script, which kept running with no parent.
 *
 * Each test runs the real CLI in its own process group with an exec script
 * that records its pid and then waits, signals the CLI process only, and
 * checks that the CLI ends with that signal and that the script is gone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupFixture,
  fixtureRoot,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

const roots: string[] = [];
const children = new Set<ChildProcess>();
const execPids = new Set<number>();

afterEach(async () => {
  // Whatever a failed assertion left behind: the CLI's process group, and
  // the exec script, which is the process this suite is about.
  for (const child of children) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
  children.clear();
  for (const pid of execPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  execPids.clear();
  await Promise.all(roots.splice(0).map(cleanupFixture));
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return condition();
};

type Phase = "pre" | "parallel" | "post";
type Signal = "SIGTERM" | "SIGINT" | "SIGHUP";

const project = async (name: string, phase: Phase): Promise<string> => {
  const root = fixtureRoot(`exec-signal-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { pipeline: { exec: [{ script: "scripts/wait.js", phase: "${phase}" }] }, generate: { sitemap: false, robots: false } };`,
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    '<!doctype html><html lang="en"><head><title>P</title></head><body><h1>Hi</h1></body></html>',
  );
  await writeFixtureFile(
    root,
    "scripts/wait.js",
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "exec.pid"))}, String(process.pid));
await new Promise((done) => setTimeout(done, 120_000));
`,
  );
  return root;
};

/** Start the CLI, wait for the exec script, signal the CLI process only. */
const signalWhileExecRuns = async (
  root: string,
  args: string[],
  signal: Signal,
): Promise<{
  exit: { code: number | null; signal: NodeJS.Signals | null } | "timeout";
  execPid: number;
  execGone: boolean;
  output: string;
}> => {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => child.once("exit", (code, sig) => done({ code, signal: sig })));

  const pidFile = join(root, "exec.pid");
  const started = await waitFor(
    () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
    30_000,
  );
  if (!started) throw new Error(`exec script never started:\n${output}`);
  const execPid = Number(readFileSync(pidFile, "utf8"));
  execPids.add(execPid);

  process.kill(child.pid!, signal);
  const exit = await Promise.race([
    exited,
    new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 10_000)),
  ]);
  const execGone = await waitFor(() => !isAlive(execPid), 5_000);
  return { exit, execPid, execGone, output };
};

// Signals to one process of a group, and a default action to die of, are
// POSIX; on Windows `kill` ends the process unconditionally.
describe.skipIf(process.platform === "win32")(
  "a signal sent to the CLI alone stops its exec scripts",
  { timeout: 60_000 },
  () => {
    const buildCases: [Phase, Signal][] = [
      ["pre", "SIGTERM"],
      ["pre", "SIGINT"],
      ["pre", "SIGHUP"],
      ["parallel", "SIGTERM"],
      ["post", "SIGTERM"],
    ];
    for (const [phase, signal] of buildCases) {
      it(`bascik --build, ${phase} script running, ${signal}`, async () => {
        const root = await project(`build-${phase}-${signal}`, phase);
        const result = await signalWhileExecRuns(root, ["--build"], signal);
        expect(result.execGone, "the exec script is still running").toBe(true);
        expect(result.exit).toEqual({ code: null, signal });
        expect(result.output).not.toMatch(/Build complete/);
      });
    }

    it("bascik (dev), pre script running before the server is up, SIGTERM", async () => {
      const root = await project("dev-pre", "pre");
      const result = await signalWhileExecRuns(
        root,
        ["--port", "44930", "--no-pin"],
        "SIGTERM",
      );
      expect(result.execGone, "the exec script is still running").toBe(true);
      expect(result.exit).toEqual({ code: null, signal: "SIGTERM" });
      expect(result.output).not.toMatch(/Server running/);
    });
  },
);
