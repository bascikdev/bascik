/**
 * The shared syntax checker behind `checkDirectiveModuleSyntax`: a worker
 * thread that parses each compiled directive module, so a build of valid
 * scripts starts no `node --check` process. These tests start REAL checker
 * threads (the default one, or a replacement source that crashes, hangs or
 * prints) and pin what happens when the checker is not there to answer: one
 * warning that names the slower fallback, a fresh checker on the next build,
 * a bounded wait that names the file, and output that is never left to pile
 * up in the checker's thread.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  checkDirectiveModuleSyntax,
  resetModuleCheckerForBuild,
  __moduleCheckStatsForTests,
  __stopSharedCheckerForTests,
} from "./typescript.ts";

vi.mock("./config.js", () => ({
  BascikConfig: { scripts: { typescript: true } },
}));

const stats = __moduleCheckStatsForTests;
const DEFAULT_TIMEOUT_MS = stats.timeoutMs;

/** A checker that answers like the real one, after running `before`. */
const checkerSource = (before: string): string => `
const vm = require("node:vm");
const { parentPort } = require("node:worker_threads");
process.emitWarning = () => {};
parentPort.on("message", ({ id, code }) => {
  ${before}
  let parses = true;
  try { new vm.SourceTextModule(code); } catch (error) { parses = !(error && error.name === "SyntaxError"); }
  parentPort.postMessage({ id, parses });
});
`;

let unique = 0;
/** A module that parses, with text no other test checks (results are cached by text). */
const validModule = (): string =>
  `export const v${++unique} = await Promise.resolve(${unique});\n`;
/** A module that does not parse, reported at line 2, column 5. */
const invalidModule = (): string =>
  `let q${++unique} = 1;\nlet q${unique} = 2;\nexport default 1;\n`;

let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  await __stopSharedCheckerForTests();
  stats.checkerSource = undefined;
  stats.timeoutMs = DEFAULT_TIMEOUT_MS;
  resetModuleCheckerForBuild();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  await __stopSharedCheckerForTests();
  stats.checkerSource = undefined;
  stats.timeoutMs = DEFAULT_TIMEOUT_MS;
  resetModuleCheckerForBuild();
});

const checkerWarnings = (): string[] =>
  warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes("syntax checker"));

describe("shared syntax checker: a checker that stops", () => {
  it("warns once, names the node --check fallback, and still reports errors with their place", async () => {
    stats.checkerSource = checkerSource(`process.exit(3);`);
    const before = stats.processes;
    await expect(
      checkDirectiveModuleSyntax(validModule(), "src/lib/first.ts"),
    ).resolves.toBeUndefined();
    await expect(
      checkDirectiveModuleSyntax(validModule(), "src/lib/second.ts"),
    ).resolves.toBeUndefined();
    await expect(
      checkDirectiveModuleSyntax(invalidModule(), "src/lib/third.ts"),
    ).rejects.toThrow(/src\/lib\/third\.ts:2:5: Identifier 'q\d+'/);
    // Every check after the crash went to a process; the crash itself was told once.
    expect(stats.processes - before).toBe(3);
    const warnings = checkerWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[bascik\] warning: /);
    expect(warnings[0]).toMatch(/exited with code 3/);
    expect(warnings[0]).toMatch(/node --check/);
    expect(warnings[0]).toMatch(/until the next build/i);
  });

  it("names why the checker crashed, and nothing it printed reaches the build's output", async () => {
    stats.checkerSource = checkerSource(
      `process.stderr.write("checker ran out of something\\n"); throw new Error("checker blew up");`,
    );
    await expect(
      checkDirectiveModuleSyntax(validModule(), "src/lib/crash.ts"),
    ).resolves.toBeUndefined();
    const warnings = checkerWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/crashed \(checker blew up\)/);
    expect(warnings[0]).not.toMatch(/ran out of something/);
  });

  it("starts a fresh checker on the next build instead of staying on the fallback for good", async () => {
    stats.checkerSource = checkerSource(`process.exit(1);`);
    await checkDirectiveModuleSyntax(validModule(), "src/lib/crash.ts");
    expect(checkerWarnings()).toHaveLength(1);
    // Still the same build: no new checker is started for every script.
    const startedAfterCrash = stats.checkersStarted;
    await checkDirectiveModuleSyntax(validModule(), "src/lib/same-build.ts");
    expect(stats.checkersStarted).toBe(startedAfterCrash);

    stats.checkerSource = undefined;
    resetModuleCheckerForBuild();
    const before = stats.processes;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        checkDirectiveModuleSyntax(validModule(), `src/lib/next-${i}.ts`),
      ),
    );
    expect(stats.checkersStarted).toBe(startedAfterCrash + 1);
    expect(stats.processes - before).toBe(0);
  });

  it("warns again in a later build only if the checker stops again", async () => {
    stats.checkerSource = checkerSource(`process.exit(2);`);
    await checkDirectiveModuleSyntax(validModule(), "src/lib/a.ts");
    resetModuleCheckerForBuild();
    await checkDirectiveModuleSyntax(validModule(), "src/lib/b.ts");
    expect(checkerWarnings()).toHaveLength(2);
    stats.checkerSource = undefined;
    resetModuleCheckerForBuild();
    await checkDirectiveModuleSyntax(validModule(), "src/lib/c.ts");
    expect(checkerWarnings()).toHaveLength(2);
  });

  it("is not counted as stopped when a build resets it while it is healthy", async () => {
    await checkDirectiveModuleSyntax(validModule(), "src/lib/a.ts");
    const started = stats.checkersStarted;
    resetModuleCheckerForBuild();
    await checkDirectiveModuleSyntax(validModule(), "src/lib/b.ts");
    // A healthy checker is kept across builds: resetting never restarts it.
    expect(stats.checkersStarted).toBe(started);
    expect(checkerWarnings()).toHaveLength(0);
  });
});

