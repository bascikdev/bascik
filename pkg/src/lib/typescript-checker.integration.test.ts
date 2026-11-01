/**
 * The shared syntax checker where builds run it: inside a page worker
 * thread, which starts the checker as a worker of its own with
 * `--experimental-vm-modules`. Each test starts a REAL worker thread that
 * loads `typescript.ts` from source (Node 24 runs it directly), checks
 * modules there and reports that thread's own counts, so what is pinned is
 * the nested-worker boundary the unit tests in the main thread cannot reach.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

const TYPESCRIPT_MODULE = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "typescript.ts"),
).href;

interface ThreadReport {
  processes: number;
  checkersStarted: number;
  errors: string[];
  warnings: string[];
}

/**
 * The page worker stand-in: checks `steps` in order in its own thread. A
 * step is a module to check, `{ crashChecker }` to make the next checker
 * this thread starts exit on its first module, or `{ nextBuild }` for the
 * reset a build makes.
 */
const HOST_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
const warnings = [];
console.warn = (message) => warnings.push(String(message));
const ts = await import(${JSON.stringify(TYPESCRIPT_MODULE)});
const stats = ts.__moduleCheckStatsForTests;
const errors = [];
for (const step of workerData.steps) {
  if (step.crashChecker) {
    stats.checkerSource = 'require("node:worker_threads").parentPort.on("message", () => process.exit(7));';
    continue;
  }
  if (step.nextBuild) {
    stats.checkerSource = undefined;
    ts.resetModuleCheckerForBuild();
    continue;
  }
  const checks = step.parallel ?? [step];
  await Promise.all(checks.map(({ code, label }) =>
    ts.checkDirectiveModuleSyntax(code, label).catch((error) => errors.push(error.message.split("\\n")[0])),
  ));
}
parentPort.postMessage({ processes: stats.processes, checkersStarted: stats.checkersStarted, errors, warnings });
`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

type Step =
  | { code: string; label: string }
  | { parallel: { code: string; label: string }[] }
  | { crashChecker: true }
  | { nextBuild: true };

/** Run `steps` in a fresh worker thread started as the page pool starts its workers. */
const inWorkerThread = async (steps: Step[]): Promise<ThreadReport> => {
  const dir = await mkdtemp(join(tmpdir(), "bascik-checker-host-"));
  tempDirs.push(dir);
  const script = join(dir, "host.mjs");
  await writeFile(script, HOST_SOURCE);
  const worker = new Worker(script, {
    workerData: { steps },
    execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
  });
  try {
    return await new Promise<ThreadReport>((resolveReport, reject) => {
      worker.once("message", resolveReport);
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(new Error(`host thread exited with code ${code}`)),
      );
    });
  } finally {
    await worker.terminate();
  }
};

const valid = (i: number) => ({
  code: `import { x } from "./m${i}.ts";\nexport const v${i} = await x;\n`,
  label: `src/lib/valid-${i}.ts`,
});
const invalid = (name: string) => ({
  code: `let ${name} = 1;\nlet ${name} = 2;\nexport default ${name};\n`,
  label: `src/lib/${name}.ts`,
});

describe("shared syntax checker inside a worker thread", () => {
  it("parses valid modules in one nested checker without a node --check process", async () => {
    const report = await inWorkerThread([
      { parallel: Array.from({ length: 16 }, (_, i) => valid(i)) },
      valid(99),
    ]);
    expect(report.errors).toEqual([]);
    expect(report.processes).toBe(0);
    expect(report.checkersStarted).toBe(1);
    expect(report.warnings).toEqual([]);
  }, 20_000);

  it("starts one process only for the module that does not parse, and names its place", async () => {
    const report = await inWorkerThread([valid(1), invalid("dupe"), valid(2)]);
    expect(report.processes).toBe(1);
    expect(report.errors).toEqual([
      expect.stringMatching(/src\/lib\/dupe\.ts:2:5: Identifier 'dupe'/),
    ]);
    expect(report.warnings).toEqual([]);
  }, 20_000);

  it("warns once when the nested checker exits, falls back to node --check, and recovers on the next build", async () => {
    const report = await inWorkerThread([
      { crashChecker: true },
      valid(1),
      valid(2),
      invalid("after_crash"),
      { nextBuild: true },
      { parallel: Array.from({ length: 8 }, (_, i) => valid(10 + i)) },
    ]);
    // The two valid modules and the invalid one after the crash; none after the reset.
    expect(report.processes).toBe(3);
    expect(report.checkersStarted).toBe(2);
    expect(report.errors).toEqual([
      expect.stringMatching(/src\/lib\/after_crash\.ts:2:5/),
    ]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(
      /shared syntax checker for directive scripts exited with code 7[\s\S]*node --check/,
    );
  }, 20_000);
});

describe("shared syntax checker and the process that runs it", () => {
  it("never holds the build process open once it is idle", async () => {
    // A checker thread whose stdio the parent reads stays referenced while
    // idle, so a build that checked one script would never exit.
    const source = `const ts = await import(${JSON.stringify(TYPESCRIPT_MODULE)});
await ts.checkDirectiveModuleSyntax("export const v = await 1;\\n", "src/lib/v.ts");
console.log("checked", ts.__moduleCheckStatsForTests.checkersStarted, ts.__moduleCheckStatsForTests.processes);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = await Promise.race([
      new Promise<number | null>((resolveExit) =>
        child.on("close", resolveExit),
      ),
      new Promise<"still running">((resolveWait) =>
        setTimeout(() => resolveWait("still running"), 10_000),
      ),
    ]);
    if (exited === "still running") child.kill();
    expect(exited, output).toBe(0);
    expect(output).toContain("checked 1 0");
  }, 20_000);
});
