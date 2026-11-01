import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  run: vi.fn(),
  batch: vi.fn(),
  all: vi.fn(),
  remove: vi.fn(),
  deps: vi.fn(),
  components: vi.fn(),
  planPages: vi.fn(),
  buildScripts: vi.fn(),
  importers: vi.fn(),
  clear: vi.fn(),
  copy: vi.fn(),
  invalidateComponents: vi.fn(),
  shutdown: [] as (() => Promise<void>)[],
  config: {
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    pipeline: {
      watchPaths: ["content/*.md"],
      exec: [{ script: "scripts/pre.ts", watch: ["content/*.md"] }],
    },
  },
}));
vi.mock("chokidar", () => ({ default: { watch: mocks.watch } }));
vi.mock("./config.ts", () => ({ BascikConfig: mocks.config }));
vi.mock("./events.ts", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    eventEmitter: new EventEmitter(),
    registerShutdownHandler: (fn: () => Promise<void>) =>
      mocks.shutdown.push(fn),
  };
});
vi.mock("./exec.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec.ts")>()),
  runScript: mocks.run,
}));
vi.mock("./processing.ts", () => ({
  processAllPages: mocks.all,
  processPageBatch: mocks.batch,
  removePage: mocks.remove,
}));
vi.mock("./mem.ts", () => ({
  mem: {
    pagesDependentOnFile: mocks.deps,
    pagesThisComponentIsUsedOn: mocks.components,
    pagesWithServerScriptPlan: mocks.planPages,
  },
}));
vi.mock("./components.ts", () => ({
  invalidateComponentListCache: mocks.invalidateComponents,
  componentsImportingStylesheet: mocks.importers,
  componentsHaveBuildScripts: mocks.buildScripts,
}));
vi.mock("./build-scripts.ts", () => ({ clearBuildScriptCaches: mocks.clear }));
vi.mock("./file-system.ts", () => ({
  copyStaticAssets: mocks.copy,
  copyReplicatePath: mocks.copy,
  deleteDistFile: mocks.remove,
  deleteDistDir: mocks.remove,
}));
vi.mock("./asset-filter.ts", () => ({
  isInlineStylesheet: () => false,
  isStaticAssetPath: () => false,
}));

import { watchSourceCycles } from "./watch-source.ts";
import { eventEmitter } from "./events.ts";

let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of [
    mocks.run,
    mocks.batch,
    mocks.all,
    mocks.remove,
    mocks.copy,
  ])
    mock.mockReset().mockResolvedValue(undefined);
  mocks.clear.mockReset();
  mocks.invalidateComponents.mockReset();
  mocks.deps.mockReset().mockReturnValue(["src/pages/consumer.html"]);
  mocks.components.mockReset().mockReturnValue([]);
  mocks.planPages.mockReset().mockReturnValue([]);
  mocks.buildScripts.mockReset().mockReturnValue(false);
  mocks.importers.mockReset().mockReturnValue([]);
  mocks.config.pipeline.watchPaths = ["content/*.md"];
  mocks.config.pipeline.exec = [
    { script: "scripts/pre.ts", watch: ["content/*.md"] },
  ];
  watcher = Object.assign(new EventEmitter(), {
    close: vi.fn().mockResolvedValue(undefined),
  });
  mocks.watch.mockReset().mockImplementation(() => {
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  });
});
afterEach(async () => {
  for (const close of mocks.shutdown.splice(0)) await close();
  eventEmitter.removeAllListeners();
  vi.useRealTimers();
});

