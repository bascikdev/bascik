import { describe, expect, it } from "vitest";
import {
  assertRetentionOraclesObserved,
  assertSettledCheckpoint,
  assertSettledHeaps,
  registryEntries,
  type RetentionCheckpoint,
} from "./module-retention.test-helper.ts";
import {
  analyzeRetentionHeap,
  type HeapSnapshot,
} from "./module-retention-heap.test-helper.ts";
import { ScriptRegistry } from "./script-registry.ts";

// WHY: the retention lanes once stayed green with a deliberate leak in place
// (superseded module entries kept in a global array, closed sockets kept in
// the server's connection set): no checkpoint field counted them and the lane
// tests asserted only what they remembered to. The harness now checks these
// invariants for every sample; these cases pin that each one fails, names the
// phase, and cannot pass by observing nothing.

const settled = (
  overrides: Partial<RetentionCheckpoint> = {},
): RetentionCheckpoint =>
  ({
    mode: "dev",
    phase: "batch-2",
    staleInlineLoads: 0,
    staleModuleEntries: 0,
    observedModuleEntries: 4,
    closedSockets: 0,
    observedSockets: 60,
    resources: ["FSReqCallback", "TCPServerWrap"],
    ...overrides,
  }) as RetentionCheckpoint;

describe("settled checkpoint invariants", () => {
  it("accepts a sample with nothing retained and the baseline's resources", () => {
    expect(() => assertSettledCheckpoint(settled(), settled())).not.toThrow();
  });

  it.each([
    ["staleInlineLoads", 2],
    ["staleModuleEntries", 1],
    ["closedSockets", 3],
  ] as const)("fails when %s is %d and names the phase", (field, value) => {
    expect(() =>
      assertSettledCheckpoint(settled({ [field]: value }), settled()),
    ).toThrow(new RegExp(`retention dev batch-2: ${field} must be 0 after GC`));
  });

  it("fails when a timer or socket outlives the baseline", () => {
    expect(() =>
      assertSettledCheckpoint(
        settled({
          resources: ["FSReqCallback", "TCPServerWrap", "Timeout"],
        }),
        settled(),
      ),
    ).toThrow(/batch-2: active resources differ from the baseline/);
  });

  it("fails when an oracle observed nothing", () => {
    expect(() =>
      assertRetentionOraclesObserved([settled({ observedSockets: 0 })]),
    ).toThrow(/observed no accepted sockets/);
    expect(() =>
      assertRetentionOraclesObserved([settled({ observedModuleEntries: 0 })]),
    ).toThrow(/observed no file-module loads/);
    expect(() => assertRetentionOraclesObserved([])).toThrow(/no checkpoints/);
  });
});

describe("settled heap invariants", () => {
  const heap = (phase: string, Timeout: number, registries = 1) => ({
    phase,
    registries,
    classes: { Timeout },
  });

  it("accepts snapshots that hold no more timers than the first", () => {
    expect(() =>
      assertSettledHeaps([heap("baseline", 2), heap("batch-2", 2)]),
    ).not.toThrow();
  });

  it("fails on a timer left running that getActiveResourcesInfo cannot see", () => {
    expect(() =>
      assertSettledHeaps([heap("baseline", 2), heap("batch-2", 7)]),
    ).toThrow(/batch-2: 7 Timeout objects, baseline 2/);
  });

  it("fails when the framework registry is missing or doubled", () => {
    expect(() => assertSettledHeaps([heap("baseline", 2, 0)])).toThrow(
      /expected exactly one ScriptRegistry/,
    );
    expect(() => assertSettledHeaps([heap("baseline", 2, 2)])).toThrow(
      /expected exactly one ScriptRegistry/,
    );
    expect(() => assertSettledHeaps([])).toThrow(/no heap snapshots/);
  });
});

describe("private-state observation guards", () => {
  // One ScriptRegistry whose cache Map (via table) holds one Module namespace.
  const registryHeap = (cacheName: string): HeapSnapshot => ({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["object", "array"]],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["property", "internal"]],
      },
    },
    strings: [
      "ScriptRegistry",
      "Map",
      "",
      "Object",
      "Module",
      cacheName,
      "table",
      "module",
      "0",
    ],
    nodes: [
      0, 0, 1, 24, 1, 0, 1, 3, 24, 1, 1, 2, 5, 24, 1, 0, 3, 7, 24, 1, 0, 4, 9,
      24, 0,
    ],
    edges: [0, 5, 5, 1, 6, 10, 1, 8, 15, 0, 7, 20],
  });

  it("counts the registry it attributed namespaces through", () => {
    const result = analyzeRetentionHeap(registryHeap("cache"), "/fixture");
    expect(result.registries).toBe(1);
    expect(result.frameworkNamespaces).toBe(1);
  });

  it("fails instead of reporting zero namespaces when the cache field is renamed", () => {
    expect(() =>
      analyzeRetentionHeap(registryHeap("moduleCache"), "/fixture"),
    ).toThrow(/ScriptRegistry heap node has no cache property/);
  });

  it("counts Timeout objects in the heap", () => {
    const heap = registryHeap("cache");
    heap.strings[3] = "Timeout";
    expect(analyzeRetentionHeap(heap, "/fixture").classes.Timeout).toBe(1);
  });

  it("fails when the registry's private cache field is missing at runtime", () => {
    const registry = new ScriptRegistry();
    expect(registryEntries(registry).size).toBe(0);
    Reflect.deleteProperty(registry, "cache");
    expect(() => registryEntries(registry)).toThrow(
      /registry cache observation unavailable/,
    );
  });
});
