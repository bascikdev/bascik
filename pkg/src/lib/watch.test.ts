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
  mockDeleteDistDir,
  mockDeleteDistFile,
  mockIsInlineStylesheet,
  mockEventEmit,
} = vi.hoisted(() => {
  const watchers: { on: ReturnType<typeof vi.fn> }[] = [];
  const mockPageProcessing = vi.fn().mockResolvedValue(undefined);
  const mockProcessAllPages = vi.fn().mockResolvedValue(undefined);
  const mockRemovePage = vi.fn().mockResolvedValue(undefined);
  const mockSelectivelyProcessPages = vi.fn().mockResolvedValue(undefined);
  const mockSelectivelyProcessPagesForWatchPath = vi.fn().mockResolvedValue(undefined);
  const mockCopyReplicatePath = vi.fn().mockResolvedValue(undefined);
  const mockCopyStaticAssets = vi.fn().mockResolvedValue(undefined);
  const mockDeleteDistDir = vi.fn().mockResolvedValue(undefined);
  const mockDeleteDistFile = vi.fn().mockResolvedValue(undefined);
  const mockIsInlineStylesheet = vi.fn().mockReturnValue(false);
  const mockEventEmit = vi.fn();
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
    mockDeleteDistDir.mockReset().mockResolvedValue(undefined);
    mockDeleteDistFile.mockReset().mockResolvedValue(undefined);
    mockEventEmit.mockReset();
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
    mockDeleteDistDir,
    mockDeleteDistFile,
    mockIsInlineStylesheet,
    mockEventEmit,
  };
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("chokidar", () => ({
  default: { watch: mockWatch },
}));

vi.mock("./processing.js", () => ({
  pageProcessing: mockPageProcessing,
  processAllPages: mockProcessAllPages,
  removePage: mockRemovePage,
  selectivelyProcessPages: mockSelectivelyProcessPages,
  selectivelyProcessPagesForWatchPath: mockSelectivelyProcessPagesForWatchPath,
}));

vi.mock("./file-system.js", () => ({
  copyReplicatePath: mockCopyReplicatePath,
  copyStaticAssets: mockCopyStaticAssets,
  deleteDistDir: mockDeleteDistDir,
  deleteDistFile: mockDeleteDistFile,
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

vi.mock("./mime.js", () => ({
  MIME_MAP: new Map([
    [".css", "text/css"],
    [".js", "application/javascript"],
  ]),
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
  removePage,
  selectivelyProcessPages,
  selectivelyProcessPagesForWatchPath,
} from "./processing.ts";
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

describe("watchFiles – watcher setup", () => {
  it("calls chokidar.watch three times", async () => {
    await watchFiles();
    expect(mockWatch).toHaveBeenCalledTimes(3);
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

  it("watcher 0: returns true for .ts and test files or files with an unknown extension", () => {
    const ignored = mockWatch.mock.calls[0][1].ignored as (
      p: string,
      s?: { isFile: () => boolean },
    ) => boolean;
    expect(ignored("/path/to/file.txt", { isFile: () => true })).toBe(true);
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

  it("creates a fourth watcher when watch paths are set", () => {
    expect(mockWatch).toHaveBeenCalledTimes(4);
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
    expect(mockWatch).toHaveBeenCalledTimes(4);
  });

  it("watches BascikConfig.assets.inlineStyles paths", () => {
    expect(mockWatch.mock.calls[3][0]).toEqual(["src/css/inlined.css"]);
  });

  it("calls processAllPages on 'add'", async () => {
    const handler = getHandler(3, "add");
    mockProcessAllPages.mockClear();
    await handler?.();
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });

  it("calls processAllPages on 'change'", async () => {
    const handler = getHandler(3, "change");
    mockProcessAllPages.mockClear();
    await handler?.();
    expect(processAllPages).toHaveBeenCalledTimes(1);
  });

  it("calls processAllPages on 'unlink'", async () => {
    const handler = getHandler(3, "unlink");
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