describe("source observer and phase queue integration", () => {
  it("deduplicates a directly edited page also found under a relative dependency alias", async () => {
    mocks.deps.mockReturnValue(["src/pages/index.html"]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    watcher.emit("all", "change", "src/pages/index.html");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/index.html"),
    ]);
  });
  it("watches glob roots once, filters nonmatches and output writes, and compiles one associated batch", async () => {
    const pre = Promise.withResolvers<void>();
    mocks.run.mockReturnValueOnce(pre.promise);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    const [roots, options] = mocks.watch.mock.calls[0];
    expect(roots.filter((root: string) => root === "content")).toHaveLength(1);
    expect(options.ignored(resolve("dist/generated.json"))).toBe(true);
    watcher.emit("all", "change", "content/ignored.txt");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.run).not.toHaveBeenCalled();
    watcher.emit("all", "change", "content/doc.md");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.batch).not.toHaveBeenCalled();
    pre.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/consumer.html"),
    ]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("a root-level glob does not watch node_modules, .git or the output (F187)", async () => {
    mocks.config.pipeline.watchPaths = ["**/*.md"];
    mocks.config.pipeline.exec = [
      { script: "scripts/pre.ts", watch: ["*.json"] },
    ];
    await watchSourceCycles(vi.fn());
    const [roots, options] = mocks.watch.mock.calls[0];
    expect(roots).toContain(".");
    for (const ignored of [
      "node_modules",
      "node_modules/pkg/README.md",
      ".git",
      ".git/HEAD",
      "src/pages/node_modules/x/a.md",
      "dist/notes.md",
      ".bascik/dist/server-scripts.json",
    ])
      expect(options.ignored(resolve(ignored)), ignored).toBe(true);
    for (const watched of ["README.md", "content/doc.md", "package.json"])
      expect(options.ignored(resolve(watched)), watched).toBe(false);
  });

  it("an explicit watch root inside node_modules is still watched", async () => {
    mocks.config.pipeline.watchPaths = [
      "**/*.css",
      "node_modules/@milk/frother-ui/dist",
    ];
    mocks.config.pipeline.exec = [];
    await watchSourceCycles(vi.fn());
    const [, options] = mocks.watch.mock.calls[0];
    expect(
      options.ignored(resolve("node_modules/@milk/frother-ui/dist/a.css")),
    ).toBe(false);
    expect(options.ignored(resolve("node_modules/other/a.css"))).toBe(true);
    expect(
      options.ignored(
        resolve("node_modules/@milk/frother-ui/dist/node_modules/x/a.css"),
      ),
    ).toBe(true);
  });

  it("exec-only source changes rebuild dependents and edits during boot are retained", async () => {
    mocks.config.pipeline.watchPaths = [];
    await watchSourceCycles(vi.fn());
    watcher.emit("all", "change", "content/doc.md");
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.run).not.toHaveBeenCalled();
    eventEmitter.emit("boot-done");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/consumer.html"),
    ]);
  });

  it("page edits do not rerun unmatched scripts and unknown source dependencies fall back to pages", async () => {
    mocks.deps.mockReturnValue([]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.all.mockClear();
    watcher.emit("all", "change", "src/pages/index.html");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/index.html"),
    ]);
    watcher.emit("all", "change", "content/doc.md");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.all).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the pages of components whose stylesheets import an edited partial", async () => {
    mocks.deps.mockReturnValue([]);
    const partial = resolve("src/components/shared/tokens.css");
    mocks.importers.mockImplementation((path: string) =>
      path === partial ? ["my-card"] : [],
    );
    mocks.components.mockImplementation((name: string) =>
      name === "my-card" ? ["src/pages/a.html", "src/pages/b.html"] : [],
    );
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.all.mockClear();
    watcher.emit("all", "change", "src/components/shared/tokens.css");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.importers).toHaveBeenCalledWith(partial);
    expect(mocks.all).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/a.html"),
      resolve("src/pages/b.html"),
    ]);
  });

  it("rescans static assets after a removed page directory is recreated", async () => {
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.copy.mockClear();
    mocks.all.mockClear();

    watcher.emit("all", "unlinkDir", "src/pages/images");
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.remove).toHaveBeenCalledWith(resolve("src/pages/images"));
    expect(mocks.copy).not.toHaveBeenCalled();

    watcher.emit("all", "addDir", "src/pages/images");
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.all).toHaveBeenCalledTimes(2);
  });

  it("runs the boot compile hook only after the source watcher is ready", async () => {
    const ready = Promise.withResolvers<void>();
    mocks.watch.mockReset().mockImplementation(() => {
      queueMicrotask(() => ready.promise.then(() => watcher.emit("ready")));
      return watcher;
    });
    const bootCompile = vi.fn(
      async (compileInitialSources: () => Promise<void>) => {
        expect(mocks.copy).not.toHaveBeenCalled();
        expect(mocks.all).not.toHaveBeenCalled();
        await compileInitialSources();
      },
    );

    const watchPromise = watchSourceCycles(vi.fn(), bootCompile);

    expect(bootCompile).not.toHaveBeenCalled();
    ready.resolve();
    await watchPromise;

    expect(bootCompile).toHaveBeenCalledOnce();
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    expect(mocks.all).toHaveBeenCalledTimes(1);
  });

  it("keeps component list cache and unrelated build script memos warm on a direct page HTML edit", async () => {
    mocks.deps.mockReturnValue([]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.clear.mockClear();
    mocks.invalidateComponents.mockClear();

    const editedPage = resolve("src/pages/index.html");
    watcher.emit("all", "change", editedPage);
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.invalidateComponents).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(editedPage);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([editedPage]);
  });

  it("clears all build script caches when a matching pre producer runs before a page edit", async () => {
    mocks.deps.mockReturnValue([]);
    mocks.config.pipeline.exec = [
      { script: "scripts/pre.ts", watch: ["src/pages/*.html"] },
    ];
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.clear.mockClear();

    const editedPage = resolve("src/pages/index.html");
    watcher.emit("all", "change", editedPage);
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([editedPage]);
  });

  it("invalidates component list cache and clears per-path build script memo when a component file changes", async () => {
    mocks.deps.mockReturnValue([]);
    mocks.components.mockReturnValue(["src/pages/index.html"]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.clear.mockClear();
    mocks.invalidateComponents.mockClear();

    const editedComponent = resolve("src/components/my-card/my-card.html");
    watcher.emit("all", "change", editedComponent);
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.invalidateComponents).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(editedComponent);
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/index.html"),
    ]);
  });

  it("rebuilds every page with a server-script plan when a component input changes, or a cache clear may reach a component build script, and only then (prompt 157)", async () => {
    // /catalog uses no component in its own markup: its server script returns
    // a component tag at request time, rendered with the manifest of the
    // component list the page was stored against. A component edit (any
    // list invalidation) must re-store it with the next list, whether or
    // not a tab has it open; a direct page edit keeps the list and does not.
    mocks.deps.mockReturnValue([]);
    mocks.components.mockReturnValue(["src/pages/index.html"]);
    mocks.planPages.mockReturnValue(["src/pages/catalog.html"]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.batch.mockClear();

    watcher.emit("all", "change", resolve("src/components/card/card.html"));
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.invalidateComponents).toHaveBeenCalledOnce();
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect([...mocks.batch.mock.calls[0][0]].sort()).toEqual(
      [
        resolve("src/pages/index.html"),
        resolve("src/pages/catalog.html"),
      ].sort(),
    );

    mocks.batch.mockClear();
    mocks.invalidateComponents.mockClear();
    mocks.deps.mockReturnValue(["src/pages/about.html"]);
    watcher.emit("all", "change", resolve("src/pages/about.html"));
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.invalidateComponents).not.toHaveBeenCalled();
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/about.html"),
    ]);

    // A watched input clears the build caches, and with them the list. No
    // component has a build script, so nothing a plan page renders at
    // request time can have read it: only its dependents rebuild.
    mocks.batch.mockClear();
    mocks.deps.mockReturnValue(["src/pages/consumer.html"]);
    watcher.emit("all", "change", resolve("content/post.md"));
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.invalidateComponents).toHaveBeenCalledOnce();
    expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([
      resolve("src/pages/consumer.html"),
    ]);

    // With a component build script, which may read the input (a menu built
    // from content/menu.json) and which only the manifest build ran for a
    // component met in script output, the plan pages rebuild too (D6).
    mocks.batch.mockClear();
    mocks.invalidateComponents.mockClear();
    mocks.buildScripts.mockReturnValue(true);
    watcher.emit("all", "change", resolve("content/post.md"));
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.invalidateComponents).toHaveBeenCalledOnce();
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect([...mocks.batch.mock.calls[0][0]].sort()).toEqual(
      [
        resolve("src/pages/consumer.html"),
        resolve("src/pages/catalog.html"),
      ].sort(),
    );
  });

  it("deleting a component used only in script output rebuilds every page with a server-script plan, so the tag passes through from the next manifest (prompt 157)", async () => {
    mocks.deps.mockReturnValue([]);
    mocks.planPages.mockReturnValue(["src/pages/catalog.html"]);
    await watchSourceCycles(vi.fn());
    eventEmitter.emit("boot-done");
    mocks.batch.mockClear();

    watcher.emit("all", "unlink", resolve("src/components/card/card.html"));
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.invalidateComponents).toHaveBeenCalledOnce();
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect([...mocks.batch.mock.calls[0][0]]).toContain(
      resolve("src/pages/catalog.html"),
    );
  });
});

// WHY: chokidar 6 reports initial-scan failures (EACCES on a watched folder)
// as `error` events, and an `error` event with no listener throws. A `once`
// listener left the watcher bare after the first failure, so a second
// failure crashed `bascik dev` instead of reporting.
describe("source observer errors (chokidar 6)", () => {
  it("rejects boot on the first scan error and survives a second one", async () => {
    const first = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    mocks.watch.mockReset().mockImplementation(() => {
      queueMicrotask(() => {
        watcher.emit("error", first);
        watcher.emit("error", new Error("EACCES again"));
      });
      return watcher;
    });
    await expect(watchSourceCycles(vi.fn())).rejects.toBe(first);
    expect(watcher.listenerCount("error")).toBeGreaterThan(0);
    expect(() => watcher.emit("error", new Error("later"))).not.toThrow();
  });

  it("reports a watcher error after boot as a build error", async () => {
    const reported: unknown[] = [];
    eventEmitter.on("build-error", (payload) => reported.push(payload));
    await watchSourceCycles(vi.fn());
    expect(() =>
      watcher.emit("error", new Error("EMFILE: too many open files")),
    ).not.toThrow();
    expect(reported).toEqual([{ message: "EMFILE: too many open files" }]);
  });
});
