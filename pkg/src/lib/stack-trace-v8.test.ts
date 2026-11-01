/**
 * `cleanStackTrace` and `remapRewrittenColumns` against traces V8 actually
 * wrote, not hand-written ones. A child `node` process (the real module
 * loader, not Vitest's) imports a module the way a build script runs: from
 * a temp file under `node_modules/.cache/bascik`, named after its source by
 * `//# sourceURL`, with its imports rewritten to file URLs. The project
 * folder has a space, a percent sign and replacement tokens (`$&`) in its name, and `node_modules` is a
 * symlink, as in monorepos and dev containers; Node's loader names a module
 * by its real path. Only the Windows frames are written by hand, in the form
 * V8 gives them there, since this host cannot produce them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanStackTrace, remapRewrittenColumns } from "./stack-trace.ts";
import { rewriteModuleSpecifiersWithEdits } from "./module-specifiers.ts";
import type { SpecifierEdit } from "./module-specifiers.ts";

const SOURCE_PATH = "src/pages/index.html";

/**
 * The module as authored. Line 1 imports a helper and throws after the
 * import on the same line in two cases, so its columns move when the
 * specifier is rewritten to a longer file URL.
 */
const AUTHORED = [
  `import { fail, inner } from "./lib/helper.mjs"; export const sameLine = () => (globalThis.mode === "same-line" ? null.boom : globalThis.mode === "same-line-eval" ? eval("null.x") : 0);`,
  `export const run = async (mode) => {`,
  `  globalThis.mode = mode;`,
  `  if (mode === "same-line" || mode === "same-line-eval") sameLine();`,
  `  if (mode === "async") await fail("async");`,
  `  if (mode === "eval") eval("null.x");`,
  `  if (mode === "function") new Function("return null.y")();`,
  `  if (mode === "json") [1].map(() => JSON.parse("{"));`,
  `  if (mode === "internals") (await import("node:fs")).readFileSync("/nonexistent/bascik-r206");`,
  `  if (mode === "callback") await new Promise((resolve, reject) => setImmediate(() => { try { inner(); } catch (error) { reject(error); } }));`,
  `};`,
].join("\n");

const HELPER = [
  `export const fail = async (why) => {`,
  `  await Promise.resolve();`,
  `  throw new Error("helper failed: " + why);`,
  `};`,
  `export const inner = () => { throw new Error("inner"); };`,
].join("\n");

const MODES = [
  "same-line",
  "same-line-eval",
  "async",
  "eval",
  "function",
  "json",
  "internals",
  "callback",
] as const;

/** 1-based line and column of `needle` (its `occurrence`-th, from 0) in the authored module. */
const at = (needle: string, occurrence = 0): string => {
  const lines = AUTHORED.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const index = lines[i].indexOf(needle, from);
      if (index === -1) break;
      if (seen++ === occurrence) return `${i + 1}:${index + 1}`;
      from = index + 1;
    }
  }
  throw new Error(`"${needle}" is not in the module`);
};

let root = "";
let projectRoot = "";
let tmpPath = "";
let edits: SpecifierEdit[] = [];
const traces = new Map<string, string>();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bascik-v8-trace-")));
  projectRoot = join(root, "milk frother%20site $&(1)");
  const realModules = join(root, "shared-node-modules");
  mkdirSync(join(projectRoot, "src", "pages", "lib"), { recursive: true });
  mkdirSync(join(realModules, ".cache", "bascik"), { recursive: true });
  symlinkSync(realModules, join(projectRoot, "node_modules"), "dir");
  writeFileSync(join(projectRoot, "src", "pages", "lib", "helper.mjs"), HELPER);
  const rewritten = rewriteModuleSpecifiersWithEdits(
    AUTHORED,
    join(projectRoot, "src", "pages"),
    { importRoot: join(projectRoot, "src") },
  );
  edits = rewritten.edits;
  tmpPath = join(
    projectRoot,
    "node_modules",
    ".cache",
    "bascik",
    "build-1-abc.mjs",
  );
  writeFileSync(tmpPath, `${rewritten.code}\n//# sourceURL=${SOURCE_PATH}`);
  const runner = `
const mod = await import(${JSON.stringify(pathToFileURL(tmpPath).href)});
const traces = {};
for (const mode of ${JSON.stringify(MODES)}) {
  try { await mod.run(mode); traces[mode] = "did not throw"; } catch (error) { traces[mode] = error.stack; }
}
process.stdout.write(JSON.stringify(traces));
`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", runner],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (child.status !== 0) throw new Error(child.stderr);
  for (const [mode, trace] of Object.entries(
    JSON.parse(child.stdout) as Record<string, string>,
  ))
    traces.set(mode, trace);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** What a build script error reports for `mode`, as `build-scripts.ts` cleans it. */
const reported = (mode: (typeof MODES)[number]): string => {
  const raw = traces.get(mode)!;
  const remapped = remapRewrittenColumns(
    raw,
    [tmpPath, pathToFileURL(tmpPath).href, SOURCE_PATH],
    edits,
  );
  return cleanStackTrace(remapped, tmpPath, SOURCE_PATH, 1);
};

const expectNoTempModule = (trace: string): void => {
  expect(trace).not.toContain("build-1-abc.mjs");
  expect(trace).not.toContain(".cache/bascik");
};

