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
  NODE_HTTP_DATE_CACHE_TIMEOUT,
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
    ).toThrow(
      /batch-2: 7 Timeout objects besides Node.s HTTP Date cache, baseline 2/,
    );
  });

  // WHY: Node's HTTP Date header cache (node:internal/http utcDate) arms one
  // unref'd timer per second after a response. A snapshot taken within that
  // second holds it and one taken later does not, so on a loaded runner the
  // baseline missed it and batch-2 failed with "2 Timeout objects, baseline 1".
  const withDateCache = (
    phase: string,
    Timeout: number,
    dateCache: number,
  ) => ({
    phase,
    registries: 1,
    classes: { Timeout, [NODE_HTTP_DATE_CACHE_TIMEOUT]: dateCache },
  });

  it("does not count Node's HTTP Date-cache timer against the baseline", () => {
    expect(() =>
      assertSettledHeaps([
        withDateCache("baseline", 1, 0),
        withDateCache("batch-2", 2, 1),
      ]),
    ).not.toThrow();
    expect(() =>
      assertSettledHeaps([
        withDateCache("baseline", 2, 1),
        withDateCache("batch-2", 1, 0),
      ]),
    ).not.toThrow();
  });

  it("still fails on a leaked timer next to the Date-cache timer", () => {
    expect(() =>
      assertSettledHeaps([
        withDateCache("baseline", 2, 1),
        withDateCache("batch-2", 3, 1),
      ]),
    ).toThrow(
      /batch-2: 2 Timeout objects besides Node's HTTP Date cache, baseline 1/,
    );
  });

  it("fails when more than one timer claims to be the Date-cache timer", () => {
    expect(() =>
      assertSettledHeaps([
        withDateCache("baseline", 1, 0),
        withDateCache("batch-2", 3, 2),
      ]),
    ).toThrow(/batch-2: 2 Node HTTP Date-cache timers/);
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

  // One Timeout per [callback name, script name] pair, each with the edges V8
  // writes: Timeout -_onTimeout-> closure -shared-> code -script-> code.
  const timerHeap = (timers: [string, string][]): HeapSnapshot => {
    const strings = ["Timeout", "_onTimeout", "shared", "script"];
    const nodes: number[] = [];
    const edges: number[] = [];
    for (const [callback, script] of timers) {
      const base = nodes.length;
      strings.push(callback, script);
      const callbackName = strings.length - 2;
      nodes.push(0, 0, base + 1, 24, 1);
      nodes.push(1, callbackName, base + 2, 24, 1);
      nodes.push(2, callbackName, base + 3, 24, 1);
      nodes.push(2, callbackName + 1, base + 4, 24, 0);
      edges.push(0, 1, base + 5, 1, 2, base + 10, 1, 3, base + 15);
    }
    return {
      snapshot: {
        meta: {
          node_fields: ["type", "name", "id", "self_size", "edge_count"],
          node_types: [["object", "closure", "code"]],
          edge_fields: ["type", "name_or_index", "to_node"],
          edge_types: [["property", "internal"]],
        },
      },
      strings,
      nodes,
      edges,
    };
  };

  it("tells Node's HTTP Date-cache timer from other timers by its script", () => {
    const { classes } = analyzeRetentionHeap(
      timerHeap([
        ["native_bind", ""],
        ["resetCache", "node:internal/http"],
        ["resetCache", "file:///fixture/api/probe.mjs"],
        ["refresh", "node:internal/http"],
      ]),
      "/fixture",
    );
    expect(classes.Timeout).toBe(4);
    expect(classes[NODE_HTTP_DATE_CACHE_TIMEOUT]).toBe(1);
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
