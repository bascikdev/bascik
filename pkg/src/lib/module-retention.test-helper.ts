import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { cleanGeneratorEnvironment, validatePrivateDirectory, digest } from "../../bench/profile-workload.ts";
import { execute } from "../../bench/profile-runner.ts";
import { createFixtureTrust, http2Request } from "../../bench/profile-tls.ts";
import type { ScriptRegistry } from "./script-registry.ts";
import { analyzeRetentionHeap } from "./module-retention-heap.test-helper.ts";
import { getLiveReloadScript } from "./live-reload.ts";

export function registryEntries(registry: ScriptRegistry): Map<string, unknown> {
  const cache: unknown = Reflect.get(registry, "cache");
  assert(cache instanceof Map, "registry cache observation unavailable");
  return cache;
}

export function assertRegistryReleased(registry: ScriptRegistry): void {
  assert.equal(registryEntries(registry).size, 0, "framework cache must be empty");
  assert.equal(registry.graph.size, 0, "framework graph must be empty");
}

export interface RetentionCheckpoint {
  mode: string;
  phase: string;
  completed: number;
  pages: number;
  cache: number;
  inlineLoads: number;
  staleInlineLoads: number;
  graph: number;
  liveRequests: number;
  liveRequestClosures: number;
  stalePlans: number;
  plans: number;
  requests: number;
  dependencyEdges: number;
  publications: number;
  fileVersions: number[];
  sidecar: number;
  activeRequests: number;
  pendingCompression: number;
  pending?: { dispatch: number; transport: number; tls: number };
  resources: string[];
  cancellation?: CancellationObservation;
  assetLifecycle?: {
    observationGeneration: number;
    publications: number;
    liveAssetPaths: string[];
    representations: number;
    inFlight: number;
    openHandles: number;
    listeners: number[];
    pending: number;
  };
  buildDepLifecycle?: {
    observationGeneration: number;
    publications: number;
    liveHelperPaths: string[];
    pages: number;
    listeners: number[];
    pending: number;
  };
  devModuleLifecycle?: {
    observationGeneration: number;
    publications: number;
    liveTargetPaths: string[];
    pages: number;
    listeners: number[];
    pending: number;
  };
  snapshot?: string;
  memory: NodeJS.MemoryUsage;
}

/**
 * Per-cycle cancellation counts reported by the child subject for R3 fault rows.
 * Each field is a cumulative count at sample time.
 */
export interface CancellationObservation {
  /** Handler entered: the authored handler was invoked. */
  entered: number;
  /** Abort acknowledged: handler's abort signal fired before headers were sent. */
  aborted: number;
  /** Invocation settled: the scriptRegistry.invoke promise resolved/rejected. */
  settled: number;
  /** API dispatch settled: apiRouteRegistry.dispatch finally block ran. */
  dispatchSettled: number;
  /**
   * Transport cleanup complete: for HTTP/2, the causal _destroySSL callback ran;
   * for HTTP/1.1, the raw socket "close" event fired.
   */
  transportSettled: number;
  /** True if any cycle sent headers before cancel (must be false for cancel-before-headers). */
  headersSent: boolean;
  /** Count of healthy requests that successfully completed after each cancel cycle. */
  healthy: number;
  /** Count of unexpected dispatch errors (must be 0). */
  errors: number;
  /** Count of outstanding IPC gates (must be 0 at sample time). */
  pending: number;
  /** Row 2 cancel-after-prefix detailed stream & writer metrics. */
  midBody?: MidBodyCancellationObservation;
}

export function compareRetentionTrends(stable: RetentionCheckpoint[], changing: RetentionCheckpoint[]) {
  const interval = (samples: RetentionCheckpoint[]) => {
    const start = samples.find(sample => sample.phase === "batch-1");
    const end = samples.find(sample => sample.phase === "batch-2");
    assert(start && end && end.completed > start.completed, "missing completed late-batch samples");
    assert(Number.isFinite(start.memory.heapUsed) && Number.isFinite(end.memory.heapUsed), "invalid heap samples");
    return { rounds: end.completed - start.completed, bytes: end.memory.heapUsed - start.memory.heapUsed };
  };
  const stableInterval = interval(stable);
  const changingInterval = interval(changing);
  assert.equal(changingInterval.rounds, stableInterval.rounds, "control batch sizes must match");
  const envelopeBytes = Math.max(256 * 1024, 2 * Math.abs(stableInterval.bytes));
  const excessLateBytes = changingInterval.bytes - stableInterval.bytes;
  return { stableLateBytes: stableInterval.bytes, changingLateBytes: changingInterval.bytes, excessLateBytes, envelopeBytes, exceedsCalibration: excessLateBytes > envelopeBytes };
}

/**
 * Pure workload-count validator (packet 113C / R2): given cumulative measured-completion counts
 * (for example `[baseline.completed, batch1.completed, batch2.completed]`), asserts every
 * consecutive delta equals `expectedBatchSize`. A deliberately missing completion (a delta one
 * short) must throw for that reason, not for an unrelated shape/length mistake.
 */
export function assertMeasuredBatchDeltas(completed: number[], expectedBatchSize: number): void {
  assert(completed.length >= 2, "measured batch validation requires a baseline and at least one batch checkpoint");
  for (let index = 1; index < completed.length; index++) {
    const delta = completed[index] - completed[index - 1];
    assert.equal(delta, expectedBatchSize, `measured batch ${index} delta: expected ${expectedBatchSize} completions, got ${delta}`);
  }
}

/**
 * Dev module churn / lifecycle stages for packet R5.
 * Stage order: watcher input -> emitted invalidation -> reload/load -> request -> transport -> parent IPC.
 */
export type DevChurnStage =
  | "watcher"
  | "invalidation"
  | "reload"
  | "request"
  | "transport"
  | "ipc";

export interface DevChurnStageObservation {
  path: string;
  generation: number;
  watcher: boolean;
  invalidation: boolean;
  reload: boolean;
  request: boolean;
  transport: boolean;
  ipc: boolean;
}

/**
 * Pure stage acknowledgment oracle for packet R5 dev module lifecycle.
 * Asserts all required stages are acknowledged and path/generation match exactly.
 */
export function assertDevChurnStages(
  actual: DevChurnStageObservation,
  expected: { path: string; generation: number },
): void {
  assert.equal(actual.path, expected.path, `exact stage path mismatch: expected ${expected.path}, got ${actual.path}`);
  assert.equal(actual.generation, expected.generation, `exact stage generation mismatch: expected ${expected.generation}, got ${actual.generation}`);
  assert.equal(actual.watcher, true, "missing watcher input acknowledgment");
  assert.equal(actual.invalidation, true, "missing emitted invalidation acknowledgment");
  assert.equal(actual.reload, true, "missing reload/load acknowledgment");
  assert.equal(actual.request, true, "missing request acknowledgment");
  assert.equal(actual.transport, true, "missing transport acknowledgment");
  assert.equal(actual.ipc, true, "missing parent IPC acknowledgment");
}

/**
 * Test-owned bounded pending-stage diagnostics oracle for packet R5.
 * Distinguishes held/pending stages and tracks exact path and generation.
 */
export class DevStageOracle {
  private stages: Record<DevChurnStage, Set<Promise<void>>> = {
    watcher: new Set(),
    invalidation: new Set(),
    reload: new Set(),
    request: new Set(),
    transport: new Set(),
    ipc: new Set(),
  };
  private holds = new Map<DevChurnStage, {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
    consumed: boolean;
  }>();
  private observedStages = new Set<DevChurnStage>();
  private failure: unknown;

  readonly path: string;
  readonly generation: number;

  constructor(path: string, generation: number) {
    this.path = path;
    this.generation = generation;
  }

  hold(stage: DevChurnStage): void {
    assert(!this.holds.has(stage), `already holding stage ${stage}`);
    this.holds.set(stage, {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      consumed: false,
    });
  }

  track(stage: DevChurnStage, work: PromiseLike<unknown>): void {
    this.observedStages.add(stage);
    const candidate = this.holds.get(stage);
    const hold = candidate && !candidate.consumed ? candidate : undefined;
    if (hold) hold.consumed = true;
    const settled = Promise.resolve(work).then(async () => {
      if (hold) {
        hold.entered.resolve();
        await hold.release.promise;
      }
    }).catch(error => {
      this.failure ??= error;
      hold?.entered.resolve();
    }).finally(() => {
      this.stages[stage].delete(settled);
    });
    this.stages[stage].add(settled);
  }

  async entered(stage: DevChurnStage): Promise<void> {
    const hold = this.holds.get(stage);
    assert(hold?.consumed, `no actual ${stage} owner consumed the hold`);
    await hold.entered.promise;
    if (this.failure) throw this.failure;
  }

  release(stage: DevChurnStage): void {
    const hold = this.holds.get(stage);
    assert(hold, `no ${stage} hold to release`);
    hold.release.resolve();
    this.holds.delete(stage);
  }

  releaseAll(): void {
    for (const stage of this.holds.keys()) this.release(stage);
  }

  async join(except?: DevChurnStage): Promise<void> {
    for (const stage of ["watcher", "invalidation", "reload", "request", "transport", "ipc"] as const) {
      if (stage !== except) await Promise.all(this.stages[stage]);
    }
    if (this.failure) throw this.failure;
  }

  pending(): Record<DevChurnStage, number> {
    return {
      watcher: this.stages.watcher.size,
      invalidation: this.stages.invalidation.size,
      reload: this.stages.reload.size,
      request: this.stages.request.size,
      transport: this.stages.transport.size,
      ipc: this.stages.ipc.size,
    };
  }

  observation(): DevChurnStageObservation {
    return {
      path: this.path,
      generation: this.generation,
      watcher: this.observedStages.has("watcher"),
      invalidation: this.observedStages.has("invalidation"),
      reload: this.observedStages.has("reload"),
      request: this.observedStages.has("request"),
      transport: this.observedStages.has("transport"),
      ipc: this.observedStages.has("ipc"),
    };
  }

  assertSettled(): void {
    if (this.failure) throw this.failure;
    for (const [stage, count] of Object.entries(this.pending())) {
      assert.equal(count, 0, `sample requires settled ${stage} acknowledgments`);
    }
  }
}

/**
 * Asserts that a cancel-before-headers observation has all five distinct
 * acknowledgments at exactly the expected cumulative count. Each field is a
 * distinct layer of the request lifecycle; a missing counter is not a valid
 * "passing" result.
 */
export function assertCanceledBeforeHeaders(
  observation: { entered: number; aborted: number; settled: number; dispatchSettled: number; transportSettled: number; headersSent: boolean },
  expected: number,
): void {
  assert.equal(observation.entered, expected, "handler entry acknowledgments");
  assert.equal(observation.headersSent, false, "headers must remain uncommitted");
  assert.equal(observation.aborted, expected, "missing handler abort acknowledgment");
  assert.equal(observation.settled, expected, "missing invocation settlement acknowledgment");
  assert.equal(observation.dispatchSettled, expected, "missing server dispatch settlement acknowledgment");
  assert.equal(observation.transportSettled, expected, "missing causal transport cleanup acknowledgment");
}

export interface MidBodyCancellationObservation {
  readerCanceled: number;
  producerSettled: number;
  writerSettled: number;
  dispatchSettled: number;
  transportSettled: number;
  prefix: string;
  suffixWrites: number;
  lockedBodies: number;
  ownedListeners: number;
}

export function assertCanceledAfterPrefix(
  observation: MidBodyCancellationObservation,
  expected: number,
): void {
  assert.equal(observation.readerCanceled, expected, "missing reader cancel acknowledgment");
  assert.equal(observation.producerSettled, expected, "missing producer settlement acknowledgment");
  assert.equal(observation.writerSettled, expected, "missing writer settlement acknowledgment");
  assert.equal(observation.dispatchSettled, expected, "missing server dispatch settlement acknowledgment");
  assert.equal(observation.transportSettled, expected, "missing causal transport cleanup acknowledgment");
  assert.equal(observation.prefix, "retention-prefix\n", "exact authored prefix");
  assert.equal(observation.suffixWrites, 0, "suffix after abort");
  assert.equal(observation.lockedBodies, 0, "retained body lock");
  assert.equal(observation.ownedListeners, 0, "retained response listeners");
}

export function assertRejectedAfterAbort(
  observation: { entered: number; aborted: number; settled: number; dispatchSettled: number; transportSettled: number; headersSent: boolean },
  expected: number,
): void {
  assert.equal(observation.entered, expected, "handler entry acknowledgments");
  assert.equal(observation.headersSent, false, "headers must remain uncommitted on rejection after abort");
  assert.equal(observation.aborted, expected, "missing handler abort acknowledgment");
  assert.equal(observation.settled, expected, "missing invocation settlement acknowledgment");
  assert.equal(observation.dispatchSettled, expected, "missing server dispatch settlement acknowledgment");
  assert.equal(observation.transportSettled, expected, "missing causal transport cleanup acknowledgment");
}

