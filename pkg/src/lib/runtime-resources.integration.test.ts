import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCanceledBeforeHeaders,
  assertCanceledAfterPrefix,
  assertRejectedAfterAbort,
  assertDevChurnStages,
  assertInlinePublication,
  assertMeasuredBatchDeltas,
  runRetentionExperiment,
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

describe("packet R5: dev module churn", () => {
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