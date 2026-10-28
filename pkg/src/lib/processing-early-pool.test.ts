import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The page worker pool of a `pipeline.workers` build or dev boot starts while
 * routes are still being expanded, so worker startup and module loading
 * overlap the main thread's expansion instead of following it. These tests pin
 * when the pool is created, how it is sized, grown and trimmed, and that it is always
 * torn down, including on the unhappy paths (an expansion that fails, no
 * pages, one page, one CPU, a pool whose workers never start).
 */

const { pools, routesGate, WorkerPoolMock } = vi.hoisted(() => {
  const pools: Array<{
    size: number;
    env: Record<string, string | undefined>;
    options: { readySignal?: boolean };
    run: ReturnType<typeof vi.fn>;
    shrink: ReturnType<typeof vi.fn>;
    grow: ReturnType<typeof vi.fn>;
    configure: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    createdBeforeRoutesSettled: boolean;
  }> = [];
  const routesGate = { settled: true };
  const WorkerPoolMock = vi.fn(function (
    this: any,
    _script: string,
    size: number,
    _init: unknown,
    options: { env: Record<string, string | undefined>; readySignal?: boolean },
  ) {
    this.size = size;
    this.env = options.env;
    this.options = options;
    this.createdBeforeRoutesSettled = !routesGate.settled;
    this.run = vi.fn(async (job: any) => ({
      relativePagePath: job.relativePagePath,
      absolutePagePath: job.pagePath,
      distHtmlBytes: new TextEncoder().encode("<html></html>"),
      usedComponentsNames: [],
      fileDependencies: [],
    }));
    this.shrink = vi.fn(async (next: number) => {
      this.size = Math.min(this.size, next);
    });
    this.grow = vi.fn((next: number) => {
      this.size = Math.max(this.size, next);
    });
    this.configure = vi.fn();
    this.terminate = vi.fn(async () => {});
    pools.push(this);
  });
  return { pools, routesGate, WorkerPoolMock };
});

vi.mock("./worker-pool.js", () => ({ WorkerPool: WorkerPoolMock }));

vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => true),
  BascikConfig: {
    base: "/",
    isBuild: true,
    scoping: {
      scriptBlocks: false,
      inheritAttributes: true,
      attributes: { class: false, id: false, name: false },
      deduplicateCss: true,
      preserve: [],
    },
    minify: { html: false, css: false, js: false, identifiers: false },
    assets: { inlineStyles: false, exclude: [] },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    pipeline: { watchPaths: [], workers: true },
    logging: {
      level: "info",
      requests: true,
      copies: true,
      deletes: true,
      transpiles: true,
    },
  },
}));

vi.mock("./file-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./file-system.ts")>()),
  listPages: vi.fn(),
  deleteDistFile: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(async () => "<html><body>page</body></html>"),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));

vi.mock("./routes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./routes.ts")>()),
  executeRoutesScript: vi.fn(),
}));

vi.mock("./sitemap.js", () => ({
  generateSitemapFiles: vi.fn(async () => {}),
}));

vi.mock("./components.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components.ts")>()),
  listComponents: vi.fn(async () => ({})),
  invalidateComponentListCache: vi.fn(),
}));

vi.mock("./script-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./script-runner.ts")>()),
  SYSTEM_MAX_CHILD_PROCESSES: 8,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: vi.fn(() => actual.cpus()) };
});

import { cpus } from "node:os";
import { listPages } from "./file-system.ts";
import { executeRoutesScript } from "./routes.ts";
import { processAllPages, stopPagePools } from "./processing.ts";
import { CHILD_WORKER_COUNT_VAR } from "./script-runner.ts";
import {
  CHILD_WORKER_COUNT_MESSAGE,
  PAGE_WORKER_INIT_MESSAGE,
} from "./page-worker-messages.ts";
import { listComponents } from "./components.ts";

const fakeCpus = (count: number) =>
  vi
    .mocked(cpus)
    .mockReturnValue(Array.from({ length: count }, () => ({}) as never));

const staticPages = (count: number) =>
  Array.from({ length: count }, (_, i) => `src/pages/page-${i}.html`);