export interface FixedFailedImportObservation {
  faultAttempts: number;
  faultErrors: number;
  recoveredRequests: number;
  dispatchSettled: number;
  transportSettled: number;
}

export function assertFixedFailedImport(
  observation: FixedFailedImportObservation,
  expected: { faults: number; recovered: number },
): void {
  assert.equal(observation.faultAttempts, expected.faults, "fault attempt acknowledgments");
  assert.equal(observation.faultErrors, expected.faults, "fault 500 error responses");
  assert.equal(observation.recoveredRequests, expected.recovered, "recovered healthy responses");
  assert.equal(observation.dispatchSettled, expected.faults + expected.recovered, "dispatch settlement acknowledgments");
  assert.equal(observation.transportSettled, expected.faults + expected.recovered, "transport cleanup acknowledgments");
}

/**
 * The existing child command lifecycle, shared with deterministic failure controls (packet R2).
 */
export type RetentionStage = "dispatch" | "transport" | "tls";
export type RetentionPending = Record<RetentionStage, number>;

/** Test-owned acknowledgments, shared by calibration and the actual child sampler. */
export class RetentionSettlement {
  private owners: Record<RetentionStage, Set<Promise<void>>> = {
    dispatch: new Set(), transport: new Set(), tls: new Set(),
  };
  private holds = new Map<RetentionStage, {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
    consumed: boolean;
  }>();
  private failure: unknown;

  pending(): RetentionPending {
    return { dispatch: this.owners.dispatch.size, transport: this.owners.transport.size, tls: this.owners.tls.size };
  }

  hold(stage: RetentionStage): void {
    assert(!this.holds.has(stage), `already holding ${stage}`);
    this.holds.set(stage, { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), consumed: false });
  }

  track(stage: RetentionStage, work: PromiseLike<unknown>): void {
    const candidate = this.holds.get(stage);
    const hold = candidate && !candidate.consumed ? candidate : undefined;
    if (hold) hold.consumed = true;
    const settled = Promise.resolve(work).then(async () => {
      if (hold) {
        hold.entered.resolve();
        await hold.release.promise;
      }
    }).catch(error => {
      this.failure ??= error;
      hold?.entered.resolve();
    }).finally(() => this.owners[stage].delete(settled));
    this.owners[stage].add(settled);
  }

  async entered(stage: RetentionStage): Promise<void> {
    const hold = this.holds.get(stage);
    assert(hold?.consumed, `no actual ${stage} owner consumed the hold`);
    await hold.entered.promise;
    if (this.failure) throw this.failure;
  }

  release(stage: RetentionStage): void {
    const hold = this.holds.get(stage);
    assert(hold, `no ${stage} hold to release`);
    hold.release.resolve();
    this.holds.delete(stage);
  }

  releaseAll(): void {
    for (const stage of this.holds.keys()) this.release(stage);
  }

  async join(except?: RetentionStage): Promise<void> {
    for (const stage of ["dispatch", "transport", "tls"] as const) {
      if (stage !== except) await Promise.all(this.owners[stage]);
    }
    if (this.failure) throw this.failure;
  }

  assertSettled(): void {
    if (this.failure) throw this.failure;
    for (const [stage, count] of Object.entries(this.pending())) {
      assert.equal(count, 0, `sample requires settled ${stage} acknowledgments`);
    }
  }
}

export class RetentionIpcWaiters {
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }>();
  private failure?: Error;

  get size() { return this.pending.size; }
  assertIdle() { assert.equal(this.size, 0, "pending IPC waiter"); }
  readonly onError = (error: Error) => this.fail(error);
  readonly onExit = (code: number | null, signal: NodeJS.Signals | null) =>
    this.fail(new Error(`retention child exited: ${code}/${signal}`));

  wait<Result>(id: number, action: string): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure);
    assert(!this.pending.has(id), "duplicate IPC command identity");
    return new Promise<Result>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`retention ${action} deadline exceeded`));
      }, 20_000);
      this.pending.set(id, { resolve: value => resolveResult(value as Result), reject, timer });
    });
  }

  reply(message: { id?: number; error?: string; result?: unknown; }) {
    if (message.id === undefined) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.result);
  }

  fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.pending.clear();
  }
}

/**
 * Validates that an unsupported Node runtime environment or missing _destroySSL prototype throws.
 */
export function assertSupportedTlsCleanupRuntime(
  version = process.version,
  prototype: unknown = tls.TLSSocket.prototype,
): void {
  assert(
    version.startsWith("v24."),
    `causal TLS transport cleanup acknowledgment requires the verified Node 24 callback ordering (got ${version})`,
  );
  const proto = prototype as { _destroySSL?: unknown } | null | undefined;
  assert(
    typeof proto?._destroySSL === "function",
    "tls.TLSSocket.prototype._destroySSL must exist to support causal TLS cleanup acknowledgment",
  );
}

/**
 * Fixed-content production batch options (packet 113C / R2). Production-only: an explicit warmup
 * request count followed by two equal measured request batches, cycling the same three fixed
 * routes sequentially (bounded concurrency 1). Rejected outside `mode !== "dev"`.
 */
export interface FixedProductionBatchOptions {
  warmupRequests: number;
  measuredBatchSize: number;
  testMode?: "negative-dispatch" | "negative-tls" | "calibration-identity";
}

/**
 * Cancel-before-headers fault cycle options (packet R3, row 1). Production-only:
 * exactly 10 smoke cycles then 100 measured cycles, each cycle sending one cancel
 * request followed by one healthy request. Concurrency is 1.
 */
export interface BeforeHeadersCancellationOptions {
  fault: "cancel-before-headers";
  smokeCycles: 10;
  measuredCycles: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch";
}

export interface AfterPrefixCancellationOptions {
  fault: "cancel-after-exact-prefix";
  smokeCycles: 10;
  measuredCycles: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch";
}

export interface RejectAfterAbortCancellationOptions {
  fault: "reject-after-acknowledged-abort";
  smokeCycles: 10;
  measuredCycles: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch";
}

export interface FixedFailedImportOptions {
  fault: "fixed-failed-import";
  smokeCycles: 10;
  measuredCycles: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch";
}

export interface StaticAssetOptions {
  input: "static-asset";
  smokeCycles: 2;
  measuredRevisions: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch";
}

export interface BuildDependencyOptions {
  input: "build-dependency";
  smokeCycles: 2;
  measuredRevisions: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch" | "negative-control" | "held-compilation-regression";
}

export interface DevModuleDeletionRecoveryOptions {
  input: "dev-module-inline" | "dev-module-external" | "dev-module-api";
  smokeCycles: 2;
  measuredRevisions: 100;
  /** Internal negative control: held-dispatch blocks sampling before the first measured batch. */
  testMode?: "negative-dispatch";
}

export interface InlinePageObservation {
  path: string;
  generation: number;
  watchEvent: string;
  publications: string[];
}

/** Generation is the armed test operation, not a public compiler generation getter. */
export function assertInlinePublication(observation: InlinePageObservation, expected: InlinePageObservation): void {
  assert.equal(observation.path, expected.path, "exact inline source path");
  assert.equal(observation.generation, expected.generation, "exact armed generation");
  assert.equal(observation.watchEvent, expected.watchEvent, "exact source watch event");
  assert.deepEqual(observation.publications, expected.publications, "missing inline publication/recovery acknowledgment");
}

const assetSource = (revision: number) => Buffer.concat([Buffer.from(`asset-${String(revision).padStart(3, "0")}\n`), Buffer.from([0, 255, 128, 13, 10])]);

const requestObservation = 'function retentionRequestClosure129() { return request.url; } globalThis[Symbol.for("bascik.retention.observe")](request, context, retentionRequestClosure129);';
export const inlineSource = (revision: number, generation: number) => `<!DOCTYPE html><html><head></head><body><p data-testid="generation">generation-${generation}</p><script data-bascik-server>export default function retentionInline129(request, context) { ${requestObservation} return "inline-${revision}:" + new URL(request.url).searchParams.get("request"); }</script></body></html>`;

const apiRouteSource = (revision: number) => `import { revision as helper } from "./helper.mjs";
export function GET(request, context) {
  ${requestObservation}
  const params = new URL(request.url).searchParams;
  const payload = { revision: ${revision}, helper, request: params.get("request") };
  if (params.get("format") === "json") return Response.json(payload);
  const chunks = ["api-" + payload.revision + ":", payload.request + ":helper-" + helper + "\\n", "complete\\n"];
  return new Response(new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
      else controller.close();
    }
  }), { headers: { "content-type": "text/plain; charset=utf-8" } });
}`;

// Independent fixture expectations, never derived from a received page or disk output.
const expectedInlineOutput = (revision: number, request?: string) => {
  const content = request === undefined
    ? '<script type="text/bascik-server" data-bascik-server-id="server_script_70616765732f696e6c696e652e68746d6c3a3a31"></script>'
    : `inline-${revision}:${request}`;
  return Buffer.from(`<!DOCTYPE html><html><head></head><body><p data-testid="generation">generation-${revision}</p>${content}${getLiveReloadScript()}</body></html>`);
};

// Literal fixture markup: the `<script>` tags are constant authored HTML, not interpolated values. The two write
// sites below carry an exact-rule exception because the analyzer taints the destination path, not the HTML.
const externalPageSource = '<!DOCTYPE html><html><head></head><body><script data-bascik-server src="../lib/handler.mjs"></script></body></html>';
const realisticExternalPageSource = '<!DOCTYPE html><html><head></head><body><script data-bascik-server src="../lib/handler.mjs"></script><retention-shared></retention-shared></body></html>';

export const retentionHelperPaths = (realistic: boolean): string[] => realistic
  ? Array.from({ length: 10 }, (_, chain) => {
    const root = chain === 9 ? "api" : "src/lib";
    const name = chain === 1 || chain === 9 ? "helper" : `helper-${chain}`;
    return [join(root, `${name}.mjs`), join(root, `${name}-middle.mjs`), join(root, `${name}-leaf.mjs`)];
  }).flat()
  : ["src/lib/helper.mjs", "api/helper.mjs"];

