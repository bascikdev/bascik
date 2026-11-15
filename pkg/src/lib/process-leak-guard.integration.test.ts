/**
 * The leak guard against real processes: a fixture that leaves an orphan
 * behind (`__fixtures__/leak-guard/leaker.ts`), read through the real `ps`.
 * The last two tests run Vitest itself with the guard as its global setup and
 * check the exit code.
 *
 * Every test ends the orphan itself when the guard did not, so a regression
 * here is not also reported by the guard of the run this file is part of.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessLeakGuard,
  LEAK_GUARD_ENV,
} from "./process-leak-guard.test-helper.ts";

const LEAKER = fileURLToPath(
  new URL("./__fixtures__/leak-guard/leaker.ts", import.meta.url),
);
const FIXTURE_CONFIG = fileURLToPath(
  new URL("./__fixtures__/leak-guard/vite.config.js", import.meta.url),
);
const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITEST_CLI = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

const directories: string[] = [];
const processes: ChildProcess[] = [];
const orphans: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The guard already killed it.
    }
  }
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bascik-leak-guard-"));
  directories.push(directory);
  return directory;
}

/**
 * Starts the leaking parent and returns it with its orphan's PID. With
 * `lifetime: "exit"` the parent is gone when this resolves.
 */
async function leak(
  lifetime: "exit" | "wait",
  environment: "inherit" | "scrub",
  marker: string | undefined,
): Promise<{ parent: ChildProcess; orphan: number }> {
  const pidFile = join(temporaryDirectory(), "orphan.pid");
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Not the marker of the run this test is part of.
  delete env[LEAK_GUARD_ENV];
  if (marker !== undefined) env[LEAK_GUARD_ENV] = marker;
  const parent = spawn(
    process.execPath,
    [LEAKER, "parent", pidFile, lifetime, environment],
    { env, stdio: ["pipe", "ignore", "inherit"] },
  );
  processes.push(parent);
  if (lifetime === "exit") {
    const [code] = await once(parent, "exit");
    expect(code).toBe(0);
  } else
    await expect
      .poll(() => {
        try {
          return readFileSync(pidFile, "utf8");
        } catch {
          return "";
        }
      })
      .toMatch(/^\d+$/);
  const orphan = Number(readFileSync(pidFile, "utf8"));
  orphans.push(orphan);
  expect(isAlive(orphan)).toBe(true);
  return { parent, orphan };
}

describe.skipIf(process.platform === "win32")("process leak guard", () => {
  it("finds a reparented orphan by its marker, reports it without its environment, and kills it", async () => {
    // A root that owns nothing, so only the marker can find the orphan.
    const bystander = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    processes.push(bystander);
    const guard = createProcessLeakGuard({
      rootPid: bystander.pid!,
      graceMilliseconds: 300,
      pollMilliseconds: 100,
    });
    const { orphan } = await leak("exit", "inherit", guard.marker);

    const result = await guard.finish();

    expect(result.checked).toBe(true);
    expect(result.leaks.map((entry) => entry.pid)).toEqual([orphan]);
    const [leaked] = result.leaks;
    expect(leaked.command).toContain("leaker.ts orphan");
    expect(leaked.command).not.toContain(LEAK_GUARD_ENV);
    expect(leaked.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(leaked.ageSeconds).toBeLessThan(60);
    // The orphan ignores SIGTERM; the guard must not.
    await expect.poll(() => isAlive(orphan)).toBe(false);
    expect(isAlive(bystander.pid!)).toBe(true);
  });

  it("leaves another run's orphan alone", async () => {
    const bystander = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    processes.push(bystander);
    const guard = createProcessLeakGuard({
      rootPid: bystander.pid!,
      graceMilliseconds: 0,
    });
    const { orphan } = await leak("exit", "inherit", `${guard.marker}-other`);

    expect(await guard.finish()).toEqual({ checked: true, leaks: [] });
    expect(isAlive(orphan)).toBe(true);
  });

  it("finds an orphan with a replaced environment that it sampled while the parent was alive", async () => {
    const { parent, orphan } = await leak("wait", "scrub", undefined);
    const guard = createProcessLeakGuard({
      rootPid: parent.pid!,
      graceMilliseconds: 300,
      pollMilliseconds: 100,
    });
    await guard.sample();
    const exited = once(parent, "exit");
    parent.stdin!.end();
    await exited;

    const result = await guard.finish();

    expect(result.leaks.map((entry) => entry.pid)).toEqual([orphan]);
    await expect.poll(() => isAlive(orphan)).toBe(false);
  });

  it("ends what a run that was killed left behind, and only that", async () => {
    // A run ID names its Vitest process. This one's is a process that has
    // already exited, as after a run that was killed.
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(gone, "exit");
    const bystander = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { stdio: "ignore" },
    );
    processes.push(bystander);
    const { orphan: abandoned } = await leak(
      "exit",
      "inherit",
      `${gone.pid}-0123456789abcdef`,
    );
    // The same, from a run whose Vitest process is still there.
    const { orphan: running } = await leak(
      "exit",
      "inherit",
      `${bystander.pid}-0123456789abcdef`,
    );

    const swept = await createProcessLeakGuard({
      rootPid: process.pid,
    }).sweepAbandoned();

    // The sweep reads the whole machine, so it may find more than this.
    const found = swept.find((entry) => entry.pid === abandoned);
    expect(found?.command).toContain("leaker.ts orphan");
    expect(found?.command).not.toContain(LEAK_GUARD_ENV);
    expect(swept.map((entry) => entry.pid)).not.toContain(running);
    await expect.poll(() => isAlive(abandoned)).toBe(false);
    expect(isAlive(running)).toBe(true);
  });

  describe("as a Vitest global setup", () => {
    async function runVitest(fixture: "leaks" | "clean") {
      const pidFile = join(temporaryDirectory(), "orphan.pid");
      const child = spawn(
        process.execPath,
        [VITEST_CLI, "run", "--config", FIXTURE_CONFIG],
        {
          cwd: PKG_ROOT,
          env: {
            ...process.env,
            LEAK_GUARD_FIXTURE: fixture,
            LEAK_GUARD_FIXTURE_PID_FILE: pidFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      processes.push(child);
      let output = "";
      child.stdout!.on("data", (chunk) => (output += chunk));
      child.stderr!.on("data", (chunk) => (output += chunk));
      const [code] = await once(child, "close");
      return { code, output, pidFile };
    }

    it("fails a run whose tests passed and left a process running, and names it", async () => {
      const { code, output, pidFile } = await runVitest("leaks");
      const orphan = Number(readFileSync(pidFile, "utf8"));
      orphans.push(orphan);

      expect(output).toMatch(/Tests\s+1 passed/);
      expect(output).toContain(
        "Leak guard: this test run left 1 process running.",
      );
      expect(output).toMatch(
        new RegExp(`pid ${orphan}, age \\d+s: .*leaker\\.ts orphan`),
      );
      expect(code).toBe(1);
      expect(isAlive(orphan)).toBe(false);
    }, 60_000);

    it("passes a run that ended everything it started", async () => {
      const { code, output } = await runVitest("clean");
      expect(output).not.toContain("Leak guard");
      expect(code).toBe(0);
    }, 60_000);
  });
});