describe("shared syntax checker: a bounded wait", () => {
  it("gives up on a checker that never answers, names the file, and checks with node --check instead", async () => {
    stats.checkerSource = checkerSource(`return;`);
    stats.timeoutMs = 300;
    const before = stats.processes;
    await expect(
      checkDirectiveModuleSyntax(invalidModule(), "src/lib/stuck.ts"),
    ).rejects.toThrow(/src\/lib\/stuck\.ts:2:5/);
    expect(stats.processes - before).toBe(1);
    const warnings = checkerWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/did not answer within 0\.3s/);
    expect(warnings[0]).toMatch(/"src\/lib\/stuck\.ts"/);
  });

  it("skips a check that does not finish at all, with a located warning, and does not cache the skip", async () => {
    stats.disableChecker = true;
    stats.timeoutMs = 1;
    const code = invalidModule();
    try {
      await expect(
        checkDirectiveModuleSyntax(code, "src/lib/slow.ts"),
      ).resolves.toBeUndefined();
      const skipped = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("src/lib/slow.ts"));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatch(
        /^\[bascik\] warning: checking the syntax of "src\/lib\/slow\.ts" did not finish within 0\.001s/,
      );
      expect(skipped[0]).toMatch(/shows when the script runs/);
      // The next build, with time to finish, still finds the error.
      stats.timeoutMs = DEFAULT_TIMEOUT_MS;
      await expect(
        checkDirectiveModuleSyntax(code, "src/lib/slow.ts"),
      ).rejects.toThrow(/src\/lib\/slow\.ts:2:5/);
    } finally {
      stats.disableChecker = false;
    }
  });
});

describe("shared syntax checker: its output", () => {
  it("drains what the checker prints, so it never piles up in the checker thread", async () => {
    // Without a reader, a worker's piped stdout buffers every write in the
    // worker until it runs out of memory.
    stats.checkerSource = checkerSource(
      `if (code.startsWith("// buffered")) { parentPort.postMessage({ id, parses: process.stdout.writableLength < 1048576 && process.stderr.writableLength < 1048576 }); return; }
       const chunk = "x".repeat(65536); for (let i = 0; i < 64; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }`,
    );
    for (let i = 0; i < 4; i++)
      await checkDirectiveModuleSyntax(validModule(), `src/lib/chatty-${i}.ts`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const before = stats.processes;
    // The checker answers "parses" only while its buffered output is small;
    // "does not parse" sends the check to node --check, which counts a process.
    await checkDirectiveModuleSyntax(
      `// buffered ${++unique}\nexport default 1;\n`,
      "src/lib/chatty-check.ts",
    );
    expect(stats.processes - before).toBe(0);
    expect(checkerWarnings()).toHaveLength(0);
  });
});
