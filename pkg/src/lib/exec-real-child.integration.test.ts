// Exec entries run as real child processes: where a relative script resolves,
// what a missing working directory reports, and what a timeout leaves behind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import {
  getActiveExecChildrenCount,
  runScript,
  resetActiveExecChildrenForTests,
} from "./exec.ts";
import { stopBeforeExit } from "./exit-stoppers.ts";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * A wrapper script that starts a long-lived grandchild (as a script running
 * `tailwindcss --watch` would) and writes its pid. With `ignoreTerm` the
 * wrapper also ignores SIGTERM, so only the SIGKILL escalation ends it.
 */
const writeWrapper = async (
  ignoreTerm: boolean,
  grandchildIgnoresTerm = false,
): Promise<string> => {
  await mkdir(join(project, "scripts"), { recursive: true });
  const script = join(
    "scripts",
    grandchildIgnoresTerm
      ? "stubborn-grandchild.mjs"
      : ignoreTerm
        ? "stubborn.mjs"
        : "wrapper.mjs",
  );
  const grandchildCode = grandchildIgnoresTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  await writeFile(
    join(project, script),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
const grandchild = spawn(process.execPath, ["-e", "${grandchildCode}"], { stdio: "ignore" });
writeFileSync("grandchild.pid", String(grandchild.pid));
setInterval(() => {}, 1000);
`,
  );
  return script;
};

const grandchildPid = async (): Promise<number> => {
  await waitFor(() => {
    try {
      return realpathSync(join(project, "grandchild.pid")) !== "";
    } catch {
      return false;
    }
  });
  return Number(await readFile(join(project, "grandchild.pid"), "utf8"));
};

let project: string;

beforeEach(async () => {
  project = realpathSync(
    await mkdtemp(join(tmpdir(), "bascik-exec-real-child-")),
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetActiveExecChildrenForTests();
  await rm(project, { recursive: true, force: true });
});

describe("exec script resolution with a cwd", () => {
  it("runs a project-root relative script inside the entry's cwd", async () => {
    await mkdir(join(project, "scripts"));
    await mkdir(join(project, "packages", "site"), { recursive: true });
    await writeFile(
      join(project, "scripts", "sync.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync("ran.txt", process.cwd());
`,
    );

    await runScript({ script: "scripts/sync.mjs", cwd: "packages/site" });

    // The script was found at the project root and started in packages/site.
    const ranIn = await readFile(
      join(project, "packages", "site", "ran.txt"),
      "utf8",
    );
    expect(realpathSync(ranIn)).toBe(join(project, "packages", "site"));
  });

  it("names a typo'd working directory instead of the Node binary", async () => {
    await mkdir(join(project, "scripts"));
    await writeFile(join(project, "scripts", "sync.mjs"), "");

    const run = runScript({ script: "scripts/sync.mjs", cwd: "packagez/site" });
    await expect(run).rejects.toThrow(
      'exec "scripts/sync.mjs": working directory "packagez/site" does not exist',
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "exec timeout and exit leave no process behind",
  () => {
    it("kills the processes a timed-out script started", async () => {
      const script = await writeWrapper(false);
      const run = runScript({ script, timeout: 1500 });
      const pid = await grandchildPid();
      expect(isAlive(pid)).toBe(true);

      await expect(run).rejects.toThrow(
        `exec "${script}" timed out after 1500ms`,
      );
      await waitFor(() => !isAlive(pid));
    });

    it("settles a timeout only after the script has exited", async () => {
      const script = await writeWrapper(true);
      const run = runScript({ script, timeout: 1500 });
      const pid = await grandchildPid();

      await expect(run).rejects.toThrow("timed out after 1500ms");
      // The wrapper ignored SIGTERM; by the time the run settles SIGKILL has
      // ended it, so nothing of this run is still active.
      expect(getActiveExecChildrenCount()).toBe(0);
      await waitFor(() => !isAlive(pid));
    });

    it("still SIGKILLs a started process that ignored SIGTERM after its parent died", async () => {
      // The wrapper dies on SIGTERM, so the grandchild is re-parented before
      // the SIGKILL escalation re-checks it; it is the same process, so it
      // must still be killed.
      const script = await writeWrapper(false, true);
      const run = runScript({ script, timeout: 1500 });
      const pid = await grandchildPid();

      await expect(run).rejects.toThrow("timed out after 1500ms");
      await waitFor(() => !isAlive(pid));
    });

    it("stops a running parallel script and its children before any exit", async () => {
      const script = await writeWrapper(false);
      const run = runScript({ script, phase: "parallel", timeout: 0 });
      void run.catch(() => undefined);
      const pid = await grandchildPid();

      // exitAfterStopping (a failed build, a dev bind failure, the crash net)
      // runs only the exit stoppers before process.exit.
      const stopping = stopBeforeExit();
      expect(stopping).not.toBeNull();
      await stopping;
      await waitFor(() => getActiveExecChildrenCount() === 0);
      await waitFor(() => !isAlive(pid));
    });
  },
);
