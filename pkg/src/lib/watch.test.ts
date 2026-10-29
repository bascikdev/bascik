import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock factories ───────────────────────────────────────────────────

const mockStopPagePools = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

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
  mockProcessPagesImportingStylesheet,
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
  mockScriptRegistryInvalidate,
  mockScriptRegistryLastInvalidated,
  mockShouldLog,
  mockApiInvalidateFile,
} = vi.hoisted(() => {
  const watchers: { on: ReturnType<typeof vi.fn> }[] = [];
  const mockScriptRegistryInvalidate = vi.fn();
  const mockScriptRegistryLastInvalidated = vi.fn(() => new Set<string>());
  const mockShouldLog = vi.fn(() => false);
  const mockApiInvalidateFile = vi.fn().mockResolvedValue(undefined);
  const mockPageProcessing = vi.fn().mockResolvedValue(undefined);
  const mockProcessAllPages = vi.fn().mockResolvedValue(undefined);
  const mockRemovePage = vi.fn().mockResolvedValue(undefined);
  const mockSelectivelyProcessPages = vi.fn().mockResolvedValue(undefined);
  const mockSelectivelyProcessPagesForWatchPath = vi
    .fn()
    .mockResolvedValue(undefined);
  const mockProcessPagesImportingStylesheet = vi
    .fn()
    .mockResolvedValue(undefined);
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
  const mockWatch = vi.fn((_path: string, _opts: Record<string, unknown>) =>
    makeWatcher(),
  );
  const resetMocks = () => {
    mockWatch
      .mockReset()
      .mockImplementation((_path: string, _opts: Record<string, unknown>) =>
        makeWatcher(),
      );
    mockPageProcessing.mockReset().mockResolvedValue(undefined);
    mockProcessAllPages.mockReset().mockResolvedValue(undefined);
    mockRemovePage.mockReset().mockResolvedValue(undefined);
    mockSelectivelyProcessPages.mockReset().mockResolvedValue(undefined);
    mockSelectivelyProcessPagesForWatchPath
      .mockReset()
      .mockResolvedValue(undefined);
    mockProcessPagesImportingStylesheet
      .mockReset()
      .mockResolvedValue(undefined);
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
    mockExistsSync
      .mockReset()
      .mockImplementation((p: string) => p === mockGetImportRoot());
    mockScriptRegistryInvalidate.mockReset();
    mockScriptRegistryLastInvalidated
      .mockReset()
      .mockImplementation(() => new Set<string>());
    mockShouldLog.mockReset().mockImplementation(() => false);
    mockApiInvalidateFile.mockReset().mockResolvedValue(undefined);
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
    mockProcessPagesImportingStylesheet,
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
    mockScriptRegistryInvalidate,
    mockScriptRegistryLastInvalidated,
    mockShouldLog,
    mockApiInvalidateFile,
  };
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("chokidar", () => ({
  default: { watch: mockWatch },
}));

vi.mock("./watch-source.ts", () => ({
  watchSourceCycles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./processing.js", () => ({
  pageProcessing: mockPageProcessing,
  processAllPages: mockProcessAllPages,
  processPageBatch: mockProcessPageBatch,
  processPagesImportingStylesheet: mockProcessPagesImportingStylesheet,
  removePage: mockRemovePage,
  selectivelyProcessPages: mockSelectivelyProcessPages,
  selectivelyProcessPagesForWatchPath: mockSelectivelyProcessPagesForWatchPath,
  stopPagePools: mockStopPagePools,
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
  shouldLog: mockShouldLog,
  BascikConfig: {
    directory: {
      pages: "/project/src/pages",
      components: ["/project/src/components"],
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

vi.mock("./script-registry.js", () => ({
  scriptRegistry: {
    invalidate: mockScriptRegistryInvalidate,
    lastInvalidated: mockScriptRegistryLastInvalidated,
  },
}));

vi.mock("./server-api.js", () => ({
  apiRouteRegistry: { invalidateFile: mockApiInvalidateFile },
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
// import root. Extra watchers (watchPaths, api, config) are
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

  it("watches every configured component root and follows symlinks there only", async () => {
    const previous = (BascikConfig as any).directory.components;
    (BascikConfig as any).directory.components = [
      "/shared/components",
      "/project/src/components",
    ];
    try {
      await watchFiles();
      expect(mockWatch.mock.calls[2][0]).toEqual([
        "/shared/components",
        "/project/src/components",
      ]);
      expect(mockWatch.mock.calls[2][1]).toMatchObject({
        followSymlinks: true,
      });
      // Pages watchers are unchanged by this prompt.
      expect(mockWatch.mock.calls[0][1]).toMatchObject({
        followSymlinks: false,
      });
      expect(mockWatch.mock.calls[1][1]).toMatchObject({
        followSymlinks: false,
      });
    } finally {
      (BascikConfig as any).directory.components = previous;
    }
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
    (mockWatch.mock.calls[3][1] as { ignored: (path: string) => boolean })
      .ignored;

  it("excludes directory.pages and every directory.components root when nested inside the import root", () => {
    const ignored = getIgnoreFn();
    expect(ignored("/project/src/pages/index.html")).toBe(true);
    expect(ignored("/project/src/components/x/x.ts")).toBe(true);
    expect(ignored("/project/src/pages")).toBe(true);
    expect(ignored("/project/src/lib/helper.ts")).toBe(false);
    expect(ignored("/project/src/api/route.ts")).toBe(false);
  });

  it("does not compile import-root dependencies without an explicit compilation watch", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const handler = getHandler(3, "change");
    await handler?.("/project/src/lib/helper.ts");
    expect(clearBuildScriptCaches).not.toHaveBeenCalled();
    expect(processPageBatch).not.toHaveBeenCalled();
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

  it("does not compile import-root dependencies on 'add'", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const handler = getHandler(3, "add");
    await handler?.("/project/src/lib/helper.ts");
    expect(processPageBatch).not.toHaveBeenCalled();
  });

  it("does not compile import-root dependencies on 'unlink'", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const handler = getHandler(3, "unlink");
    await handler?.("/project/src/lib/helper.ts");
    expect(processPageBatch).not.toHaveBeenCalled();
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

  it("catches and logs errors when runtime invalidation throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    mockScriptRegistryInvalidate.mockImplementationOnce(() => {
      throw new Error("Runtime error");
    });

    const handler = getHandler(3, "change");
    await expect(
      handler?.("/project/src/lib/helper.ts"),
    ).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "[bascik] watch error:",
      expect.any(Error),
    );

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

  it("rescans static assets when a removed directory is recreated", async () => {
    const unlinkDir = getHandler(0, "unlinkDir");
    const addDir = getHandler(0, "addDir");

    unlinkDir?.("/project/src/pages/images");
    addDir?.("/project/src/pages/images");
    await Promise.resolve();

    expect(copyStaticAssets).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith("asset-changed");
  });

  it("rescans static assets on addDir even when Chokidar coalesced the preceding unlinkDir", async () => {
    const addDir = getHandler(0, "addDir");

    addDir?.("/project/src/pages/images/nested");
    await Promise.resolve();

    expect(copyStaticAssets).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith("asset-changed");
  });

  it("rescans static assets after unlinkDir if the source directory already exists on disk", async () => {
    mockExistsSync.mockReturnValue(true);
    const unlinkDir = getHandler(0, "unlinkDir");

    unlinkDir?.("/project/src/pages/images");
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteDistDir).toHaveBeenCalledWith("/project/src/pages/images");
    expect(copyStaticAssets).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith("asset-changed");
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

    expect(
      ignored("/project/src/pages/styles.css", { isFile: () => true }),
    ).toBe(false);
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
    mockIsInlineStylesheet.mockImplementation((p: string) =>
      p.endsWith("styles.css"),
    );
    mockProcessAllPages.mockClear();
    mockEventEmit.mockClear();
    const handler = getHandler(0, "change");
    await handler?.("/path/to/src/css/styles.css");
    expect(processAllPages).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).not.toHaveBeenCalledWith("asset-changed");
  });

  it("emits asset-changed when a non-matching stylesheet changes", async () => {
    (BascikConfig as any).assets = { inlineStyles: ["src/css/styles.css"] };
    mockIsInlineStylesheet.mockImplementation((p: string) =>
      p.endsWith("styles.css"),
    );
    mockProcessAllPages.mockClear();
    mockEventEmit.mockClear();
    const handler = getHandler(0, "change");
    await handler?.("/path/to/src/css/other.css");
    expect(processAllPages).not.toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith("asset-changed");
  });

  it.each(["add", "change", "unlink"])(
    "rebuilds pages of components importing a static stylesheet on '%s' before reloading",
    async (event) => {
      const order: string[] = [];
      mockProcessPagesImportingStylesheet.mockImplementation(async () => {
        order.push("rebuild");
      });
      mockEventEmit.mockImplementation((name: string) => {
        order.push(name);
      });
      await getHandler(0, event)?.("/project/src/pages/styles/tokens.css");
      await Promise.resolve();
      await Promise.resolve();
      expect(
        mockProcessPagesImportingStylesheet,
      ).toHaveBeenCalledExactlyOnceWith("/project/src/pages/styles/tokens.css");
      if (event !== "unlink")
        expect(order).toEqual(["rebuild", "asset-changed"]);
    },
  );

  it("does not look up stylesheet importers for an inline stylesheet, which rebuilds every page", async () => {
    mockIsInlineStylesheet.mockReturnValue(true);
    mockProcessAllPages.mockClear();
    try {
      await getHandler(0, "change")?.("/project/src/pages/styles.css");
      expect(processAllPages).toHaveBeenCalledOnce();
      expect(mockProcessPagesImportingStylesheet).not.toHaveBeenCalled();
    } finally {
      mockIsInlineStylesheet.mockReset().mockReturnValue(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML page watcher (watcher 1) event handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – html page watcher (watcher 1)", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("runs the initial compile after watcher setup resolves", () => {
    expect(copyStaticAssets).toHaveBeenCalledTimes(1);
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

    expect(ignored("/path/to/template.hbs", { isFile: () => true })).toBe(
      false,
    );
    expect(ignored("/path/to/private.hbs", { isFile: () => true })).toBe(true);
    expect(mockIsStaticAssetPath).toHaveBeenNthCalledWith(
      1,
      "/path/to/template.hbs",
    );
    expect(mockIsStaticAssetPath).toHaveBeenNthCalledWith(
      2,
      "/path/to/private.hbs",
    );
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
    await new Promise((r) => setTimeout(r, 0));

    // ready has not fired yet — initialScanDone is still false
    captured["add"]?.("/new-page.html");
    expect(pageProcessing).not.toHaveBeenCalled();

    // unblock watchFiles by firing ready
    await captured["ready"]?.();
    await watchPromise;
  });

  it("accepts a bootCompile hook so watcher installation stays outside publisher scope", async () => {
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
    const bootCompile = vi.fn(
      async (compileInitialSources: () => Promise<void>) => {
        expect(copyStaticAssets).not.toHaveBeenCalled();
        expect(processAllPages).not.toHaveBeenCalled();
        await compileInitialSources();
      },
    );

    mockWatch
      .mockImplementationOnce(() => simpleWatcher)
      .mockImplementationOnce(() => deferredWatcher)
      .mockImplementation(() => simpleWatcher);

    const watchPromise = watchFiles({ bootCompile });
    await new Promise((r) => setTimeout(r, 0));

    expect(bootCompile).not.toHaveBeenCalled();
    await captured["ready"]?.();
    await watchPromise;

    expect(bootCompile).toHaveBeenCalledOnce();
    expect(copyStaticAssets).toHaveBeenCalledTimes(1);
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });

  it("installs component and watchPaths watchers only after bootCompile returns, outside the publisher scope", async () => {
    (BascikConfig as any).pipeline = { watchPaths: ["/extra/watch/path"] };
    const bootCompilePaused = Promise.withResolvers<void>();
    const releaseBootCompile = Promise.withResolvers<void>();
    const registrationPublisherStates: boolean[] = [];
    const compilationEvents = await import("./compilation-events.ts");
    let componentChangeHandler: ((path: string) => Promise<void>) | undefined;
    let watchPathChangeHandler: ((path: string) => Promise<void>) | undefined;

    mockWatch.mockImplementation((path: string | string[]) => {
      const watched = Array.isArray(path) ? path : [path];
      const watcher = {
        on: vi.fn(function (
          this: any,
          event: string,
          handler: (...args: any[]) => any,
        ) {
          if (
            watched.includes("/project/src/components") &&
            event === "change"
          ) {
            componentChangeHandler = handler as (path: string) => Promise<void>;
          }
          if (watched.includes("/extra/watch/path") && event === "change") {
            watchPathChangeHandler = handler as (path: string) => Promise<void>;
          }
          if (event === "ready") {
            void handler();
          }
          return this;
        }),
      };
      if (
        watched.includes("/project/src/components") ||
        watched.includes("/extra/watch/path")
      ) {
        registrationPublisherStates.push(
          compilationEvents.hasCompilationPublisher(),
        );
      }
      return watcher;
    });

    const bootCompile = vi.fn(
      async (compileInitialSources: () => Promise<void>) => {
        await compilationEvents.withCompilationPublisher(
          vi.fn(),
          async () => {
            await compileInitialSources();
            bootCompilePaused.resolve();
            await releaseBootCompile.promise;
            expect(compilationEvents.hasCompilationPublisher()).toBe(true);
          },
          { onPageErrors: "publish" },
        );
      },
    );

    const watchPromise = watchFiles({ bootCompile });

    await bootCompilePaused.promise;
    const watchedBeforeBootReturns = mockWatch.mock.calls.map(([path]) => path);
    expect(watchedBeforeBootReturns).not.toContainEqual([
      "/project/src/components",
    ]);
    expect(watchedBeforeBootReturns).not.toContainEqual(["/extra/watch/path"]);

    releaseBootCompile.resolve();
    await watchPromise;

    const watchedAfterBootReturns = mockWatch.mock.calls.map(([path]) => path);
    expect(watchedAfterBootReturns).toContainEqual(["/project/src/components"]);
    expect(watchedAfterBootReturns).toContainEqual(["/extra/watch/path"]);
    expect(registrationPublisherStates).toEqual([false, false]);

    mockSelectivelyProcessPages.mockImplementation(async () => {
      expect(compilationEvents.hasCompilationPublisher()).toBe(false);
    });
    mockSelectivelyProcessPagesForWatchPath.mockImplementation(async () => {
      expect(compilationEvents.hasCompilationPublisher()).toBe(false);
    });

    await componentChangeHandler?.("/project/src/components/button.html");
    await watchPathChangeHandler?.("/extra/watch/path/content.md");

    expect(clearBuildScriptCaches).toHaveBeenCalledWith(
      "/project/src/components/button.html",
    );
    expect(clearBuildScriptCaches).toHaveBeenCalledWith(
      "/extra/watch/path/content.md",
    );
    expect(selectivelyProcessPages).toHaveBeenCalledWith(
      "/project/src/components/button.html",
    );
    expect(selectivelyProcessPagesForWatchPath).toHaveBeenCalledWith(
      "/extra/watch/path/content.md",
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith("watch-path-processed", {
      path: "/extra/watch/path/content.md",
    });
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

  // The CLI exits as soon as this rejects; page workers still loading the
  // compiler at that moment can abort Node 24, so they are stopped first.
  it("stops the page worker pools before reporting a static asset copy failure", async () => {
    mockStopPagePools.mockClear();
    let finishPages!: () => void;
    mockProcessAllPages.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishPages = resolve)),
    );
    let stopped = false;
    mockStopPagePools.mockImplementationOnce(async () => {
      await Promise.resolve();
      stopped = true;
    });
    vi.mocked(copyStaticAssets).mockRejectedValueOnce(new Error("EACCES"));
    const failed = watchFiles().then(
      () => "resolved",
      (error: Error) => ({ message: error.message, stopped }),
    );
    await expect(failed).resolves.toEqual({ message: "EACCES", stopped: true });
    expect(mockStopPagePools).toHaveBeenCalledOnce();
    finishPages();
  });

  it("still reports the copy failure when stopping the pools fails", async () => {
    mockStopPagePools.mockRejectedValueOnce(new Error("stop failed"));
    vi.mocked(copyStaticAssets).mockRejectedValueOnce(new Error("EACCES"));
    await expect(watchFiles()).rejects.toThrow("EACCES");
  });

  it("does not stop the pools when the build succeeds", async () => {
    mockStopPagePools.mockClear();
    await watchFiles();
    expect(mockStopPagePools).not.toHaveBeenCalled();
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

  it("invalidates only the deleted watch path and rebuilds its dependents on 'unlink'", async () => {
    const handler = getHandler(3, "unlink");
    mockProcessAllPages.mockClear();
    await handler?.("/extra/watch/path/deleted.ts");
    expect(selectivelyProcessPagesForWatchPath).toHaveBeenCalledWith(
      "/extra/watch/path/deleted.ts",
    );
    expect(mockClearBuildScriptCaches.mock.calls).toEqual([
      ["/extra/watch/path/deleted.ts"],
    ]);
    expect(processAllPages).not.toHaveBeenCalled();
  });
});

describe("watchFiles – glob watch paths", () => {
  beforeEach(async () => {
    (BascikConfig as any).pipeline = {
      watchPaths: ["/extra/content/**/*.md", "/extra/data/"],
    };
    await watchFiles();
  });

  afterEach(() => {
    (BascikConfig as any).pipeline = { watchPaths: [] };
  });

  // Chokidar does not expand globs, so a glob is watched from its folder.
  it("watches the folder a glob starts in", () => {
    expect(mockWatch.mock.calls[3][0]).toEqual([
      "/extra/content",
      "/extra/data/",
    ]);
  });

  it.each(["add", "change", "unlink"])(
    "processes a %s event only for files the glob matches",
    async (event) => {
      const handler = getHandler(3, event);
      await handler?.("/extra/content/posts/first.md");
      await handler?.("/extra/content/posts/draft.txt");
      expect(
        (selectivelyProcessPagesForWatchPath as ReturnType<typeof vi.fn>).mock
          .calls,
      ).toEqual([["/extra/content/posts/first.md"]]);
    },
  );
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

  it("does not create an implicit compilation watch for inlineStyles", () => {
    expect(mockWatch).toHaveBeenCalledTimes(DEV_WATCHER_COUNT);
  });

  it.each(["add", "change", "unlink"])(
    "uses explicit watchPaths for inline stylesheet %s",
    async (event) => {
      clearWatchers();
      mockWatch.mockClear();
      BascikConfig.pipeline.watchPaths = ["src/css/"];
      await watchFiles();
      await getHandler(3, event)?.("src/css/inlined.css");
      expect(
        selectivelyProcessPagesForWatchPath,
      ).toHaveBeenCalledExactlyOnceWith("src/css/inlined.css");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Watcher error resiliency (onWatchError handling)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – error resiliency", () => {
  beforeEach(async () => {
    await watchFiles();
  });

  it("catches and logs errors when asset watcher handlers reject", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCopyReplicatePath.mockRejectedValueOnce(new Error("Disk error"));

    const addHandler = getHandler(0, "add");
    await expect(addHandler?.("/path/to/broken.css")).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "[bascik] watch error:",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("catches and logs errors when pageProcessing rejects during page change", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPageProcessing.mockRejectedValueOnce(new Error("Transpile error"));

    const changeHandler = getHandler(1, "change");
    expect(() => changeHandler?.("/path/to/bad.html")).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(errorSpy).toHaveBeenCalledWith(
      "[bascik] watch error:",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("catches and logs errors when selectivelyProcessPages rejects during component change", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSelectivelyProcessPages.mockRejectedValueOnce(
      new Error("Component error"),
    );

    const changeHandler = getHandler(2, "change");
    await expect(
      changeHandler?.("/path/to/bad-comp.html"),
    ).resolves.not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      "[bascik] watch error:",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coordinated watch & exec notification
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – overlap between pipeline.watchPaths and exec.watch", () => {
  it("delegates overlapping sources to one phase-ordered observer", async () => {
    (BascikConfig as any).pipeline = {
      watchPaths: ["src/content/docs"],
      exec: [{ script: "scripts/gen-docs.ts", watch: ["src/content/docs"] }],
    };
    await watchFiles();
    const { watchSourceCycles } = await import("./watch-source.ts");
    expect(watchSourceCycles).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
    );
    expect(mockWatch).not.toHaveBeenCalledWith(
      expect.arrayContaining(["src/content/docs"]),
      expect.anything(),
    );
    expect(processAllPages).not.toHaveBeenCalled();
    expect(mockEventEmit).not.toHaveBeenCalledWith("asset-changed");
  });

  it.each([{ watchPaths: [] }, { watchPaths: ["content/"] }])(
    "exec completion never compiles with watchPaths $watchPaths",
    async ({ watchPaths }) => {
      const { installExecPublication } = await import("./exec-publication.ts");
      const { EventEmitter } = await import("node:events");
      const emitter = new EventEmitter();
      installExecPublication(emitter);
      BascikConfig.pipeline.watchPaths = watchPaths;
      BascikConfig.pipeline.exec = [
        { script: "scripts/generator.ts", watch: ["content/"] },
      ];
      await watchFiles();
      mockProcessAllPages.mockClear();
      mockEventEmit.mockClear();
      for (const paths of [[], ["content/doc.md"]]) {
        emitter.emit("exec-completed", {
          entry: BascikConfig.pipeline.exec![0],
          paths,
        });
      }
      await Promise.resolve();
      expect(processAllPages).not.toHaveBeenCalled();
      expect(selectivelyProcessPagesForWatchPath).not.toHaveBeenCalled();
      expect(processPageBatch).not.toHaveBeenCalled();
      expect(clearBuildScriptCaches).not.toHaveBeenCalled();
      expect(mockEventEmit).not.toHaveBeenCalled();
    },
  );

  it("uses the same source observer for paths not covered by an exec entry", async () => {
    (BascikConfig as any).pipeline = {
      watchPaths: ["src/content/docs"],
      exec: [{ script: "scripts/gen-docs.ts", watch: ["src/content/other"] }],
    };
    await watchFiles();

    const { watchSourceCycles } = await import("./watch-source.ts");
    expect(watchSourceCycles).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
    );
    expect(selectivelyProcessPagesForWatchPath).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime module invalidation ownership (prompt 112)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchFiles – runtime module invalidation (prompt 112)", () => {
  beforeEach(async () => {
    await watchFiles();
    mockScriptRegistryInvalidate.mockClear();
    mockProcessPageBatch.mockClear();
  });

  it.each(["add", "change", "unlink"])(
    "import-root '%s' invalidates the runtime module identity even when no page depends on it",
    async (event) => {
      // A `src=` server script module (or a helper it imports) is a request-time
      // dependency, not a build-time one, so mem.pagesDependentOnFile knows
      // nothing about it. The watcher must still invalidate the runtime registry.
      mockPagesDependentOnFile.mockReturnValue([]);
      const handler = getHandler(3, event);
      await handler?.("/project/src/lib/src-script.ts");
      expect(mockScriptRegistryInvalidate).toHaveBeenCalledWith(
        "/project/src/lib/src-script.ts",
      );
      expect(processPageBatch).not.toHaveBeenCalled();
    },
  );

  it("import-root 'change' invalidates runtime modules without rebuilding dependents", async () => {
    mockPagesDependentOnFile.mockReturnValue(["src/pages/a.html"]);
    const order: string[] = [];
    mockScriptRegistryInvalidate.mockImplementation(() =>
      order.push("invalidate"),
    );
    mockProcessPageBatch.mockImplementation(async () => {
      order.push("rebuild");
      return [];
    });
    const handler = getHandler(3, "change");
    await handler?.("/project/src/lib/helper.ts");
    expect(order).toEqual(["invalidate"]);
  });

  it("component watcher 'change' invalidates a companion script module identity", async () => {
    const handler = getHandler(2, "change");
    await handler?.("/project/src/components/card/card.server.ts");
    expect(mockScriptRegistryInvalidate).toHaveBeenCalledWith(
      "/project/src/components/card/card.server.ts",
    );
  });
});

describe("watchFiles – transitive helper invalidation (prompt 138)", () => {
  beforeEach(async () => {
    await watchFiles();
    mockScriptRegistryInvalidate.mockClear();
  });

  it("import-root 'change' on a helper reaches the registry and logs the entries the graph advanced", async () => {
    const { pathToFileURL } = await import("node:url");
    const { resolve: resolvePath } = await import("node:path");
    const helper = resolvePath(process.cwd(), "src/lib/helper.ts");
    const entry = resolvePath(process.cwd(), "src/lib/src-script.ts");
    mockShouldLog.mockReturnValue(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // The registry reports that the helper key and, transitively, the entry key advanced.
    mockScriptRegistryInvalidate.mockReturnValue(true);
    mockScriptRegistryLastInvalidated.mockReturnValue(
      new Set([pathToFileURL(helper).href, pathToFileURL(entry).href]),
    );
    mockPagesDependentOnFile.mockReturnValue([]);

    const handler = getHandler(3, "change");
    await handler?.(helper);

    expect(mockScriptRegistryInvalidate).toHaveBeenCalledWith(helper);
    const line = logSpy.mock.calls
      .map((c) => c.join(" "))
      .find((l) => l.includes("module invalidated"));
    logSpy.mockRestore();
    expect(line).toContain("module invalidated: src/lib/helper.ts");
    // The entry that imports the helper is named so the author sees what reloads.
    expect(line).toContain("src/lib/src-script.ts");
    expect(line).not.toContain("bascik-gen");
  });

  it("logs only the changed path when it was the sole key advanced", async () => {
    const { pathToFileURL } = await import("node:url");
    const { resolve: resolvePath } = await import("node:path");
    const entry = resolvePath(process.cwd(), "src/lib/src-script.ts");
    mockShouldLog.mockReturnValue(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockScriptRegistryInvalidate.mockReturnValue(true);
    mockScriptRegistryLastInvalidated.mockReturnValue(
      new Set([pathToFileURL(entry).href]),
    );

    const handler = getHandler(3, "change");
    await handler?.(entry);

    const line = logSpy.mock.calls
      .map((c) => c.join(" "))
      .find((l) => l.includes("module invalidated"));
    logSpy.mockRestore();
    expect(line).toBe("[bascik] module invalidated: src/lib/src-script.ts");
  });

  it("does not log or consult the graph when the registry never imported the file", async () => {
    mockShouldLog.mockReturnValue(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockScriptRegistryInvalidate.mockReturnValue(false);

    const handler = getHandler(3, "change");
    await handler?.("/project/src/lib/unrelated.ts");

    expect(mockScriptRegistryLastInvalidated).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some((c) => c.join(" ").includes("module invalidated")),
    ).toBe(false);
    logSpy.mockRestore();
  });
});

describe("watchFiles – api route watcher (prompt 112)", () => {
  beforeEach(async () => {
    clearWatchers();
    mockWatch.mockClear();
    // Both the import root and the api directory exist for this suite.
    mockExistsSync.mockImplementation(() => true);
    await watchFiles();
    mockApiInvalidateFile.mockClear();
    mockEventEmit.mockClear();
  });

  const apiWatcherIndex = (): number =>
    mockWatch.mock.calls.findIndex(
      (c) => Array.isArray(c[0]) && c[0].includes("src/api"),
    );

  it.each(["add", "change", "unlink"])(
    "'%s' invalidates the route file then emits api-route-changed",
    async (event) => {
      const order: string[] = [];
      mockApiInvalidateFile.mockImplementation(async () => {
        order.push("invalidate");
      });
      mockEventEmit.mockImplementation((name: string) => {
        if (name === "api-route-changed") order.push("emit");
      });
      const handler = getHandler(apiWatcherIndex(), event);
      await handler?.("/project/src/api/value.ts");
      expect(mockApiInvalidateFile).toHaveBeenCalledWith(
        "/project/src/api/value.ts",
      );
      expect(mockEventEmit).toHaveBeenCalledWith("api-route-changed", {
        path: "/project/src/api/value.ts",
        type: event,
      });
      expect(order).toEqual(["invalidate", "emit"]);
    },
  );

  it("does not emit api-route-changed when invalidation throws, and stays alive", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApiInvalidateFile.mockRejectedValueOnce(new Error("scan failed"));
    const handler = getHandler(apiWatcherIndex(), "change");
    await expect(handler?.("/project/src/api/value.ts")).resolves.not.toThrow();
    expect(mockEventEmit).not.toHaveBeenCalledWith(
      "api-route-changed",
      expect.anything(),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[bascik] watch error:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chokidar 6 contract
// ─────────────────────────────────────────────────────────────────────────────

// WHY: chokidar 6 reports add() failures (EACCES on a watched directory,
// EMFILE) as `error` events, and Node's EventEmitter throws an `error` event
// that has no listener, so one unreadable folder in a watched tree crashed
// `bascik dev`. Chokidar 6 also validates options in its constructor and
// renamed `interval`/`binaryInterval`; these cases pin both.
describe("watchFiles – chokidar 6 contract", () => {
  const withEveryWatcher = async (run: () => Promise<void>): Promise<void> => {
    const previousVitest = process.env.VITEST;
    // The config-file watcher is skipped under Vitest; include it here.
    delete process.env.VITEST;
    mockExistsSync.mockImplementation(() => true);
    BascikConfig.pipeline.watchPaths = ["content/*.md"];
    try {
      await run();
    } finally {
      process.env.VITEST = previousVitest;
    }
  };

  it("registers an error listener on every dev watcher", async () => {
    await withEveryWatcher(async () => {
      await watchFiles();
      // pages assets, pages html, components, watchPaths, import root, api, config
      expect(mockWatch).toHaveBeenCalledTimes(7);
      for (let i = 0; i < mockWatch.mock.calls.length; i++) {
        expect(
          getHandler(i, "error"),
          `watcher ${i} (${JSON.stringify(mockWatch.mock.calls[i][0])})`,
        ).toBeTypeOf("function");
      }
    });
  });

  it("logs a watcher error after boot instead of throwing, on every watcher", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withEveryWatcher(async () => {
        await watchFiles();
        for (let i = 0; i < mockWatch.mock.calls.length; i++) {
          errorSpy.mockClear();
          const failure = Object.assign(
            new Error("EACCES: permission denied"),
            {
              code: "EACCES",
            },
          );
          expect(() => getHandler(i, "error")?.(failure)).not.toThrow();
          expect(errorSpy).toHaveBeenCalledWith(
            "[bascik] watch error:",
            failure,
          );
        }
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects boot when the page watcher fails before it is ready", async () => {
    const failure = new Error("EACCES: permission denied, scandir");
    mockWatch.mockImplementation(() => {
      const handlers = new Map<string, (...args: any[]) => any>();
      const watcher = {
        on: vi.fn((event: string, handler: (...args: any[]) => any) => {
          handlers.set(event, handler);
          // The html watcher fails during its initial scan instead of
          // becoming ready.
          if (event === "error") queueMicrotask(() => handler(failure));
          return watcher;
        }),
      };
      return watcher;
    });
    await expect(watchFiles()).rejects.toBe(failure);
  });

  it("passes chokidar 6 option validation and uses no deprecated alias", async () => {
    const { FSWatcher } =
      await vi.importActual<typeof import("chokidar")>("chokidar");
    await withEveryWatcher(async () => {
      await watchFiles();
      for (const [, options] of mockWatch.mock.calls) {
        for (const deprecated of ["usePolling", "interval", "binaryInterval"])
          expect(options).not.toHaveProperty(deprecated);
        expect(options).not.toMatchObject({ backend: "polling" });
        // The constructor throws TypeError on invalid options; it does not
        // touch the filesystem until add().
        const real = new FSWatcher(
          options as ConstructorParameters<typeof FSWatcher>[0],
        );
        expect(real.options.backend).toBe("auto");
        await real.close();
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full rebuilds are coalesced
// ─────────────────────────────────────────────────────────────────────────────

// Adding 300 pages at once used to start 300 overlapping full rebuilds of a
// 2,000-page site: the dev server ran out of file handles (EMFILE), then out
// of memory. Every watcher event that rebuilds every page now shares one
// running rebuild and at most one rebuild queued behind it.
describe("watchFiles – full rebuilds are coalesced", () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  let finishers: Array<(error?: Error) => void>;

  beforeEach(async () => {
    await watchFiles();
    finishers = [];
    mockProcessAllPages.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          finishers.push((error) => (error ? reject(error) : resolve()));
        }),
    );
  });

  const finishRunning = async (error?: Error): Promise<void> => {
    finishers.shift()?.(error);
    await settle();
  };

  it("runs one rebuild and one trailing rebuild for a burst of page adds", async () => {
    const add = getHandler(1, "add")!;
    for (let i = 0; i < 300; i++) add(`/project/src/pages/bulk/p${i}.html`);
    await settle();
    expect(processAllPages).toHaveBeenCalledTimes(1);

    await finishRunning();
    expect(processAllPages).toHaveBeenCalledTimes(2);

    await finishRunning();
    expect(processAllPages).toHaveBeenCalledTimes(2);
    expect(finishers).toHaveLength(0);
  });

  it("removes every deleted page but rebuilds all pages at most twice for a burst of unlinks", async () => {
    const unlink = getHandler(1, "unlink")!;
    for (let i = 0; i < 100; i++) unlink(`/project/src/pages/bulk/p${i}.html`);
    await settle();
    expect(removePage).toHaveBeenCalledTimes(100);
    expect(processAllPages).toHaveBeenCalledTimes(1);

    await finishRunning();
    await finishRunning();
    expect(processAllPages).toHaveBeenCalledTimes(2);
    expect(finishers).toHaveLength(0);
  });

  it("shares one trailing rebuild between page, component and inline stylesheet events", async () => {
    mockIsInlineStylesheet.mockReturnValue(true);
    try {
      const pending = [
        getHandler(2, "add")!("/project/src/components/new-card.html"),
        getHandler(0, "add")!("/project/src/pages/inline.css"),
        getHandler(0, "change")!("/project/src/pages/inline.css"),
        getHandler(0, "unlink")!("/project/src/pages/inline.css"),
        getHandler(1, "add")!("/project/src/pages/new.html"),
        getHandler(1, "unlink")!("/project/src/pages/old.html"),
        getHandler(2, "add")!("/project/src/components/other.html"),
      ];
      await settle();
      expect(processAllPages).toHaveBeenCalledTimes(1);

      await finishRunning();
      expect(processAllPages).toHaveBeenCalledTimes(2);
      await finishRunning();
      await Promise.all(pending);
      expect(processAllPages).toHaveBeenCalledTimes(2);
    } finally {
      mockIsInlineStylesheet.mockReset().mockReturnValue(false);
    }
  });

  it("starts another rebuild for an add that arrives once the trailing rebuild is running", async () => {
    const add = getHandler(1, "add")!;
    add("/project/src/pages/a.html");
    add("/project/src/pages/b.html");
    await finishRunning();
    expect(processAllPages).toHaveBeenCalledTimes(2);

    // The trailing rebuild listed the pages before c.html existed.
    add("/project/src/pages/c.html");
    await settle();
    expect(processAllPages).toHaveBeenCalledTimes(2);
    await finishRunning();
    expect(processAllPages).toHaveBeenCalledTimes(3);
    await finishRunning();
    expect(finishers).toHaveLength(0);
  });

  it("waits for a component add's rebuild to cover it before its handler settles", async () => {
    const add = getHandler(2, "add")!;
    void add("/project/src/components/first.html");
    let secondDone = false;
    const second = Promise.resolve(
      add("/project/src/components/second.html"),
    ).then(() => (secondDone = true));
    await finishRunning();
    // The first rebuild may have read the component list before second.html.
    expect(secondDone).toBe(false);
    await finishRunning();
    await second;
    expect(secondDone).toBe(true);
  });

  it("logs a failed rebuild once and still runs the trailing rebuild", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const add = getHandler(1, "add")!;
      for (let i = 0; i < 20; i++) add(`/project/src/pages/p${i}.html`);
      await settle();
      await finishRunning(new Error("compile failed"));
      expect(
        errorSpy.mock.calls.filter((c) =>
          String(c[1]).includes("compile failed"),
        ),
      ).toHaveLength(1);
      expect(processAllPages).toHaveBeenCalledTimes(2);
      await finishRunning();

      // A later event starts a fresh rebuild.
      add("/project/src/pages/later.html");
      await settle();
      expect(processAllPages).toHaveBeenCalledTimes(3);
      await finishRunning();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
