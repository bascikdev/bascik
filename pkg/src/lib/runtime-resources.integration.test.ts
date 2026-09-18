import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCanceledBeforeHeaders,
  assertCanceledAfterPrefix,
  assertRejectedAfterAbort,
  assertFixedFailedImport,
  assertDevChurnStages,
  assertInlinePublication,
  assertMeasuredBatchDeltas,
  assertSupportedTlsCleanupRuntime,
  DevStageOracle,
  runRetentionExperiment,
  RetentionIpcWaiters,
  RetentionSettlement,
  type DevChurnStage,
  type DevChurnStageObservation,
  type RetentionCheckpoint,
} from "./module-retention.test-helper.ts";

const retentionReportDirectories: string[] = [];

afterEach(async ({ task }) => {
  const failed = task.result?.state === "fail" || process.env.BASCIK_PROFILE_TEST_KEEP_REPORTS === "1";
  if (failed) {
    for (const directory of retentionReportDirectories) {
      console.error(`Private retention diagnostics retained: ${directory}`);
    }
    retentionReportDirectories.length = 0;
    return;
  }
  while (retentionReportDirectories.length > 0) {
    const directory = retentionReportDirectories.pop();
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Error removing retention test directory ${directory}:`, error);
          throw error;
        }
      }
    }
  }
});

describe("packet R2: fixed production batches", () => {
  it("batch delta oracle rejects a missing completion (negative control)", () => {
    expect(() => assertMeasuredBatchDeltas([0, 252, 503], 252)).toThrow(
      /measured batch 2 delta: expected 252 completions, got 251/,
    );
    expect(() => assertMeasuredBatchDeltas([0], 252)).toThrow(
      /requires a baseline and at least one batch checkpoint/,
    );
    assertMeasuredBatchDeltas([0, 252, 504], 252);
  });

  it.each(["exit", "error"] as const)(
    "held-cleanup IPC rejects waiter on child %s (negative control)",
    async (event) => {
      const waiters = new RetentionIpcWaiters();
      const pending = waiters.wait(1, "held-cleanup ack");
      const rejected = expect(pending).rejects.toThrow(
        event === "exit" ? "retention child exited" : "injected child error",
      );
      expect(() => waiters.assertIdle()).toThrow("pending IPC waiter");
      if (event === "exit") waiters.onExit(1, null);
      else waiters.onError(new Error("injected child error"));
      await rejected;
      waiters.assertIdle();
    },
  );

  it.each(["dispatch", "tls"] as const)("settlement oracle rejects a held %s acknowledgment", async stage => {
    const boundary = new RetentionSettlement();
    boundary.hold(stage);
    boundary.track(stage, Promise.resolve());
    try {
      await boundary.entered(stage);
      expect(() => boundary.assertSettled()).toThrow(`sample requires settled ${stage} acknowledgments`);
    } finally {
      boundary.releaseAll();
      await boundary.join();
    }
    boundary.assertSettled();
  });

  it("TLS causal hook verifies Node 24 runtime and rejects unsupported environments", () => {
    // Unsupported-runtime negative control
    expect(() => assertSupportedTlsCleanupRuntime("v22.18.0", { _destroySSL: () => {} })).toThrow(
      /causal TLS transport cleanup acknowledgment requires the verified Node 24 callback ordering/,
    );
    // Missing _destroySSL negative control
    expect(() => assertSupportedTlsCleanupRuntime("v24.17.0", {})).toThrow(
      /tls\.TLSSocket\.prototype\._destroySSL must exist/,
    );
    assertSupportedTlsCleanupRuntime(process.version);
  });

  it("settlement preserves unexpected owner failures and rejects an unconsumed hold", async () => {
    const failed = new RetentionSettlement();
    failed.track("dispatch", Promise.reject(new Error("unexpected dispatch failure")));
    await expect(failed.join()).rejects.toThrow("unexpected dispatch failure");
    expect(() => failed.assertSettled()).toThrow("unexpected dispatch failure");
    const missing = new RetentionSettlement();
    missing.hold("tls");
    try {
      await expect(missing.entered("tls")).rejects.toThrow("no actual tls owner consumed the hold");
    } finally {
      missing.releaseAll();
    }
  });

  it("held real dispatch blocks sampling (negative control)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    await runRetentionExperiment(
      directory,
      false,
      2,
      "http1",
      false,
      { warmupRequests: 1, measuredBatchSize: 1, testMode: "negative-dispatch" },
    );
  }, 20_000);

  it("held real TLS callback blocks sampling (negative control)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    await runRetentionExperiment(
      directory,
      false,
      2,
      "http2",
      false,
      { warmupRequests: 1, measuredBatchSize: 1, testMode: "negative-tls" },
    );
  }, 20_000);

  it("TLS calibration and foreign identity rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    await runRetentionExperiment(
      directory,
      false,
      2,
      "http2",
      false,
      { warmupRequests: 3, measuredBatchSize: 1, testMode: "calibration-identity" },
    );
  }, 20_000);

  it.each(["http1", "http2"] as const)(
    "production-only 102 warmup + 252 + 252 sequential requests across three routes (%s)",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      const checkpoints = await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { warmupRequests: 102, measuredBatchSize: 252 },
      );

      expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
        "baseline",
        "batch-1",
        "batch-2",
      ]);
      expect(checkpoints.every((checkpoint) => checkpoint.mode === mode)).toBe(true);
      assertMeasuredBatchDeltas(
        checkpoints.map((checkpoint) => checkpoint.completed),
        252,
      );
      expect(checkpoints[2].completed - checkpoints[0].completed).toBe(504);
      // Independent authored-handler observations, not parent-supplied sample labels.
      assertMeasuredBatchDeltas(checkpoints.map(checkpoint => checkpoint.requests), 252);
      expect(checkpoints.map(checkpoint => checkpoint.completed)).toEqual([0, 252, 504]);

      for (const checkpoint of checkpoints) {
        expect(checkpoint).toMatchObject({
          pages: 2,
          plans: 2,
          cache: 2,
          graph: 0,
          liveRequests: 0,
          liveRequestClosures: 0,
          stalePlans: 0,
          publications: 0,
          activeRequests: 0,
          pendingCompression: 0,
          pending: { dispatch: 0, transport: 0, tls: 0 },
          staleInlineLoads: 0,
        });
        for (const owner of ["inlineLoads", "dependencyEdges", "sidecar"] as const) {
          expect(checkpoint[owner], owner).toBe(checkpoints[0][owner]);
        }
        for (const bytes of Object.values(checkpoint.memory)) {
          expect(Number.isFinite(bytes)).toBe(true);
          expect(bytes).toBeGreaterThanOrEqual(0);
        }
        expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
        expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      }
    },
    120_000,
  );
});

describe("packet R3 row: cancel before headers", () => {
  it.each(["aborted", "settled", "dispatchSettled", "transportSettled"] as const)(
    "oracle rejects missing %s acknowledgment (negative control)",
    (field) => {
      const base = { entered: 1, aborted: 1, settled: 1, dispatchSettled: 1, transportSettled: 1, headersSent: false };
      const bad = { ...base, [field]: 0 };
      expect(() => assertCanceledBeforeHeaders(bad, 1)).toThrow(/missing .* acknowledgment/);
      // Valid observation must not throw.
      assertCanceledBeforeHeaders(base, 1);
    },
  );

  it("oracle rejects headersSent true (negative control)", () => {
    const bad = { entered: 1, aborted: 1, settled: 1, dispatchSettled: 1, transportSettled: 1, headersSent: true };
    expect(() => assertCanceledBeforeHeaders(bad, 1)).toThrow(/headers must remain uncommitted/);
  });

  it("oracle rejects mismatched entered count (negative control)", () => {
    const bad = { entered: 2, aborted: 1, settled: 1, dispatchSettled: 1, transportSettled: 1, headersSent: false };
    expect(() => assertCanceledBeforeHeaders(bad, 1)).toThrow(/handler entry acknowledgments/);
  });

  it.each(["http1", "http2"] as const)(
    "cancel before headers %s: held-cleanup negative control",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "cancel-before-headers", smokeCycles: 10, measuredCycles: 100, testMode: "negative-dispatch" },
      );
    },
    30_000,
  );

  it.each(["http1", "http2"] as const)(
    "cancel before headers %s: 10 smoke then 100 measured cycles",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      const checkpoints = await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "cancel-before-headers", smokeCycles: 10, measuredCycles: 100 },
      );

      expect(checkpoints.map((c) => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
      expect(checkpoints.every((c) => c.mode === mode)).toBe(true);

      for (const [index, checkpoint] of checkpoints.entries()) {
        // baseline: 10 smoke pairs (10 healthy); batch-1: +50 fault + 50 healthy; batch-2: +100 fault + 100 healthy
        const cancelCount = index === 0 ? 10 : index === 1 ? 60 : 110;
        const healthyCount = cancelCount;

        expect(checkpoint.cancellation).toBeDefined();
        assertCanceledBeforeHeaders(checkpoint.cancellation!, cancelCount);
        expect(checkpoint.cancellation).toMatchObject({
          healthy: healthyCount,
          errors: 0,
          pending: 0,
        });

        expect(checkpoint).toMatchObject({
          pages: 2,
          plans: 2,
          cache: 2,
          graph: 0,
          liveRequests: 0,
          liveRequestClosures: 0,
          stalePlans: 0,
          publications: 0,
          activeRequests: 0,
          pendingCompression: 0,
          pending: { dispatch: 0, transport: 0, tls: 0 },
          staleInlineLoads: 0,
        });
        expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
        expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      }
    },
    180_000,
  );
});

describe("packet R3 row: cancel after exact prefix", () => {
  it.each([
    ["readerCanceled", 0, "missing reader cancel acknowledgment"],
    ["producerSettled", 0, "missing producer settlement acknowledgment"],
    ["writerSettled", 0, "missing writer settlement acknowledgment"],
    ["dispatchSettled", 0, "missing server dispatch settlement acknowledgment"],
    ["transportSettled", 0, "missing causal transport cleanup acknowledgment"],
    ["prefix", "wrong", "exact authored prefix"],
    ["suffixWrites", 1, "suffix after abort"],
    ["lockedBodies", 1, "retained body lock"],
    ["ownedListeners", 1, "retained response listeners"],
  ] as const)("oracle rejects %s fault (negative control)", (field, value, message) => {
    const observation = {
      readerCanceled: 1,
      producerSettled: 1,
      writerSettled: 1,
      dispatchSettled: 1,
      transportSettled: 1,
      prefix: "retention-prefix\n",
      suffixWrites: 0,
      lockedBodies: 0,
      ownedListeners: 0,
    };
    expect(() => assertCanceledAfterPrefix({ ...observation, [field]: value }, 1)).toThrow(message);
    assertCanceledAfterPrefix(observation, 1);
  });

  it.each(["http1", "http2"] as const)(
    "cancel after exact prefix %s: held-cleanup negative control",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "cancel-after-exact-prefix", smokeCycles: 10, measuredCycles: 100, testMode: "negative-dispatch" },
      );
    },
    30_000,
  );

  it.each(["http1", "http2"] as const)(
    "cancel after exact prefix %s: 10 smoke then 100 measured cycles",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      const checkpoints = await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "cancel-after-exact-prefix", smokeCycles: 10, measuredCycles: 100 },
      );

      expect(checkpoints.map((c) => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
      expect(checkpoints.every((c) => c.mode === mode)).toBe(true);

      for (const [index, checkpoint] of checkpoints.entries()) {
        const cancelCount = index === 0 ? 10 : index === 1 ? 60 : 110;
        const healthyCount = cancelCount;

        expect(checkpoint.cancellation).toBeDefined();
        expect(checkpoint.cancellation!.midBody).toBeDefined();
        assertCanceledAfterPrefix(checkpoint.cancellation!.midBody!, cancelCount);
        expect(checkpoint.cancellation).toMatchObject({
          entered: cancelCount,
          aborted: cancelCount,
          headersSent: true,
          healthy: healthyCount,
          errors: 0,
          pending: 0,
        });

        expect(checkpoint).toMatchObject({
          pages: 2,
          plans: 2,
          cache: 2,
          graph: 0,
          liveRequests: 0,
          liveRequestClosures: 0,
          stalePlans: 0,
          publications: 0,
          activeRequests: 0,
          pendingCompression: 0,
          pending: { dispatch: 0, transport: 0, tls: 0 },
          staleInlineLoads: 0,
        });
        expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
        expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      }
    },
    180_000,
  );
});

describe("packet R3 row: reject after acknowledged abort", () => {
  it.each(["aborted", "settled", "dispatchSettled", "transportSettled"] as const)(
    "oracle rejects missing %s acknowledgment (negative control)",
    (field) => {
      const base = { entered: 1, aborted: 1, settled: 1, dispatchSettled: 1, transportSettled: 1, headersSent: false };
      const bad = { ...base, [field]: 0 };
      expect(() => assertRejectedAfterAbort(bad, 1)).toThrow(/missing .* acknowledgment/);
      assertRejectedAfterAbort(base, 1);
    },
  );

  it("oracle rejects headersSent true (negative control)", () => {
    const bad = { entered: 1, aborted: 1, settled: 1, dispatchSettled: 1, transportSettled: 1, headersSent: true };
    expect(() => assertRejectedAfterAbort(bad, 1)).toThrow(/headers must remain uncommitted/);
  });

  it("oracle rejects mismatched entered count (negative control)", () => {
    const bad = { entered: 2, aborted: 1, settled: 1, dispatchSettled: 1, transportSettled: 1, headersSent: false };
    expect(() => assertRejectedAfterAbort(bad, 1)).toThrow(/handler entry acknowledgments/);
  });

  it.each(["http1", "http2"] as const)(
    "reject after acknowledged abort %s: held-cleanup negative control",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "reject-after-acknowledged-abort", smokeCycles: 10, measuredCycles: 100, testMode: "negative-dispatch" },
      );
    },
    30_000,
  );

  it.each(["http1", "http2"] as const)(
    "reject after acknowledged abort %s: 10 smoke then 100 measured cycles",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      const checkpoints = await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "reject-after-acknowledged-abort", smokeCycles: 10, measuredCycles: 100 },
      );

      expect(checkpoints.map((c) => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
      expect(checkpoints.every((c) => c.mode === mode)).toBe(true);

      for (const [index, checkpoint] of checkpoints.entries()) {
        const cancelCount = index === 0 ? 10 : index === 1 ? 60 : 110;
        const healthyCount = cancelCount;

        expect(checkpoint.cancellation).toBeDefined();
        assertRejectedAfterAbort(checkpoint.cancellation!, cancelCount);
        expect(checkpoint.cancellation).toMatchObject({
          healthy: healthyCount,
          errors: 0,
          pending: 0,
        });

        expect(checkpoint).toMatchObject({
          pages: 2,
          plans: 2,
          cache: 2,
          graph: 0,
          liveRequests: 0,
          liveRequestClosures: 0,
          stalePlans: 0,
          publications: 0,
          activeRequests: 0,
          pendingCompression: 0,
          pending: { dispatch: 0, transport: 0, tls: 0 },
          staleInlineLoads: 0,
        });
        expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
        expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      }
    },
    180_000,
  );
});

describe("packet R3 row: fixed failed import", () => {
  it.each([
    ["faultAttempts", 0, "fault attempt acknowledgments"],
    ["faultErrors", 0, "fault 500 error responses"],
    ["recoveredRequests", 0, "recovered healthy responses"],
    ["dispatchSettled", 0, "dispatch settlement acknowledgments"],
    ["transportSettled", 0, "transport cleanup acknowledgments"],
  ] as const)("oracle rejects missing %s acknowledgment (negative control)", (field, value, message) => {
    const base = { faultAttempts: 1, faultErrors: 1, recoveredRequests: 1, dispatchSettled: 2, transportSettled: 2 };
    const bad = { ...base, [field]: value };
    expect(() => assertFixedFailedImport(bad, { faults: 1, recovered: 1 })).toThrow(message);
    assertFixedFailedImport(base, { faults: 1, recovered: 1 });
  });

  it.each(["http1", "http2"] as const)(
    "fixed failed import %s: held-cleanup negative control",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "fixed-failed-import", smokeCycles: 10, measuredCycles: 100, testMode: "negative-dispatch" },
      );
    },
    30_000,
  );

  it.each(["http1", "http2"] as const)(
    "fixed failed import %s: 10 smoke then 100 measured cycles",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      const checkpoints = await runRetentionExperiment(
        directory,
        false,
        2,
        mode,
        false,
        { fault: "fixed-failed-import", smokeCycles: 10, measuredCycles: 100 },
      );

      expect(checkpoints.map((c) => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
      expect(checkpoints.every((c) => c.mode === mode)).toBe(true);

      for (const checkpoint of checkpoints) {
        expect(checkpoint).toMatchObject({
          pages: 2,
          plans: 2,
          cache: 2,
          graph: 0,
          liveRequests: 0,
          liveRequestClosures: 0,
          stalePlans: 0,
          publications: 0,
          activeRequests: 0,
          pendingCompression: 0,
          pending: { dispatch: 0, transport: 0, tls: 0 },
          staleInlineLoads: 0,
        });
        expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
        expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      }
    },
    180_000,
  );
});

describe("packet R5: dev module churn stage oracle", () => {
  async function assertDevRowSettlement(directory: string, checkpoints: RetentionCheckpoint[]) {
    expect(checkpoints.map(checkpoint => checkpoint.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
    expect(checkpoints.map(checkpoint => checkpoint.completed)).toEqual([0, 50, 100]);
    assertMeasuredBatchDeltas(checkpoints.map(checkpoint => checkpoint.completed), 50);
    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({
        activeRequests: 0, liveRequests: 0, liveRequestClosures: 0,
        stalePlans: 0, staleInlineLoads: 0, pendingCompression: 0,
        pending: { dispatch: 0, transport: 0, tls: 0 }, devModuleLifecycle: { pending: 0 },
      });
      for (const owner of ["pages", "plans", "cache", "graph", "sidecar", "dependencyEdges", "inlineLoads"] as const) {
        expect(checkpoint[owner], `${checkpoint.phase}: ${owner}`).toBe(checkpoints[0][owner]);
      }
      expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      expect(checkpoint.devModuleLifecycle?.listeners).toEqual(checkpoints[0].devModuleLifecycle?.listeners);
      expect(checkpoint.devModuleLifecycle?.liveTargetPaths).toHaveLength(1);
      expect(checkpoint.devModuleLifecycle?.liveTargetPaths).toEqual(checkpoints[0].devModuleLifecycle?.liveTargetPaths);
    }
    const shutdown = JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")) as {
      watchers: number; closedWatchers: number[];
    };
    expect(shutdown.watchers).toBeGreaterThan(0);
    expect(shutdown.closedWatchers).toEqual(Array.from({ length: shutdown.watchers }, (_, index) => index));
    expect(shutdown).toMatchObject({
      connected: false, exitCode: 0, signalCode: null,
      restored: { destroySSL: true, createSecureServer: true, createServer: true },
    });
  }

  it("API route publication oracle rejects missing unlink acknowledgment", () => {
    const expected = { path: "/fixture/api/probe.mjs", generation: 1, watchEvent: "unlink", publications: ["api-route-changed"] };
    expect(() => assertInlinePublication({ ...expected, publications: [] }, expected)).toThrow("missing inline publication/recovery acknowledgment");
    assertInlinePublication(expected, expected);
  });

  it("dev module deletion/recovery (API route): 2 smoke then 100 revisions split 50+50 with JSON and stream recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    const checkpoints = await runRetentionExperiment(directory, true, 2, "dev", false, {
      input: "dev-module-api", smokeCycles: 2, measuredRevisions: 100,
    });
    await assertDevRowSettlement(directory, checkpoints);
    const path = join(await realpath(directory), "project/api/probe.mjs");
    expect(checkpoints.map(checkpoint => checkpoint.completed)).toEqual([0, 50, 100]);
    expect(checkpoints.map(checkpoint => checkpoint.devModuleLifecycle?.observationGeneration)).toEqual([8, 58, 108]);
    expect(checkpoints.map(checkpoint => checkpoint.devModuleLifecycle?.publications)).toEqual([8, 58, 108]);
    assertMeasuredBatchDeltas(checkpoints.map(checkpoint => checkpoint.devModuleLifecycle!.publications), 50);
    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({
        activeRequests: 0, liveRequests: 0, liveRequestClosures: 0, stalePlans: 0,
        staleInlineLoads: 0, pendingCompression: 0, pending: { dispatch: 0, transport: 0, tls: 0 },
        devModuleLifecycle: { pending: 0, liveTargetPaths: [path] },
      });
      expect(checkpoint.devModuleLifecycle?.listeners).toEqual(checkpoints[0].devModuleLifecycle?.listeners);
      expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      for (const owner of ["pages", "plans", "cache", "graph", "sidecar", "dependencyEdges", "inlineLoads", "publications"] as const) {
        expect(checkpoint[owner]).toBe(checkpoints[0][owner]);
      }
    }
    const stages = JSON.parse(await readFile(join(directory, "api-stages.json"), "utf8")) as {
      observation: DevChurnStageObservation; held?: DevChurnStage; revision: number; deleted: boolean;
    }[];
    expect(stages).toHaveLength(110);
    expect(stages.slice(0, 6).map(stage => stage.held)).toEqual(["watcher", "invalidation", "reload", "request", "transport", "ipc"]);
    expect(stages.slice(8, 108).map(stage => stage.revision)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    for (const [index, stage] of stages.entries()) assertDevChurnStages(stage.observation, { path, generation: index + 1 });
    const observations = JSON.parse(await readFile(join(directory, "dev-module-observations.json"), "utf8")) as {
      path: string; generation: number; watchEvent: string; publications: string[];
    }[];
    expect(observations).toHaveLength(110);
    expect(observations.filter(observation => observation.watchEvent === "unlink")).toHaveLength(3);
    for (const [index, observation] of observations.entries()) {
      const watchEvent = index < 8 ? ["change", "unlink", "add", "change"][index % 4]
        : index < 108 ? "change" : index === 108 ? "unlink" : "add";
      assertInlinePublication(observation, { path, generation: index + 1, watchEvent, publications: ["api-route-changed"] });
    }
    expect(stages.slice(-2).map(stage => ({ revision: stage.revision, deleted: stage.deleted }))).toEqual([
      { revision: 0, deleted: true }, { revision: 0, deleted: false },
    ]);
  }, 180_000);

  it("external helper publication oracle rejects missing error acknowledgment", () => {
    const expected = { path: "/fixture/src/lib/helper.mjs", generation: 1, watchEvent: "unlink", publications: ["build-error"] };
    expect(() => assertInlinePublication({ ...expected, publications: [] }, expected)).toThrow("missing inline publication/recovery acknowledgment");
    assertInlinePublication(expected, expected);
  });

  it(
    "dev module deletion/recovery (external src helper): 2 smoke cycles then 100 revisions split 50+50 and deletion recovery",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
      retentionReportDirectories.push(directory);
      const checkpoints = await runRetentionExperiment(directory, true, 2, "dev", false, {
        input: "dev-module-external",
        smokeCycles: 2,
        measuredRevisions: 100,
      });
      await assertDevRowSettlement(directory, checkpoints);
      expect(checkpoints.map((checkpoint) => checkpoint.completed)).toEqual([0, 50, 100]);
      expect(checkpoints.map((checkpoint) => checkpoint.devModuleLifecycle?.observationGeneration)).toEqual([8, 58, 108]);
      assertMeasuredBatchDeltas(
        checkpoints.map((checkpoint) => checkpoint.publications),
        50,
      );
      for (const checkpoint of checkpoints) {
        expect(checkpoint.pending).toEqual({ dispatch: 0, transport: 0, tls: 0 });
        expect(checkpoint.devModuleLifecycle?.pending).toBe(0);
        expect(checkpoint.devModuleLifecycle?.liveTargetPaths).toEqual(checkpoints[0].devModuleLifecycle?.liveTargetPaths);
        expect(checkpoint.devModuleLifecycle?.listeners).toEqual(checkpoints[0].devModuleLifecycle?.listeners);
        expect(checkpoint.resources).toEqual(checkpoints[0].resources);
        for (const owner of ["pages", "plans", "cache", "graph", "sidecar", "dependencyEdges"] as const) {
          expect(checkpoint[owner]).toBe(checkpoints[0][owner]);
        }
        expect(checkpoint).toMatchObject({
          activeRequests: 0,
          liveRequests: 0,
          liveRequestClosures: 0,
          stalePlans: 0,
          pendingCompression: 0,
        });
      }
      const stages = JSON.parse(await readFile(join(directory, "external-stages.json"), "utf8")) as {
        observation: DevChurnStageObservation;
        held?: DevChurnStage;
      }[];
      expect(stages).toHaveLength(110);
      expect(stages.slice(0, 6).map((stage) => stage.held)).toEqual([
        "watcher",
        "invalidation",
        "reload",
        "request",
        "transport",
        "ipc",
      ]);
      for (const [index, stage] of stages.entries()) {
        assertDevChurnStages(stage.observation, { path: stages[0].observation.path, generation: index + 1 });
      }
      const publications = JSON.parse(await readFile(join(directory, "dev-module-observations.json"), "utf8")) as {
        watchEvent: string;
        publications: string[];
      }[];
      expect(publications.filter((event) => event.watchEvent === "unlink")).toHaveLength(3);
      expect(publications.slice(-2)).toMatchObject([
        { watchEvent: "unlink", publications: ["build-error"] },
        { watchEvent: "add", publications: ["transpiled"] },
      ]);
    },
    180_000,
  );
  const fullObservation: DevChurnStageObservation = {
    path: "/project/src/pages/inline.html",
    generation: 1,
    watcher: true,
    invalidation: true,
    reload: true,
    request: true,
    transport: true,
    ipc: true,
  };

  it.each([
    ["watcher", "missing watcher input acknowledgment"],
    ["invalidation", "missing emitted invalidation acknowledgment"],
    ["reload", "missing reload/load acknowledgment"],
    ["request", "missing request acknowledgment"],
    ["transport", "missing transport acknowledgment"],
    ["ipc", "missing parent IPC acknowledgment"],
  ] as const)("stage oracle rejects missing %s acknowledgment (negative control)", (stage, expectedError) => {
    const missing = { ...fullObservation, [stage]: false };
    expect(() =>
      assertDevChurnStages(missing, { path: fullObservation.path, generation: fullObservation.generation }),
    ).toThrow(expectedError);
  });

  it("stage oracle rejects path or generation mismatch (negative control)", () => {
    expect(() =>
      assertDevChurnStages(fullObservation, { path: "/other/path.html", generation: 1 }),
    ).toThrow(/exact stage path mismatch/);
    expect(() =>
      assertDevChurnStages(fullObservation, { path: fullObservation.path, generation: 2 }),
    ).toThrow(/exact stage generation mismatch/);
    // Exact match passes
    assertDevChurnStages(fullObservation, { path: fullObservation.path, generation: 1 });
  });

  it.each(["exit", "error"] as const)(
    "dev stage IPC rejects pending waiter on child %s (negative control)",
    async (event) => {
      const waiters = new RetentionIpcWaiters();
      const pending = waiters.wait(42, "dev-stage-ipc");
      const rejected = expect(pending).rejects.toThrow(
        event === "exit" ? "retention child exited" : "dev stage worker error",
      );
      expect(() => waiters.assertIdle()).toThrow("pending IPC waiter");
      if (event === "exit") waiters.onExit(1, null);
      else waiters.onError(new Error("dev stage worker error"));
      await rejected;
      waiters.assertIdle();
    },
  );

  it.each(["watcher", "invalidation", "reload", "request", "transport", "ipc"] as const)(
    "dev stage settlement oracle rejects held %s stage (negative control)",
    async (stage: DevChurnStage) => {
      const oracle = new DevStageOracle(fullObservation.path, fullObservation.generation);
      oracle.hold(stage);
      oracle.track(stage, Promise.resolve());
      try {
        await oracle.entered(stage);
        expect(() => oracle.assertSettled()).toThrow(`sample requires settled ${stage} acknowledgments`);
        expect(oracle.pending()[stage]).toBe(1);
      } finally {
        oracle.releaseAll();
        await oracle.join();
      }
      oracle.assertSettled();
      expect(oracle.pending()[stage]).toBe(0);
    },
  );

  it("dev stage settlement oracle distinguishes all stages and confirms complete observation", async () => {
    const oracle = new DevStageOracle(fullObservation.path, fullObservation.generation);
    const stages: DevChurnStage[] = ["watcher", "invalidation", "reload", "request", "transport", "ipc"];
    for (const stage of stages) {
      oracle.track(stage, Promise.resolve());
    }
    await oracle.join();
    oracle.assertSettled();
    const observation = oracle.observation();
    assertDevChurnStages(observation, { path: fullObservation.path, generation: fullObservation.generation });
  });

  it("dev stage settlement oracle preserves unexpected owner failures and rejects an unconsumed hold", async () => {
    const failed = new DevStageOracle(fullObservation.path, fullObservation.generation);
    failed.track("watcher", Promise.reject(new Error("unexpected watcher failure")));
    await expect(failed.join()).rejects.toThrow("unexpected watcher failure");
    expect(() => failed.assertSettled()).toThrow("unexpected watcher failure");

    const missing = new DevStageOracle(fullObservation.path, fullObservation.generation);
    missing.hold("reload");
    try {
      await expect(missing.entered("reload")).rejects.toThrow("no actual reload owner consumed the hold");
    } finally {
      missing.releaseAll();
    }
  });

  it("dev module deletion/recovery (inline page): 2 smoke then 100 revisions split 50+50 with edit delete recreate restore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    const checkpoints = await runRetentionExperiment(
      directory,
      true,
      2,
      "dev",
      false,
      { input: "dev-module-inline", smokeCycles: 2, measuredRevisions: 100 },
    );
    await assertDevRowSettlement(directory, checkpoints);
    expect(checkpoints.map(c => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
    expect(checkpoints[0].completed).toBe(0);
    expect(checkpoints[1].completed).toBe(50);
    expect(checkpoints[2].completed).toBe(100);

    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({
        pages: 2,
        plans: 2,
        cache: 2,
        graph: 4,
        inlineLoads: 1,
        liveRequests: 0,
        liveRequestClosures: 0,
        stalePlans: 0,
        activeRequests: 0,
        pendingCompression: 0,
        pending: { dispatch: 0, transport: 0, tls: 0 },
      });
      expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
      expect(checkpoint.resources).toEqual(checkpoints[0].resources);
      expect(checkpoint.staleInlineLoads).toBe(0);
      expect(checkpoint.devModuleLifecycle?.listeners).toEqual(checkpoints[0].devModuleLifecycle?.listeners);
      expect(checkpoint.devModuleLifecycle?.liveTargetPaths).toEqual(checkpoints[0].devModuleLifecycle?.liveTargetPaths);
      for (const owner of ["sidecar", "dependencyEdges"] as const) {
        expect(checkpoint[owner]).toBe(checkpoints[0][owner]);
      }
    }

    assertMeasuredBatchDeltas(checkpoints.map(c => c.devModuleLifecycle!.observationGeneration), 50 * 4);
    // Each cycle publishes one edit, one surviving page after deletion,
    // both pages after recreation, and one restored-page edit. Boot adds two.
    assertMeasuredBatchDeltas(checkpoints.map(c => c.devModuleLifecycle!.publications), 50 * 5);
    expect(checkpoints[2].devModuleLifecycle).toMatchObject({
      observationGeneration: (2 + 100) * 4,
      publications: 2 + (2 + 100) * 5,
      pending: 0,
    });
  }, 180_000);

});

describe("packet R6: static asset lifecycle", () => {
  it.each(["change", "add"])("asset oracle rejects missing %s publication/recovery (negative control)", watchEvent => {
    const expected = { path: "/fixture/src/pages/asset.txt", generation: 1, watchEvent, publications: ["asset-changed"] };
    expect(() => assertInlinePublication({ ...expected, publications: [] }, expected)).toThrow(
      "missing inline publication/recovery acknowledgment",
    );
    assertInlinePublication(expected, expected);
    for (const fault of [{ path: "/unrelated" }, { generation: 0 }, { watchEvent: "unlink" }, { publications: ["asset-changed", "asset-changed"] }]) {
      expect(() => assertInlinePublication({ ...expected, ...fault }, expected)).toThrow();
    }
  });

  it.each(["exit", "error"] as const)("asset publication IPC rejects child %s (negative control)", async event => {
    const waiters = new RetentionIpcWaiters();
    const pending = waiters.wait(1, "asset recovery publication");
    const rejected = expect(pending).rejects.toThrow(event === "exit" ? "retention child exited" : "unrelated build-error");
    expect(() => waiters.assertIdle()).toThrow("pending IPC waiter");
    if (event === "exit") waiters.onExit(1, null);
    else waiters.onError(new Error("unrelated build-error"));
    await rejected;
    waiters.assertIdle();
  });

  it("held real dispatch blocks sampling before static asset baseline (negative control)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    await runRetentionExperiment(
      directory,
      false,
      2,
      "dev",
      false,
      { input: "static-asset", smokeCycles: 2, measuredRevisions: 100, testMode: "negative-dispatch" },
    );
  }, 30_000);

  it("static asset: 2 smoke then 100 revisions split 50+50 with edit delete recreate restore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    const checkpoints = await runRetentionExperiment(
      directory,
      true,
      2,
      "dev",
      false,
      { input: "static-asset", smokeCycles: 2, measuredRevisions: 100 },
    );
    expect(checkpoints.map(c => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
    expect(checkpoints[0].completed).toBe(0);
    expect(checkpoints[1].completed).toBe(50);
    expect(checkpoints[2].completed).toBe(100);

    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({
        pages: 2,
        plans: 2,
        cache: 2,
        graph: 4,
        inlineLoads: 1,
        liveRequests: 0,
        liveRequestClosures: 0,
        stalePlans: 0,
        activeRequests: 0,
        pendingCompression: 0,
        pending: { dispatch: 0, transport: 0, tls: 0 },
      });
      expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
      expect(checkpoint.resources).toEqual(checkpoints[0].resources);
    }

    expect(checkpoints[2].assetLifecycle).toMatchObject({
      observationGeneration: (2 + 100) * 4,
      publications: (2 + 100) * 4,
      pending: 0,
      representations: 1,
      inFlight: 0,
      openHandles: 0,
    });
  }, 180_000);
});

describe("packet R6: local build dependency lifecycle", () => {
  it.each(["change", "add", "unlink"])("build-dependency oracle rejects missing %s publication/recovery (negative control)", watchEvent => {
    const expected = {
      path: "/fixture/src/lib/build-helper.ts",
      generation: 1,
      watchEvent,
      publications: watchEvent === "unlink" ? ["build-error"] : ["transpiled"],
    };
    expect(() => assertInlinePublication({ ...expected, publications: [] }, expected)).toThrow(
      "missing inline publication/recovery acknowledgment",
    );
    assertInlinePublication(expected, expected);
    for (const fault of [{ path: "/unrelated" }, { generation: 0 }, { watchEvent: watchEvent === "unlink" ? "change" : "unlink" }, { publications: ["transpiled", "transpiled"] }]) {
      expect(() => assertInlinePublication({ ...expected, ...fault }, expected)).toThrow();
    }
  });

  it.each(["exit", "error"] as const)("build-dependency publication IPC rejects child %s (negative control)", async event => {
    const waiters = new RetentionIpcWaiters();
    const pending = waiters.wait(1, "build-dependency recovery publication");
    const rejected = expect(pending).rejects.toThrow(event === "exit" ? "retention child exited" : "unrelated build-error");
    expect(() => waiters.assertIdle()).toThrow("pending IPC waiter");
    if (event === "exit") waiters.onExit(1, null);
    else waiters.onError(new Error("unrelated build-error"));
    await rejected;
    waiters.assertIdle();
  });

  it("held real dispatch blocks sampling before build-dependency baseline (negative control)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    await runRetentionExperiment(
      directory,
      false,
      2,
      "dev",
      false,
      { input: "build-dependency", smokeCycles: 2, measuredRevisions: 100, testMode: "negative-dispatch" },
    );
  }, 30_000);

  it("build-dependency oracle negative control FIRST actual uncaught intended ownership/altered byte failure", async () => {
    const expected = {
      path: "/fixture/src/lib/build-helper.ts",
      generation: 1,
      watchEvent: "change",
      publications: ["transpiled"],
    };
    // Injected altered byte / missing pub / wrong path must fail closed
    expect(() => assertInlinePublication({ ...expected, publications: [] }, expected)).toThrow(
      "missing inline publication/recovery acknowledgment",
    );
    expect(() => assertInlinePublication({ ...expected, path: "/fixture/wrong" }, expected)).toThrow(
      "exact inline source path",
    );
  });

  it("build-dependency: 2 smoke then 100 revisions split 50+50 with edit delete recreate restore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    retentionReportDirectories.push(directory);
    const checkpoints = await runRetentionExperiment(
      directory,
      true,
      2,
      "dev",
      false,
      { input: "build-dependency", smokeCycles: 2, measuredRevisions: 100 },
    );
    expect(checkpoints.map(c => c.phase)).toEqual(["baseline", "batch-1", "batch-2"]);
    expect(checkpoints[0].completed).toBe(0);
    expect(checkpoints[1].completed).toBe(50);
    expect(checkpoints[2].completed).toBe(100);

    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({
        pages: 2,
        plans: 2,
        cache: 2,
        graph: 4,
        inlineLoads: 1,
        liveRequests: 0,
        liveRequestClosures: 0,
        stalePlans: 0,
        activeRequests: 0,
        pendingCompression: 0,
        pending: { dispatch: 0, transport: 0, tls: 0 },
      });
      expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
      expect(checkpoint.resources).toEqual(checkpoints[0].resources);
    }

    expect(checkpoints[2].buildDepLifecycle).toMatchObject({
      observationGeneration: (2 + 100) * 4,
      pending: 0,
      pages: 2,
    });
  }, 180_000);
});

