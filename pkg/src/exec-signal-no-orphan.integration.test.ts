/**
 * A signal sent to the CLI alone never leaves a `pipeline.exec` script
 * running.
 *
 * Only a running server had SIGINT / SIGTERM / SIGHUP handling. A build has
 * no server, and a dev boot has none until its `pre` scripts have finished,
 * so a signal that reached only the `bascik` process there (`kill`, a
 * supervisor, a CI runner canceling a step; a terminal's Ctrl-C signals the
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
type Signal = "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGUSR2";

const project = async (
  name: string,
  phase: Phase,
  // A second script in a later phase, and what lets the run reach it after
  // the signal: the policy that continues past a failed script, or (`gated`)
  // a first script that takes the full 200 ms to stop because it ignores
  // SIGTERM, beside a page whose compile ends once a `go` file exists.
  next?: { phase?: Phase; onExecError?: "warn"; gated?: boolean },
): Promise<string> => {
  const root = fixtureRoot(`exec-signal-${name}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, "package.json", '{"type":"module"}');
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `export default { pipeline: { exec: [{ script: "scripts/wait.js", phase: "${phase}" }${
      next
        ? `, { script: "scripts/next.js", phase: "${next.phase ?? "parallel"}" }`
        : ""
    }]${
      next?.onExecError ? `, onExecError: "${next.onExecError}"` : ""
    } }, generate: { sitemap: false, robots: false } };`,
  );
  await writeFixtureFile(
    root,
    "scripts/next.js",
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "next.pid"))}, String(process.pid));
await new Promise((done) => setTimeout(done, 120_000));
`,
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!doctype html><html lang="en"><head><title>P</title></head><body>${
      next?.gated
        ? `<script data-bascik-build>
import { existsSync } from "node:fs";
export default async () => {
  while (!existsSync(${JSON.stringify(join(root, "go"))}))
    await new Promise((done) => setTimeout(done, 5));
  return "";
};
</script>`
        : ""
    }<h1>Hi</h1></body></html>`,
  );
  await writeFixtureFile(
    root,
    "scripts/wait.js",
    `import { writeFileSync } from "node:fs";
${next?.gated ? 'process.on("SIGTERM", () => {});' : ""}
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
  afterSignal?: () => Promise<void>,
  // Output to wait for, after the script started, before the signal.
  ready?: RegExp,
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
  if (ready && !(await waitFor(() => ready.test(output), 30_000)))
    throw new Error(`never printed ${ready}:\n${output}`);

  process.kill(child.pid!, signal);
  await afterSignal?.();
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
      // SIGQUIT (Ctrl+\) and SIGUSR2 (nodemon's restart) end a process too.
      ["pre", "SIGQUIT"],
      ["pre", "SIGUSR2"],
      ["parallel", "SIGUSR2"],
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

    // Stopping the `pre` script fails it. Where a failure is only a warning
    // (dev by default, a build under `onExecError: "warn"`) the run used to
    // carry on into the `parallel` phase and start that script right before
    // the process died, leaving it running instead.
    /** Whether `scripts/next.js` ran; it is cleaned up if it did. */
    const nextScriptStarted = async (root: string): Promise<boolean> => {
      // A script spawned before the CLI died has had time to write its pid.
      const nextPidFile = join(root, "next.pid");
      await waitFor(() => existsSync(nextPidFile), 1_500);
      if (!existsSync(nextPidFile)) return false;
      const nextPid = Number(readFileSync(nextPidFile, "utf8"));
      if (nextPid) execPids.add(nextPid);
      return true;
    };

    const continuingCases: [
      string,
      string,
      string[],
      { onExecError?: "warn" },
    ][] = [
      ["bascik (dev)", "dev", ["--port", "24936", "--no-pin"], {}],
      [
        "bascik --build, onExecError warn",
        "build",
        ["--build"],
        { onExecError: "warn" },
      ],
    ];
    for (const [label, slug, args, next] of continuingCases) {
      it(`${label}: a signal during pre does not start the parallel script`, async () => {
        const root = await project(`next-${slug}`, "pre", next);
        const result = await signalWhileExecRuns(root, args, "SIGTERM");
        expect(result.execGone, "the pre script is still running").toBe(true);
        expect(result.exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(
          await nextScriptStarted(root),
          "the parallel script was started after the signal",
        ).toBe(false);
        expect(result.output).not.toMatch(/Continuing because/);
      });
    }

    // The page compile runs beside the `parallel` script and is not stopped
    // by the signal. When it ends while that script is still being stopped,
    // the build's next step is the `post` phase.
    it("bascik --build: a signal during parallel does not start the post script when the pages finish", async () => {
      const root = await project("next-post", "parallel", {
        phase: "post",
        gated: true,
      });
      const result = await signalWhileExecRuns(
        root,
        ["--build"],
        "SIGTERM",
        async () => {
          await new Promise((done) => setTimeout(done, 40));
          await writeFixtureFile(root, "go", "1");
        },
      );
      expect(result.execGone, "the parallel script is still running").toBe(
        true,
      );
      expect(result.exit).toEqual({ code: null, signal: "SIGTERM" });
      expect(
        await nextScriptStarted(root),
        "the post script was started after the signal",
      ).toBe(false);
    });

    // Once the server is up, its graceful shutdown stops the exec scripts.
    // A script it stopped is not a failure: the shutdown used to print
    // "exec error: ... exited with code null" with a stack for a parallel
    // script, and "Continuing because pipeline.onExecError is 'warn'" for a
    // post script.
    // A post script starts once the server is bound, before the URL is
    // logged; a parallel one starts before the server exists.
    const shutdownCases: [Phase, Signal, string, RegExp | undefined][] = [
      ["parallel", "SIGINT", "24603", /Server running/],
      ["parallel", "SIGTERM", "24604", /Server running/],
      ["post", "SIGINT", "24605", undefined],
      ["parallel", "SIGUSR2", "24606", /Server running/],
      ["parallel", "SIGQUIT", "24607", /Server running/],
    ];
    for (const [phase, signal, port, ready] of shutdownCases) {
      it(`bascik (dev), server up, ${phase} script running, ${signal}: the stopped script is not reported`, async () => {
        const root = await project(`dev-up-${phase}-${signal}`, phase);
        const result = await signalWhileExecRuns(
          root,
          ["--port", port, "--no-pin"],
          signal,
          undefined,
          ready,
        );
        expect(result.execGone, "the exec script is still running").toBe(true);
        expect(result.output).toMatch(/shutting down gracefully/);
        expect(result.exit).toEqual({ code: 0, signal: null });
        expect(result.output).not.toMatch(
          /exec error|exited with code|was ended by|Continuing because|\n\s+at /,
        );
      });
    }

    it("bascik (dev), pre script running before the server is up, SIGTERM", async () => {
      const root = await project("dev-pre", "pre");
      const result = await signalWhileExecRuns(
        root,
        ["--port", "24930", "--no-pin"],
        "SIGTERM",
      );
      expect(result.execGone, "the exec script is still running").toBe(true);
      expect(result.exit).toEqual({ code: null, signal: "SIGTERM" });
      expect(result.output).not.toMatch(/Server running/);
    });
  },
);
