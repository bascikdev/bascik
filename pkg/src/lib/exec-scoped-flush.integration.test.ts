import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Scoped consumer flush (prompt 139).
//
// Real modules: the exec publication coordinator, `mem` (the page dependency
// graph), `build-scripts` (the real dependency collector and its in-memory
// dependency-content memo), and `watch.ts#execConsumerFlush`. Only the page
// compiler is mocked, so the test observes exactly which pages the flush asks
// to recompile and which memo entries survive.
//
// Page A's build script reads `dist/generated.json` (a producer output).
// Page B's build script reads `content/other.txt` (nothing produces it).
// A producer that declares `outputs: ['dist/generated.json']` completes.
// Expected: A recompiles, B does not, and B's memoized dependency content
// stays in the memo.

const { mockProcessPageBatch, mockSelectivelyProcessPagesForWatchPath, compiled } = vi.hoisted(() => {
  const compiled: string[] = [];
  const mockProcessPageBatch = vi.fn(async (pages: string[]) => {
    compiled.push(...pages);
    return pages;
  });
  const mockSelectivelyProcessPagesForWatchPath = vi.fn();
  return { mockProcessPageBatch, mockSelectivelyProcessPagesForWatchPath, compiled };
});

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
  registerExecConsumerFlush,
  _execPublicationTestHooks,
} from "./exec-publication.ts";
import { execConsumerFlush } from "./watch.ts";
import type { ExecEntry } from "./types.ts";

const PAGE_A = "src/pages/a.html";
const PAGE_B = "src/pages/b.html";
const buildScript = (file: string): string =>
  `<!DOCTYPE html><html><body><script data-bascik-build>import { readFileSync } from 'node:fs'; console.log(readFileSync('${file}', 'utf8'));</script></body></html>`;

describe("exec consumer flush scoped to declared producer outputs (prompt 139)", () => {
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

    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    installExecPublication(emitter);
  });

  afterEach(async () => {
    _execPublicationTestHooks.reset();
    mem.removePage(absA);
    mem.removePage(absB);
    clearBuildScriptCaches();
    process.chdir(previousCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  /** Register the real flush and resolve once a generation has been published. */
  const registerRealFlush = (): Promise<void> =>
    new Promise<void>((done) => {
      registerExecConsumerFlush(async (...args: Parameters<typeof execConsumerFlush>) => {
        try {
          await execConsumerFlush(...args);
        } finally {
          done();
        }
      });
    });

  it("recompiles only the pages that read a declared output and keeps unrelated memo entries", async () => {
    const flushed = registerRealFlush();
    const producer: ExecEntry = {
      script: "scripts/generator.mjs",
      phase: "pre",
      watch: ["content/"],
      outputs: ["dist/generated.json"],
    };
    // The producer's trigger path (`content/doc.md`) is read by no page; only
    // its declared output ties it to page A.
    emitter.emit("exec-completed", { entry: producer, paths: ["content/doc.md"] });
    await flushed;

    expect(compiled).toEqual([absA]);
    expect(compiled).not.toContain(absB);
    // Page A's memoized output bytes were invalidated; page B's dependency
    // content survived because nothing it reads changed.
    expect(cacheHooks.hasDepContent("dist/generated.json")).toBe(false);
    expect(cacheHooks.hasDepContent("content/other.txt")).toBe(true);
    expect(_execPublicationTestHooks.generationValue).toBe(1);
  });

  it("a producer without declared outputs keeps the blanket behavior: every page recompiles and the memo is dropped", async () => {
    const flushed = registerRealFlush();
    const producer: ExecEntry = { script: "scripts/generator.mjs", phase: "pre", watch: ["content/"] };
    emitter.emit("exec-completed", { entry: producer, paths: ["content/doc.md"] });
    await flushed;

    expect(new Set(compiled)).toEqual(new Set([absA, absB]));
    expect(cacheHooks.depContentSize).toBe(0);
  });
});
