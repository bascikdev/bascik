import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Real modules: the coordinator, exec.execWatchCoversPath, and exec without
// child spawns (we emit events directly through the real listener). This test
// pins the producer/consumer overlap contract: a producer completion must
// flush consumer compilation AFTER the producer finishes, exactly once per
// generation, and a failed producer must never emit a success reload.
import {
  installExecPublication,
  registerExecConsumerFlush,
  setExecProducerWatchGlobs,
  execEntryOutputs,
  _execPublicationTestHooks,
  type ExecFlushOutputs,
} from "./exec-publication.ts";
import { execWatchCoversPath } from "./exec.ts";
import type { ExecEntry } from "./types.ts";

const entry = (partial: Partial<ExecEntry> & { script: string }): ExecEntry => ({
  phase: "pre",
  ...partial,
});

describe("exec publication coordinator: producer/consumer overlap", () => {
  let emitter: EventEmitter;
  const flushCalls: string[][] = [];
  const declaredCalls: ExecFlushOutputs[] = [];

  beforeEach(() => {
    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    flushCalls.length = 0;
    declaredCalls.length = 0;
    installExecPublication(emitter);
    registerExecConsumerFlush(async (paths, declared) => {
      flushCalls.push(paths);
      declaredCalls.push(declared);
    });
  });

  afterEach(() => {
    _execPublicationTestHooks.reset();
  });

  it("covers an overlapped watch path under a trailing-slash exec glob", () => {
    setExecProducerWatchGlobs([["content/"]]);
    expect(execWatchCoversPath(["content/"], "content/doc.md", undefined)).toBe(true);
    expect(execWatchCoversPath(["content/"], "src/other.md", undefined)).toBe(false);
  });

  it("covers common glob shapes, absolute paths, and ./-prefixed patterns (reviewer probe table)", () => {
    const cwd = process.cwd();
    // Single-segment glob
    expect(execWatchCoversPath(["content/*.md"], "content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["content/*.md"], "content/sub/doc.md")).toBe(false);
    expect(execWatchCoversPath(["content/*.md"], "content/doc.txt")).toBe(false);
    // Globstar
    expect(execWatchCoversPath(["content/**/*.md"], "content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["content/**/*.md"], "content/sub/doc.md")).toBe(true);
    expect(execWatchCoversPath(["content/**/*.md"], "content/sub/doc.txt")).toBe(false);
    // Nested literal directory with extension glob
    expect(execWatchCoversPath(["src/data/*.json"], "src/data/x.json")).toBe(true);
    expect(execWatchCoversPath(["src/data/*.json"], "src/other/x.json")).toBe(false);
    // Absolute pattern vs absolute path
    expect(execWatchCoversPath(["/abs/content"], "/abs/content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["/abs/content"], "/abs/other/doc.md")).toBe(false);
    // ./-prefixed pattern vs absolute cwd path (chokidar reports absolute paths
    // when the watched glob is absolute, and relative otherwise)
    expect(execWatchCoversPath(["./content"], `${cwd}/content/doc.md`)).toBe(true);
    expect(execWatchCoversPath(["./content"], "content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["content/*.md"], `${cwd}/content/doc.md`)).toBe(true);
    // Absolute self-script vs relative change path still guards
    expect(execWatchCoversPath(["scripts/"], `${cwd}/scripts/gen.mjs`, "scripts/gen.mjs")).toBe(false);
    // Existing true cases
    expect(execWatchCoversPath(["content"], "content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["content/**"], "content/sub/doc.md")).toBe(true);
  });

  it("never matches the producer's own script (cyclic self-watch guard)", () => {
    expect(execWatchCoversPath(["scripts/"], "scripts/generator.mjs", "scripts/generator.mjs")).toBe(false);
    expect(execWatchCoversPath(["scripts/"], "scripts/generator.mjs", undefined)).toBe(true);
  });

  it("flushes consumers once, with all paths, after a producer completion", async () => {
    setExecProducerWatchGlobs([["content/"]]);
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md", "content/other.md"],
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls.length).toBe(1);
    expect(flushCalls[0]).toEqual(["content/doc.md", "content/other.md"]);
    // Monotonic generation must have advanced once.
    expect(_execPublicationTestHooks.generationValue).toBe(1);
  });

  it("dedupes repeated paths within a single producer completion", async () => {
    setExecProducerWatchGlobs([["content/"]]);
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md", "content/doc.md", "content/other.md"],
    });

    await Promise.resolve();
    await Promise.resolve();
    // A single generation dedupes repeated paths into one unique flush.
    expect(flushCalls.length).toBe(1);
    expect(new Set(flushCalls[0])).toEqual(new Set(["content/doc.md", "content/other.md"]));
  });

  it("flushes two distinct producer completions as distinct monotonic generations", async () => {
    setExecProducerWatchGlobs([["content/"]]);
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md"],
    });
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/other.md"],
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Independent work stays concurrent: each completion flushes its own
    // generation, in monotonic order, without losing either path.
    const allPaths = flushCalls.flat();
    expect(allPaths).toContain("content/doc.md");
    expect(allPaths).toContain("content/other.md");
    expect(flushCalls.length).toBe(2);
    expect(_execPublicationTestHooks.generationValue).toBe(2);
  });

  it("a failed producer never flushes consumers and never emits a reload; it surfaces a build-error", async () => {
    setExecProducerWatchGlobs([["content/"]]);
    const errors: Array<{ message: string; file: string }> = [];
    const onError = (p: { message: string; file: string }) => errors.push(p);
    emitter.on("build-error", onError);

    emitter.emit("exec-failed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md"],
      error: new Error("generator exploded"),
    });

    // No consumer flush (last-known-good preserved), no success reload emitted
    // (a reload is only ever triggered by an accepted publication / transpiled
    // event downstream). The build-error is surfaced for prompt 97's overlay.
    expect(flushCalls.length).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("generator exploded");
    expect(_execPublicationTestHooks.generationValue).toBe(0);
  });

  // ── Dev parallel phase (prompt 137) ────────────────────────────────────────
  // In dev the parallel phase is not awaited before the server binds. Each
  // parallel outcome is handed to this coordinator exactly like a watched
  // producer completion, so it is observed and published, never dropped.

  it("a parallel completion flushes consumers exactly once as its own monotonic generation", async () => {
    const parallel = entry({ script: "scripts/search-index.mjs", phase: "parallel" });
    emitter.emit("exec-completed", { entry: parallel, paths: [parallel.script] });

    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls).toEqual([["scripts/search-index.mjs"]]);
    expect(_execPublicationTestHooks.generationValue).toBe(1);
    expect(_execPublicationTestHooks.pendingPaths).toEqual([]);
  });

  it("two unrelated parallel completions publish as two monotonic generations without serializing each other", async () => {
    const first = entry({ script: "scripts/a.mjs", phase: "parallel" });
    const second = entry({ script: "scripts/b.mjs", phase: "parallel" });
    emitter.emit("exec-completed", { entry: first, paths: [first.script] });
    emitter.emit("exec-completed", { entry: second, paths: [second.script] });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls.flat()).toEqual(["scripts/a.mjs", "scripts/b.mjs"]);
    expect(flushCalls.length).toBe(2);
    expect(_execPublicationTestHooks.generationValue).toBe(2);
  });

  it("retains a parallel completion that lands before the consumer flush is registered and publishes it once on registration", async () => {
    // Startup race: a fast parallel entry can finish before watch.ts has
    // registered the consumer recompile. The completion must not be dropped
    // and must not burn a generation with nobody to publish to.
    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    installExecPublication(emitter);
    const parallel = entry({ script: "scripts/early.mjs", phase: "parallel" });
    emitter.emit("exec-completed", { entry: parallel, paths: [parallel.script] });

    await Promise.resolve();
    await Promise.resolve();
    expect(_execPublicationTestHooks.generationValue).toBe(0);
    expect(_execPublicationTestHooks.pendingPaths).toEqual(["scripts/early.mjs"]);

    registerExecConsumerFlush(async (paths) => {
      flushCalls.push(paths);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls).toEqual([["scripts/early.mjs"]]);
    expect(_execPublicationTestHooks.generationValue).toBe(1);
    expect(_execPublicationTestHooks.pendingPaths).toEqual([]);
  });

  it("a failed parallel entry surfaces a build-error and never a consumer flush or a success reload", async () => {
    const errors: Array<{ message: string; file: string }> = [];
    const reloads: string[] = [];
    emitter.on("build-error", (p: { message: string; file: string }) => errors.push(p));
    emitter.on("transpiled", () => reloads.push("transpiled"));
    emitter.on("asset-changed", () => reloads.push("asset-changed"));
    emitter.on("watch-path-processed", () => reloads.push("watch-path-processed"));

    const parallel = entry({ script: "scripts/og-images.mjs", phase: "parallel" });
    emitter.emit("exec-failed", {
      entry: parallel,
      paths: [parallel.script],
      error: new Error('[bascik] exec "scripts/og-images.mjs" exited with code 1'),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(flushCalls).toEqual([]);
    expect(reloads).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("scripts/og-images.mjs");
    expect(errors[0].message).toContain("exited with code 1");
    expect(_execPublicationTestHooks.generationValue).toBe(0);
  });

  // ── Declared outputs (prompt 139) ──────────────────────────────────────────
  // A producer that declares `outputs` lets the flush target the pages that
  // read those files. The coordinator carries the union of declared outputs
  // per generation alongside the trigger paths; one producer without outputs
  // marks the whole generation unscoped so the flush falls back to blanket.

  it("normalizes an entry's outputs to a list and ignores blanks", () => {
    expect(execEntryOutputs(undefined)).toEqual([]);
    expect(execEntryOutputs(entry({ script: "a.mjs" }))).toEqual([]);
    expect(execEntryOutputs(entry({ script: "a.mjs", outputs: "dist/one.json" }))).toEqual(["dist/one.json"]);
    expect(execEntryOutputs(entry({ script: "a.mjs", outputs: ["dist/one.json", " ", "dist/two.json"] }))).toEqual([
      "dist/one.json",
      "dist/two.json",
    ]);
  });

  it("hands the flush the trigger paths and the producer's declared outputs, scoped", async () => {
    setExecProducerWatchGlobs([["content/"]]);
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"], outputs: ["dist/generated.json"] }),
      paths: ["content/doc.md"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls).toEqual([["content/doc.md"]]);
    expect(declaredCalls).toEqual([{ outputs: ["dist/generated.json"], scoped: true }]);
    expect(_execPublicationTestHooks.generationValue).toBe(1);
    expect(_execPublicationTestHooks.pendingOutputs).toEqual([]);
    expect(_execPublicationTestHooks.pendingUnscopedValue).toBe(false);
  });

  it("a producer without outputs is handed to the flush unscoped with no outputs (pre-139 behavior)", async () => {
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(declaredCalls).toEqual([{ outputs: [], scoped: false }]);
  });

  it("unions declared outputs across producers completed in the same held generation and dedupes them", async () => {
    // No consumer yet: both completions land in one held generation.
    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    installExecPublication(emitter);
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/a.mjs", phase: "parallel", outputs: ["dist/a.json", "dist/shared.json"] }),
      paths: ["scripts/a.mjs"],
    });
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/b.mjs", phase: "parallel", outputs: "dist/shared.json" }),
      paths: ["scripts/b.mjs"],
    });
    expect(_execPublicationTestHooks.generationValue).toBe(0);
    expect(new Set(_execPublicationTestHooks.pendingOutputs)).toEqual(new Set(["dist/a.json", "dist/shared.json"]));

    registerExecConsumerFlush(async (paths, declared) => {
      flushCalls.push(paths);
      declaredCalls.push(declared);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls).toEqual([["scripts/a.mjs", "scripts/b.mjs"]]);
    expect(declaredCalls).toHaveLength(1);
    expect(declaredCalls[0].scoped).toBe(true);
    expect(new Set(declaredCalls[0].outputs)).toEqual(new Set(["dist/a.json", "dist/shared.json"]));
    expect(_execPublicationTestHooks.generationValue).toBe(1);
  });

  it("one producer without outputs makes the whole held generation unscoped", async () => {
    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    installExecPublication(emitter);
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/a.mjs", phase: "parallel", outputs: ["dist/a.json"] }),
      paths: ["scripts/a.mjs"],
    });
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/legacy.mjs", phase: "parallel" }),
      paths: ["scripts/legacy.mjs"],
    });
    registerExecConsumerFlush(async (paths, declared) => {
      flushCalls.push(paths);
      declaredCalls.push(declared);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(declaredCalls).toHaveLength(1);
    expect(declaredCalls[0].scoped).toBe(false);
    // The declared outputs are still passed along; only the scope flag drops.
    expect(declaredCalls[0].outputs).toEqual(["dist/a.json"]);
  });

  it("declared outputs do not leak from one flushed generation into the next", async () => {
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/a.mjs", phase: "parallel", outputs: ["dist/a.json"] }),
      paths: ["scripts/a.mjs"],
    });
    await Promise.resolve();
    await Promise.resolve();
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/b.mjs", phase: "parallel", outputs: ["dist/b.json"] }),
      paths: ["scripts/b.mjs"],
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(declaredCalls).toEqual([
      { outputs: ["dist/a.json"], scoped: true },
      { outputs: ["dist/b.json"], scoped: true },
    ]);
    expect(_execPublicationTestHooks.generationValue).toBe(2);
  });

  it("a failed producer does not contribute its declared outputs to the pending generation", async () => {
    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    installExecPublication(emitter);
    emitter.on("build-error", () => undefined);
    emitter.emit("exec-failed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"], outputs: ["dist/generated.json"] }),
      paths: ["content/doc.md"],
      error: new Error("boom"),
    });
    expect(_execPublicationTestHooks.pendingOutputs).toEqual([]);
    expect(_execPublicationTestHooks.pendingPaths).toEqual([]);
  });

  it("recovers through the next valid generation after a failure", async () => {
    setExecProducerWatchGlobs([["content/"]]);
    const errors: Array<{ message: string; file: string }> = [];
    emitter.on("build-error", (p: { message: string; file: string }) => errors.push(p));

    // Failed required work first.
    emitter.emit("exec-failed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md"],
      error: new Error("tmp failure"),
    });
    expect(flushCalls.length).toBe(0);

    // Next valid generation recovers: the consumer compile runs.
    emitter.emit("exec-completed", {
      entry: entry({ script: "scripts/gen.mjs", watch: ["content/"] }),
      paths: ["content/doc.md"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushCalls.length).toBe(1);
    expect(errors).toHaveLength(1);
  });
});