export async function runRetentionExperiment(directory: string, changing: boolean, generations: number, mode: "dev" | "http1" | "http2" = "dev", realistic = false, options?: FixedProductionBatchOptions | BeforeHeadersCancellationOptions | AfterPrefixCancellationOptions | RejectAfterAbortCancellationOptions | FixedFailedImportOptions | StaticAssetOptions | BuildDependencyOptions | DevModuleDeletionRecoveryOptions): Promise<RetentionCheckpoint[]> {
  const staticAssetOptions = options && "input" in options && options.input === "static-asset" ? options : undefined;
  const buildDepOptions = options && "input" in options && options.input === "build-dependency" ? options : undefined;
  const devModuleOptions = options && "input" in options && (options.input === "dev-module-inline" || options.input === "dev-module-external" || options.input === "dev-module-api") ? options : undefined;
  const externalHelper = devModuleOptions?.input === "dev-module-external";
  const apiRoute = devModuleOptions?.input === "dev-module-api";
  const fixedProductionBatch = options && "warmupRequests" in options ? options : undefined;
  const beforeHeadersCancellation = options && "fault" in options && options.fault === "cancel-before-headers" ? options : undefined;
  const afterPrefixCancellation = options && "fault" in options && options.fault === "cancel-after-exact-prefix" ? options : undefined;
  const rejectAfterAbortCancellation = options && "fault" in options && options.fault === "reject-after-acknowledged-abort" ? options : undefined;
  const fixedFailedImportFault = options && "fault" in options && options.fault === "fixed-failed-import" ? options : undefined;
  assert(Number.isInteger(generations) && generations >= 2 && generations <= 100 && generations % 2 === 0, "generations must be even, 2..100");
  assert(mode === "dev" || !changing, "production captures require stable source");
  if (devModuleOptions) {
    assert(mode === "dev" && !realistic, "dev module deletion/recovery requires the small dev fixture");
    assert.equal(devModuleOptions.smokeCycles, 2, "dev module deletion/recovery requires exactly 2 smoke cycles");
    assert.equal(devModuleOptions.measuredRevisions, 100, "dev module deletion/recovery requires exactly 100 measured revisions");
  }
  if (staticAssetOptions) {
    assert(mode === "dev" && !realistic, "asset lifecycle requires the small dev fixture");
    assert.equal(staticAssetOptions.smokeCycles, 2, "asset lifecycle requires exactly 2 smoke cycles");
    assert.equal(staticAssetOptions.measuredRevisions, 100, "asset lifecycle requires exactly 100 measured revisions");
  }
  if (buildDepOptions) {
    assert(mode === "dev" && !realistic, "build dependency lifecycle requires the small dev fixture");
    assert.equal(buildDepOptions.smokeCycles, 2, "build dependency lifecycle requires exactly 2 smoke cycles");
    assert.equal(buildDepOptions.measuredRevisions, 100, "build dependency lifecycle requires exactly 100 measured revisions");
  }
  if (beforeHeadersCancellation) {
    assert(mode !== "dev", "cancel-before-headers fault requires production mode");
    assert(!realistic, "cancel-before-headers fault requires small fixed production source");
    assert.equal(beforeHeadersCancellation.smokeCycles, 10, "cancel-before-headers requires exactly 10 smoke cycles");
    assert.equal(beforeHeadersCancellation.measuredCycles, 100, "cancel-before-headers requires exactly 100 measured cycles");
  }
  if (afterPrefixCancellation) {
    assert(mode !== "dev", "cancel-after-exact-prefix fault requires production mode");
    assert(!realistic, "cancel-after-exact-prefix fault requires small fixed production source");
    assert.equal(afterPrefixCancellation.smokeCycles, 10, "cancel-after-exact-prefix requires exactly 10 smoke cycles");
    assert.equal(afterPrefixCancellation.measuredCycles, 100, "cancel-after-exact-prefix requires exactly 100 measured cycles");
  }
  if (rejectAfterAbortCancellation) {
    assert(mode !== "dev", "reject-after-acknowledged-abort fault requires production mode");
    assert(!realistic, "reject-after-acknowledged-abort fault requires small fixed production source");
    assert.equal(rejectAfterAbortCancellation.smokeCycles, 10, "reject-after-acknowledged-abort requires exactly 10 smoke cycles");
    assert.equal(rejectAfterAbortCancellation.measuredCycles, 100, "reject-after-acknowledged-abort requires exactly 100 measured cycles");
  }
  if (fixedFailedImportFault) {
    assert(mode !== "dev", "fixed-failed-import fault requires production mode");
    assert(!realistic, "fixed-failed-import fault requires small fixed production source");
    assert.equal(fixedFailedImportFault.smokeCycles, 10, "fixed-failed-import requires exactly 10 smoke cycles");
    assert.equal(fixedFailedImportFault.measuredCycles, 100, "fixed-failed-import requires exactly 100 measured cycles");
  }
  if (fixedProductionBatch) {
    assert(mode !== "dev", "fixed production batch options are production-only; dev is not yet supported");
    assert(Number.isInteger(fixedProductionBatch.warmupRequests) && fixedProductionBatch.warmupRequests > 0, "fixed production batch requires a positive warmup request count");
    assert(Number.isInteger(fixedProductionBatch.measuredBatchSize) && fixedProductionBatch.measuredBatchSize > 0, "fixed production batch requires a positive measured batch size");
  }
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  directory = await validatePrivateDirectory(directory, [repository]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(directory, [repository]);
  assert.equal((await readdir(directory)).length, 0, "retention report directory must be empty");
  const sourceHashes = Object.fromEntries(await Promise.all([
    "script-registry.ts", "module-graph.ts", "server-scripts.ts", "api-runtime.ts", "watch.ts", "watch-source.ts", "source-cycle.ts", "mem.ts", "server-sidecar.ts",
    "module-retention.test-helper.ts", "module-retention-subject.test-helper.ts", "module-retention-heap.test-helper.ts",
  ].map(async file => [file, digest(await readFile(new URL(file, import.meta.url)))])));
  const metadata = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    runtime: process.versions, platform: process.platform, arch: process.arch,
    mode, changing, generations, realistic, options, sourceHashes, directory, startedAt: new Date().toISOString(),
    safeguards: { subjectMilliseconds: 300_000, heapBytes: 256 * 1024 * 1024, rssBytes: 768 * 1024 * 1024 },
    limitation: "Bounded fixture evidence, not a whole-heap dominator analysis, production soak, or approved lifetime policy",
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...metadata, success: false }, null, 2), { mode: 0o600 });
  const project = join(directory, "project");
  for (const subdirectory of ["src/pages", "src/components", "src/lib", "api", "scripts"]) await mkdir(join(project, subdirectory), { recursive: true });
  const listener = net.createServer();
  await new Promise<void>((resolveReady, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolveReady); });
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolveClosed, reject) => listener.close(error => error ? reject(error) : resolveClosed()));
  const trust = mode === "http2" ? await createFixtureTrust(join(project, "tls"), ["127.0.0.1"]) : undefined;
  const fixtureCa = trust ? await readFile(trust.caPath) : undefined;
  await writeFile(join(project, "bascik.config.ts"), `export default ${JSON.stringify({
    directory: { pages: "src/pages", components: "src/components", out: "dist", api: "api" },
    pipeline: {
      workers: false,
      ...(buildDepOptions ? { watchPaths: ["src/lib/build-helper.ts"] } : {}),
      ...(externalHelper ? { watchPaths: ["src/lib"] } : {}),
      exec: buildDepOptions ? [] : [{ script: "scripts/post.mjs", phase: "post", watch: ["src/pages/**/*.html", "src/components/**/*.html"] }],
    },
    minify: false, http: { hostname: "127.0.0.1", port, tls: trust ? { enabled: true, keyFile: "tls/server-key.pem", certFile: "tls/server.pem" } : { enabled: false }, rateLimit: false },
    logging: { level: "error" }, generate: { sitemap: false, robots: false },
  })};`);
  await writeFile(join(project, "scripts/post.mjs"), 'import { mkdir, writeFile } from "node:fs/promises"; await mkdir("dist", {recursive:true}); await writeFile("dist/post.json", "{\\"complete\\":true}");');
  if (buildDepOptions) {
    await writeFile(join(project, "src/lib/build-helper.ts"), "export const buildNumber = 0;");
    await writeFile(join(project, "src/pages/inline.html"), `<!DOCTYPE html><html><head></head><body><p data-testid="generation">generation-0</p><p data-testid="build-dep"><script data-bascik-build>import { buildNumber } from '@/lib/build-helper.ts'; console.log('build-' + buildNumber);</script></p><script data-bascik-server>export default function retentionInline129(request, context) { ${requestObservation} return "inline-0:" + new URL(request.url).searchParams.get("request"); }</script></body></html>`);
  } else {
    await writeFile(join(project, "src/pages/inline.html"), inlineSource(0, 0));
  }
  if (staticAssetOptions) await writeFile(join(project, "src/pages/asset.txt"), assetSource(0));
  await writeFile(join(project, "src/pages/external.html"), externalPageSource); // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- `project` is the private fixture destination path; the HTML is a literal constant
  if (externalHelper) await writeFile(join(project, "src/pages/external.html"), '<!DOCTYPE html><html><head></head><body><script data-bascik-build>import { revision } from "@/lib/helper.mjs"; console.log("src-" + revision);</script></body></html>');
  await writeFile(join(project, "src/lib/handler.mjs"), `import {revision} from "./helper.mjs"; export default function retentionSrc129(request, context) { ${requestObservation} return "src-" + revision + ":" + new URL(request.url).searchParams.get("request"); }`);
  await writeFile(join(project, "api/probe.mjs"), `import {revision} from "./helper.mjs"; export function GET(request, context) { ${requestObservation} return new Response("api-" + revision + ":" + new URL(request.url).searchParams.get("request")); }`);
  const originalApiRoute = apiRouteSource(0);
  if (apiRoute) await writeFile(join(project, "api/probe.mjs"), originalApiRoute);
  for (const path of ["src/lib/helper.mjs", "api/helper.mjs"]) await writeFile(join(project, path), 'export const revision = 0;');
  if (beforeHeadersCancellation) {
    // The fault API handler calls the child-installed cancel global on entry so the parent can
    // gate the abort precisely. It never sends headers; it returns only after abort is observed.
    // Notice that standard Bascik API routes receive (request, context, { signal }) as their 3 arguments!
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- `project` is the private fixture destination path; the JS is a literal constant
    await writeFile(join(project, "api/fault.mjs"), `export async function GET(request, _context, { signal }) {
  const cancel = globalThis[Symbol.for("bascik.retention.cancel")];
  const token = new URL(request.url).searchParams.get("cancel");
  if (!cancel || !token) return new Response("no-cancel-token", { status: 400 });
  cancel("entered", token);
  try {
    const abortSignal = signal || request.signal;
    if (abortSignal.aborted) {
      cancel("aborted", token);
    } else {
      await new Promise(resolve => abortSignal.addEventListener("abort", resolve, { once: true }));
      cancel("aborted", token);
    }
  } finally {
    cancel("settled", token);
  }
  return new Response(null, { status: 499 });
}`);
  }
  if (afterPrefixCancellation) {
    // R3 row 2: cancel-after-exact-prefix.
    // Authored streaming handler yields exact prefix chunk, awaits pull-pending gate,
    // and settles producer and reader cleanly on client abort.
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- `project` is the private fixture destination path; the JS is a literal constant
    await writeFile(join(project, "api/fault-prefix.mjs"), `export async function GET(request, _context, { signal }) {
  const cancel = globalThis[Symbol.for("bascik.retention.cancel")];
  const token = new URL(request.url).searchParams.get("cancel");
  if (!cancel || !token) return new Response("no-cancel-token", { status: 400 });
  const gate = Promise.withResolvers();
  let first = true;
  let canceled = false;
  const body = new ReadableStream({
    async pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(new TextEncoder().encode("retention-prefix\\n"));
        return;
      }
      cancel("pull-pending", token);
      await gate.promise;
      if (!canceled) {
        controller.enqueue(new TextEncoder().encode("forbidden-suffix"));
        controller.close();
      }
      cancel("producer-settled", token);
    },
    cancel() {
      canceled = true;
      gate.resolve();
      cancel("reader-canceled", token);
    }
  }, { highWaterMark: 0 });
  cancel("body", token, body);
  cancel("entered", token);
  return new Response(body);
}`);
  }
  if (rejectAfterAbortCancellation) {
    // R3 row 3: reject after acknowledged abort.
    // Authored handler calls cancel global on entry, awaits abort, and rejects with exact Error.
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- `project` is the private fixture destination path; the JS is a literal constant
    await writeFile(join(project, "api/fault-reject.mjs"), `export async function GET(request, _context, { signal }) {
  const cancel = globalThis[Symbol.for("bascik.retention.cancel")];
  const token = new URL(request.url).searchParams.get("cancel");
  if (!cancel || !token) return new Response("no-cancel-token", { status: 400 });
  cancel("entered", token);
  const abortSignal = signal || request.signal;
  if (!abortSignal.aborted) {
    await new Promise(resolve => abortSignal.addEventListener("abort", resolve, { once: true }));
  }
  cancel("aborted", token);
  cancel("settled", token);
  throw new Error("acknowledged-abort-rejection");
}`);
  }
  if (fixedFailedImportFault) {
    // R3 row 4: fixed failed import.
    // Dynamic import route importing target helper. If broken, it catches or fails with 500.
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- `project` is the private fixture destination path; the JS is a literal constant
    await writeFile(join(project, "api/fault-import.mjs"), `export async function GET(request) {
  const url = new URL(request.url);
  const fixed = url.searchParams.get("fixed") === "true";
  try {
    const mod = await import(fixed ? "./probe.mjs" : "./missing-helper-nonexistent.mjs");
    return new Response("imported-ok");
  } catch (error) {
    return new Response("import-failed: " + (error && error.message), { status: 500 });
  }
}`);
  }

  const helperPaths = retentionHelperPaths(realistic);
  const revisions = Array<number>(10).fill(0);
  let inlineRevision = 0;
  let componentRevision = 0;
  let pageGeneration = 0;
  const realisticInline = () => inlineSource(inlineRevision, pageGeneration)
    .replace('export default function retentionInline129', () => 'import { revision as helperRevision } from "@/lib/helper-0.mjs";\nexport default function retentionInline129')
    .replace('return "inline-', () => 'return "helper-" + helperRevision + ":inline-')
    .replace('</body>', () => '<retention-shared></retention-shared></body>');
  const componentSource = () => `<script data-bascik-server>
${Array.from({ length: 7 }, (_, index) => `import { revision as revision${index + 2} } from "@/lib/helper-${index + 2}.mjs";`).join("\n")}
export default function retentionShared129(request, context) { ${requestObservation} return "shared-${componentRevision}:" + [${Array.from({ length: 7 }, (_, index) => `revision${index + 2}`).join(",")}].join(",") + ":" + new URL(request.url).searchParams.get("request"); }
</script>`;
  if (realistic) {
    for (let chain = 0; chain < 10; chain++) {
      const [top, middle, leaf] = helperPaths.slice(chain * 3, chain * 3 + 3);
      await writeFile(join(project, top), `export { revision } from "./${middle.split("/").at(-1)}";`);
      await writeFile(join(project, middle), `export { revision } from "./${leaf.split("/").at(-1)}";`);
      await writeFile(join(project, leaf), 'export const revision = 0;');
    }
    await writeFile(join(project, "src/components/retention-shared.html"), componentSource());
    await writeFile(join(project, "src/pages/inline.html"), realisticInline());
    await writeFile(join(project, "src/pages/external.html"), realisticExternalPageSource); // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- `project` is the private fixture destination path; the HTML is a literal constant
    for (let page = 0; page < 18; page++) {
      await writeFile(join(project, `src/pages/page-${page}.html`), `<!DOCTYPE html><html><head></head><body><p>page-${page}</p><retention-shared></retention-shared></body></html>`);
    }
  }

  const environment = cleanGeneratorEnvironment(process.env);
  for (const key of Object.keys(environment)) if (key.startsWith("BASCIK_") || key.startsWith("VITEST") || key === "NODE_ENV") delete environment[key];
  if (mode !== "dev") await execute([process.execPath, fileURLToPath(new URL("../transpile.ts", import.meta.url)), "--build"], project, join(directory, "build"), environment);
  const faultFlag = beforeHeadersCancellation ? "before-headers" : afterPrefixCancellation ? "after-prefix" : rejectAfterAbortCancellation ? "reject-after-abort" : fixedFailedImportFault ? "fixed-failed-import" : staticAssetOptions ? "static-asset" : buildDepOptions ? "build-dependency" : devModuleOptions ? devModuleOptions.input : "false";
  const child = fork(fileURLToPath(new URL("./module-retention-subject.test-helper.ts", import.meta.url)), [directory, mode, String(realistic), faultFlag], {
    cwd: project, execArgv: ["--expose-gc"], env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const log = createWriteStream(join(directory, "process.log"), { mode: 0o600 });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  let sequence = 0;
  const pending = new RetentionIpcWaiters();
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number | null>();
  const closed = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const closedWatchers: number[] = [];
  const logClosed = Promise.withResolvers<void>();
  const cancellation = Promise.withResolvers<never>();
  const requests = new AbortController();
  let failure: Error | undefined;
  let externalWorkSettled = false;
  let apiWorkSettled = false;
  let apiStageWaiters: {
    path: string;
    generation: number;
    watcher: ReturnType<typeof Promise.withResolvers<void>>;
    invalidation: ReturnType<typeof Promise.withResolvers<void>>;
    reload: ReturnType<typeof Promise.withResolvers<void>>;
  } | undefined;
  let externalStageWaiters: {
    path: string;
    generation: number;
    watcher: ReturnType<typeof Promise.withResolvers<void>>;
    invalidation: ReturnType<typeof Promise.withResolvers<void>>;
  } | undefined;
  void ready.promise.catch(() => {});
  void cancellation.promise.catch(() => {});
  const fail = (error: Error) => {
    failure ??= error;
    if (externalHelper && !externalWorkSettled) requests.abort(failure);
    if (apiRoute && !apiWorkSettled) requests.abort(failure);
    for (const stage of ["watcher", "invalidation", "reload"] as const) apiStageWaiters?.[stage].reject(failure);
    externalStageWaiters?.watcher.reject(failure);
    externalStageWaiters?.invalidation.reject(failure);
    ready.reject(failure);
    pending.fail(failure);
  };
  const onError = (error: Error) => { exited.resolve(null); pending.onError(error); fail(error); };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited.resolve(code);
    pending.onExit(code, signal);
    fail(new Error(`retention child exited: ${code}/${signal}`));
  };
  const onClose = (code: number | null) => {
    exited.resolve(code);
    closed.resolve();
    fail(new Error(`retention child closed: ${code}`));
  };
  const onLogClose = () => logClosed.resolve();
  const onDisconnect = () => disconnected.resolve();
  child.on("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);
  child.once("disconnect", onDisconnect);
  log.on("error", fail);
  log.once("close", onLogClose);
  const onMessage = (message: { id?: number; ready?: boolean; error?: string; result?: unknown; watcherClosed?: number; externalStage?: InlinePageObservation & { stage: string }; apiStage?: InlinePageObservation & { stage: "watcher" | "invalidation" | "reload" }; }) => {
    if (message.watcherClosed !== undefined) closedWatchers.push(message.watcherClosed);
    if (message.apiStage) {
      const stage = message.apiStage;
      writeFileSync(join(directory, "api-stage.json"), JSON.stringify(stage, null, 2), { mode: 0o600 });
      if (apiStageWaiters && stage.path === apiStageWaiters.path && stage.generation === apiStageWaiters.generation) {
        apiStageWaiters[stage.stage].resolve();
      }
    }
    if (message.externalStage) {
      const stage = message.externalStage;
      writeFileSync(join(directory, "external-stage.json"), JSON.stringify(stage, null, 2), { mode: 0o600 });
      if (externalStageWaiters && stage.path === externalStageWaiters.path && stage.generation === externalStageWaiters.generation) {
        if (stage.stage === "watcher") externalStageWaiters.watcher.resolve();
        if (stage.stage === "invalidation") externalStageWaiters.invalidation.resolve();
      }
    }
    if (message.ready) ready.resolve();
    if (message.error && message.id === undefined) fail(new Error(message.error));
    pending.reply(message);
  };
  child.on("message", onMessage);
  const bounded = async <Result>(promise: Promise<Result>, milliseconds: number, label: string): Promise<Result> => {
    let deadline: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`retention ${label} deadline exceeded`)), milliseconds);
      })]);
    } finally { clearTimeout(deadline); }
  };
  const killGroup = async (signal: NodeJS.Signals | 0) => {
    if (!child.pid) return false;
    const deadline = Date.now() + 1000;
    for (; ;) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); return true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        if (code !== "EPERM" || Date.now() >= deadline) throw error;
        await new Promise<void>(resolveTurn => setTimeout(resolveTurn, 20));
      }
    }
  };
  let cleanup: Promise<void> | undefined;
  const cleanupGroup = () => cleanup ??= (async () => {
    if (await killGroup("SIGTERM")) {
      await bounded(closed.promise, 500, "termination grace").catch(() => {});
      await killGroup("SIGKILL");
    }
    await bounded(closed.promise, 1000, "final reap");
    const deadline = Date.now() + 1000;
    while (await killGroup(0)) {
      if (Date.now() >= deadline) throw new Error("retention process group reap deadline exceeded");
      await new Promise<void>(resolveTurn => setTimeout(resolveTurn, 20));
    }
  })();
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    const error = new Error(`retention interrupted by ${signal}`);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    fail(error);
    requests.abort(error);
    cancellation.reject(error);
    void cleanupGroup().catch(fail);
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const experimentDeadline = setTimeout(() => {
    const error = new Error("retention subject deadline exceeded");
    fail(error);
    requests.abort(error);
    cancellation.reject(error);
    void cleanupGroup().catch(fail);
  }, 300_000);
  const command = <Result>(action: string, options: Record<string, unknown> = {}): Promise<Result> => {
    if (failure) return Promise.reject(failure);
    const id = sequence++;
    const waiterPromise = pending.wait<Result>(id, action);
    child.send({ id, action, ...options }, error => { if (error) fail(error); });
    return waiterPromise;
  };
  const bootDeadline = setTimeout(() => fail(new Error("retention boot deadline exceeded")), 20_000);
  const checkpoints: RetentionCheckpoint[] = [];
  const artifacts: { path: string; bytes: number; sha256: string; }[] = [];
  let requestCount = 0;
  const origin = `${mode === "http2" ? "https" : "http"}://127.0.0.1:${port}`;
  async function readResponse(path: string): Promise<{ status: number; text: string; bytes: Buffer; }> {
    if (mode !== "http2") {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]), headers: { connection: "close" } });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, text: bytes.toString("utf8"), bytes };
    }
    const response = await http2Request(origin, path, fixtureCa);
    return { status: response.status, text: response.body.toString("utf8"), bytes: response.body };
  }
  const fixedRoutes: [string, string][] = [["/inline", "inline"], ["/external", "src"], ["/api/probe", "api"]];
  async function requestOne(path: string, label: string, revision: number, generation: number, query = "") {
    const request = String(requestCount++);
    if (apiRoute && label === "api") {
      await verifyApiRoute(revision, request);
      return;
    }
    const response = await readResponse(`${path}?request=${request}${query}`);
    assert.equal(response.status, 200, `${label} status`);
    if (externalHelper && label === "src") {
      assert.deepEqual(response.bytes, expectedExternalOutput(revision), "external helper exact request bytes");
      return;
    }
    const text = response.text;
    assert(text.includes(`${label}-${revision}:${request}`), `${label} completed response: ${text}`);
    if (label === "inline") assert(text.includes(`generation-${generation}</p>`), "published page generation");
    if (devModuleOptions?.input === "dev-module-inline" && label === "inline") {
      assert.deepEqual(response.bytes, expectedInlineOutput(revision, request), "inline exact request bytes");
    }
    if (fixedProductionBatch) {
      const marker = `${label}-${revision}:${request}`;
      const expected = label === "api" ? marker : `<!DOCTYPE html><html><head></head><body>${label === "inline" ? `<p data-testid="generation">generation-${generation}</p>` : ""}${marker}</body></html>`;
      assert.deepEqual(response.bytes, Buffer.from(expected), `${label} exact response bytes`);
    }
  }
  async function requestAll(revision: number, generation: number) {
    if (realistic) {
      const routes = ["/inline", "/external", ...Array.from({ length: 18 }, (_, page) => `/page-${page}`), "/api/probe"];
      for (const path of routes) {
        const request = String(requestCount++);
        const response = await readResponse(`${path}?request=${request}`);
        assert.equal(response.status, 200, `${path} status`);
        const expected = path === "/api/probe"
          ? `api-${revisions[9]}:${request}`
          : `shared-${componentRevision}:${revisions.slice(2, 9).join(",")}:${request}`;
        assert(response.text.includes(expected), `${path} fidelity: expected ${expected}, got ${response.text}`);
        if (path === "/inline") {
          assert(response.text.includes(`helper-${revisions[0]}:inline-${inlineRevision}:${request}`), "inline transitive helper freshness");
          assert(response.text.includes(`generation-${pageGeneration}</p>`), "inline page publication");
        }
        if (path === "/external") assert(response.text.includes(`src-${revisions[1]}:${request}`), "src transitive helper freshness");
      }
      return;
    }
    for (const [path, label] of fixedRoutes) {
      const isTarget = devModuleOptions
        ? (label === "inline" && devModuleOptions.input === "dev-module-inline") ||
        (label === "src" && devModuleOptions.input === "dev-module-external") ||
        (label === "api" && devModuleOptions.input === "dev-module-api")
        : true;
      await requestOne(path, label, isTarget ? revision : 0, isTarget ? generation : 0);
    }
  }
  async function requestFixedBatch(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      const [path, label] = fixedRoutes[index % fixedRoutes.length];
      await requestOne(path, label, 0, 0);
    }
  }
  async function checkpoint(phase: string, completed: number, snapshot = false) {
    checkpoints.push(await command<RetentionCheckpoint>("sample", { phase, completed, snapshot }));
    await writeFile(join(directory, "checkpoints.json"), JSON.stringify({ node: process.version, mode, changing, generations, checkpoints }, null, 2), { mode: 0o600 });
  }
  async function stopSubject(): Promise<void> {
    pending.assertIdle();
    const reply = await command<{ restored: { destroySSL: boolean; createSecureServer: boolean; createServer: boolean; }; watchers: number }>("stop");
    if (fixedProductionBatch || beforeHeadersCancellation || staticAssetOptions || buildDepOptions || devModuleOptions) assert.deepEqual(reply.restored, { destroySSL: true, createSecureServer: true, createServer: true });
    assert.equal(await bounded(Promise.race([exited.promise, cancellation.promise]), 10_000, "shutdown"), 0, "retention child shutdown");
    if (devModuleOptions) {
      await bounded(Promise.all([closed.promise, disconnected.promise]), 1000, "child close and IPC disconnect");
      assert(reply.watchers > 0, "dev fixture must own watchers");
      assert.deepEqual(closedWatchers.sort((a, b) => a - b), Array.from({ length: reply.watchers }, (_, index) => index), "every watcher must finish closing exactly once");
      assert.equal(child.connected, false, "child IPC must disconnect without parent intervention");
      assert.equal(child.exitCode, 0, "child must exit cleanly before fallback cleanup");
      assert.equal(child.signalCode, null, "child must not require signal termination");
      pending.assertIdle();
      await writeFile(join(directory, "shutdown.json"), JSON.stringify({
        watchers: reply.watchers, closedWatchers, connected: child.connected,
        exitCode: child.exitCode, signalCode: child.signalCode, restored: reply.restored,
      }, null, 2), { mode: 0o600 });
    }
  }
  async function edit(path: string, source: string, kind: string) {
    await command("arm", { path, kind, publications: kind === "component" ? 20 : 1 });
    await writeFile(join(project, path), source);
    await command("completed");
  }
  const assetObservations: InlinePageObservation[] = [];
  async function verifyAsset(revision: number, deleted = false) {
    const response = await readResponse("/asset.txt");
    if (deleted) {
      await assert.rejects(readFile(join(project, "dist/asset.txt")), { code: "ENOENT" }, "deleted asset disk output");
      assert.equal(response.status, 404, "deleted asset HTTP status");
      assert.deepEqual(response.bytes, Buffer.from("Not Found"), "deleted asset exact HTTP bytes");
    } else {
      assert.equal(response.status, 200, "asset publication HTTP status");
      assert.deepEqual(response.bytes, assetSource(revision), "asset exact HTTP publication bytes");
      assert.deepEqual(await readFile(join(project, "dist/asset.txt")), assetSource(revision), "asset exact disk publication bytes");
    }
  }
  async function assetTransition(watchEvent: "change" | "unlink" | "add", revision: number) {
    const path = join(project, "src/pages/asset.txt");
    const generation = assetObservations.length + 1;
    const expected = { path, generation, watchEvent, publications: ["asset-changed"] };
    await command("arm", { path, kind: "asset-lifecycle", generation, watchEvent });
    if (watchEvent === "unlink") await unlink(path);
    else await writeFile(path, assetSource(revision));
    const observation = await command<InlinePageObservation>("completed", { generation });
    assertInlinePublication(observation, expected);
    assetObservations.push(observation);
    await writeFile(join(directory, "asset-observations.json"), JSON.stringify(assetObservations, null, 2), { mode: 0o600 });
    await verifyAsset(revision, watchEvent === "unlink");
    await requestAll(0, 0);
    await command("asset-idle");
    pending.assertIdle();
  }
  const depObservations: InlinePageObservation[] = [];
  // Exact served output for the build-dependency fixture. The data-bascik-build script's
  // console.log output (with trailing newline) replaces the script tag; the live-reload script
  // is appended. The data-bascik-server script is NOT executed on disk (inert placeholder), but
  // IS executed at request time (its output replaces the placeholder). Never derived from a
  // received page.
  const expectedBuildDepDiskOutput = (revision: number) => Buffer.from(
    `<!DOCTYPE html><html><head></head><body><p data-testid="generation">generation-0</p><p data-testid="build-dep">build-${revision}\n</p><script type="text/bascik-server" data-bascik-server-id="server_script_70616765732f696e6c696e652e68746d6c3a3a31"></script>${getLiveReloadScript()}</body></html>`,
  );
  const expectedBuildDepHttpOutput = (revision: number) => Buffer.from(
    `<!DOCTYPE html><html><head></head><body><p data-testid="generation">generation-0</p><p data-testid="build-dep">build-${revision}\n</p>inline-0:test-dep${getLiveReloadScript()}</body></html>`,
  );
  async function verifyBuildDep(revision: number, deleted = false) {
    const response = await readResponse("/inline?request=test-dep");
    if (deleted) {
      // In dev server, when a build dependency is unlinked/fails, the page build fails (emits build-error).
      // The dev server retains the last successfully transpiled page in mem store,
      // but dist/inline.html is not overwritten.
      assert.equal(response.status, 200, "deleted build-dependency HTTP status (retains previous build in dev mem)");
      assert.deepEqual(response.bytes, expectedBuildDepHttpOutput(revision), "exact last-good build served during build-error");
    } else {
      assert.equal(response.status, 200, "build-dependency recovery HTTP status");
      assert.deepEqual(response.bytes, expectedBuildDepHttpOutput(revision), "exact build-dependency recovery HTTP bytes");
      const distHtml = await readFile(join(project, "dist/inline.html"), "utf8");
      assert.deepEqual(Buffer.from(distHtml), expectedBuildDepDiskOutput(revision), "exact disk inline.html build-dependency bytes");
    }
  }
  async function buildDepTransition(watchEvent: "change" | "unlink" | "add", revision: number, expectRevision = revision) {
    const path = join(project, "src/lib/build-helper.ts");
    const generation = depObservations.length + 1;
    const expected = { path, generation, watchEvent, publications: watchEvent === "unlink" ? ["build-error"] : ["transpiled"] };
    await command("arm", { path, kind: "build-dependency-lifecycle", generation, watchEvent });
    if (watchEvent === "unlink") await unlink(path);
    else await writeFile(path, `export const buildNumber = ${revision};`);
    const observation = await command<InlinePageObservation>("completed", { generation });
    assertInlinePublication(observation, expected);
    depObservations.push(observation);
    await writeFile(join(directory, "build-dep-observations.json"), JSON.stringify(depObservations, null, 2), { mode: 0o600 });
    await verifyBuildDep(expectRevision, watchEvent === "unlink");
    if (watchEvent !== "unlink") {
      await requestAll(0, 0);
    }
    await command("asset-idle");
    pending.assertIdle();
  }
  const devModuleObservations: InlinePageObservation[] = [];
  const apiStageObservations: { observation: DevChurnStageObservation; held?: DevChurnStage; revision: number; deleted: boolean; }[] = [];
  async function verifyApiRoute(revision: number, request: string, deleted = false) {
    for (const format of ["json", "stream"] as const) {
      const response = await fetch(`${origin}/api/probe?request=${encodeURIComponent(request)}&format=${format}`, {
        signal: AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
        headers: { connection: "close" },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, deleted ? 404 : 200, `API ${format} exact status`);
      if (deleted) {
        assert.deepEqual(bytes, Buffer.from("Not Found"), `deleted API ${format} exact bytes`);
      } else {
        assert.equal(response.headers.get("content-type"), format === "json" ? "application/json" : "text/plain; charset=utf-8");
        const expected = format === "json"
          ? JSON.stringify({ revision, helper: 0, request })
          : `api-${revision}:${request}:helper-0\ncomplete\n`;
        assert.deepEqual(bytes, Buffer.from(expected), `API ${format} exact revision/request bytes`);
      }
    }
  }
  async function apiRouteTransition(watchEvent: "change" | "unlink" | "add", revision: number) {
    const path = join(project, "api/probe.mjs");
    const generation = devModuleObservations.length + 1;
    const oracle = new DevStageOracle(path, generation);
    const stages: DevChurnStage[] = ["watcher", "invalidation", "reload", "request", "transport", "ipc"];
    const held = stages[generation - 1];
    apiStageWaiters = { path, generation, watcher: Promise.withResolvers<void>(), invalidation: Promise.withResolvers<void>(), reload: Promise.withResolvers<void>() };
    const diagnose = (stage: string) => writeFileSync(join(directory, "api-stage.json"), JSON.stringify({
      path, generation, watchEvent, revision, stage, pending: oracle.pending(),
    }, null, 2), { mode: 0o600 });
    if (held) oracle.hold(held);
    for (const stage of ["watcher", "invalidation", "reload"] as const) oracle.track(stage, apiStageWaiters[stage].promise);
    try {
      diagnose("arm");
      await command("arm", { path, kind: "dev-module-lifecycle", generation, watchEvent });
      if (watchEvent === "unlink") await unlink(path);
      else await writeFile(path, revision === 0 ? originalApiRoute : apiRouteSource(revision));
      const completion = command<InlinePageObservation>("completed", { generation });
      oracle.track("ipc", completion);
      diagnose("completed IPC pending");
      const observation = await completion;
      assertInlinePublication(observation, { path, generation, watchEvent, publications: ["api-route-changed"] });
      devModuleObservations.push(observation);
      await writeFile(join(directory, "dev-module-observations.json"), JSON.stringify(devModuleObservations, null, 2), { mode: 0o600 });
      const verification = (async () => {
        // First requests after the route-table acknowledgment, with no polling or warmup.
        await verifyApiRoute(revision, `generation-${generation}`, watchEvent === "unlink");
        if (watchEvent === "unlink") await assert.rejects(readFile(path), { code: "ENOENT" });
        else assert.equal(await readFile(path, "utf8"), revision === 0 ? originalApiRoute : apiRouteSource(revision));
        const inline = await readResponse("/inline?request=healthy-api");
        assert.equal(inline.status, 200);
        assert.deepEqual(inline.bytes, expectedInlineOutput(0, "healthy-api"));
        const external = await readResponse("/external?request=healthy-api");
        assert.equal(external.status, 200);
        assert.deepEqual(external.bytes, Buffer.from(`<!DOCTYPE html><html><head></head><body>src-0:healthy-api${getLiveReloadScript()}</body></html>`));
      })();
      oracle.track("request", verification);
      diagnose("request pending");
      await verification;
      const transport = command("asset-idle");
      oracle.track("transport", transport);
      diagnose("transport pending");
      await transport;
      pending.assertIdle();
      if (held) {
        await bounded(oracle.entered(held), 10_000, `API ${held} hold`);
        await bounded(oracle.join(held), 10_000, `API other stages while holding ${held}`);
        assert.throws(() => oracle.assertSettled(), new RegExp(`sample requires settled ${held} acknowledgments`));
        assert.equal(oracle.pending()[held], 1);
        oracle.release(held);
      }
      await bounded(oracle.join(), 10_000, "API stage settlement");
      oracle.assertSettled();
      diagnose("settled");
      apiStageObservations.push({ observation: oracle.observation(), held, revision, deleted: watchEvent === "unlink" });
      await writeFile(join(directory, "api-stages.json"), JSON.stringify(apiStageObservations, null, 2), { mode: 0o600 });
    } finally {
      oracle.releaseAll();
      for (const stage of ["watcher", "invalidation", "reload"] as const) apiStageWaiters[stage].reject(new Error("API observation ended before stage acknowledgment"));
      apiStageWaiters = undefined;
    }
  }
  const externalStageObservations: { observation: DevChurnStageObservation; held?: DevChurnStage; sseGeneration?: number; }[] = [];
  let lastExternalSseGeneration = 0;
  const expectedExternalOutput = (revision: number) => Buffer.from(`<!DOCTYPE html><html><head></head><body>src-${revision}\n${getLiveReloadScript()}</body></html>`);
  let externalPublishedRevision = 0;
  async function verifyDevModule(revision: number, deleted = false) {
    if (devModuleOptions?.input === "dev-module-inline") {
      const response = await readResponse("/inline?request=test-inline");
      if (deleted) {
        assert.equal(response.status, 404, "deleted inline page HTTP status");
        assert.deepEqual(response.bytes, Buffer.from("Not Found"), "deleted inline page exact response bytes");
        await assert.rejects(readFile(join(project, "dist/inline.html")), { code: "ENOENT" }, "deleted inline page dist output");
      } else {
        assert.equal(response.status, 200, "inline page HTTP status");
        assert.deepEqual(response.bytes, expectedInlineOutput(revision, "test-inline"), "inline exact response bytes");
        assert.deepEqual(await readFile(join(project, "dist/inline.html")), expectedInlineOutput(revision), "inline exact disk bytes");
      }
    } else if (devModuleOptions?.input === "dev-module-external") {
      const response = await readResponse("/external?request=test-external");
      assert.equal(response.status, 200, "external helper page HTTP status");
      const expected = expectedExternalOutput(deleted ? externalPublishedRevision : revision);
      assert.deepEqual(response.bytes, expected, "external helper exact response bytes");
      assert.deepEqual(await readFile(join(project, "dist/external.html")), expected, "external helper exact disk bytes");
      if (!deleted) externalPublishedRevision = revision;
    } else if (devModuleOptions?.input === "dev-module-api") {
      await verifyApiRoute(revision, "test-api", deleted);
    }
  }
  async function devModuleTransition(watchEvent: "change" | "unlink" | "add", revision: number, expectRevision = revision) {
    if (apiRoute) return apiRouteTransition(watchEvent, expectRevision);
    const isInline = devModuleOptions?.input === "dev-module-inline";
    const isExternal = devModuleOptions?.input === "dev-module-external";
    const path = isInline
      ? join(project, "src/pages/inline.html")
      : isExternal
        ? join(project, "src/lib/helper.mjs")
        : join(project, "api/helper.mjs");
    const generation = devModuleObservations.length + 1;
    const expectedPub = isInline
      ? watchEvent === "unlink" ? ["transpiled:pages/external.html"]
        : watchEvent === "add" ? ["transpiled:pages/external.html", "transpiled:pages/inline.html"]
          : ["transpiled:pages/inline.html"]
      : watchEvent === "unlink"
        ? (isExternal ? ["build-error"] : [])
        : (devModuleOptions?.input === "dev-module-api" ? ["api-route-changed"] : ["transpiled"]);
    const expected = { path, generation, watchEvent, publications: expectedPub };
    const stages: DevChurnStage[] = ["watcher", "invalidation", "reload", "request", "transport", "ipc"];
    const oracle = isExternal ? new DevStageOracle(path, generation) : undefined;
    const held = isExternal ? stages[generation - 1] : undefined;
    if (oracle) {
      externalStageWaiters = { path, generation, watcher: Promise.withResolvers<void>(), invalidation: Promise.withResolvers<void>() };
      if (held) oracle.hold(held);
      oracle.track("watcher", externalStageWaiters.watcher.promise);
      oracle.track("invalidation", externalStageWaiters.invalidation.promise);
    }
    try {
      await command("arm", { path, kind: "dev-module-lifecycle", generation, watchEvent });
      const sse = isExternal ? await fetch(`${origin}/bascik-live-reload`, {
        signal: AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
        headers: { referer: `${origin}/external`, connection: "close" },
      }) : undefined;
      const reader = sse?.body?.getReader();
      let sseBuffer = "";
      const nextFrame = async () => {
        assert(reader, "external helper SSE reader");
        while (!sseBuffer.includes("\n\n")) {
          const chunk = await reader.read();
          assert(!chunk.done, "external helper SSE ended before publication");
          sseBuffer += Buffer.from(chunk.value).toString("utf8");
          assert(sseBuffer.length < 64 * 1024, "bounded external helper SSE frame");
        }
        const index = sseBuffer.indexOf("\n\n");
        const frame = sseBuffer.slice(0, index);
        sseBuffer = sseBuffer.slice(index + 2);
        return frame;
      };
      try {
        if (reader) {
          assert.equal(sse!.status, 200, "external helper SSE admission");
          assert.equal(await nextFrame(), "data: connected", "SSE armed before helper mutation");
        }
        if (watchEvent === "unlink") {
          await unlink(path);
        } else if (isInline) {
          await writeFile(path, inlineSource(revision, revision));
        } else {
          await writeFile(path, `export const revision = ${revision};`);
        }
        const completion = command<InlinePageObservation>("completed", { generation });
        oracle?.track("ipc", completion);
        const observation = await completion;
        assertInlinePublication(observation, expected);
        if (reader) {
          const publication = (async () => {
            // SSE comment heartbeats carry no application event. Consume protocol
            // framing, not a retry of a failed publication assertion.
            let frame = await nextFrame();
            while (frame.startsWith(":")) frame = await nextFrame();
            if (watchEvent === "unlink") {
              assert(frame.startsWith("event: build-error\ndata: "), "actual SSE build error publication");
              const error = JSON.parse(frame.slice("event: build-error\ndata: ".length));
              assert(error.message.includes("helper.mjs"), "SSE error identifies missing helper");
            } else {
              assert.match(frame, /^data: reload \d+$/, "actual SSE recovery publication");
              const actualGeneration = Number(frame.slice("data: reload ".length));
              assert.equal(actualGeneration, lastExternalSseGeneration + 1, "exact external SSE publication generation");
              lastExternalSseGeneration = actualGeneration;
            }
          })();
          oracle?.track("reload", publication);
          await publication;
        }
        devModuleObservations.push(observation);
        await writeFile(join(directory, "dev-module-observations.json"), JSON.stringify(devModuleObservations, null, 2), { mode: 0o600 });
        const requestVerification = verifyDevModule(expectRevision, watchEvent === "unlink");
        oracle?.track("request", requestVerification);
        await requestVerification;
        if (isInline && watchEvent === "unlink") {
          await requestOne("/external", "src", 0, 0);
          await requestOne("/api/probe", "api", 0, 0);
        }
        if (watchEvent !== "unlink") {
          if (isInline) {
            await requestAll(expectRevision, expectRevision);
          } else {
            await requestAll(isExternal ? expectRevision : 0, isExternal ? expectRevision : 0);
          }
        }
      } finally {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      const transport = command("asset-idle");
      oracle?.track("transport", transport);
      await transport;
      pending.assertIdle();
      if (oracle) {
        if (held) {
          await oracle.entered(held);
          await oracle.join(held);
          assert.throws(() => oracle.assertSettled(), new RegExp(`sample requires settled ${held} acknowledgments`));
          assert.equal(oracle.pending()[held], 1, "held actual external owner acknowledgment");
          oracle.release(held);
        }
        await oracle.join();
        oracle.assertSettled();
        const observation = oracle.observation();
        assertDevChurnStages(observation, { path, generation });
        externalStageObservations.push({ observation, held, sseGeneration: watchEvent === "unlink" ? undefined : lastExternalSseGeneration });
        await writeFile(join(directory, "external-stages.json"), JSON.stringify(externalStageObservations, null, 2), { mode: 0o600 });
      }
    } finally {
      oracle?.releaseAll();
      externalStageWaiters = undefined;
    }
  }
  try {
    await ready.promise;
    clearTimeout(bootDeadline);
    if (fixedProductionBatch) {
      if (fixedProductionBatch.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestOne(fixedRoutes[0][0], fixedRoutes[0][1], 0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 1, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }

      if (fixedProductionBatch.testMode === "negative-tls") {
        await command("hold-next-tls-cleanup");
        await requestOne(fixedRoutes[0][0], fixedRoutes[0][1], 0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["tls"] },
        );
        assert.deepEqual(blockedReport, { blocked: "tls", pending: { dispatch: 0, transport: 0, tls: 1 } });
        await command("release-held-tls-cleanup");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 1, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }

      if (fixedProductionBatch.testMode === "calibration-identity") {
        await requestFixedBatch(fixedProductionBatch.warmupRequests);
        // sample joins all dispatches and transports (including scheduled destroySSL)
        const joined = await command<RetentionCheckpoint>("sample", { phase: "calibration-join", completed: 0, snapshot: false });
        assert.deepEqual(joined.pending, { dispatch: 0, transport: 0, tls: 0 });

        const initialCal = await command<{
          hookInstalled: boolean;
          secureConnections: number;
          destroyedFixtureSockets: number;
          foreignDestroyCalls: number;
          serverIdentityMismatches: number;
          restored: boolean;
        }>("tls-calibration");
        assert.equal(initialCal.hookInstalled, true);
        assert.equal(initialCal.secureConnections, initialCal.destroyedFixtureSockets);
        assert.equal(initialCal.foreignDestroyCalls, 0);
        assert.equal(initialCal.serverIdentityMismatches, 0);

        await command("tls-calibration-inject-foreign");
        const postInjectCal = await command<typeof initialCal>("tls-calibration");
        assert.equal(postInjectCal.foreignDestroyCalls, 1);
        assert.equal(postInjectCal.destroyedFixtureSockets, initialCal.destroyedFixtureSockets);
        await stopSubject();
        return checkpoints;
      }

      await requestFixedBatch(fixedProductionBatch.warmupRequests);
      await command("prime");

      // Join warmup traffic before testing held dispatch
      const warmupJoined = await command<RetentionCheckpoint>("sample", { phase: "warmup-join", completed: 0, snapshot: false });
      assert.deepEqual(warmupJoined.pending, { dispatch: 0, transport: 0, tls: 0 });

      // Step 1e: Perform negative controls before baseline
      await command("hold-next-dispatch");
      await requestOne(fixedRoutes[0][0], fixedRoutes[0][1], 0, 0);
      const blockedDispatch = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
        "sample",
        { expectPending: ["dispatch"] },
      );
      assert.deepEqual(blockedDispatch, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
      await command("release-held-dispatch");

      if (mode === "http2") {
        await command("hold-next-tls-cleanup");
        await requestOne(fixedRoutes[0][0], fixedRoutes[0][1], 0, 0);
        const blockedTls = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["tls"] },
        );
        assert.deepEqual(blockedTls, { blocked: "tls", pending: { dispatch: 0, transport: 0, tls: 1 } });
        await command("release-held-tls-cleanup");
      }

      // Follow up with a healthy request to join and prove final transport completion
      await requestOne(fixedRoutes[0][0], fixedRoutes[0][1], 0, 0);

      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });
      await requestFixedBatch(fixedProductionBatch.measuredBatchSize);
      await checkpoint("batch-1", fixedProductionBatch.measuredBatchSize);
      await requestFixedBatch(fixedProductionBatch.measuredBatchSize);
      await checkpoint("batch-2", fixedProductionBatch.measuredBatchSize * 2, true);
      if (mode === "http2") {
        const calibration = await command<{
          hookInstalled: boolean; secureConnections: number; destroyedFixtureSockets: number;
          foreignDestroyCalls: number; serverIdentityMismatches: number;
        }>("tls-calibration");
        assert.equal(calibration.hookInstalled, true);
        assert.equal(calibration.secureConnections, requestCount, "every fixed request uses a trusted HTTP/2 connection");
        assert.equal(calibration.destroyedFixtureSockets, requestCount, "every fixture TLS cleanup callback completed");
        assert.equal(calibration.foreignDestroyCalls, 0);
        assert.equal(calibration.serverIdentityMismatches, 0);
      }
    } else if (beforeHeadersCancellation) {
      // R3 row 1: cancel-before-headers fault cycles.
      // Each cycle: arm gate, send fault request (client aborts on handler entry), healthy request.
      // Workload: 10 smoke cycles, checkpoint baseline, 50 measured, checkpoint batch-1, 50 measured, checkpoint batch-2.

      let cancelCount = 0;
      async function faultCycle(): Promise<void> {
        const token = String(cancelCount);
        await command("cancel-arm", { token });
        const entered = command<{ headersSent: boolean }>("cancel-entered", { token });
        void entered.catch(() => {});
        const clientClosed = Promise.withResolvers<void>();
        const sessionClosed = Promise.withResolvers<void>();
        // Observe unexpected headers as a fatal error.
        const transportFailed = Promise.withResolvers<never>();
        void transportFailed.promise.catch(() => {});
        let closing = false;
        const path = `/api/fault?cancel=${token}`;
        const session = mode === "http2" ? http2.connect(origin, { ca: fixtureCa }) : undefined;
        session?.once("error", (err: Error) => { if (!closing) transportFailed.reject(err); });
        session?.once("close", () => sessionClosed.resolve());
        const client = session
          ? session.request({ ":path": path })
          : http.request(`${origin}${path}`, { agent: false });
        client.once("error", (err: NodeJS.ErrnoException) => {
          if (!(closing && mode === "http1" && err.code === "ECONNRESET")) transportFailed.reject(err);
        });
        // Before-headers: any response arriving is unexpected.
        client.once("response", () => transportFailed.reject(new Error("cancel-before-headers received unexpected response")));
        client.once("close", () => clientClosed.resolve());
        client.end();
        try {
          const entry = await Promise.race([entered, transportFailed.promise]);
          assert.equal(entry.headersSent, false, "child entry requires uncommitted headers");
          // Abort the client transport now that entry is confirmed.
          closing = true;
          if (session) {
            (client as http2.ClientHttp2Stream).close(http2.constants.NGHTTP2_CANCEL);
            session.destroy();
          } else {
            (client as http.ClientRequest).destroy();
          }
          // Wait for IPC settlement (dispatch + transport acknowledged) before proceeding.
          const settled = await Promise.race([
            command<{ cancellation: CancellationObservation }>("cancel-settled", { token }),
            transportFailed.promise,
          ]);
          assert.equal(settled.cancellation.entered, cancelCount + 1, "cancel-settled entry count");
          assert.equal(settled.cancellation.aborted, cancelCount + 1, "cancel-settled abort count");
          assert.equal(settled.cancellation.headersSent, false, "cancel-settled headers uncommitted");
          await Promise.race([clientClosed.promise, transportFailed.promise]);
          cancelCount++;
        } finally {
          closing = true;
          (client as http.ClientRequest).destroy();
          session?.destroy();
          try { await bounded(clientClosed.promise, 5_000, "cancel client close"); }
          finally { if (session) await bounded(sessionClosed.promise, 5_000, "cancel session close"); }
        }
        // Healthy request after each cancel cycle: proves server recovery.
        await requestOne("/api/probe", "api", 0, 0);
        await command("cancel-healthy");
        pending.assertIdle();
      }

      // Held-dispatch negative control for R3 (mirrors R2 warmup control).
      if (beforeHeadersCancellation.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestOne("/api/probe", "api", 0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }

      // 10 smoke cycles (not measured).
      for (let cycle = 0; cycle < beforeHeadersCancellation.smokeCycles; cycle++) await faultCycle();
      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });
      // 50 measured cycles, then sample.
      for (let cycle = 0; cycle < beforeHeadersCancellation.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-1", 0);
      // 50 more measured cycles, then final sample.
      for (let cycle = 0; cycle < beforeHeadersCancellation.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-2", 0, true);
    } else if (afterPrefixCancellation) {
      // R3 row 2: cancel-after-exact-prefix fault cycles.
      // Each cycle: arm gate, send fault request, receive exact prefix chunk, await pull-pending,
      // client aborts, verify no forbidden-suffix received, verify reader and producer settlement,
      // and send one healthy request to confirm recovery.
      let cancelCount = 0;
      const expectedPrefix = Buffer.from("retention-prefix\n");

      async function faultCycle(): Promise<void> {
        const token = String(cancelCount);
        await command("cancel-arm", { token });
        const entered = command<{ headersSent: boolean }>("cancel-entered", { token });
        void entered.catch(() => {});
        const clientClosed = Promise.withResolvers<void>();
        const sessionClosed = Promise.withResolvers<void>();
        const transportFailed = Promise.withResolvers<never>();
        void transportFailed.promise.catch(() => {});
        const prefixReceived = Promise.withResolvers<void>();
        const chunks: Buffer[] = [];
        let closing = false;
        const path = `/api/fault-prefix?cancel=${token}`;
        const session = mode === "http2" ? http2.connect(origin, { ca: fixtureCa }) : undefined;
        session?.once("error", (err: Error) => { if (!closing) transportFailed.reject(err); });
        session?.once("close", () => sessionClosed.resolve());

        const receive = (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          if (!bytes.equals(expectedPrefix.subarray(0, bytes.length))) {
            transportFailed.reject(new Error("canceled after prefix received incorrect prefix or suffix"));
          } else if (bytes.length === expectedPrefix.length) {
            prefixReceived.resolve();
          }
        };

        const client = session
          ? session.request({ ":path": path })
          : http.request(`${origin}${path}`, { agent: false });
        client.once("error", (err: NodeJS.ErrnoException) => {
          if (!(closing && mode === "http1" && err.code === "ECONNRESET")) transportFailed.reject(err);
        });

        if (session) {
          client.once("response", (headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader) => {
            if (headers[":status"] !== 200) transportFailed.reject(new Error("after-prefix HTTP/2 status must be 200"));
          });
          client.on("data", receive);
        } else {
          client.once("response", (res: http.IncomingMessage) => {
            if (res.statusCode !== 200) transportFailed.reject(new Error("after-prefix HTTP/1.1 status must be 200"));
            res.on("data", receive);
            res.once("error", (err: NodeJS.ErrnoException) => {
              if (!(closing && err.code === "ECONNRESET")) transportFailed.reject(err);
            });
          });
        }
        client.once("close", () => clientClosed.resolve());
        client.end();

        try {
          const entry = await Promise.race([entered, transportFailed.promise]);
          assert.equal(entry.headersSent, false, "child entry precedes headers commit");
          await bounded(Promise.race([prefixReceived.promise, transportFailed.promise]), 10_000, "exact authored prefix");
          // Confirm reader is blocked on its next pull before disconnecting
          await command("cancel-pull-pending", { token });
          assert.deepEqual(Buffer.concat(chunks), expectedPrefix, "exact authored prefix before closing");

          closing = true;
          if (session) {
            (client as http2.ClientHttp2Stream).close(http2.constants.NGHTTP2_CANCEL);
            session.destroy();
          } else {
            (client as http.ClientRequest).destroy();
          }

          const settled = await Promise.race([
            command<{ cancellation: CancellationObservation }>("cancel-settled", { token }),
            transportFailed.promise,
          ]);

          assert.equal(settled.cancellation.entered, cancelCount + 1, "cancel-settled entry count");
          assert.equal(settled.cancellation.aborted, cancelCount + 1, "cancel-settled abort count");
          assert.equal(settled.cancellation.headersSent, true, "cancel-settled headers committed");
          assert(settled.cancellation.midBody, "missing midBody observation");
          assert.equal(settled.cancellation.midBody.readerCanceled, cancelCount + 1, "reader cancel count");
          assert.equal(settled.cancellation.midBody.producerSettled, cancelCount + 1, "producer settled count");
          assert.equal(settled.cancellation.midBody.writerSettled, cancelCount + 1, "writer settled count");
          assert.equal(settled.cancellation.midBody.suffixWrites, 0, "no suffix writes");

          await Promise.race([clientClosed.promise, transportFailed.promise]);
          assert.deepEqual(Buffer.concat(chunks), expectedPrefix, "exact authored prefix with no suffix");
          cancelCount++;
        } finally {
          closing = true;
          (client as http.ClientRequest).destroy();
          session?.destroy();
          try { await bounded(clientClosed.promise, 5_000, "cancel client close"); }
          finally { if (session) await bounded(sessionClosed.promise, 5_000, "cancel session close"); }
        }

        // Healthy request after each cancel cycle
        await requestOne("/api/probe", "api", 0, 0);
        await command("cancel-healthy");
        pending.assertIdle();
      }

      if (afterPrefixCancellation.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestOne("/api/probe", "api", 0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }

      for (let cycle = 0; cycle < afterPrefixCancellation.smokeCycles; cycle++) await faultCycle();
      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });

      for (let cycle = 0; cycle < afterPrefixCancellation.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-1", 0);

      for (let cycle = 0; cycle < afterPrefixCancellation.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-2", 0, true);
    } else if (rejectAfterAbortCancellation) {
      // R3 row 3: reject after acknowledged abort fault cycles.
      // Each cycle: arm gate, send fault request, client aborts on handler entry,
      // handler observes abort and throws exact Error, server terminates with no uncommitted headers.
      // Follow with healthy request to prove server recovery.
      let cancelCount = 0;
      async function faultCycle(): Promise<void> {
        const token = String(cancelCount);
        await command("cancel-arm", { token });
        const entered = command<{ headersSent: boolean }>("cancel-entered", { token });
        void entered.catch(() => {});
        const clientClosed = Promise.withResolvers<void>();
        const sessionClosed = Promise.withResolvers<void>();
        const transportFailed = Promise.withResolvers<never>();
        void transportFailed.promise.catch(() => {});
        let closing = false;
        const path = `/api/fault-reject?cancel=${token}`;
        const session = mode === "http2" ? http2.connect(origin, { ca: fixtureCa }) : undefined;
        session?.once("error", (err: Error) => { if (!closing) transportFailed.reject(err); });
        session?.once("close", () => sessionClosed.resolve());
        const client = session
          ? session.request({ ":path": path })
          : http.request(`${origin}${path}`, { agent: false });
        client.once("error", (err: NodeJS.ErrnoException) => {
          if (!(closing && mode === "http1" && err.code === "ECONNRESET")) transportFailed.reject(err);
        });
        client.once("response", () => transportFailed.reject(new Error("reject-after-abort received unexpected response")));
        client.once("close", () => clientClosed.resolve());
        client.end();
        try {
          const entry = await Promise.race([entered, transportFailed.promise]);
          assert.equal(entry.headersSent, false, "child entry requires uncommitted headers");
          closing = true;
          if (session) {
            (client as http2.ClientHttp2Stream).close(http2.constants.NGHTTP2_CANCEL);
            session.destroy();
          } else {
            (client as http.ClientRequest).destroy();
          }
          const settled = await Promise.race([
            command<{ cancellation: CancellationObservation }>("cancel-settled", { token }),
            transportFailed.promise,
          ]);
          assert.equal(settled.cancellation.entered, cancelCount + 1, "cancel-settled entry count");
          assert.equal(settled.cancellation.aborted, cancelCount + 1, "cancel-settled abort count");
          assert.equal(settled.cancellation.headersSent, false, "cancel-settled headers uncommitted");
          await Promise.race([clientClosed.promise, transportFailed.promise]);
          cancelCount++;
        } finally {
          closing = true;
          (client as http.ClientRequest).destroy();
          session?.destroy();
          try { await bounded(clientClosed.promise, 5_000, "cancel client close"); }
          finally { if (session) await bounded(sessionClosed.promise, 5_000, "cancel session close"); }
        }
        await requestOne("/api/probe", "api", 0, 0);
        await command("cancel-healthy");
        pending.assertIdle();
      }

      if (rejectAfterAbortCancellation.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestOne("/api/probe", "api", 0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }

      for (let cycle = 0; cycle < rejectAfterAbortCancellation.smokeCycles; cycle++) await faultCycle();
      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });

      for (let cycle = 0; cycle < rejectAfterAbortCancellation.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-1", 0);

      for (let cycle = 0; cycle < rejectAfterAbortCancellation.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-2", 0, true);
    } else if (fixedFailedImportFault) {
      // R3 row 4: fixed failed import fault cycles.
      // Send fault request -> receives 500 error response.
      // Followed by healthy fixed request -> receives 200 response.
      let faultAttempts = 0;
      async function faultCycle(): Promise<void> {
        // Fault request to broken import
        const request = String(requestCount++);
        const res1 = await readResponse(`/api/fault-import?request=${request}`);
        assert.equal(res1.status, 500, "failed import returns 500");
        faultAttempts++;
        // Recovered request to fixed route
        const res2 = await readResponse(`/api/fault-import?fixed=true&request=${request}`);
        assert.equal(res2.status, 200, "fixed import returns 200");
        assert(res2.text.includes("imported-ok"), "fixed import returns expected payload");
        // Also exercise probe route so healthy request cache expectations remain consistent
        await requestOne("/api/probe", "api", 0, 0);
        pending.assertIdle();
      }

      if (fixedFailedImportFault.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestOne("/api/probe", "api", 0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }

      for (let cycle = 0; cycle < fixedFailedImportFault.smokeCycles; cycle++) await faultCycle();
      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });

      for (let cycle = 0; cycle < fixedFailedImportFault.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-1", 0);

      for (let cycle = 0; cycle < fixedFailedImportFault.measuredCycles / 2; cycle++) await faultCycle();
      await checkpoint("batch-2", 0, true);
    } else if (staticAssetOptions) {
      if (staticAssetOptions.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestAll(0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }
      const smokeCycles = staticAssetOptions.smokeCycles;
      for (let cycle = 0; cycle < smokeCycles; cycle++) {
        await assetTransition("change", 0);
        await assetTransition("unlink", 0);
        await assetTransition("add", 0);
        await assetTransition("change", 0);
        assert.deepEqual(await readFile(join(project, "src/pages/asset.txt")), assetSource(0), "restore original authored asset bytes");
      }
      for (let warmup = 0; warmup < 10; warmup++) await requestAll(0, 0);
      await verifyAsset(0);
      await command("prime");

      // Join warmup traffic before testing held dispatch
      const warmupJoined = await command<RetentionCheckpoint>("sample", { phase: "warmup-join", completed: 0, snapshot: false });
      assert.deepEqual(warmupJoined.pending, { dispatch: 0, transport: 0, tls: 0 });

      // Hold-next-dispatch/sample expectPending/release handshake before baseline sample
      await command("hold-next-dispatch");
      await requestAll(0, 0);
      const blockedDispatch = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
        "sample",
        { expectPending: ["dispatch"] },
      );
      assert.deepEqual(blockedDispatch, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
      await command("release-held-dispatch");

      // Clean sample to verify dispatch released and fully settled
      const settledClean = await command<RetentionCheckpoint>("sample", { phase: "settled-clean", completed: 0, snapshot: false });
      assert.deepEqual(settledClean.pending, { dispatch: 0, transport: 0, tls: 0 });

      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });
      const half = staticAssetOptions.measuredRevisions / 2;
      for (let revision = 1; revision <= half; revision++) {
        await assetTransition("change", changing ? revision : 0);
        await assetTransition("unlink", 0);
        await assetTransition("add", changing ? revision : 0);
        await assetTransition("change", 0);
        assert.deepEqual(await readFile(join(project, "src/pages/asset.txt")), assetSource(0), "restore original authored asset bytes");
      }
      await checkpoint("batch-1", half);
      for (let revision = half + 1; revision <= staticAssetOptions.measuredRevisions; revision++) {
        await assetTransition("change", changing ? revision : 0);
        await assetTransition("unlink", 0);
        await assetTransition("add", changing ? revision : 0);
        await assetTransition("change", 0);
        assert.deepEqual(await readFile(join(project, "src/pages/asset.txt")), assetSource(0), "restore original authored asset bytes");
      }
      await checkpoint("batch-2", staticAssetOptions.measuredRevisions, true);
    } else if (buildDepOptions) {
      if (buildDepOptions.testMode === "held-compilation-regression") {
        await command("hold-next-build-dep-callback");
        const path = join(project, "src/lib/build-helper.ts");
        const generation = 1;
        await command("arm", { path, kind: "build-dependency-lifecycle", generation, watchEvent: "unlink" });
        await unlink(path);
        try {
          // Await the actual watchPaths compilation callback entering its held gate. This is an
          // explicit callback-entry acknowledgment, not a timing probe.
          const entry = await command<{ entered: boolean; completionResolved: boolean }>("await-build-dep-callback-entry");
          assert.equal(entry.entered, true, "actual watchPaths compilation callback must enter the held gate");
          // The defective subject resolves completion from the "all" watcher handler before the
          // held compilation callback settles. This is the premature-acknowledgment regression.
          assert.equal(entry.completionResolved, false, "completion cannot advance while actual compilation callback is held");
        } finally {
          await command("release-held-build-dep-callback");
        }
        await command("completed", { generation });
        await stopSubject();
        return checkpoints;
      }
      if (buildDepOptions.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestAll(0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }
      const smokeCycles = buildDepOptions.smokeCycles;
      for (let cycle = 0; cycle < smokeCycles; cycle++) {
        await buildDepTransition("change", 0);
        await buildDepTransition("unlink", 0);
        await buildDepTransition("add", 0);
        await buildDepTransition("change", 0);
        assert.deepEqual(await readFile(join(project, "src/lib/build-helper.ts"), "utf8"), "export const buildNumber = 0;", "restore original authored build helper bytes");
      }
      for (let warmup = 0; warmup < 10; warmup++) await requestAll(0, 0);
      await verifyBuildDep(0);
      await command("prime");

      // Join warmup traffic before testing held dispatch
      const warmupJoined = await command<RetentionCheckpoint>("sample", { phase: "warmup-join", completed: 0, snapshot: false });
      assert.deepEqual(warmupJoined.pending, { dispatch: 0, transport: 0, tls: 0 });

      // Hold-next-dispatch/sample expectPending/release handshake before baseline sample
      await command("hold-next-dispatch");
      await requestAll(0, 0);
      const blockedDispatch = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
        "sample",
        { expectPending: ["dispatch"] },
      );
      assert.deepEqual(blockedDispatch, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
      await command("release-held-dispatch");

      // Clean sample to verify dispatch released and fully settled
      const settledClean = await command<RetentionCheckpoint>("sample", { phase: "settled-clean", completed: 0, snapshot: false });
      assert.deepEqual(settledClean.pending, { dispatch: 0, transport: 0, tls: 0 });

      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });
      const half = buildDepOptions.measuredRevisions / 2;
      for (let revision = 1; revision <= half; revision++) {
        await buildDepTransition("change", changing ? revision : 0, changing ? revision : 0);
        await buildDepTransition("unlink", 0, changing ? revision : 0);
        await buildDepTransition("add", changing ? revision : 0, changing ? revision : 0);
        await buildDepTransition("change", 0, 0);
        assert.deepEqual(await readFile(join(project, "src/lib/build-helper.ts"), "utf8"), "export const buildNumber = 0;", "restore original authored build helper bytes");
      }
      await checkpoint("batch-1", half);
      for (let revision = half + 1; revision <= buildDepOptions.measuredRevisions; revision++) {
        await buildDepTransition("change", changing ? revision : 0, changing ? revision : 0);
        await buildDepTransition("unlink", 0, changing ? revision : 0);
        await buildDepTransition("add", changing ? revision : 0, changing ? revision : 0);
        await buildDepTransition("change", 0, 0);
        assert.deepEqual(await readFile(join(project, "src/lib/build-helper.ts"), "utf8"), "export const buildNumber = 0;", "restore original authored build helper bytes");
      }
      await checkpoint("batch-2", buildDepOptions.measuredRevisions, true);
    } else if (devModuleOptions) {
      if (devModuleOptions.testMode === "negative-dispatch") {
        await command("hold-next-dispatch");
        await requestAll(0, 0);
        const blockedReport = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
          "sample",
          { expectPending: ["dispatch"] },
        );
        assert.deepEqual(blockedReport, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
        await command("release-held-dispatch");
        const cleanSample = await command<RetentionCheckpoint>("sample", { phase: "clean", completed: 0, snapshot: false });
        assert.deepEqual(cleanSample.pending, { dispatch: 0, transport: 0, tls: 0 });
        await stopSubject();
        return checkpoints;
      }
      const restoreBytes = () => {
        if (devModuleOptions.input === "dev-module-inline") return inlineSource(0, 0);
        if (apiRoute) return originalApiRoute;
        return "export const revision = 0;";
      };
      const targetFilePath = () => {
        if (devModuleOptions.input === "dev-module-inline") return join(project, "src/pages/inline.html");
        if (devModuleOptions.input === "dev-module-external") return join(project, "src/lib/helper.mjs");
        return join(project, "api/probe.mjs");
      };
      const smokeCycles = devModuleOptions.smokeCycles;
      for (let cycle = 0; cycle < smokeCycles; cycle++) {
        await devModuleTransition("change", -(cycle + 1));
        await devModuleTransition("unlink", 0);
        await devModuleTransition("add", 0);
        await devModuleTransition("change", 0);
        assert.deepEqual(await readFile(targetFilePath(), "utf8"), restoreBytes(), "restore original authored dev module bytes");
      }
      for (let warmup = 0; warmup < 10; warmup++) await requestAll(0, 0);
      await verifyDevModule(0);
      await command("prime");

      const warmupJoined = await command<RetentionCheckpoint>("sample", { phase: "warmup-join", completed: 0, snapshot: false });
      assert.deepEqual(warmupJoined.pending, { dispatch: 0, transport: 0, tls: 0 });

      await command("hold-next-dispatch");
      await requestAll(0, 0);
      const blockedDispatch = await command<{ blocked: string; pending: { dispatch: number; transport: number; tls: number } }>(
        "sample",
        { expectPending: ["dispatch"] },
      );
      assert.deepEqual(blockedDispatch, { blocked: "dispatch", pending: { dispatch: 1, transport: 0, tls: 0 } });
      await command("release-held-dispatch");

      const settledClean = await command<RetentionCheckpoint>("sample", { phase: "settled-clean", completed: 0, snapshot: false });
      assert.deepEqual(settledClean.pending, { dispatch: 0, transport: 0, tls: 0 });

      await checkpoint("baseline", 0, true);
      assert.deepEqual(checkpoints[0].pending, { dispatch: 0, transport: 0, tls: 0 });
      const half = devModuleOptions.measuredRevisions / 2;
      for (let revision = 1; revision <= half; revision++) {
        await devModuleTransition("change", changing ? revision : 0, changing ? revision : 0);
        if (externalHelper || apiRoute) continue;
        await devModuleTransition("unlink", 0, 0);
        await devModuleTransition("add", 0, 0);
        await devModuleTransition("change", 0, 0);
        assert.deepEqual(await readFile(targetFilePath(), "utf8"), restoreBytes(), "restore original authored dev module bytes");
      }
      await checkpoint("batch-1", half);
      for (let revision = half + 1; revision <= devModuleOptions.measuredRevisions; revision++) {
        await devModuleTransition("change", changing ? revision : 0, changing ? revision : 0);
        if (externalHelper || apiRoute) continue;
        await devModuleTransition("unlink", 0, 0);
        await devModuleTransition("add", 0, 0);
        await devModuleTransition("change", 0, 0);
        assert.deepEqual(await readFile(targetFilePath(), "utf8"), restoreBytes(), "restore original authored dev module bytes");
      }
      await checkpoint("batch-2", devModuleOptions.measuredRevisions, true);
      if (externalHelper || apiRoute) {
        await devModuleTransition("unlink", 0);
        await devModuleTransition("add", 0);
        assert.equal(await readFile(targetFilePath(), "utf8"), restoreBytes(), "restored dev module authored bytes");
        if (externalHelper) externalWorkSettled = true;
        if (apiRoute) apiWorkSettled = true;
      }
    } else {
      for (let warmup = 0; warmup < 10; warmup++) await requestAll(0, 0);
      await command("prime");
      for (let warmup = 0; warmup < 10; warmup++) await requestAll(0, 0);
      await checkpoint("baseline", 0, true);
      for (let generation = 1; generation <= generations; generation++) {
        if (realistic && mode === "dev") {
          const step = generation % 10;
          if (step === 1 || step === 6) {
            inlineRevision = changing && step === 1 ? generation : 0;
            pageGeneration = generation;
            await edit("src/pages/inline.html", realisticInline(), "page");
          } else if (step === 2 || step === 7) {
            componentRevision = changing && step === 2 ? generation : 0;
            await edit("src/components/retention-shared.html", `<span>generation-${generation}</span>` + componentSource(), "component");
          } else if (changing) {
            const chain = step === 3 || step === 9 ? 0 : step === 4 || step === 0 ? 1 : step === 5 ? 9 : 2;
            revisions[chain] = step === 9 || step === 0 ? 0 : generation;
            await edit(helperPaths[chain * 3 + 2], `export const revision = ${revisions[chain]};`, chain === 9 ? "api" : "module");
          }
        } else if (!realistic && mode === "dev") await edit("src/pages/inline.html", inlineSource(changing ? generation : 0, generation), "page");
        if (!realistic && changing) {
          await edit("src/lib/helper.mjs", `export const revision = ${generation};`, "module");
          await edit("api/helper.mjs", `export const revision = ${generation};`, "api");
        }
        await requestAll(changing ? generation : 0, mode === "dev" ? generation : 0);
        if (generation === generations / 2) await checkpoint("batch-1", generation);
        if (realistic && generation % 20 === 0) await checkpoint(`edit-${generation}`, generation);
      }
      await checkpoint("batch-2", generations, true);
    }
    if (!fixedProductionBatch && !beforeHeadersCancellation && !afterPrefixCancellation && !rejectAfterAbortCancellation && !fixedFailedImportFault && !staticAssetOptions && !buildDepOptions && !devModuleOptions) {
      if (realistic && mode === "dev") {
        inlineRevision = 0;
        pageGeneration = 0;
        await edit("src/pages/inline.html", realisticInline(), "page");
      } else if (mode === "dev") await edit("src/pages/inline.html", inlineSource(0, 0), "page");
      if (!realistic && changing) {
        await edit("src/lib/helper.mjs", 'export const revision = 0;', "module");
        await edit("api/helper.mjs", 'export const revision = 0;', "api");
      }
      await requestAll(0, 0);
      await checkpoint("reverted", generations + 1, true);
      await command("clear");
      await checkpoint("cleared", generations + 1, true);
    }
    await stopSubject();
    const heaps = [];
    for (const checkpoint of checkpoints) {
      if (!checkpoint.snapshot) continue;
      heaps.push({ phase: checkpoint.phase, ...analyzeRetentionHeap(JSON.parse(await readFile(checkpoint.snapshot, "utf8")), project) });
    }
    await writeFile(join(directory, "heaps.json"), JSON.stringify(heaps, null, 2), { mode: 0o600 });
    const snapshotNames = (fixedProductionBatch || beforeHeadersCancellation || afterPrefixCancellation || rejectAfterAbortCancellation || fixedFailedImportFault)
      ? ["baseline.heapsnapshot", "batch-2.heapsnapshot"]
      : (staticAssetOptions || buildDepOptions || devModuleOptions)
        ? ["priming.heapsnapshot", "baseline.heapsnapshot", "batch-2.heapsnapshot"]
        : ["priming.heapsnapshot", "baseline.heapsnapshot", "batch-2.heapsnapshot", "reverted.heapsnapshot", "cleared.heapsnapshot"];
    for (const name of [...snapshotNames, "heaps.json", "checkpoints.json"]) {
      const bytes = await readFile(join(directory, name));
      artifacts.push({ path: join(directory, name), bytes: bytes.length, sha256: digest(bytes) });
    }
  } finally {
    clearTimeout(experimentDeadline);
    clearTimeout(bootDeadline);
    fail(new Error("retention experiment closed"));
    try { await cleanupGroup(); }
    finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("disconnect", onDisconnect);
      if (child.connected) child.disconnect();
      child.stdout!.unpipe(log); child.stderr!.unpipe(log);
      child.stdout!.destroy(); child.stderr!.destroy();
      log.end();
      try { await bounded(logClosed.promise, 1000, "log close"); }
      finally {
        log.destroy();
        log.off("error", fail);
        log.off("close", onLogClose);
      }
    }
  }
  requests.signal.throwIfAborted();
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...metadata, success: true, completedRequests: requestCount, checkpoints, artifacts }, null, 2), { mode: 0o600 });
  return checkpoints;
}