/**
 * Prompt 138: dev-only module dependency graph and resolve hook.
 *
 * The pure graph (edges, generations, transitive invalidation, cycle guard,
 * zero allocation for unseen keys) and the resolve hook's URL rules are tested
 * in-process by driving the exported functions directly. The real Node loader
 * boundary is exercised in a child process because Vitest's module runner
 * intercepts `import()` inside test files and never reaches `node:module`
 * hooks. Nothing from `node:module` is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createModuleGraph,
  createResolveHook,
  installModuleGraphHook,
  moduleKeyForPath,
  forgetModulePaths,
  _moduleKeyTestHooks,
  stripGeneration,
  DEV_GENERATION_PARAM,
  type ResolveHookContext,
  type ResolveHookNext,
} from "./module-graph.ts";

const execFileAsync = promisify(execFile);

const key = (p: string): string => pathToFileURL(p).href;

describe("module graph: generations and edges", () => {
  it("returns generation 0 and allocates nothing for a key it has never seen", () => {
    const graph = createModuleGraph();
    const never = key("/project/src/lib/never.ts");
    expect(graph.generationOf(never)).toBe(0);
    expect(graph.invalidateModule(never).size).toBe(0);
    expect(graph.has(never)).toBe(false);
    expect(graph.size).toBe(0);
  });

  it("advances a tracked key and, transitively, every recorded parent", () => {
    const graph = createModuleGraph();
    const util = key("/p/src/lib/util.ts");
    const helper = key("/p/src/lib/helper.ts");
    const entry = key("/p/src/lib/entry.ts");
    const otherEntry = key("/p/src/api/value.ts");
    const unrelated = key("/p/src/lib/unrelated.ts");
    graph.recordEdge(util, helper);
    graph.recordEdge(helper, entry);
    graph.recordEdge(helper, otherEntry);
    graph.track(unrelated);

    const advanced = graph.invalidateModule(util);
    expect([...advanced].sort()).toEqual([util, helper, entry, otherEntry].sort());
    expect(graph.generationOf(util)).toBe(1);
    expect(graph.generationOf(helper)).toBe(1);
    expect(graph.generationOf(entry)).toBe(1);
    expect(graph.generationOf(otherEntry)).toBe(1);
    expect(graph.generationOf(unrelated)).toBe(0);
  });

  it("advances only the entry when the entry itself is invalidated (children keep their generation)", () => {
    const graph = createModuleGraph();
    const helper = key("/p/src/lib/helper.ts");
    const entry = key("/p/src/lib/entry.ts");
    graph.recordEdge(helper, entry);
    const advanced = graph.invalidateModule(entry);
    expect([...advanced]).toEqual([entry]);
    expect(graph.generationOf(helper)).toBe(0);
    expect(graph.generationOf(entry)).toBe(1);
  });

  it("terminates on an import cycle and advances each member once", () => {
    const graph = createModuleGraph();
    const a = key("/p/a.ts");
    const b = key("/p/b.ts");
    const c = key("/p/c.ts");
    graph.recordEdge(a, b);
    graph.recordEdge(b, c);
    graph.recordEdge(c, a);
    graph.recordEdge(a, a);
    const advanced = graph.invalidateModule(a);
    expect([...advanced].sort()).toEqual([a, b, c].sort());
    expect(graph.generationOf(a)).toBe(1);
    expect(graph.generationOf(b)).toBe(1);
    expect(graph.generationOf(c)).toBe(1);
  });

  it("track() marks a key seen at generation 0 without adding edges, so a later invalidate advances it", () => {
    const graph = createModuleGraph();
    const attempted = key("/p/attempted.ts");
    graph.track(attempted);
    expect(graph.has(attempted)).toBe(true);
    expect(graph.generationOf(attempted)).toBe(0);
    expect(graph.parentsOf(attempted).size).toBe(0);
    expect([...graph.invalidateModule(attempted)]).toEqual([attempted]);
    expect(graph.generationOf(attempted)).toBe(1);
  });

  it("clear() drops all generations and edges", () => {
    const graph = createModuleGraph();
    graph.recordEdge(key("/p/h.ts"), key("/p/e.ts"));
    graph.invalidateModule(key("/p/h.ts"));
    graph.clear();
    expect(graph.size).toBe(0);
    expect(graph.generationOf(key("/p/e.ts"))).toBe(0);
  });
});

describe("module graph: key helpers", () => {
  it("stripGeneration removes only the framework marker and keeps authored params", () => {
    expect(stripGeneration("file:///p/m.ts?bascik-gen=3")).toBe("file:///p/m.ts");
    expect(stripGeneration("file:///p/m.ts?flavor=x&bascik-gen=3")).toBe("file:///p/m.ts?flavor=x");
    expect(stripGeneration("file:///p/m.ts?flavor=x#frag")).toBe("file:///p/m.ts?flavor=x#frag");
    expect(stripGeneration("data:text/javascript,export%20default%201")).toBe("data:text/javascript,export%20default%201");
  });

  it("moduleKeyForPath resolves symlinks so the key matches what Node's resolver reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-138-key-"));
    try {
      const realDir = join(dir, "real");
      await mkdir(realDir);
      await writeFile(join(realDir, "m.mjs"), "export default 1;\n");
      await symlink(realDir, join(dir, "link"));
      const viaLink = moduleKeyForPath(join(dir, "link", "m.mjs"));
      const viaReal = moduleKeyForPath(join(realDir, "m.mjs"));
      expect(viaLink).toBe(viaReal);
      expect(viaLink).toBe(pathToFileURL(realpathSync(join(realDir, "m.mjs"))).href);
      // A missing file falls back to the unresolved path instead of throwing.
      const missing = join(dir, "link", "missing.mjs");
      expect(moduleKeyForPath(missing)).toBe(pathToFileURL(missing).href);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moduleKeyForPath is the single owner of the key rule: the registry's identity key equals it, and forgetModulePaths drops the memo (finding #12/#2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-key-owner-"));
    try {
      const realDir = join(dir, "real");
      await mkdir(realDir);
      const realFile = join(realDir, "m.mjs");
      await writeFile(realFile, "export default 1;\n");
      await symlink(realDir, join(dir, "link"));
      const linkFile = join(dir, "link", "m.mjs");

      _moduleKeyTestHooks.clearRealpathMemo();
      const { resolveModuleIdentity } = await import("./script-registry.ts");
      expect(resolveModuleIdentity(linkFile).key).toBe(moduleKeyForPath(linkFile));
      expect(resolveModuleIdentity(`${pathToFileURL(linkFile).href}?flavor=x#f`).key).toBe(
        `${moduleKeyForPath(linkFile)}?flavor=x#f`,
      );
      expect(_moduleKeyTestHooks.hasRealpathMemo(linkFile)).toBe(true);

      // Forgetting by the spelled path or by the realpath drops the entry.
      forgetModulePaths([realFile]);
      expect(_moduleKeyTestHooks.hasRealpathMemo(linkFile)).toBe(false);
      moduleKeyForPath(linkFile);
      forgetModulePaths([linkFile]);
      expect(_moduleKeyTestHooks.hasRealpathMemo(linkFile)).toBe(false);
    } finally {
      _moduleKeyTestHooks.clearRealpathMemo();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("module graph: resolve hook rules", () => {
  const projectRoot = "/p/site";
  const parentEntry = `file:///p/site/src/lib/entry.ts`;
  const context = (parentURL: string | undefined): ResolveHookContext => ({ conditions: [], importAttributes: {}, parentURL });
  const nextTo = (url: string): ResolveHookNext => () => ({ url, format: "module" });

  it("passes through bare, node:, and data: resolutions untouched and records nothing", () => {
    const graph = createModuleGraph();
    const hook = createResolveHook(graph, { roots: [projectRoot] });
    for (const url of ["node:fs", "data:text/javascript,1", "file:///p/site/node_modules/pkg/index.js", "file:///elsewhere/lib.ts"]) {
      const out = hook("x", context(parentEntry), nextTo(url));
      expect(out.url).toBe(url);
    }
    expect(graph.size).toBe(0);
  });

  it("records child -> parent edges (generation-stripped) for project files and leaves a generation-0 URL clean", () => {
    const graph = createModuleGraph();
    const hook = createResolveHook(graph, { roots: [projectRoot] });
    const helper = "file:///p/site/src/lib/helper.ts";
    const out = hook("./helper.ts", context(`${parentEntry}?bascik-gen=4`), nextTo(helper));
    expect(out.url).toBe(helper);
    expect(graph.parentsOf(helper).has(parentEntry)).toBe(true);
    expect(graph.parentsOf(helper).has(`${parentEntry}?bascik-gen=4`)).toBe(false);
  });

  it("does not record a parent that is outside the tracked roots or under node_modules", () => {
    const graph = createModuleGraph();
    const hook = createResolveHook(graph, { roots: [projectRoot] });
    const entry = "file:///p/site/src/lib/entry.ts";
    hook(entry, context("file:///p/site/node_modules/@bascik/bascik/dist/lib/script-registry.js"), nextTo(entry));
    hook(entry, context("file:///outside/registry.ts"), nextTo(entry));
    hook(entry, context(undefined), nextTo(entry));
    expect(graph.has(entry)).toBe(true);
    expect(graph.parentsOf(entry).size).toBe(0);
  });

  it("appends ?bascik-gen=N to a tracked child whose generation is above 0, preserving authored params", () => {
    const graph = createModuleGraph();
    const hook = createResolveHook(graph, { roots: [projectRoot] });
    const helper = "file:///p/site/src/lib/helper.ts?flavor=x";
    hook("./helper.ts?flavor=x", context(parentEntry), nextTo(helper));
    graph.invalidateModule(helper);
    graph.invalidateModule(helper);
    const out = hook("./helper.ts?flavor=x", context(parentEntry), nextTo(helper));
    const url = new URL(out.url);
    expect(url.searchParams.get("flavor")).toBe("x");
    expect(url.searchParams.get(DEV_GENERATION_PARAM)).toBe("2");
    expect(stripGeneration(out.url)).toBe(helper);
  });

  it("re-entering a URL that already carries the marker maps back to the same key and current generation", () => {
    const graph = createModuleGraph();
    const hook = createResolveHook(graph, { roots: [projectRoot] });
    const entry = "file:///p/site/src/lib/entry.ts";
    hook(entry, context(undefined), nextTo(entry));
    graph.invalidateModule(entry);
    const out = hook(`${entry}?bascik-gen=1`, context(undefined), nextTo(`${entry}?bascik-gen=1`));
    expect(out.url).toBe(`${entry}?bascik-gen=1`);
    expect(graph.size).toBe(1);
  });

  it("tracks files under an additional root (import root outside the project) but never node_modules", () => {
    const graph = createModuleGraph();
    const hook = createResolveHook(graph, { roots: [projectRoot, "/p/shared"] });
    const shared = "file:///p/shared/lib/x.ts";
    const sharedDep = "file:///p/shared/node_modules/dep/index.js";
    hook("@/lib/x.ts", context(parentEntry), nextTo(shared));
    hook("dep", context(shared), nextTo(sharedDep));
    expect(graph.has(shared)).toBe(true);
    expect(graph.has(sharedDep)).toBe(false);
  });
});

describe("installModuleGraphHook", () => {
  afterEach(() => {
    installModuleGraphHook({ projectRoot: process.cwd(), isDev: true }).deregister();
  });

  it("installs nothing outside development and returns an inert handle", () => {
    const handle = installModuleGraphHook({ projectRoot: process.cwd(), isDev: false });
    expect(handle.installed).toBe(false);
    expect(() => handle.deregister()).not.toThrow();
  });

  it("is idempotent in development: a second call returns the already installed handle", () => {
    const first = installModuleGraphHook({ projectRoot: process.cwd(), isDev: true });
    const second = installModuleGraphHook({ projectRoot: process.cwd(), isDev: true });
    expect(first.installed).toBe(true);
    expect(second).toBe(first);
    first.deregister();
    const third = installModuleGraphHook({ projectRoot: process.cwd(), isDev: true });
    expect(third).not.toBe(first);
    expect(third.installed).toBe(true);
  });
});

describe("module graph under the real Node loader (child process)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bascik-138-graph-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reloads a two-level helper chain through generation URLs while the untouched levels keep identity", async () => {
    const proj = join(dir, "proj");
    await mkdir(join(proj, "src/lib"), { recursive: true });
    await writeFile(join(proj, "src/lib/util.mjs"), 'export const u = "U-OLD";\n');
    await writeFile(join(proj, "src/lib/helper.mjs"), 'import { u } from "./util.mjs";\nexport const instance = {};\nexport const h = () => u;\n');
    await writeFile(join(proj, "src/lib/entry.mjs"), 'import { h } from "./helper.mjs";\nimport "node:fs";\nexport default () => h();\n');
    const graphModule = pathToFileURL(join(process.cwd(), "src/lib/module-graph.ts")).href;
    const script = `
      import { installModuleGraphHook, moduleGraph, moduleKeyForPath } from ${JSON.stringify(graphModule)};
      import { writeFileSync, realpathSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const proj = ${JSON.stringify(proj)};
      const handle = installModuleGraphHook({ projectRoot: proj, isDev: true });
      const entryKey = moduleKeyForPath(proj + "/src/lib/entry.mjs");
      const helperKey = moduleKeyForPath(proj + "/src/lib/helper.mjs");
      const utilKey = moduleKeyForPath(proj + "/src/lib/util.mjs");
      const before = (await import(entryKey)).default();
      writeFileSync(proj + "/src/lib/util.mjs", 'export const u = "U-NEW";\\n');
      const withoutInvalidate = (await import(entryKey)).default();
      const advanced = [...moduleGraph.invalidateModule(utilKey)];
      const gen = moduleGraph.generationOf(entryKey);
      const nextEntryUrl = entryKey + "?bascik-gen=" + gen;
      const after = (await import(nextEntryUrl)).default();
      // Now edit only the entry: helper and util must keep their generation (and instance).
      const helperInstanceBefore = (await import(helperKey + "?bascik-gen=" + moduleGraph.generationOf(helperKey))).instance;
      writeFileSync(proj + "/src/lib/entry.mjs", 'import { h, instance } from "./helper.mjs";\\nexport default () => "E2:" + h();\\nexport { instance };\\n');
      const advancedEntryOnly = [...moduleGraph.invalidateModule(entryKey)];
      const entry2 = await import(entryKey + "?bascik-gen=" + moduleGraph.generationOf(entryKey));
      handle.deregister();
      console.log(JSON.stringify({
        before, withoutInvalidate, after,
        advanced: advanced.map((k) => k.split("/").pop()).sort(),
        gens: { entry: gen, helper: moduleGraph.generationOf(helperKey), util: moduleGraph.generationOf(utilKey) },
        keysAreRealpaths: utilKey === pathToFileURL(realpathSync(proj + "/src/lib/util.mjs")).href,
        advancedEntryOnly: advancedEntryOnly.map((k) => k.split("/").pop()),
        entry2Value: entry2.default(),
        helperInstanceStable: entry2.instance === helperInstanceBefore,
        helperGenAfterEntryEdit: moduleGraph.generationOf(helperKey),
        graphSize: moduleGraph.size,
      }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, BASCIK_BUILD: "0", BASCIK_SERVER: "0" },
    });
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result).toMatchObject({
      before: "U-OLD",
      withoutInvalidate: "U-OLD",
      after: "U-NEW",
      advanced: ["entry.mjs", "helper.mjs", "util.mjs"],
      gens: { entry: 1, helper: 1, util: 1 },
      keysAreRealpaths: true,
      advancedEntryOnly: ["entry.mjs"],
      entry2Value: "E2:U-NEW",
      helperInstanceStable: true,
      helperGenAfterEntryEdit: 1,
    });
    // Only the three project files are tracked: node:fs and the -e script never enter the graph.
    expect(result.graphSize).toBe(3);
  });

  it("keys the graph by realpath when the project directory is reached through a symlink", async () => {
    const real = join(dir, "real-proj");
    await mkdir(join(real, "src"), { recursive: true });
    await writeFile(join(real, "src/entry.mjs"), 'import { h } from "./helper.mjs";\nexport default () => h();\n');
    await writeFile(join(real, "src/helper.mjs"), 'export const h = () => "H-OLD";\n');
    const link = join(dir, "link-proj");
    await symlink(real, link);
    const graphModule = pathToFileURL(join(process.cwd(), "src/lib/module-graph.ts")).href;
    const script = `
      import { installModuleGraphHook, moduleGraph, moduleKeyForPath } from ${JSON.stringify(graphModule)};
      import { writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const link = ${JSON.stringify(link)};
      // The hook is configured with the symlinked root; realpath is applied internally.
      installModuleGraphHook({ projectRoot: link, isDev: true });
      const entryKey = moduleKeyForPath(link + "/src/entry.mjs");
      const before = (await import(pathToFileURL(link + "/src/entry.mjs").href)).default();
      writeFileSync(link + "/src/helper.mjs", 'export const h = () => "H-NEW";\\n');
      // Invalidate through the *symlinked* path, as a watcher would report it.
      const advanced = [...moduleGraph.invalidateModule(moduleKeyForPath(link + "/src/helper.mjs"))];
      const after = (await import(entryKey + "?bascik-gen=" + moduleGraph.generationOf(entryKey))).default();
      console.log(JSON.stringify({ before, after, advancedCount: advanced.length, entryKeyIsReal: !entryKey.includes("link-proj") }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, BASCIK_BUILD: "0", BASCIK_SERVER: "0" },
    });
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result).toEqual({ before: "H-OLD", after: "H-NEW", advancedCount: 2, entryKeyIsReal: true });
  });
});
