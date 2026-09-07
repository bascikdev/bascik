import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real dependency graph and cache: exec outcomes must leave both untouched.

const { mockProcessPageBatch, mockSelectivelyProcessPagesForWatchPath, compiled, watchPaths, mockListPages } = vi.hoisted(() => {
  const compiled: string[] = [];
  const mockProcessPageBatch = vi.fn(async (pages: string[]) => {
    compiled.push(...pages);
    return pages;
  });
  const mockSelectivelyProcessPagesForWatchPath = vi.fn();
  return { mockProcessPageBatch, mockSelectivelyProcessPagesForWatchPath, compiled, watchPaths: [] as string[], mockListPages: vi.fn() };
});

vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return { ...actual, BascikConfig: { ...actual.BascikConfig, pipeline: { ...actual.BascikConfig.pipeline, watchPaths } } };
});

vi.mock("./file-system.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./file-system.ts")>(),
  listPages: mockListPages,
}));

vi.mock("./processing.ts", () => ({
  pageProcessing: vi.fn(),
  processAllPages: vi.fn(),
  processPageBatch: mockProcessPageBatch,
  removePage: vi.fn(),
  selectivelyProcessPages: vi.fn(),
  selectivelyProcessPagesForWatchPath: mockSelectivelyProcessPagesForWatchPath,
}));

import { mem } from "./mem.ts";
import {
  clearBuildScriptCaches,
  collectAllScriptDeps,
  _buildScriptCacheTestHooks as cacheHooks,
} from "./build-scripts.ts";
import {
  installExecPublication,
} from "./exec-publication.ts";

const PAGE_A = "src/pages/a.html";
const PAGE_B = "src/pages/b.html";
const buildScript = (file: string): string =>
  `<!DOCTYPE html><html><body><script data-bascik-build>import { readFileSync } from 'node:fs'; console.log(readFileSync('${file}', 'utf8'));</script></body></html>`;

describe("exec outcomes preserve dependency caches", () => {
  let workDir: string;
  let previousCwd: string;
  let emitter: EventEmitter;
  let absA: string;
  let absB: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    workDir = await mkdtemp(join(tmpdir(), "bascik-scoped-flush-"));
    process.chdir(workDir);
    await mkdir(join(workDir, "dist"), { recursive: true });
    await mkdir(join(workDir, "content"), { recursive: true });
    await mkdir(join(workDir, "src/pages"), { recursive: true });
    await writeFile(join(workDir, "dist/generated.json"), JSON.stringify({ value: "generation-1" }), "utf8");
    await writeFile(join(workDir, "content/other.txt"), "other-1", "utf8");
    await writeFile(join(workDir, "content/doc.md"), "# doc", "utf8");
    absA = resolve(workDir, PAGE_A);
    absB = resolve(workDir, PAGE_B);

    compiled.length = 0;
    watchPaths.length = 0;
    mockListPages.mockReset().mockResolvedValue([absA, absB]);
    mockProcessPageBatch.mockClear();
    mockSelectivelyProcessPagesForWatchPath.mockReset();
    // Mirror the real fallback: the dependents of the changed path, or every
    // page when the dependency graph has no match.
    mockSelectivelyProcessPagesForWatchPath.mockImplementation(async (changedPath?: string) => {
      const dependents = changedPath ? mem.pagesDependentOnFile(changedPath) : [];
      await mockProcessPageBatch(dependents.length > 0 ? dependents : [absA, absB]);
    });

    clearBuildScriptCaches();
    mem.removePage(absA);
    mem.removePage(absB);

    // Register both pages through the real dependency collector, which also
    // memoizes each dependency's content.
    const depsA = await collectAllScriptDeps(buildScript("dist/generated.json"), PAGE_A);
    const depsB = await collectAllScriptDeps(buildScript("content/other.txt"), PAGE_B);
    expect(depsA).toEqual(["dist/generated.json"]);
    expect(depsB).toEqual(["content/other.txt"]);
    await mem.storePage({ relativePagePath: "a.html", absolutePagePath: absA, pageContent: "<html></html>", fileDependencies: depsA });
    await mem.storePage({ relativePagePath: "b.html", absolutePagePath: absB, pageContent: "<html></html>", fileDependencies: depsB });
    expect(mem.pagesDependentOnFile("dist/generated.json")).toEqual([absA]);
    expect(mem.pagesDependentOnFile("content/other.txt")).toEqual([absB]);
    expect(cacheHooks.hasDepContent("dist/generated.json")).toBe(true);
    expect(cacheHooks.hasDepContent("content/other.txt")).toBe(true);

    emitter = new EventEmitter();
    installExecPublication(emitter);
  });

  afterEach(async () => {
    mem.removePage(absA);
    mem.removePage(absB);
    clearBuildScriptCaches();
    process.chdir(previousCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it.each([{ patterns: [] }, { patterns: ["content/"] }, { patterns: ["dist/generated.json"] }])("completion with compilation watches $patterns changes no memo entries", async ({ patterns }) => {
    watchPaths.push(...patterns);
    await writeFile("dist/generated.json", JSON.stringify({ value: "generation-2" }));
    for (const paths of [[], ["content/doc.md"], ["content/other.txt"]]) {
      emitter.emit("exec-completed", { entry: { script: "scripts/generator.mjs", watch: ["content/"] }, paths });
    }
    await Promise.resolve();
    expect(compiled).toEqual([]);
    expect(cacheHooks.hasDepContent("dist/generated.json")).toBe(true);
    expect(cacheHooks.hasDepContent("content/other.txt")).toBe(true);
    expect(mem.pagesDependentOnFile("dist/generated.json")).toEqual([absA]);
    expect(mockListPages).not.toHaveBeenCalled();
  });
});