describe("cleanStackTrace and remapRewrittenColumns on real V8 traces", () => {
  it("the raw traces name the temp module by its real path, through the symlink", () => {
    // What makes the remap necessary: an eval's origin names the module's
    // own URL, not its sourceURL, and Node's loader resolved the symlink.
    expect(traces.get("eval")).toContain("shared-node-modules");
    expect(traces.get("eval")).toContain("milk%20frother%2520site");
  });

  it("maps a throw after a rewritten import on the same line to the column as written", () => {
    const trace = reported("same-line");
    expect(trace).toContain(`at sameLine (${SOURCE_PATH}:${at("boom")})`);
    expect(trace).toContain(
      `at Module.run (${SOURCE_PATH}:${at("sameLine();")})`,
    );
    expectNoTempModule(trace);
  });

  it("maps an eval's origin on a line with a rewritten import, and leaves the eval's own position alone", () => {
    const trace = reported("same-line-eval");
    expect(trace).toContain(
      `at eval (eval at sameLine (${SOURCE_PATH}:${at('eval("null.x")')}), <anonymous>:1:6)`,
    );
    expectNoTempModule(trace);
  });

  it("maps an eval's origin when the module was loaded through a symlink", () => {
    const trace = reported("eval");
    expect(trace).toContain(
      `at eval (eval at run (${SOURCE_PATH}:${at('eval("null.x")', 1)}), <anonymous>:1:6)`,
    );
    expect(trace).toContain(
      `at Module.run (${SOURCE_PATH}:${at('eval("null.x")', 1)})`,
    );
    expectNoTempModule(trace);
  });

  it("maps a new Function frame's origin", () => {
    const trace = reported("function");
    expect(trace).toMatch(
      new RegExp(
        `at eval \\(eval at run \\(${SOURCE_PATH}:${at("new Function")}\\), <anonymous>:\\d+:\\d+\\)`,
      ),
    );
    expectNoTempModule(trace);
  });

  it("keeps async frames, and the helper's own file, which the author wrote", () => {
    const trace = reported("async");
    expect(trace).toContain("Error: helper failed: async");
    expect(trace).toMatch(
      /at fail \(file:\/\/\/.*milk%20frother%2520site[^/]*\/src\/pages\/lib\/helper\.mjs:3:9\)/,
    );
    expect(trace).toContain(
      `at async Module.run (${SOURCE_PATH}:${at("await fail")})`,
    );
  });

  it("keeps builtin frames between the author's frames", () => {
    const trace = reported("json");
    const lines = trace.split("\n").map((line) => line.trim());
    expect(lines[1]).toBe("at JSON.parse (<anonymous>)");
    expect(lines[2]).toBe(`at ${SOURCE_PATH}:${at('parse("{")')}`);
    expect(lines[3]).toBe("at Array.map (<anonymous>)");
    expect(lines[4]).toBe(
      `at Module.run (${SOURCE_PATH}:${at("map(() => JSON")})`,
    );
  });

  it("drops Node's internal frames and keeps the author's", () => {
    const trace = reported("internals");
    expect(trace).toContain("ENOENT");
    expect(trace).not.toMatch(/\(node:|node:internal/);
    expect(trace).toContain(
      `at Module.run (${SOURCE_PATH}:${at("readFileSync")})`,
    );
  });

  it("drops the timers frames of a callback and keeps the author's frames", () => {
    const trace = reported("callback");
    expect(trace).toContain("Error: inner");
    expect(trace).toContain(`${SOURCE_PATH}:${at("inner();")}`);
    expect(trace).not.toMatch(/node:internal|\(node:/);
  });
});

describe("cleanStackTrace on V8's Windows frames", () => {
  // As V8 writes them on Windows: an ES module by file URL (percent-encoded),
  // a path in a CommonJS frame with backslashes.
  const windowsTmp =
    "C:\\Users\\Milk Frother\\site\\node_modules\\.cache\\bascik\\build-1-abc.mjs";
  const windowsUrl =
    "file:///C:/Users/Milk%20Frother/site/node_modules/.cache/bascik/build-1-abc.mjs";

  it("maps a file URL frame with a percent-encoded space", () => {
    expect(
      cleanStackTrace(
        `Error: x\n    at Module.run (${windowsUrl}:3:5)\n    at async main (${windowsUrl}:9:1)`,
        windowsTmp,
        SOURCE_PATH,
        1,
      ),
    ).toBe(
      `Error: x\n    at Module.run (${SOURCE_PATH}:3:5)\n    at async main (${SOURCE_PATH}:9:1)`,
    );
  });

  it("maps a backslash path frame, an eval origin, and a frame with no column", () => {
    expect(
      cleanStackTrace(
        [
          "TypeError: y",
          `    at eval (eval at run (${windowsUrl}:6:22), <anonymous>:1:6)`,
          `    at run (${windowsTmp}:6:22)`,
          `${windowsTmp}:6`,
        ].join("\n"),
        windowsTmp,
        SOURCE_PATH,
        1,
      ),
    ).toBe(
      [
        "TypeError: y",
        `    at eval (eval at run (${SOURCE_PATH}:6:22), <anonymous>:1:6)`,
        `    at run (${SOURCE_PATH}:6:22)`,
        `${SOURCE_PATH}:6`,
      ].join("\n"),
    );
  });
});