/** A routes script that settles only when the returned function is called. */
const holdRoutes = (routes: string[] | Error) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  routesGate.settled = false;
  vi.mocked(executeRoutesScript).mockImplementation(async () => {
    await released;
    routesGate.settled = true;
    if (routes instanceof Error) throw routes;
    return {
      cleanedHtml: "<html><body>route</body></html>",
      routes: routes.map((slug) => ({ params: { slug } })),
    } as never;
  });
  return release;
};

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  pools.length = 0;
  WorkerPoolMock.mockClear();
  routesGate.settled = true;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fakeCpus(8);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processAllPages – early page worker pool", () => {
  it("creates the pool once the page list is known, before the component list has loaded", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(3));
    let loadComponents!: (list: object) => void;
    vi.mocked(listComponents).mockImplementationOnce(
      () => new Promise((resolve) => (loadComponents = resolve as never)),
    );
    const build = processAllPages();
    await flush();
    expect(pools).toHaveLength(1);
    // The compile inputs are not known yet, so the workers wait for them.
    expect(pools[0].configure).not.toHaveBeenCalled();
    const componentList = { card: { path: "src/components/card.html" } };
    loadComponents(componentList);
    await build;
    expect(pools[0].configure).toHaveBeenCalledWith({
      kind: PAGE_WORKER_INIT_MESSAGE,
      componentList,
      globalStylesHtml: expect.any(String),
    });
    // Sent before the first page, so no worker compiles without components.
    expect(pools[0].configure.mock.invocationCallOrder[0]).toBeLessThan(
      pools[0].run.mock.invocationCallOrder[0],
    );
  });

  it("terminates the pool when the component list fails to load after the pool started", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(3));
    let failComponents!: (error: Error) => void;
    vi.mocked(listComponents).mockImplementationOnce(
      () => new Promise((_, reject) => (failComponents = reject)),
    );
    const build = processAllPages();
    await flush();
    expect(pools).toHaveLength(1);
    failComponents(new Error("bad component"));
    await expect(build).rejects.toThrow("bad component");
    expect(pools[0].run).not.toHaveBeenCalled();
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("terminates the pool when the component list fails before the page list is known", async () => {
    let listed!: (pages: string[]) => void;
    vi.mocked(listPages).mockImplementationOnce(
      () => new Promise((resolve) => (listed = resolve as never)),
    );
    vi.mocked(listComponents).mockRejectedValueOnce(new Error("bad component"));
    const build = processAllPages();
    let settled = false;
    void build.catch(() => (settled = true));
    await flush();
    // The build must not report the failure while a pool may still appear.
    expect(settled).toBe(false);
    listed(staticPages(3));
    await expect(build).rejects.toThrow("bad component");
    expect(pools).toHaveLength(1);
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("creates the pool before route expansion has finished", async () => {
    vi.mocked(listPages).mockResolvedValue([
      ...staticPages(3),
      "src/pages/blog/[slug].html",
    ]);
    const release = holdRoutes(["a", "b", "c", "d", "e"]);
    const build = processAllPages();
    await flush();
    // Expansion is still blocked on the routes script, yet the workers exist.
    expect(pools).toHaveLength(1);
    expect(pools[0].createdBeforeRoutesSettled).toBe(true);
    expect(pools[0].run).not.toHaveBeenCalled();
    release();
    await build;
    expect(pools[0].run).toHaveBeenCalledTimes(8);
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("starts no more workers than pages even with a dynamic route, then grows to the jobs", async () => {
    // A dynamic route can expand to any number of jobs, but starting one
    // worker per CPU for it would load the compiler in threads a small site
    // never uses (and that cannot be stopped until they have loaded).
    vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
    const release = holdRoutes(["a", "b", "c", "d", "e"]);
    const build = processAllPages();
    await flush();
    expect(pools[0].size).toBe(1);
    expect(pools[0].env[CHILD_WORKER_COUNT_VAR]).toBe("1");
    release();
    await build;
    expect(pools[0].grow).toHaveBeenCalledWith(5);
    expect(pools[0].shrink).not.toHaveBeenCalled();
    // The workers re-divide the child budget for five workers, not one.
    expect(pools[0].configure).toHaveBeenCalledWith({
      kind: CHILD_WORKER_COUNT_MESSAGE,
      workerCount: 5,
    });
    // Grown before the first job was handed out.
    expect(pools[0].grow.mock.invocationCallOrder[0]).toBeLessThan(
      pools[0].run.mock.invocationCallOrder[0],
    );
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("starts one worker per page for a small dynamic site and never grows past the CPUs", async () => {
    vi.mocked(listPages).mockResolvedValue([
      "src/pages/index.html",
      "src/pages/blog/[slug].html",
    ]);
    const release = holdRoutes(Array.from({ length: 40 }, (_, i) => `p${i}`));
    const build = processAllPages();
    await flush();
    expect(pools[0].size).toBe(2);
    release();
    await build;
    expect(pools[0].grow).toHaveBeenCalledWith(8);
    expect(pools[0].shrink).not.toHaveBeenCalled();
  });

  it("does not resize a small dynamic site whose jobs match its pages", async () => {
    vi.mocked(listPages).mockResolvedValue([
      "src/pages/index.html",
      "src/pages/blog/[slug].html",
    ]);
    holdRoutes(["only"])();
    await processAllPages();
    expect(pools[0].size).toBe(2);
    expect(pools[0].grow).not.toHaveBeenCalled();
    expect(pools[0].shrink).not.toHaveBeenCalled();
    expect(pools[0].configure).toHaveBeenCalledOnce();
  });

  it("trims to the jobs when a dynamic route yields fewer jobs than pages", async () => {
    vi.mocked(listPages).mockResolvedValue([
      ...staticPages(2),
      "src/pages/blog/[slug].html",
    ]);
    holdRoutes([])();
    await processAllPages();
    expect(pools[0].shrink).toHaveBeenCalledWith(2);
    expect(pools[0].configure).toHaveBeenCalledWith({
      kind: CHILD_WORKER_COUNT_MESSAGE,
      workerCount: 2,
    });
    expect(pools[0].shrink.mock.invocationCallOrder[0]).toBeLessThan(
      pools[0].run.mock.invocationCallOrder[0],
    );
  });

  it("caps a many-page dynamic site at the CPUs from the start", async () => {
    vi.mocked(listPages).mockResolvedValue([
      ...staticPages(11),
      "src/pages/blog/[slug].html",
    ]);
    holdRoutes(["a", "b"])();
    await processAllPages();
    expect(WorkerPoolMock.mock.calls[0][1]).toBe(8);
    expect(pools[0].grow).not.toHaveBeenCalled();
    expect(pools[0].shrink).not.toHaveBeenCalled();
  });

  it("does not trim or reconfigure when there are at least as many jobs as workers", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(12));
    await processAllPages();
    expect(pools[0].size).toBe(8);
    expect(pools[0].shrink).not.toHaveBeenCalled();
    // Only the init message: no worker-count change for a pool that fits.
    expect(pools[0].configure).toHaveBeenCalledOnce();
    expect(pools[0].configure.mock.calls[0][0].kind).toBe(
      PAGE_WORKER_INIT_MESSAGE,
    );
  });

  it("never starts more workers than static pages when every page is static", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(3));
    await processAllPages();
    expect(WorkerPoolMock).toHaveBeenCalledTimes(1);
    expect(pools[0].size).toBe(3);
    expect(pools[0].env[CHILD_WORKER_COUNT_VAR]).toBe("3");
    expect(pools[0].shrink).not.toHaveBeenCalled();
  });

  it("starts one worker for a single-page site", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(1));
    const paths = await processAllPages();
    expect(paths).toEqual(["pages/page-0.html"]);
    expect(pools[0].size).toBe(1);
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("starts no pool for a site with zero pages", async () => {
    vi.mocked(listPages).mockResolvedValue([]);
    await expect(processAllPages()).resolves.toEqual([]);
    expect(WorkerPoolMock).not.toHaveBeenCalled();
  });

  it("uses one worker on a machine reporting one CPU, and still one when it reports none", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(5));
    fakeCpus(1);
    await processAllPages();
    expect(pools[0].size).toBe(1);
    // os.cpus() can be empty (some containers and platforms); a pool of zero
    // workers would never run a job and the build would hang.
    fakeCpus(0);
    await processAllPages();
    expect(pools[1].size).toBe(1);
  });

  it("terminates the early pool when expansion yields no jobs", async () => {
    vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
    const release = holdRoutes([]);
    const build = processAllPages();
    await flush();
    expect(pools).toHaveLength(1);
    release();
    await expect(build).resolves.toEqual([]);
    expect(pools[0].run).not.toHaveBeenCalled();
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("terminates the early pool and reports the page when expansion fails", async () => {
    vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
    const release = holdRoutes(new Error("routes exploded"));
    const build = processAllPages();
    await flush();
    release();
    await expect(build).rejects.toThrow(/blog\/\[slug\]\.html/);
    await expect(build).rejects.toThrow(/routes exploded/);
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("terminates the early pool when one page fails expansion and the rest compile", async () => {
    vi.mocked(listPages).mockResolvedValue([
      ...staticPages(2),
      "src/pages/blog/[slug].html",
    ]);
    const release = holdRoutes(new Error("routes exploded"));
    const build = processAllPages();
    await flush();
    release();
    await expect(build).rejects.toThrow(/routes exploded/);
    expect(pools[0].shrink).toHaveBeenCalledWith(2);
    expect(pools[0].run).toHaveBeenCalledTimes(2);
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("reports every page and terminates once when the workers never start", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(3));
    WorkerPoolMock.mockImplementationOnce(function (this: any, ...args) {
      WorkerPoolMock.getMockImplementation()!.apply(this, args as never);
      this.run = vi.fn(async () => {
        throw new Error(
          "WorkerPool has no viable workers: worker startup failed repeatedly; check the worker module",
        );
      });
    });
    await expect(processAllPages()).rejects.toThrow(
      /Build failed with 3 page errors/,
    );
    expect(pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("asks the pool to wait for each worker to load before stopping it", async () => {
    // Trimming and failure paths can now stop workers that are still loading
    // the compiler, which can abort the process on Node 24.
    vi.mocked(listPages).mockResolvedValue(staticPages(2));
    await processAllPages();
    expect(pools[0].options.readySignal).toBe(true);
  });

  // Cleanup must never mask the failure that made the build stop.
  describe("when stopping the pool itself fails", () => {
    const failingTerminate = () =>
      WorkerPoolMock.mockImplementationOnce(function (this: any, ...args) {
        WorkerPoolMock.getMockImplementation()!.apply(this, args as never);
        this.terminate = vi.fn(async () => {
          throw new Error("terminate failed");
        });
      });

    it("still reports the component-load failure", async () => {
      failingTerminate();
      vi.mocked(listPages).mockResolvedValue(staticPages(2));
      vi.mocked(listComponents).mockRejectedValueOnce(
        new Error("bad component"),
      );
      await expect(processAllPages()).rejects.toThrow("bad component");
      expect(pools[0].terminate).toHaveBeenCalledOnce();
    });

    it("still reports the expansion failure", async () => {
      failingTerminate();
      vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
      holdRoutes(new Error("routes exploded"))();
      await expect(processAllPages()).rejects.toThrow(/routes exploded/);
      expect(pools[0].terminate).toHaveBeenCalledOnce();
    });

    it("still finishes a build that found no jobs", async () => {
      failingTerminate();
      vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
      holdRoutes([])();
      await expect(processAllPages()).resolves.toEqual([]);
      expect(pools[0].terminate).toHaveBeenCalledOnce();
    });

    it("still returns the compiled pages", async () => {
      failingTerminate();
      vi.mocked(listPages).mockResolvedValue(staticPages(2));
      await expect(processAllPages()).resolves.toHaveLength(2);
      expect(pools[0].terminate).toHaveBeenCalledOnce();
    });
  });

  // A build runs page processing next to the static asset copy; when the copy
  // fails first the CLI exits at once, and a worker still loading the
  // compiler at that moment can abort Node 24. The caller stops the pools
  // (which waits for each worker to load) before it lets the failure out.
  describe("stopPagePools", () => {
    it("stops a pool whose phase is still expanding routes", async () => {
      vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
      const release = holdRoutes(["a"]);
      const build = processAllPages();
      void build.catch(() => {});
      await flush();
      await stopPagePools();
      expect(pools[0].terminate).toHaveBeenCalledOnce();
      release();
      await build.catch(() => {});
    });

    it("waits for a pool that has not started yet because the page list is still loading", async () => {
      let listed!: (pages: string[]) => void;
      vi.mocked(listPages).mockImplementationOnce(
        () => new Promise((resolve) => (listed = resolve as never)),
      );
      const build = processAllPages();
      void build.catch(() => {});
      let stopped = false;
      const stopping = stopPagePools().then(() => (stopped = true));
      await flush();
      expect(stopped).toBe(false);
      listed(staticPages(2));
      await stopping;
      expect(pools[0].terminate).toHaveBeenCalled();
      await build.catch(() => {});
    });

    it("does nothing once the phase has stopped its own pool", async () => {
      vi.mocked(listPages).mockResolvedValue(staticPages(2));
      await processAllPages();
      await stopPagePools();
      expect(pools[0].terminate).toHaveBeenCalledOnce();
    });

    it("never rejects, even when stopping a pool fails", async () => {
      vi.mocked(listPages).mockResolvedValue(["src/pages/blog/[slug].html"]);
      const release = holdRoutes(["a"]);
      WorkerPoolMock.mockImplementationOnce(function (this: any, ...args) {
        WorkerPoolMock.getMockImplementation()!.apply(this, args as never);
        this.terminate = vi.fn(async () => {
          throw new Error("terminate failed");
        });
      });
      const build = processAllPages();
      void build.catch(() => {});
      await flush();
      await expect(stopPagePools()).resolves.toBeUndefined();
      release();
      await build.catch(() => {});
    });
  });

  it("does not start a pool when workers are off", async () => {
    vi.mocked(listPages).mockResolvedValue(staticPages(3));
    await processAllPages({ useWorkers: false });
    expect(WorkerPoolMock).not.toHaveBeenCalled();
  });
});
