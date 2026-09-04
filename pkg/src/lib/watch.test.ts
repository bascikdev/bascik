import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock factories ───────────────────────────────────────────────────

const {
  mockWatch,
  getWatcher,
  clearWatchers,
  resetMocks,
  mockPageProcessing,
  mockProcessAllPages,
  mockRemovePage,
  mockSelectivelyProcessPages,
  mockSelectivelyProcessPagesForWatchPath,
  mockCopyReplicatePath,
  mockCopyStaticAssets,
  mockIsStaticAssetPath,
  mockDeleteDistDir,
  mockDeleteDistFile,
  mockIsInlineStylesheet,
  mockEventEmit,
  mockProcessPageBatch,
  mockPagesDependentOnFile,
  mockClearBuildScriptCaches,
  mockGetImportRoot,
  mockExistsSync,
} = vi.hoisted(() => {
  const watchers: { on: ReturnType<typeof vi.fn> }[] = [];
  const mockPageProcessing = vi.fn().mockResolvedValue(undefined);
  const mockProcessAllPages = vi.fn().mockResolvedValue(undefined);
  const mockRemovePage = vi.fn().mockResolvedValue(undefined);
  const mockSelectivelyProcessPages = vi.fn().mockResolvedValue(undefined);
  const mockSelectivelyProcessPagesForWatchPath = vi.fn().mockResolvedValue(undefined);
  const mockCopyReplicatePath = vi.fn().mockResolvedValue(undefined);
  const mockCopyStaticAssets = vi.fn().mockResolvedValue(undefined);
  const mockIsStaticAssetPath = vi.fn().mockReturnValue(true);
  const mockDeleteDistDir = vi.fn().mockResolvedValue(undefined);
  const mockDeleteDistFile = vi.fn().mockResolvedValue(undefined);
  const mockIsInlineStylesheet = vi.fn().mockReturnValue(false);
  const mockEventEmit = vi.fn();
  const mockProcessPageBatch = vi.fn().mockResolvedValue([]);
  const mockPagesDependentOnFile = vi.fn().mockReturnValue([]);
  const mockClearBuildScriptCaches = vi.fn();
  const mockGetImportRoot = vi.fn().mockReturnValue("/project/src");
  const mockExistsSync = vi.fn().mockReturnValue(true);
  const makeWatcher = () => {
    const w = {
      on: vi.fn(function (
        this: { on: ReturnType<typeof vi.fn> },
        event: string,
        handler: (...args: any[]) => any,
      ) {
        if (event === "ready") {
          void handler();
        }
        return this;
      }),
    };
    watchers.push(w);
    return w;
  };
  const mockWatch = vi.fn((_path: string, _opts: Record<string, unknown>) => makeWatcher());
  const resetMocks = () => {
    mockWatch.mockReset().mockImplementation((_path: string, _opts: Record<string, unknown>) => makeWatcher());
    mockPageProcessing.mockReset().mockResolvedValue(undefined);
    mockProcessAllPages.mockReset().mockResolvedValue(undefined);
    mockRemovePage.mockReset().mockResolvedValue(undefined);
    mockSelectivelyProcessPages.mockReset().mockResolvedValue(undefined);
    mockSelectivelyProcessPagesForWatchPath.mockReset().mockResolvedValue(
      undefined,
    );
    mockCopyReplicatePath.mockReset().mockResolvedValue(undefined);
    mockCopyStaticAssets.mockReset().mockResolvedValue(undefined);
    mockIsStaticAssetPath.mockReset().mockReturnValue(true);
    mockDeleteDistDir.mockReset().mockResolvedValue(undefined);
    mockDeleteDistFile.mockReset().mockResolvedValue(undefined);
    mockEventEmit.mockReset();
    mockProcessPageBatch.mockReset().mockResolvedValue([]);
    mockPagesDependentOnFile.mockReset().mockReturnValue([]);
    mockClearBuildScriptCaches.mockReset();
    mockGetImportRoot.mockReset().mockReturnValue("/project/src");
    // Only the import root exists by default so the api watcher (which also
    // probes existsSync) is not created in these tests.
    mockExistsSync.mockReset().mockImplementation((p: string) => p === mockGetImportRoot());
  };
  return {
    mockWatch,
    getWatcher: (i: number) => watchers[i],
    clearWatchers: () => {
      watchers.length = 0;
    },
    resetMocks,
    mockPageProcessing,
    mockProcessAllPages,
    mockRemovePage,
    mockSelectivelyProcessPages,
    mockSelectivelyProcessPagesForWatchPath,
    mockCopyReplicatePath,
    mockCopyStaticAssets,
    mockIsStaticAssetPath,
    mockDeleteDistDir,
    mockDeleteDistFile,
    mockIsInlineStylesheet,
    mockEventEmit,
    mockProcessPageBatch,
    mockPagesDependentOnFile,
    mockClearBuildScriptCaches,
    mockGetImportRoot,
    mockExistsSync,
  };
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("chokidar", () => ({
  default: { watch: mockWatch },
}));

vi.mock("./processing.js", () => ({
  pageProcessing: mockPageProcessing,
  processAllPages: mockProcessAllPages,
  processPageBatch: mockProcessPageBatch,
  removePage: mockRemovePage,
  selectivelyProcessPages: mockSelectivelyProcessPages,
  selectivelyProcessPagesForWatchPath: mockSelectivelyProcessPagesForWatchPath,
}));

vi.mock("./mem.js", () => ({
  mem: { pagesDependentOnFile: mockPagesDependentOnFile },
}));

vi.mock("./import-root.js", () => ({
  getImportRoot: mockGetImportRoot,
}));

vi.mock("./build-scripts.js", () => ({
  clearBuildScriptCaches: mockClearBuildScriptCaches,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("./file-system.js", () => ({
  copyReplicatePath: mockCopyReplicatePath,
  copyStaticAssets: mockCopyStaticAssets,
  deleteDistDir: mockDeleteDistDir,
  deleteDistFile: mockDeleteDistFile,
}));

vi.mock("./asset-filter.js", () => ({
  isStaticAssetPath: mockIsStaticAssetPath,
  isInlineStylesheet: mockIsInlineStylesheet,
}));

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: {
      pages: "/project/src/pages",
      components: "/project/src/components",
      out: "dist",
    },
    pipeline: {
      watchPaths: [],
    },
    assets: {
      inlineStyles: false,
    },
    isBuild: false,
  },
}));

vi.mock("./events.js", () => ({
  eventEmitter: { emit: mockEventEmit },
  registerShutdownHandler: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { watchFiles } from "./watch.ts";
import {
  pageProcessing,
  processAllPages,
  processPageBatch,
  removePage,
  selectivelyProcessPages,
  selectivelyProcessPagesForWatchPath,
} from "./processing.ts";
import { clearBuildScriptCaches } from "./build-scripts.ts";
import {
  copyReplicatePath,
  copyStaticAssets,
  deleteDistDir,
  deleteDistFile,
} from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import { eventEmitter } from "./events.ts";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetMocks();
  clearWatchers();
  (BascikConfig as any).assets = { inlineStyles: false };
  (BascikConfig as any).pipeline = { watchPaths: [] };
});

// ─── Helper: get a named event handler from a given watcher index ─────────────

const getHandler = (
  watcherIndex: number,
  event: string,
): ((...args: any[]) => any) | undefined => {
  const watcher = getWatcher(watcherIndex);
  const call = watcher?.on.mock.calls.find((c: any[]) => c[0] === event);
  return call?.[1];
};

// ─────────────────────────────────────────────────────────────────────────────
// Watcher setup
// ─────────────────────────────────────────────────────────────────────────────

// Default dev-mode watcher count: pages assets, pages html, components,
// import root. Extra watchers (watchPaths, inlineStyles, api, config) are
// opt-in and asserted separately.
const DEV_WATCHER_COUNT = 4;

describe("watchFiles – watcher setup", () => {
  it("calls chokidar.watch four times in dev mode with default config", async () => {
    await watchFiles();
    expect(mockWatch).toHaveBeenCalledTimes(DEV_WATCHER_COUNT);
  });

  it("configures native persistent watching in dev mode without polling", async () => {
    await watchFiles();
    expect(mockWatch.mock.calls[0][1]).toMatchObject({ persistent: true });
    expect(mockWatch.mock.calls[0][1]).not.toHaveProperty("usePolling");
  });

  it("watches the pages directory for asset copying", async () => {
    await watchFiles();
    expect(mockWatch.mock.calls[0][0]).toContain("/project/src/pages");
  });

  it("watches the pages directory for html transpilation", async () => {
    await watchFiles();
    expect(mockWatch.mock.calls[1][0]).toContain("/project/src/pages");
  });

  it("watches the components directory", async () => {
    await watchFiles();
    expect(mockWatch.mock.calls[2][0]).toContain("/project/src/components");
  });

  it("watches the import root directory", async () => {
    await watchFiles();
    expect(mockWatch.mock.calls[3][0]).toEqual(["/project/src"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Import root watcher (watcher 3, dev-only, dependency-gated)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – import root watcher (watcher 3)", () => {
  beforeEach(async () => {
    await watchFiles();
    // The pages-html watcher's ready handler runs processAllPages during
    // setup; clear that residue so not-called assertions target the handlers.
    mockProcessAllPages.mockClear();
    mockSelectivelyProcessPagesForWatchPath.mockClear();
    mockClearBuildScriptCaches.mockClear();
    mockProcessPageBatch.mockClear();
    mockEventEmit.mockClear();
  });

  const getIgnoreFn = (): ((path: string) => boolean) =>
    (mockWatch.mock.calls[3][1] as { ignored: (path: string) => boolean }).ignored;

  it("excludes directory.pages and directory.components when nested inside the import root", () => {
    const ignored = getIgnoreFn();
    expect(ignored("/project/src/pages/index.html")).toBe(true);
    expect(ignored("/project/src/components/x/x.ts")).toBe(true);
    expect(ignored("/project/src/pages")).toBe(true);
    expect(ignored("/project/src/lib/helper.ts")).toBe(false);
    expect(ignored("/project/src/api/route.ts")).toBe(false);
  });

  it("rebuilds dependent pages on 'change' when dependents exist", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const handler = getHandler(3, "change");
    await handler?.("/project/src/lib/helper.ts");
    expect(clearBuildScriptCaches).toHaveBeenCalledWith("/project/src/lib/helper.ts");
    expect(processPageBatch).toHaveBeenCalledWith(["src/pages/a.html"]);
    expect(selectivelyProcessPagesForWatchPath).not.toHaveBeenCalled();
    expect(processAllPages).not.toHaveBeenCalled();
  });

  it("does nothing on 'change' when no pages depend on the file", async () => {
    mockPagesDependentOnFile.mockReturnValue([]);
    const handler = getHandler(3, "change");
    await handler?.("/project/src/css/unrelated.css");
    expect(processPageBatch).not.toHaveBeenCalled();
    expect(processAllPages).not.toHaveBeenCalled();
    expect(clearBuildScriptCaches).not.toHaveBeenCalled();
  });

  it("rebuilds dependent pages on 'add'", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const handler = getHandler(3, "add");
    await handler?.("/project/src/lib/helper.ts");
    expect(processPageBatch).toHaveBeenCalledWith(["src/pages/a.html"]);
  });

  it("rebuilds dependent pages on 'unlink'", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const handler = getHandler(3, "unlink");
    await handler?.("/project/src/lib/helper.ts");
    expect(processPageBatch).toHaveBeenCalledWith(["src/pages/a.html"]);
  });

  it("does not emit asset-changed or watch-path-processed", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    mockEventEmit.mockClear();
    const handler = getHandler(3, "change");
    await handler?.("/project/src/lib/helper.ts");
    expect(mockEventEmit).not.toHaveBeenCalledWith("asset-changed");
    expect(mockEventEmit).not.toHaveBeenCalledWith(
      "watch-path-processed",
      expect.anything(),
    );
  });

  it("catches and logs errors when processPageBatch rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    mockProcessPageBatch.mockRejectedValueOnce(new Error("Batch error"));

    const handler = getHandler(3, "change");
    await expect(handler?.("/project/src/lib/helper.ts")).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("[bascik] watch error:", expect.any(Error));

    errorSpy.mockRestore();
  });

  it("is not created in build mode", async () => {
    clearWatchers();
    mockWatch.mockClear();
    (BascikConfig as any).isBuild = true;
    try {
      await watchFiles();
      expect(mockWatch).not.toHaveBeenCalled();
    } finally {
      (BascikConfig as any).isBuild = false;
    }
  });

  it("is not created when the import root directory does not exist", async () => {
    clearWatchers();
    mockWatch.mockClear();
    mockExistsSync.mockReturnValue(false);
    await watchFiles();
    expect(mockWatch).toHaveBeenCalledTimes(3);
  });

  it("watches a custom import root outside the project", async () => {
    clearWatchers();
    mockWatch.mockClear();
    mockGetImportRoot.mockReturnValue("/repo/shared/scripts");
    await watchFiles();
    expect(mockWatch.mock.calls[3][0]).toEqual(["/repo/shared/scripts"]);
    const ignored = getIgnoreFn();
    expect(ignored("/repo/shared/scripts/md-renderer.ts")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Asset watcher (watcher 0) event handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – asset watcher (watcher 0)", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("calls copyReplicatePath on 'add'", async () => {
    const handler = getHandler(0, "add");
    await handler?.("/path/to/style.css");
    expect(copyReplicatePath).toHaveBeenCalledWith(
      "/path/to/style.css",
      "dist",
    );
  });

  it("calls copyReplicatePath on 'change'", async () => {
    const handler = getHandler(0, "change");
    await handler?.("/path/to/style.css");
    expect(copyReplicatePath).toHaveBeenCalledWith(
      "/path/to/style.css",
      "dist",
    );
  });

  it("calls deleteDistFile on 'unlink'", async () => {
    const handler = getHandler(0, "unlink");
    handler?.("/path/to/old.css");
    expect(deleteDistFile).toHaveBeenCalledWith("/path/to/old.css");
  });

  it("calls deleteDistDir on 'unlinkDir'", async () => {
    const handler = getHandler(0, "unlinkDir");
    handler?.("/path/to/dir");
    expect(deleteDistDir).toHaveBeenCalledWith("/path/to/dir");
  });

  it("emits asset-changed when a file changes and not in build mode", async () => {
    const handler = getHandler(0, "change");
    await handler?.("/path/to/style.css");
    expect(eventEmitter.emit).toHaveBeenCalledWith("asset-changed");
  });

  it("calls processAllPages when an inline stylesheet changes and inlineStyles is true", async () => {
    (BascikConfig as any).assets = { inlineStyles: true };
    mockIsInlineStylesheet.mockReturnValue(true);
    mockProcessAllPages.mockClear();
    mockEventEmit.mockClear();
    const handler = getHandler(0, "change");
    await handler?.("/path/to/style.css");
    expect(processAllPages).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).not.toHaveBeenCalledWith("asset-changed");
  });

  it("does not ignore an inline stylesheet when inlineStyles is true", () => {
    (BascikConfig as any).assets = { inlineStyles: true };
    mockIsInlineStylesheet.mockReturnValue(true);
    mockIsStaticAssetPath.mockReturnValue(false);
    const ignored = mockWatch.mock.calls[0][1].ignored as (
      path: string,
      stats: { isFile: () => boolean },
    ) => boolean;

    expect(ignored("/project/src/pages/styles.css", { isFile: () => true })).toBe(false);
  });

  it("calls processAllPages when an inline stylesheet is added and inlineStyles is true", async () => {
    (BascikConfig as any).assets = { inlineStyles: true };
    mockIsInlineStylesheet.mockReturnValue(true);
    mockProcessAllPages.mockClear();
    mockEventEmit.mockClear();
    const handler = getHandler(0, "add");
    await handler?.("/path/to/style.css");
    expect(processAllPages).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).not.toHaveBeenCalledWith("asset-changed");
  });

  it("rebuilds pages when an inline stylesheet is deleted", async () => {
    (BascikConfig as any).assets = { inlineStyles: true };
    mockIsInlineStylesheet.mockReturnValue(true);
    mockProcessAllPages.mockClear();
    mockDeleteDistFile.mockClear();
    const handler = getHandler(0, "unlink");

    await handler?.("/project/src/pages/styles.css");

    expect(processAllPages).toHaveBeenCalledOnce();
    expect(deleteDistFile).not.toHaveBeenCalled();
  });

  it("calls processAllPages when matching inlineStyles array on change", async () => {
    (BascikConfig as any).assets = { inlineStyles: ["src/css/styles.css"] };
    mockIsInlineStylesheet.mockImplementation((p: string) => p.endsWith("styles.css"));
    mockProcessAllPages.mockClear();
    mockEventEmit.mockClear();
    const handler = getHandler(0, "change");
    await handler?.("/path/to/src/css/styles.css");
    expect(processAllPages).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).not.toHaveBeenCalledWith("asset-changed");
  });

  it("emits asset-changed when a non-matching stylesheet changes", async () => {
    (BascikConfig as any).assets = { inlineStyles: ["src/css/styles.css"] };
    mockIsInlineStylesheet.mockImplementation((p: string) => p.endsWith("styles.css"));
    mockProcessAllPages.mockClear();
    mockEventEmit.mockClear();
    const handler = getHandler(0, "change");
    await handler?.("/path/to/src/css/other.css");
    expect(processAllPages).not.toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith("asset-changed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML page watcher (watcher 1) event handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – html page watcher (watcher 1)", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("calls processAllPages on 'ready'", async () => {
    const readyHandler = getHandler(1, "ready");
    mockProcessAllPages.mockClear();
    await readyHandler?.();
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });

  it("calls processAllPages on 'add' after ready", () => {
    // ready already fired during watchFiles() in beforeEach; initialScanDone is true
    const addHandler = getHandler(1, "add");
    mockProcessAllPages.mockClear();
    addHandler?.("/path/to/new-page.html");
    expect(processAllPages).toHaveBeenCalled();
  });

  it("calls pageProcessing on 'change'", () => {
    const handler = getHandler(1, "change");
    handler?.("/path/to/page.html");
    expect(pageProcessing).toHaveBeenCalledWith("/path/to/page.html");
  });

  it("calls removePage on 'unlink'", () => {
    const handler = getHandler(1, "unlink");
    handler?.("/path/to/deleted.html");
    expect(removePage).toHaveBeenCalledWith("/path/to/deleted.html");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component watcher (watcher 2) event handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – component watcher (watcher 2)", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("calls processAllPages on 'add'", async () => {
    const handler = getHandler(2, "add");
    await handler?.();
    expect(processAllPages).toHaveBeenCalled();
  });

  it("calls selectivelyProcessPages on 'change'", async () => {
    const handler = getHandler(2, "change");
    await handler?.("/path/to/my-comp.html");
    expect(selectivelyProcessPages).toHaveBeenCalledWith(
      "/path/to/my-comp.html",
    );
  });

  it("calls selectivelyProcessPages on 'unlink'", async () => {
    const handler = getHandler(2, "unlink");
    await handler?.("/path/to/old-comp.html");
    expect(selectivelyProcessPages).toHaveBeenCalledWith(
      "/path/to/old-comp.html",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML page watcher (watcher 1) – unlinkDir handler
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – html page watcher (watcher 1) unlinkDir", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("calls deleteDistDir on 'unlinkDir'", () => {
    const handler = getHandler(1, "unlinkDir");
    handler?.("/path/to/dir");
    expect(deleteDistDir).toHaveBeenCalledWith("/path/to/dir");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ignored predicates
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – ignored predicates", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("watcher 0: returns false for a file with a known static asset extension", () => {
    const ignored = mockWatch.mock.calls[0][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/style.css", { isFile: () => true })).toBe(false);
    expect(ignored("/path/to/app.js", { isFile: () => true })).toBe(false);
  });

  it("watcher 0: delegates unknown-extension decisions to the shared asset predicate", () => {
    const ignored = mockWatch.mock.calls[0][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    mockIsStaticAssetPath.mockReturnValueOnce(true).mockReturnValueOnce(false);

    expect(ignored("/path/to/template.hbs", { isFile: () => true })).toBe(false);
    expect(ignored("/path/to/private.hbs", { isFile: () => true })).toBe(true);
    expect(mockIsStaticAssetPath).toHaveBeenNthCalledWith(1, "/path/to/template.hbs");
    expect(mockIsStaticAssetPath).toHaveBeenNthCalledWith(2, "/path/to/private.hbs");
  });

  it("watcher 0: returns true for denied source and test files", () => {
    const ignored = mockWatch.mock.calls[0][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    mockIsStaticAssetPath.mockReturnValue(false);

    expect(ignored("/path/to/helper.ts", { isFile: () => true })).toBe(true);
    expect(ignored("/path/to/app.test.js", { isFile: () => true })).toBe(true);
  });

  it("watcher 0: returns false when stats is undefined", () => {
    const ignored = mockWatch.mock.calls[0][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/file.txt", undefined)).toBe(false);
  });

  it("watcher 1: returns false for an .html file", () => {
    const ignored = mockWatch.mock.calls[1][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/page.html", { isFile: () => true })).toBe(false);
  });

  it("watcher 1: returns true for a non-.html file (covers line 51)", () => {
    const ignored = mockWatch.mock.calls[1][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/script.js", { isFile: () => true })).toBe(true);
  });

  it("watcher 1: returns false when stats is undefined", () => {
    const ignored = mockWatch.mock.calls[1][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/script.js", undefined)).toBe(false);
  });

  it("watcher 2: returns false for an .html file", () => {
    const ignored = mockWatch.mock.calls[2][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/comp.html", { isFile: () => true })).toBe(false);
  });

  it("watcher 2: returns false for a .css file", () => {
    const ignored = mockWatch.mock.calls[2][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/comp.css", { isFile: () => true })).toBe(false);
  });

  it("watcher 2: returns true for a non-.html/.css/.js/.ts/.mjs file (covers line 73)", () => {
    const ignored = mockWatch.mock.calls[2][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/data.json", { isFile: () => true })).toBe(true);
    expect(ignored("/path/to/script.ts", { isFile: () => true })).toBe(false);
  });

  it("watcher 2: returns false when stats is undefined", () => {
    const ignored = mockWatch.mock.calls[2][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/script.ts", undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// add before ready (initialScanDone = false)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – add before ready (initialScanDone = false)", () => {
  it("does NOT call pageProcessing when initialScanDone is false", async () => {
    const captured: Record<string, (...args: any[]) => any> = {};
    const deferredWatcher = {
      on: vi.fn(function (this: any, event: string, handler: any) {
        captured[event] = handler;
        return this;
      }),
    };
    const simpleWatcher = {
      on: vi.fn(function (this: any) {
        return this;
      }),
    };

    // call 0 (asset watcher): simple pass-through; call 1 (pages html watcher): deferred ready
    mockWatch
      .mockImplementationOnce(() => simpleWatcher)
      .mockImplementationOnce(() => deferredWatcher);

    const watchPromise = watchFiles();

    // ready has not fired yet — initialScanDone is still false
    captured["add"]?.("/new-page.html");
    expect(pageProcessing).not.toHaveBeenCalled();

    // unblock watchFiles by firing ready
    await captured["ready"]?.();
    await watchPromise;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isBuild = true branches
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – isBuild = true", () => {
  beforeEach(() => {
    (BascikConfig as any).isBuild = true;
  });

  afterEach(() => {
    (BascikConfig as any).isBuild = false;
  });

  it("copies static assets and transpiles all pages without creating file watchers", async () => {
    await watchFiles();

    expect(copyStaticAssets).toHaveBeenCalledTimes(1);
    expect(processAllPages).toHaveBeenCalledTimes(1);
    expect(mockWatch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra watch paths watcher (watcher 3, dev-only)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – extra watch paths (watcher 3)", () => {
  beforeEach(async () => {
    (BascikConfig as any).pipeline = { watchPaths: ["/extra/watch/path"] };
    await watchFiles();
  });

  afterEach(() => {
    (BascikConfig as any).pipeline = { watchPaths: [] };
  });

  it("creates a fifth watcher when watch paths are set", () => {
    expect(mockWatch).toHaveBeenCalledTimes(DEV_WATCHER_COUNT + 1);
  });

  it("watches BascikConfig.pipeline.watchPaths paths", () => {
    expect(mockWatch.mock.calls[3][0]).toEqual(["/extra/watch/path"]);
  });

  it("calls selectivelyProcessPagesForWatchPath on 'add'", async () => {
    const handler = getHandler(3, "add");
    await handler?.("/extra/watch/path/new.ts");
    expect(selectivelyProcessPagesForWatchPath).toHaveBeenCalledWith(
      "/extra/watch/path/new.ts",
    );
  });

  it("calls selectivelyProcessPagesForWatchPath on 'change'", async () => {
    const handler = getHandler(3, "change");
    await handler?.("/extra/watch/path/changed.ts");
    expect(selectivelyProcessPagesForWatchPath).toHaveBeenCalledWith(
      "/extra/watch/path/changed.ts",
    );
  });

  it("calls processAllPages on 'unlink'", async () => {
    const handler = getHandler(3, "unlink");
    await handler?.();
    expect(processAllPages).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inline styles paths watcher (dev-only)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – inlineStyles paths", () => {
  beforeEach(async () => {
    (BascikConfig as any).assets = { inlineStyles: ["src/css/inlined.css"] };
    await watchFiles();
  });

  afterEach(() => {
    (BascikConfig as any).assets = { inlineStyles: false };
  });

  it("creates an extra watcher when inlineStyles array is configured", () => {
    expect(mockWatch).toHaveBeenCalledTimes(DEV_WATCHER_COUNT + 1);
  });

  it("watches BascikConfig.assets.inlineStyles paths", () => {
    expect(mockWatch.mock.calls[4][0]).toEqual(["src/css/inlined.css"]);
  });

  it("calls processAllPages on 'add'", async () => {
    const handler = getHandler(4, "add");
    mockProcessAllPages.mockClear();
    await handler?.();
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });

  it("calls processAllPages on 'change'", async () => {
    const handler = getHandler(4, "change");
    mockProcessAllPages.mockClear();
    await handler?.();
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });

  it("calls processAllPages on 'unlink'", async () => {
    const handler = getHandler(4, "unlink");
    mockProcessAllPages.mockClear();
    await handler?.();
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Watcher error resiliency (onWatchError handling)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – error resiliency", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("catches and logs errors when asset watcher handlers reject", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    mockCopyReplicatePath.mockRejectedValueOnce(new Error("Disk error"));

    const addHandler = getHandler(0, "add");
    await expect(addHandler?.("/path/to/broken.css")).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("[bascik] watch error:", expect.any(Error));

    errorSpy.mockRestore();
  });

  it("catches and logs errors when pageProcessing rejects during page change", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    mockPageProcessing.mockRejectedValueOnce(new Error("Transpile error"));

    const changeHandler = getHandler(1, "change");
    expect(() => changeHandler?.("/path/to/bad.html")).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(errorSpy).toHaveBeenCalledWith("[bascik] watch error:", expect.any(Error));

    errorSpy.mockRestore();
  });

  it("catches and logs errors when selectivelyProcessPages rejects during component change", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    mockSelectivelyProcessPages.mockRejectedValueOnce(new Error("Component error"));

    const changeHandler = getHandler(2, "change");
    await expect(changeHandler?.("/path/to/bad-comp.html")).resolves.not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith("[bascik] watch error:", expect.any(Error));

    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coordinated watch & exec notification
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – overlap between pipeline.watchPaths and exec.watch", () => {
  it("coordinates reload notifications when a path is present in both pipeline.watchPaths and exec.watch", async () => {
    (BascikConfig as any).pipeline = {
      watchPaths: ["src/content/docs"],
      exec: [{ script: "scripts/gen-docs.ts", watch: ["src/content/docs"] }],
    };
    await watchFiles();

    // Trigger change in the overlapping watch path
    const handler = getHandler(3, "change");
    mockEventEmit.mockClear();
    await handler?.("src/content/docs/intro.md");

    // It should invoke selective page processing for the watch path
    expect(selectivelyProcessPagesForWatchPath).toHaveBeenCalledWith("src/content/docs/intro.md");
    // Ensure conflicting uncoordinated reload events are not emitted directly from watch handler
    expect(mockEventEmit).not.toHaveBeenCalledWith("asset-changed");
    // Should have coordinated execution flag or handled synchronously
    expect(mockEventEmit).toHaveBeenCalledWith("watch-path-processed", expect.objectContaining({ path: "src/content/docs/intro.md" }));
  });
});

