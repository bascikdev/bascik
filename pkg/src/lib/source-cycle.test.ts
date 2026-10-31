import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createSourceCycle } from "./source-cycle.ts";
import { BuildScriptError } from "./build-error.ts";

const gate = () => Promise.withResolvers<void>();
afterEach(() => vi.useRealTimers());

const assertNoListenerLeak = (
  target: EventEmitter,
  expectedBaseline: ReturnType<EventEmitter["rawListeners"]>,
) => {
  expect(target.rawListeners("build-error")).toEqual(expectedBaseline);
};

describe("source-owned phase cycles", () => {
  it("retains earlier page reloads when another source edit arrives during compilation", async () => {
    vi.useFakeTimers();
    const first = gate();
    const emitter = new EventEmitter();
    const reload = vi.fn();
    emitter.on("transpiled", reload);
    let count = 0;
    const cycle = createSourceCycle({
      entries: [],
      run: vi.fn(),
      emitter,
      compile: async (_paths, publish) => {
        publish("transpiled", { relativePagePath: `${++count}.html` });
        if (count === 1) await first.promise;
      },
    });
    cycle.enqueue("src/pages/a.html");
    await vi.advanceTimersByTimeAsync(50);
    cycle.enqueue("src/pages/b.html");
    first.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(reload.mock.calls).toEqual([
      [{ relativePagePath: "1.html" }],
      [{ relativePagePath: "2.html" }],
    ]);
    cycle.close();
  });

  it("reports a located build-error when compilation fails inside a component build script", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const errors: unknown[] = [];
    emitter.on("build-error", (payload) => errors.push(payload));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new BuildScriptError(
      '[bascik] build script error in "components/x.html" at (line 4, column 7):\nboom',
      {
        sourceFile: "components/x.html",
        line: 4,
        column: 7,
      },
    );
    const cycle = createSourceCycle({
      entries: [],
      run: vi.fn(),
      emitter,
      // The compile scope wraps what the work threw, so the cycle sees an AggregateError.
      compile: async () => {
        throw new AggregateError([failure], "wrapped");
      },
    });
    cycle.enqueue("src/components/x.html");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: "components/x.html",
      line: 4,
      column: 7,
    });
    cycle.close();
    consoleError.mockRestore();
  });

  it("reruns a script when its own explicitly watched source is edited", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const cycle = createSourceCycle({
      entries: [{ script: "scripts/pre.ts", watch: ["scripts/*.ts"] }],
      run,
      compile: vi.fn().mockResolvedValue(undefined),
      emitter: new EventEmitter(),
    });
    cycle.enqueue("scripts/pre.ts");
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    cycle.close();
  });
  it("coalesces overlap, awaits pre, starts parallel alongside compile, then post", async () => {
    vi.useFakeTimers();
    const pre = gate();
    const parallel = gate();
    const order: string[] = [];
    const compile = vi.fn(async () => {
      order.push("compile");
    });
    const cycle = createSourceCycle({
      entries: [
        { script: "pre.ts", watch: ["content/"] },
        { script: "parallel.ts", phase: "parallel", watch: ["content/"] },
        { script: "post.ts", phase: "post", watch: ["content/"] },
        { script: "unmatched.ts", watch: ["other/"] },
      ],
      run: async (entry) => {
        order.push(entry.script);
        if (entry.script === "pre.ts") await pre.promise;
        if (entry.script === "parallel.ts") await parallel.promise;
      },
      compile,
      emitter: new EventEmitter(),
    });
    cycle.enqueue("content/a.md");
    cycle.enqueue(`${process.cwd()}/content/a.md`);
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["pre.ts"]);
    pre.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["pre.ts", "parallel.ts", "compile", "post.ts"]);
    expect(compile).toHaveBeenCalledTimes(1);
    parallel.resolve();
    await cycle.idle();
    expect(compile).toHaveBeenCalledTimes(1);
    cycle.close();
  });

  it("retains edits during pre and compilation and retries after a failed pre", async () => {
    vi.useFakeTimers();
    const pre = gate();
    const compileGate = gate();
    const emitter = new EventEmitter();
    const errors: unknown[] = [];
    emitter.on("build-error", (error) => errors.push(error));
    const run = vi
      .fn()
      .mockImplementationOnce(() => pre.promise)
      .mockResolvedValue(undefined);
    const compile = vi
      .fn()
      .mockImplementationOnce(() => compileGate.promise)
      .mockResolvedValue(undefined);
    const cycle = createSourceCycle({
      entries: [{ script: "pre.ts", watch: ["content/"] }],
      run,
      compile,
      emitter,
    });
    cycle.enqueue("content/a.md");
    await vi.advanceTimersByTimeAsync(50);
    cycle.enqueue("content/b.md");
    pre.reject(new Error("pre failed"));
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toHaveLength(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        resolve("content/a.md"),
        resolve("content/b.md"),
      ]),
    );
    cycle.enqueue("content/c.md");
    compileGate.resolve();
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(compile).toHaveBeenCalledTimes(2);
    cycle.close();
  });

  it("does not serialize later page edits behind parallel scripts or rerun unmatched scripts", async () => {
    vi.useFakeTimers();
    const parallel = gate();
    const run = vi.fn(() => parallel.promise);
    const compile = vi.fn().mockResolvedValue(undefined);
    const cycle = createSourceCycle({
      entries: [{ script: "p.ts", phase: "parallel", watch: ["content/"] }],
      run,
      compile,
      emitter: new EventEmitter(),
    });
    cycle.enqueue("content/a.md");
    await vi.advanceTimersByTimeAsync(50);
    cycle.enqueue("src/pages/index.html");
    await vi.advanceTimersByTimeAsync(50);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    parallel.resolve();
    await cycle.idle();
    cycle.close();
  });

  it("holds success publication through post, discards it on failure, and never publishes parallel completion", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const reload = vi.fn();
    emitter.on("transpiled", reload);
    const post = gate();
    const cycle = createSourceCycle({
      entries: [{ script: "post.ts", phase: "post", watch: ["content/"] }],
      run: () => post.promise,
      compile: async (_paths, publish) => {
        publish("transpiled", { relativePagePath: "index.html" });
      },
      emitter,
    });
    cycle.enqueue("content/a.md");
    await vi.advanceTimersByTimeAsync(50);
    expect(reload).not.toHaveBeenCalled();
    post.reject(new Error("post failed"));
    await cycle.idle();
    expect(reload).not.toHaveBeenCalled();
    cycle.close();
  });

  it("emits a publication chosen by publishEarly while compilation is still running, and holds the rest", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const reload = vi.fn();
    emitter.on("transpiled", reload);
    const rest = gate();
    const cycle = createSourceCycle({
      entries: [],
      run: vi.fn(),
      emitter,
      publishEarly: (_event, payload) =>
        (payload as { relativePagePath: string }).relativePagePath ===
        "open.html",
      compile: async (_paths, publish) => {
        publish("transpiled", { relativePagePath: "open.html" });
        publish("transpiled", { relativePagePath: "other.html" });
        await rest.promise;
      },
    });
    cycle.enqueue("src/components/x.html");
    await vi.advanceTimersByTimeAsync(50);
    expect(reload.mock.calls).toEqual([[{ relativePagePath: "open.html" }]]);
    rest.resolve();
    await cycle.idle();
    expect(reload.mock.calls).toEqual([
      [{ relativePagePath: "open.html" }],
      [{ relativePagePath: "other.html" }],
    ]);
    cycle.close();
  });

  it("holds every publication through a matching post script even when publishEarly accepts it", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const reload = vi.fn();
    emitter.on("transpiled", reload);
    const post = gate();
    const cycle = createSourceCycle({
      entries: [{ script: "post.ts", phase: "post", watch: ["content/"] }],
      run: () => post.promise,
      publishEarly: () => true,
      compile: async (_paths, publish) => {
        publish("transpiled", { relativePagePath: "index.html" });
      },
      emitter,
    });
    cycle.enqueue("content/a.md");
    await vi.advanceTimersByTimeAsync(50);
    expect(reload).not.toHaveBeenCalled();
    post.resolve();
    await cycle.idle();
    expect(reload).toHaveBeenCalledTimes(1);
    cycle.close();
  });

  it("tells the owner about each exec failure after reporting it, for pre, parallel, and post alike", async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const emitter = new EventEmitter();
    const errors: unknown[] = [];
    emitter.on("build-error", (error) => errors.push(error));
    const failures: Array<[string, string]> = [];
    const cycle = createSourceCycle({
      entries: [
        { script: "pre.ts", watch: ["content/"] },
        { script: "parallel.ts", phase: "parallel", watch: ["content/"] },
        { script: "post.ts", phase: "post", watch: ["content/"] },
      ],
      run: async (entry) => {
        if (entry.script === "parallel.ts") throw new Error("parallel failed");
      },
      compile: vi.fn().mockResolvedValue(undefined),
      emitter,
      onExecFailure: (error, entry) =>
        failures.push([entry.script, (error as Error).message]),
    });
    cycle.enqueue("content/a.md");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(failures).toEqual([["parallel.ts", "parallel failed"]]);
    expect(errors).toHaveLength(1);
    cycle.close();
    consoleSpy.mockRestore();
  });

  it("keeps the cycle alive and retries the failed paths after a post failure when the owner only observes", async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("post failed"))
      .mockResolvedValue(undefined);
    const compile = vi.fn().mockResolvedValue(undefined);
    const cycle = createSourceCycle({
      entries: [{ script: "post.ts", phase: "post", watch: ["content/"] }],
      run,
      compile,
      emitter: new EventEmitter(),
      onExecFailure: vi.fn(),
    });
    cycle.enqueue("content/a.md");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    cycle.enqueue("content/b.md");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        resolve("content/a.md"),
        resolve("content/b.md"),
      ]),
    );
    cycle.close();
    consoleSpy.mockRestore();
  });

  it("settles 100 repeated same-two-path cycles with exact publications, paths, baseline listeners, recovery, and zero timers", async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const emitter = new EventEmitter();
    const testErrorListener = vi.fn();
    emitter.on("build-error", testErrorListener);
    const baseline = emitter.rawListeners("build-error");
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toBe(testErrorListener);

    const emittedPublications: [string, unknown][] = [];
    const transpiledListener = (payload: unknown) => {
      emittedPublications.push(["transpiled", payload]);
    };
    emitter.on("transpiled", transpiledListener);

    const pathA = resolve("src/pages/a.html");
    const pathB = resolve("src/pages/b.html");
    const expectedPaths = [pathA, pathB].sort();

    const makeAttempt = (index: number) => ({
      index,
      compile: gate(),
      post: gate(),
      parallel: gate(),
      compileEntered: gate(),
      postEntered: gate(),
      postStarted: false,
      parallelSettled: false,
    });
    let current = makeAttempt(0);
    const parallelTasks: Promise<void>[] = [];
    const compilePaths: string[][] = [];

    const cycle = createSourceCycle({
      entries: [
        {
          script: "parallel.ts",
          phase: "parallel",
          watch: ["src/pages/"],
        },
        {
          script: "post.ts",
          phase: "post",
          watch: ["src/pages/"],
        },
      ],
      run: (entry) => {
        const state = current;
        if (entry.phase === "parallel") {
          const task = state.parallel.promise.then(() => {
            state.parallelSettled = true;
          });
          parallelTasks.push(task);
          return task;
        }
        if (entry.phase === "post") {
          state.postStarted = true;
          state.postEntered.resolve();
          return state.post.promise;
        }
        throw new Error(`Unexpected source-cycle phase: ${entry.phase}`);
      },
      compile: async (paths, publish) => {
        const state = current;
        compilePaths.push([...paths].sort());
        publish("transpiled", {
          cyclePaths: [...paths].sort(),
          attempt: state.index,
        });
        state.compileEntered.resolve();
        await state.compile.promise;
      },
      emitter,
    });

    const failureIndex = 42;
    const failure = new Error(`compile failure at attempt ${failureIndex}`);
    const expectedPublications: [string, unknown][] = [];

    try {
      for (let attempt = 0; attempt <= 100; attempt++) {
        current = makeAttempt(attempt);

        if (attempt === failureIndex + 1) {
          // Only re-enqueue a: recovery must also retain failed path b.
          cycle.enqueue("src/pages/a.html");
        } else {
          cycle.enqueue("src/pages/a.html");
          cycle.enqueue("src/pages/b.html");
        }

        await vi.advanceTimersByTimeAsync(50);
        await current.compileEntered.promise;

        expect(compilePaths).toHaveLength(attempt + 1);
        expect(compilePaths[attempt]).toEqual(expectedPaths);
        expect(parallelTasks).toHaveLength(attempt + 1);
        expect(current.postStarted).toBe(false);
        expect(emittedPublications).toEqual(expectedPublications);

        if (attempt === failureIndex) {
          current.compile.reject(failure);
          await cycle.idle();
          expect(current.postStarted).toBe(false);
          expect(testErrorListener.mock.calls).toEqual([
            [{ message: failure.message, file: undefined }],
          ]);
          expect(emittedPublications).toEqual(expectedPublications);
        } else {
          current.compile.resolve();
          await current.postEntered.promise;
          expect(emittedPublications).toEqual(expectedPublications);
          current.post.resolve();
          await cycle.idle();
          expectedPublications.push([
            "transpiled",
            { cyclePaths: expectedPaths, attempt },
          ]);
          expect(emittedPublications).toEqual(expectedPublications);
        }

        // idle joins compilation/post, not this still-held parallel task.
        expect(current.parallelSettled).toBe(false);
        current.parallel.resolve();
        await Promise.all(parallelTasks);
        expect(current.parallelSettled).toBe(true);
        assertNoListenerLeak(emitter, baseline);
        expect(vi.getTimerCount()).toBe(0);
      }

      expect(compilePaths).toHaveLength(101);
      expect(parallelTasks).toHaveLength(101);
      expect(emittedPublications).toHaveLength(100);
      expect(testErrorListener.mock.calls).toEqual([
        [{ message: failure.message, file: undefined }],
      ]);
      expect(consoleSpy.mock.calls).toEqual([
        ["[bascik] source cycle error:", failure],
      ]);

      // Step 5: Final settlement and leak audit before teardown
      assertNoListenerLeak(emitter, baseline);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cycle.close();
      current.compile.resolve();
      current.post.resolve();
      current.parallel.resolve();
      try {
        await Promise.all([cycle.idle(), ...parallelTasks]);
      } finally {
        emitter.removeListener("build-error", testErrorListener);
        emitter.removeListener("transpiled", transpiledListener);
        consoleSpy.mockRestore();
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

// F031 / F189: a cycle fails only for its own work. A build-error from a
// parallel script an earlier cycle started, or from a source outside any
// cycle (a startup parallel script, a watcher error), must not discard a
// later cycle's successful compile.
describe("source cycles fail only for their own errors", () => {
  const silenceErrors = () =>
    vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("an earlier cycle's parallel script failing during a later compile does not fail the later cycle", async () => {
    vi.useFakeTimers();
    const consoleSpy = silenceErrors();
    const emitter = new EventEmitter();
    const reloads: unknown[] = [];
    const errors: unknown[] = [];
    emitter.on("transpiled", (payload) => reloads.push(payload));
    emitter.on("build-error", (payload) => errors.push(payload));
    const parallel = gate();
    const secondCompile = gate();
    const compiled: string[][] = [];
    const cycle = createSourceCycle({
      entries: [
        {
          script: "scripts/optimize-images.ts",
          phase: "parallel",
          watch: ["content/"],
        },
      ],
      run: () => parallel.promise,
      emitter,
      compile: async (paths, publish) => {
        compiled.push(paths);
        if (compiled.length === 2) await secondCompile.promise;
        publish("transpiled", { relativePagePath: `${compiled.length}.html` });
      },
    });
    cycle.enqueue("content/post.md");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    cycle.enqueue("src/pages/about.html");
    await vi.advanceTimersByTimeAsync(50);
    expect(compiled).toHaveLength(2);
    // The image script from the first edit fails while the page compiles.
    parallel.reject(new Error("sharp: unsupported image"));
    await vi.advanceTimersByTimeAsync(0);
    secondCompile.resolve();
    await cycle.idle();
    expect(errors).toEqual([
      expect.objectContaining({
        message: "sharp: unsupported image",
        file: "scripts/optimize-images.ts",
      }),
    ]);
    expect(reloads).toEqual([
      { relativePagePath: "1.html" },
      { relativePagePath: "2.html" },
    ]);
    // The page edit is not re-queued as failed: the next edit compiles alone.
    cycle.enqueue("src/pages/contact.html");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(compiled[2]).toEqual([resolve("src/pages/contact.html")]);
    cycle.close();
    consoleSpy.mockRestore();
  });

  it("a build-error from outside any cycle during a compile does not fail that cycle", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const reloads: unknown[] = [];
    emitter.on("transpiled", (payload) => reloads.push(payload));
    const compiling = gate();
    const release = gate();
    const compiled: string[][] = [];
    const cycle = createSourceCycle({
      entries: [],
      run: vi.fn(),
      emitter,
      compile: async (paths, publish) => {
        compiled.push(paths);
        compiling.resolve();
        await release.promise;
        publish("transpiled", { relativePagePath: "about.html" });
      },
    });
    cycle.enqueue("src/pages/about.html");
    await vi.advanceTimersByTimeAsync(50);
    await compiling.promise;
    // A startup parallel script (exec-publication) or the watcher reports.
    emitter.emit("build-error", {
      message: "exec producer failed: boom",
      file: "scripts/startup.ts",
    });
    release.resolve();
    await cycle.idle();
    expect(reloads).toEqual([{ relativePagePath: "about.html" }]);
    cycle.enqueue("src/pages/contact.html");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(compiled[1]).toEqual([resolve("src/pages/contact.html")]);
    cycle.close();
  });

  it("a build-error the compile itself reports still fails the cycle and retries its paths", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const reloads: unknown[] = [];
    emitter.on("transpiled", (payload) => reloads.push(payload));
    const compiled: string[][] = [];
    const cycle = createSourceCycle({
      entries: [],
      run: vi.fn(),
      emitter,
      compile: async (paths, publish) => {
        compiled.push(paths);
        await Promise.resolve();
        if (compiled.length === 1)
          emitter.emit("build-error", { message: "page failed" });
        publish("transpiled", { relativePagePath: "about.html" });
      },
    });
    cycle.enqueue("src/pages/about.html");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(reloads).toEqual([]);
    cycle.enqueue("src/pages/contact.html");
    await vi.advanceTimersByTimeAsync(50);
    await cycle.idle();
    expect(compiled[1].sort()).toEqual(
      [
        resolve("src/pages/about.html"),
        resolve("src/pages/contact.html"),
      ].sort(),
    );
    expect(reloads).toEqual([{ relativePagePath: "about.html" }]);
    cycle.close();
  });
});
