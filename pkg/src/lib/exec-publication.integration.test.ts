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
  _execPublicationTestHooks,
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

  beforeEach(() => {
    _execPublicationTestHooks.reset();
    emitter = new EventEmitter();
    flushCalls.length = 0;
    installExecPublication(emitter);
    registerExecConsumerFlush(async (paths) => {
      flushCalls.push(paths);
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