import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRetentionExperiment, compareRetentionTrends, type RetentionCheckpoint } from "./module-retention.test-helper.ts";
import { analyzeRetentionHeap, type HeapSnapshot } from "./module-retention-heap.test-helper.ts";

const directories: string[] = [];
export async function cleanupRetentionReports(reports: string[], failed: boolean) {
  if (failed) {
    for (const directory of reports) console.error(`Private retention diagnostics retained: ${directory}`);
    return;
  }
  await Promise.all(reports.map(directory => rm(directory, { recursive: true, force: true })));
}
afterEach(async ({ task }) => {
  await cleanupRetentionReports(directories.splice(0), task.result?.state === "fail" || process.env.BASCIK_PROFILE_TEST_KEEP_REPORTS === "1");
});

describe("module retention lifecycle evidence", () => {
  it("retains failed retention diagnostics privately and removes successful reports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    const manifest = join(directory, "manifest.json");
    await writeFile(manifest, '{"success":false}', { mode: 0o600 });
    await cleanupRetentionReports([directory], true);
    expect(await readFile(manifest, "utf8")).toContain("success");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await cleanupRetentionReports([directory], false);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("captures twenty fixed live pages and thirty helpers through realistic source cycles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    directories.push(directory);
    const checkpoints = await runRetentionExperiment(directory, true, 2, "dev", true);
    for (const checkpoint of checkpoints.slice(0, -1)) {
      expect(checkpoint).toMatchObject({ pages: 20, plans: 20, cache: 2, inlineLoads: 21, staleInlineLoads: 0, graph: 32, liveRequests: 0, stalePlans: 0 });
      expect(checkpoint.dependencyEdges).toBe(22);
    }
    expect(checkpoints[2].completed).toBe(2);
  }, 60_000);
  it("calibrates late post-GC trends without treating byte equality as a correctness rule", () => {
    const samples = (last: number) => [
      { phase: "batch-1", completed: 30, memory: { heapUsed: 1_000_000 } },
      { phase: "batch-2", completed: 60, memory: { heapUsed: last } },
    ] as RetentionCheckpoint[];
    expect(compareRetentionTrends(samples(1_200_000), samples(2_000_000))).toEqual({
      stableLateBytes: 200_000, changingLateBytes: 1_000_000, excessLateBytes: 800_000, envelopeBytes: 400_000, exceedsCalibration: true,
    });
    expect(compareRetentionTrends(samples(1_200_000), samples(1_300_000)).exceedsCalibration).toBe(false);
    expect(() => compareRetentionTrends([], samples(1_300_000))).toThrow();
  });
  it("attributes published namespaces directly to the framework cache", () => {
    const heap: HeapSnapshot = {
      snapshot: {
        meta: {
          node_fields: ["type", "name", "id", "self_size", "edge_count"], node_types: [["object", "array"]],
          edge_fields: ["type", "name_or_index", "to_node"], edge_types: [["property", "internal"]],
        }
      },
      strings: ["ScriptRegistry", "Map", "", "Object", "Module", "cache", "table", "module", "0"],
      nodes: [0, 0, 1, 24, 1, 0, 1, 3, 24, 1, 1, 2, 5, 24, 1, 0, 3, 7, 24, 1, 0, 4, 9, 24, 0],
      edges: [0, 5, 5, 1, 6, 10, 1, 8, 15, 0, 7, 20],
    };
    const result = analyzeRetentionHeap(heap, "/fixture");
    expect(result.frameworkNamespaces).toBe(1);
    expect(result.frameworkPaths[0]).toEqual(["ScriptRegistry", "property:cache -> Map", "internal:table", "internal:0 -> Object", "property:module -> Module"]);
  });
  it.each(["http1", "http2"] as const)("retains a fixed-source %s production control", async mode => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    directories.push(directory);
    const checkpoints = await runRetentionExperiment(directory, false, 2, mode);
    expect(checkpoints.every(checkpoint => checkpoint.mode === mode)).toBe(true);
    for (const checkpoint of checkpoints.slice(0, -1)) {
      expect(checkpoint).toMatchObject({ pages: 2, plans: 2, cache: 2, graph: 0, liveRequests: 0, liveRequestClosures: 0, stalePlans: 0, publications: 0 });
      expect(checkpoint.fileVersions).toEqual([0, 0, 0, 0]);
    }
    const heaps: ReturnType<typeof analyzeRetentionHeap>[] = JSON.parse(await readFile(join(directory, "heaps.json"), "utf8"));
    expect(heaps.map(heap => heap.frameworkNamespaces)).toEqual(checkpoints.filter(checkpoint => checkpoint.snapshot).map(checkpoint => checkpoint.cache));
    expect(heaps[1].fixtureJobs.length).toBe(heaps[0].fixtureJobs.length);
  }, 60_000);
  it("attributes object module jobs only through strong loader edges", () => {
    const heap: HeapSnapshot = {
      snapshot: {
        meta: {
          node_fields: ["type", "name", "id", "self_size", "edge_count"], node_types: [["object", "string"]],
          edge_fields: ["type", "name_or_index", "to_node"], edge_types: [["property", "internal", "weak", "shortcut"]],
        }
      },
      strings: ["LoadCache", "ModuleJob", "url", "file:///fixture/helper.mjs", "table"],
      nodes: [0, 0, 1, 24, 1, 0, 1, 3, 48, 1, 1, 3, 5, 64, 0],
      edges: [1, 4, 5, 0, 2, 10],
    };
    const result = analyzeRetentionHeap(heap, "/fixture");
    expect(result.classes.ModuleJob).toBe(1);
    expect(result.fixtureJobs).toEqual([{ url: "file:///fixture/helper.mjs", path: ["LoadCache", "internal:table -> ModuleJob"] }]);
    for (const type of [2, 3]) {
      expect(analyzeRetentionHeap({ ...heap, edges: [type, 4, 5, 0, 2, 10] }, "/fixture").fixtureJobs[0].path).toEqual([]);
    }
    expect(() => analyzeRetentionHeap({ ...heap, edges: [1, 4, 99, 0, 2, 10] }, "/fixture")).toThrow();
  });
  it.each([false, true])("measures completed dev generations, changing=%s", async (changing) => {
    const directory = await mkdtemp(join(tmpdir(), "bascik-retention-test-"));
    directories.push(directory);
    const checkpoints = await runRetentionExperiment(directory, changing, 6);
    expect(checkpoints.map(checkpoint => checkpoint.phase)).toEqual(["baseline", "batch-1", "batch-2", "reverted", "cleared"]);
    for (const checkpoint of checkpoints.slice(0, -1)) {
      expect(checkpoint.pages).toBe(2);
      expect(checkpoint.liveRequests).toBe(0);
      expect(checkpoint.liveRequestClosures).toBe(0);
      expect(checkpoint.stalePlans).toBe(0);
      expect(checkpoint.plans).toBe(2);
      expect(checkpoint.activeRequests).toBe(0);
      expect(checkpoint.pendingCompression).toBe(0);
      expect(checkpoint.dependencyEdges).toBe(2);
    }
    expect(checkpoints[2].completed).toBe(6);
    expect(checkpoints[2].requests - checkpoints[0].requests).toBe(18);
    expect(checkpoints[2].publications - checkpoints[0].publications).toBe(6);
    expect(checkpoints[2].cache).toBe(2);
    expect(checkpoints[2].graph).toBe(4);
    expect(checkpoints[3].cache).toBe(checkpoints[2].cache);
    expect(checkpoints[3].fileVersions).toEqual(Array(4).fill(changing ? 7 : 0));
    expect(checkpoints.at(-1)).toMatchObject({ cache: 0, graph: 0, pages: 0 });
    const heaps: ReturnType<typeof analyzeRetentionHeap>[] = JSON.parse(await readFile(join(directory, "heaps.json"), "utf8"));
    expect(heaps.map(heap => heap.frameworkNamespaces)).toEqual(checkpoints.filter(checkpoint => checkpoint.snapshot).map(checkpoint => checkpoint.cache));
    for (const heap of heaps) {
      expect(heap.classes.LoadCache).toBeGreaterThan(0);
      expect(heap.fixtureJobs.length).toBeGreaterThan(0);
      expect(heap.fixtureJobs.every(job => job.path[0] === "LoadCache" && job.path.at(-1)?.endsWith("ModuleJob"))).toBe(true);
    }
    for (const checkpoint of checkpoints.filter(value => value.snapshot)) {
      expect((await stat(checkpoint.snapshot!)).mode & 0o077).toBe(0);
    }
    if (!changing) {
      expect(checkpoints[2].cache).toBe(checkpoints[0].cache);
      expect(checkpoints[2].graph).toBe(checkpoints[0].graph);
      expect(heaps[1].fixtureJobs.length).toBe(heaps[0].fixtureJobs.length);
    }
  }, 60_000);
});