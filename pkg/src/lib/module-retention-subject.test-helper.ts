import assert from "node:assert/strict";
import { writeHeapSnapshot } from "node:v8";
import { setImmediate as nextTurn } from "node:timers/promises";
import { resolve, join } from "node:path";
import { chmod, readFile, readdir } from "node:fs/promises";
import tls from "node:tls";
import net from "node:net";
import http from "node:http";
import http2 from "node:http2";
import {
  registryEntries,
  assertRegistryReleased,
  retentionHelperPaths,
  RetentionSettlement,
  assertSupportedTlsCleanupRuntime,
  type RetentionCheckpoint,
  type InlinePageObservation,
} from "./module-retention.test-helper.ts";
import chokidar from "chokidar";
import zlib from "node:zlib";

const [directory, mode, realisticFlag, faultFlag] = process.argv.slice(2);
const realistic = realisticFlag === "true";
const beforeHeaders = faultFlag === "before-headers";
const afterPrefix = faultFlag === "after-prefix";
const cancellationEnabled = beforeHeaders || afterPrefix;
const staticAssetEnabled = faultFlag === "static-asset";
const buildDepEnabled = faultFlag === "build-dependency";
process.argv = process.argv.slice(0, 2);
if (mode !== "dev") process.argv.push("--server");
assert(process.send && global.gc, "retention subject requires IPC and child-only --expose-gc");
process.umask(0o077);
const watcherReadiness: Promise<void>[] = [];
const pendingCompression = new Set<Promise<void>>();
for (const codec of ["gzip", "brotliCompress"] as const) {
  const original = zlib[codec];
  zlib[codec] = ((...args: unknown[]) => {
    const completion = Promise.withResolvers<void>();
    pendingCompression.add(completion.promise);
    const callback = args.pop() as (error: Error | null, result: Buffer) => void;
    return Reflect.apply(original, zlib, [...args, (error: Error | null, result: Buffer) => {
      try { callback(error, result); }
      finally { pendingCompression.delete(completion.promise); completion.resolve(); }
    }]);
  }) as typeof original;
}
const originalWatch = chokidar.watch;
chokidar.watch = (...args: Parameters<typeof originalWatch>) => {
  const watcher = originalWatch(...args);
  watcherReadiness.push(new Promise<void>((ready, reject) => { watcher.once("ready", ready); watcher.once("error", reject); }));
  watcher.on("all", (event, path) => {
    const observation = armed?.asset;
    if (staticAssetEnabled && (!observation || resolve(path) !== observation.path)) {
      process.send!({ error: `Unexpected asset fixture watch event: ${event} ${path}` });
      return;
    }
    if (buildDepEnabled) {
      if (!observation || resolve(path) !== observation.path) return;
      if (observation.watchEvent) {
        // Debounce / deduplicate identical watch events on the same armed path from multiple watchers
        if (observation.watchEvent === event) return;
        process.send!({ error: `Unexpected build-dependency watch event: ${event} ${path}, generation ${observation.generation}` });
        return;
      }
      if (event !== armed!.expectedWatchEvent) {
        process.send!({ error: `Unexpected build-dependency watch event: ${event} ${path}, generation ${observation.generation}` });
        return;
      }
    observation.watchEvent = event;
    if (armed?.kind === "build-dependency-lifecycle") {
      if (armed.expectedWatchEvent === "unlink") {
        if (!observation.publications.includes("build-error")) {
          observation.publications.push("build-error");
        }
        armed.completion.resolve();
      } else if (observation.publications.includes("transpiled")) {
        armed.completion.resolve();
      }
    }
    return;
    }
    if (!observation || resolve(path) !== observation.path) return;
    if (observation.watchEvent || event !== armed!.expectedWatchEvent) {
      process.send!({ error: `Unexpected asset watch event: ${event} ${path}, generation ${observation.generation}` });
      return;
    }
    observation.watchEvent = event;
  });
  return watcher;
};

const { scriptRegistry } = await import("./script-registry.ts");
const { mem } = await import("./mem.ts");
const { eventEmitter } = await import("./events.ts");
const { apiRouteRegistry } = await import("./server-api.ts");
const { moduleKeyForPath } = await import("./module-graph.ts");
const { serverSidecarRegistry } = await import("./server-sidecar.ts");
const { getCompressedCacheEntriesCount, getInFlightCompressionsCount, getOpenStreamedAssetHandles } = await import("./caching.ts");
const requestRefs: WeakRef<object>[] = [];
const requestClosureRefs: WeakRef<object>[] = [];
const planRefs: WeakRef<object>[] = [];
const seenPlans = new WeakSet<object>();
const loadRefs: WeakRef<object>[] = [];
const seenLoads = new WeakSet<object>();
let activeRequests = 0;
let requests = 0;
let publications = 0;
let armed: {
  path: string;
  kind: string;
  publications: number;
  completion: ReturnType<typeof Promise.withResolvers<void>>;
  asset?: InlinePageObservation;
  expectedWatchEvent?: string;
} | undefined;
let assetGeneration = 0;
let assetPublications = 0;

// Cancel fault tracking (R3 rows 1 & 2).
const cancellationCounts: import("./module-retention.test-helper.ts").CancellationObservation = {
  entered: 0, aborted: 0, settled: 0, dispatchSettled: 0, transportSettled: 0,
  headersSent: false, healthy: 0, errors: 0, pending: 0,
};
if (afterPrefix) {
  cancellationCounts.midBody = {
    readerCanceled: 0,
    producerSettled: 0,
    writerSettled: 0,
    dispatchSettled: 0,
    transportSettled: 0,
    prefix: "",
    suffixWrites: 0,
    lockedBodies: 0,
    ownedListeners: 0,
  };
}
// Current active cancellation gate, set by "cancel-arm" action.
let cancellationGate: {
  token: string;
  entered: ReturnType<typeof Promise.withResolvers<{ headersSent: boolean }>>;
  dispatch: ReturnType<typeof Promise.withResolvers<void>>;
  closed: ReturnType<typeof Promise.withResolvers<void>>;
  pullPending?: ReturnType<typeof Promise.withResolvers<void>>;
  producer?: ReturnType<typeof Promise.withResolvers<void>>;
  body?: ReadableStream<Uint8Array>;
  readerCanceled?: boolean;
  bytes?: Buffer[];
} | undefined;

// Transport & Dispatch tracking according to verified architecture
const kTransportMarker = Symbol("bascik.retention.transport");
const boundary = new RetentionSettlement();
const fixtureSockets = new Set<tls.TLSSocket>();
const foreignDestroyResolvers = new WeakMap<tls.TLSSocket, PromiseWithResolvers<void>>();

let fixtureServer: net.Server | undefined;
let restoreHooks: (() => { destroySSL: boolean; createSecureServer: boolean; createServer: boolean }) | undefined;

let secureConnections = 0;
let destroyedFixtureSockets = 0;
let foreignDestroyCalls = 0;
let serverIdentityMismatches = 0;
let hookInstalled = false;

interface RawTransportMarker {
  server: net.Server;
  socket: net.Socket | tls.TLSSocket;
  teardown?: PromiseWithResolvers<void>;
}

function wrapHandlerExecution(
  thisArg: unknown,
  listener: (...args: unknown[]) => unknown,
  args: unknown[],
): unknown {
  const result = Reflect.apply(listener, thisArg, args);
  if (result !== null && typeof result === "object" && "then" in result && typeof (result as PromiseLike<unknown>).then === "function") {
    boundary.track("dispatch", result as PromiseLike<unknown>);
  }
  return result;
}

function installInstanceOnWrapper(
  server: net.Server,
  wrapEvent: (event: string | symbol, listener: (...args: unknown[]) => unknown) => ((...args: unknown[]) => unknown) | undefined,
): { capturedOn: typeof server.on; capturedAddListener: typeof server.addListener } {
  const capturedOn = server.on;
  const capturedAddListener = server.addListener;

  type ListenerFn = (...args: unknown[]) => unknown;

  const wrappedOn = function(this: unknown, event: string | symbol, listener: ListenerFn): net.Server {
    const wrapped = wrapEvent(event, listener);
    return Reflect.apply(capturedOn, this, [event, wrapped ?? listener]) as net.Server;
  };

  server.on = wrappedOn as typeof server.on;
  server.addListener = wrappedOn as typeof server.addListener;

  return { capturedOn, capturedAddListener };
}

if (mode === "http2") {
  assertSupportedTlsCleanupRuntime();
  const tlsProto = tls.TLSSocket.prototype as { _destroySSL?: (...args: unknown[]) => unknown };
  assert(typeof tlsProto._destroySSL === "function", "tls.TLSSocket.prototype._destroySSL must exist to patch");
  const originalDestroySSL = tlsProto._destroySSL;
  hookInstalled = true;

  tlsProto._destroySSL = function(this: tls.TLSSocket, ...args: unknown[]) {
    const result = Reflect.apply(originalDestroySSL, this, args);
    const marker = (this as unknown as Record<symbol, unknown>)[kTransportMarker] as RawTransportMarker | undefined;
    const foreignResolver = foreignDestroyResolvers.get(this);
    if (foreignResolver) {
      foreignDestroyResolvers.delete(this);
      foreignResolver.resolve();
    }
    const socketServer = (this as { server?: unknown }).server;
    if (socketServer !== fixtureServer) {
      serverIdentityMismatches += fixtureSockets.has(this) ? 1 : 0;
    }
    if (!marker) {
      foreignDestroyCalls++;
      return result;
    }
    assert.equal(marker.socket, this, "TLS callback must acknowledge the marked raw socket");
    assert.equal(marker.server, fixtureServer, "TLS callback marker must identify the fixture server");
    assert.equal(socketServer, fixtureServer, "TLS callback raw socket must belong to the fixture server");
    assert(fixtureSockets.has(this), "TLS callback requires an observed raw fixture socket");
    destroyedFixtureSockets++;
    fixtureSockets.delete(this);
    assert(marker.teardown, "fixture TLS callback requires an acknowledgment");
    marker.teardown.resolve();
    Reflect.deleteProperty(this, kTransportMarker);
    return result;
  };

  const origCreateSecureServer = http2.createSecureServer;
  let capturedSecureOn: typeof net.Server.prototype.on | undefined;
  let capturedSecureAddListener: typeof net.Server.prototype.addListener | undefined;

  const patchedCreateSecureServer = function(...args: Parameters<typeof origCreateSecureServer>) {
    assert(!fixtureServer, "exactly one fixture server per child");
    const server = Reflect.apply(origCreateSecureServer, http2, args) as http2.Http2SecureServer;
    fixtureServer = server;

    server.prependListener("secureConnection", (raw: unknown) => {
      assert(raw instanceof tls.TLSSocket, "secureConnection must deliver a TLSSocket");
      secureConnections++;
      if ((raw as { server?: unknown }).server !== fixtureServer) {
        serverIdentityMismatches++;
      }
      assert.equal((raw as { server?: unknown }).server, fixtureServer, "secureConnection requires exact fixture server identity");
      fixtureSockets.add(raw);
      const marker: RawTransportMarker = { server, socket: raw };
      (raw as unknown as Record<symbol, unknown>)[kTransportMarker] = marker;

      const tlsTeardown = Promise.withResolvers<void>();
      boundary.track("tls", tlsTeardown.promise);
      marker.teardown = tlsTeardown;

      const rawClose = Promise.withResolvers<void>();
      raw.once("close", () => rawClose.resolve());
      boundary.track("transport", rawClose.promise);
    });

    server.prependListener("session", (session: http2.ServerHttp2Session) => {
      const sessionClose = Promise.withResolvers<void>();
      session.once("close", () => sessionClose.resolve());
      boundary.track("transport", sessionClose.promise);
    });

    const { capturedOn, capturedAddListener } = installInstanceOnWrapper(server, (event, listener) => {
      if (event === "stream") {
        return function(this: unknown, ...streamArgs: unknown[]) {
          const stream = streamArgs[0] as http2.ServerHttp2Stream | undefined;
          const session = stream?.session;
          const proxySocket = session?.socket;
          const marker = proxySocket ? (proxySocket as unknown as Record<symbol, unknown>)[kTransportMarker] as RawTransportMarker | undefined : undefined;
          assert(marker, "stream must correlate to an observed fixture socket via session.socket marker");
          assert.equal(marker.server, fixtureServer, "stream transport must belong to fixture server");
          assert(marker.socket instanceof tls.TLSSocket && fixtureSockets.has(marker.socket), "stream requires an observed raw TLS socket");
          return wrapHandlerExecution(this, listener, streamArgs);
        };
      }
      if (event === "request") {
        return function(this: unknown, ...reqArgs: unknown[]) {
          return wrapHandlerExecution(this, listener, reqArgs);
        };
      }
      return undefined;
    });
    capturedSecureOn = capturedOn;
    capturedSecureAddListener = capturedAddListener;

    return server;
  };

  http2.createSecureServer = patchedCreateSecureServer as typeof origCreateSecureServer;

  restoreHooks = () => {
    tlsProto._destroySSL = originalDestroySSL;
    http2.createSecureServer = origCreateSecureServer;
    hookInstalled = false;
    if (fixtureServer) {
      Reflect.deleteProperty(fixtureServer, "on");
      Reflect.deleteProperty(fixtureServer, "addListener");
      assert.equal(fixtureServer.on, capturedSecureOn, "server.on restored to prototype");
      assert.equal(fixtureServer.addListener, capturedSecureAddListener, "server.addListener restored to prototype");
    }
    return {
      destroySSL: tlsProto._destroySSL === originalDestroySSL,
      createSecureServer: http2.createSecureServer === origCreateSecureServer,
      createServer: true,
    };
  };
} else if (mode === "http1" || staticAssetEnabled || buildDepEnabled) {
  const origCreateServer = http.createServer;
  let capturedHttp1On: typeof net.Server.prototype.on | undefined;
  let capturedHttp1AddListener: typeof net.Server.prototype.addListener | undefined;

  const patchedCreateServer = function(...args: Parameters<typeof origCreateServer>) {
    assert(!fixtureServer, "exactly one fixture server per child");
    const server = Reflect.apply(origCreateServer, http, args) as http.Server;
    fixtureServer = server;

    server.prependListener("connection", (socket: net.Socket) => {
      if ((socket as { server?: unknown }).server !== fixtureServer) {
        serverIdentityMismatches++;
      }
      const marker: RawTransportMarker = { server, socket };
      (socket as unknown as Record<symbol, unknown>)[kTransportMarker] = marker;

      const rawClose = Promise.withResolvers<void>();
      socket.once("close", () => rawClose.resolve());
      boundary.track("transport", rawClose.promise);
    });

    const { capturedOn, capturedAddListener } = installInstanceOnWrapper(server, (event, listener) => {
      if (event === "request") {
        return function(this: unknown, ...reqArgs: unknown[]) {
          return wrapHandlerExecution(this, listener, reqArgs);
        };
      }
      return undefined;
    });
    capturedHttp1On = capturedOn;
    capturedHttp1AddListener = capturedAddListener;

    return server;
  };

  http.createServer = patchedCreateServer as typeof origCreateServer;

  restoreHooks = () => {
    http.createServer = origCreateServer;
    if (fixtureServer) {
      Reflect.deleteProperty(fixtureServer, "on");
      Reflect.deleteProperty(fixtureServer, "addListener");
      assert.equal(fixtureServer.on, capturedHttp1On, "server.on restored to prototype");
      assert.equal(fixtureServer.addListener, capturedHttp1AddListener, "server.addListener restored to prototype");
    }
    return {
      destroySSL: true,
      createSecureServer: true,
      createServer: http.createServer === origCreateServer,
    };
  };
}

Reflect.set(globalThis, Symbol.for("bascik.retention.observe"), (request: object, context: object, closure: object) => {
  requests++;
  requestRefs.push(new WeakRef(request), new WeakRef(context));
  requestClosureRefs.push(new WeakRef(closure));
});

const invoke = scriptRegistry.invoke;
scriptRegistry.invoke = async function <Result>(...args: Parameters<typeof invoke>) {
  activeRequests++;
  // For before-headers fault mode: detect fault-route invocations by specifier.
  const isFaultInvocation = beforeHeaders && typeof args[0] === "string" && args[0].includes("fault");
  try { return await invoke.call(this, ...args) as import("./script-registry.ts").ScriptExecutionResult<Result>; }
  finally {
    activeRequests--;
    if (isFaultInvocation) cancellationCounts.settled++;
  }
};
const load = scriptRegistry.load;
scriptRegistry.load = function(...args: Parameters<typeof load>) {
  const result = load.call(this, ...args);
  const state: unknown = args[1] && Reflect.get(this, "ownedLoads").get(args[1]);
  if (state && typeof state === "object" && !seenLoads.has(state)) {
    seenLoads.add(state);
    loadRefs.push(new WeakRef(state));
  }
  return result;
};
const invalidate = scriptRegistry.invalidate;
scriptRegistry.invalidate = function(specifier) {
  const advanced = invalidate.call(this, specifier);
  if (advanced && armed?.kind === "module" && resolve(specifier) === armed.path) armed.completion.resolve();
  return advanced;
};
eventEmitter.on("transpiled", (event?: { relativePagePath?: string }) => {
  publications++;
  if (staticAssetEnabled && assetGeneration && event?.relativePagePath) {
    process.send!({ error: `Unexpected page publication for static asset: ${event.relativePagePath}` });
  }
  if (buildDepEnabled && armed?.kind === "build-dependency-lifecycle" && event?.relativePagePath === "pages/inline.html") {
    assert(armed.asset, "build-dependency publication requires armed operation");
    if (!armed.asset.publications.includes("transpiled")) {
      armed.asset.publications.push("transpiled");
    }
    if (armed.asset.watchEvent) {
      armed.completion.resolve();
    }
    return;
  }
  if (armed?.kind === "page" || armed?.kind === "component") {
    armed.publications--;
    if (armed.publications === 0) armed.completion.resolve();
  }
});
eventEmitter.on("asset-changed", () => {
  if (!staticAssetEnabled) return;
  assert(armed?.asset, "asset publication requires an armed operation");
  assert.equal(armed.asset.watchEvent, armed.expectedWatchEvent, "asset publication follows exact watch event");
  assert.equal(armed.asset.publications.length, 0, "one asset publication per operation");
  armed.asset.publications.push("asset-changed");
  assetPublications++;
  armed.completion.resolve();
});
eventEmitter.on("api-route-changed", (event: { path: string; }) => {
  if (staticAssetEnabled) process.send!({ error: `Unexpected API change for static asset: ${event.path}` });
  if (armed?.kind === "api" && resolve(event.path) === armed.path) armed.completion.resolve();
});
eventEmitter.on("build-error", error => {
  if (buildDepEnabled && armed?.kind === "build-dependency-lifecycle" && armed.expectedWatchEvent === "unlink") {
    assert(armed.asset, "build-dependency publication requires armed operation");
    if (!armed.asset.publications.includes("build-error")) {
      armed.asset.publications.push("build-error");
    }
    if (armed.asset.watchEvent) {
      armed.completion.resolve();
    }
    return;
  }
  process.send!({ error: JSON.stringify(error) });
});
eventEmitter.on("watch-path-processed", (event?: { path?: string }) => {
  publications++;
  if (buildDepEnabled && armed?.kind === "build-dependency-lifecycle") {
    assert(armed.asset, "build-dependency publication requires armed operation");
    if (armed.expectedWatchEvent === "unlink") {
      if (!armed.asset.publications.includes("build-error")) {
        armed.asset.publications.push("build-error");
      }
    } else {
      if (!armed.asset.publications.includes("transpiled")) {
        armed.asset.publications.push("transpiled");
      }
    }
    if (armed.asset.watchEvent) {
      armed.completion.resolve();
    }
  }
});

if (cancellationEnabled) {
  // Install the cancel entry global called by api/fault.mjs and api/fault-prefix.mjs.
  Reflect.set(globalThis, Symbol.for("bascik.retention.cancel"), (event: "entered" | "aborted" | "settled" | "body" | "pull-pending" | "reader-canceled" | "producer-settled", token: string, body?: ReadableStream<Uint8Array>) => {
    assert(cancellationGate && cancellationGate.token === token, `authored cancellation token mismatch: expected ${cancellationGate?.token ?? "none"}, got ${token}`);
    if (event === "entered") {
      cancellationCounts.entered++;
      cancellationCounts.headersSent ||= false; // committed below after dispatch entry confirms headersSent
      cancellationGate.entered.resolve({ headersSent: false });
    } else if (event === "aborted") {
      cancellationCounts.aborted++;
    } else if (event === "settled") {
      cancellationCounts.settled++;
    } else if (event === "body") {
      assert(afterPrefix && body instanceof ReadableStream, "real authored body required for after-prefix");
      cancellationGate.body = body;
    } else if (event === "pull-pending") {
      cancellationGate.pullPending?.resolve();
    } else if (event === "reader-canceled") {
      assert(afterPrefix && cancellationCounts.midBody, "reader canceled requires afterPrefix");
      assert(!cancellationGate.readerCanceled, "reader canceled more than once");
      cancellationGate.readerCanceled = true;
      cancellationCounts.aborted++;
      cancellationCounts.midBody.readerCanceled++;
    } else if (event === "producer-settled") {
      assert(afterPrefix && cancellationCounts.midBody, "producer settled requires afterPrefix");
      cancellationCounts.midBody.producerSettled++;
      cancellationGate.producer?.resolve();
    }
  });

  // Wrap apiRouteRegistry.dispatch to track dispatch and transport settlement using boundary.
  // The existing server-level hooks (connection/secureConnection/_destroySSL) already register
  // transport and tls owners on `boundary` when a request arrives. We only need to track
  // dispatch settlement and response closure for the fault gate.
  const origDispatch = apiRouteRegistry.dispatch.bind(apiRouteRegistry);
  apiRouteRegistry.dispatch = async function(req, res, match, secHeaders) {
    const isFault = typeof req.path === "string" && (req.path.startsWith("/api/fault"));
    const gate = isFault ? cancellationGate : undefined;

    let origWrite: typeof res.write | undefined;
    if (gate) {
      res.on("close", () => gate.closed.resolve());
      if (afterPrefix) {
        gate.bytes = [];
        origWrite = res.write.bind(res);
        res.write = function(chunk: any, ...writeArgs: any[]): boolean {
          const bytes = Buffer.from(chunk);
          gate.bytes!.push(bytes);
          if (gate.readerCanceled || (res as any).destroyed) {
            cancellationCounts.midBody!.suffixWrites++;
          }
          return origWrite!(chunk, ...writeArgs);
        } as typeof res.write;
      }
    }

    const dispatchWork = origDispatch(req, res, match, secHeaders);
    if (gate) {
      // Track dispatch via the shared boundary so boundary.join() in cancel-settled covers it.
      boundary.track("dispatch", dispatchWork);
    }

    try {
      return await dispatchWork;
    } catch (error) {
      cancellationCounts.errors++;
      throw error;
    } finally {
      if (gate) {
        if (afterPrefix && origWrite) {
          cancellationCounts.midBody!.writerSettled++;
          res.write = origWrite;
        }
        cancellationCounts.dispatchSettled++;
        cancellationCounts.headersSent ||= res.headersSent;
        gate.dispatch.resolve();
      }
    }
  } as typeof apiRouteRegistry.dispatch;
}

function observePlans() {
  for (const page of mem.pages()) {
    const plan = page.serverScriptPlan;
    if (plan && !seenPlans.has(plan)) { seenPlans.add(plan); planRefs.push(new WeakRef(plan)); }
  }
}

async function sample(
  phase: string,
  completed: number,
  snapshot: boolean,
  expectPending?: ("dispatch" | "transport" | "tls")[],
): Promise<RetentionCheckpoint | { blocked: string; pending: { dispatch: number; transport: number; tls: number } }> {
  if (expectPending && expectPending.length > 0) {
    const expectedStage = expectPending[0];
    await boundary.entered(expectedStage);
    await boundary.join(expectedStage);
    assert.throws(
      () => boundary.assertSettled(),
      (err: unknown) => err instanceof Error && err.message.includes(`sample requires settled ${expectedStage} acknowledgments`),
      `sample must fail closed on held stage ${expectedStage}`,
    );
    return { blocked: expectedStage, pending: boundary.pending() };
  }

  await boundary.join();
  await Promise.all([...pendingCompression]);

  assert.equal(activeRequests, 0, "sample requires settled request handlers");
  if (staticAssetEnabled) {
    assert.equal(armed, undefined, "asset sample requires completed observation");
  }
  boundary.assertSettled();
  assert.equal(pendingCompression.size, 0, "sample requires settled compression");

  observePlans();
  await nextTurn(); global.gc!(); await nextTurn(); global.gc!();
  const memory = process.memoryUsage();
  const currentPlans = new Set(mem.pages().map(page => page.serverScriptPlan).filter(Boolean));
  const currentLoads = new Set<object>();
  const ownedLoads: unknown = Reflect.get(scriptRegistry, "ownedLoads");
  assert(ownedLoads instanceof WeakMap, "job-owned load observation unavailable");
  for (const plan of currentPlans) {
    if (!plan || "error" in plan) continue;
    for (const segment of plan.segments) {
      if (segment.kind !== "script") continue;
      const state: unknown = ownedLoads.get(segment.job);
      if (state && typeof state === "object") currentLoads.add(state);
    }
  }
  const stalePlans = planRefs.filter(reference => { const plan = reference.deref(); return plan && !currentPlans.has(plan as import("./types.ts").StoredPage["serverScriptPlan"]); }).length;
  const cache = registryEntries(scriptRegistry);
  const filePaths = realistic ? ["src/lib/handler.mjs", "api/probe.mjs", ...retentionHelperPaths(true)] : ["src/lib/handler.mjs", "src/lib/helper.mjs", "api/probe.mjs", "api/helper.mjs"];
  const keys = new Set([...cache.keys(), ...filePaths.map(path => moduleKeyForPath(resolve(path)))]);
  const result: RetentionCheckpoint = {
    mode,
    phase, completed, pages: mem.pages().length, plans: currentPlans.size,
    cache: cache.size, graph: scriptRegistry.graph.size,
    inlineLoads: currentLoads.size,
    staleInlineLoads: loadRefs.filter(reference => { const state = reference.deref(); return state && !currentLoads.has(state); }).length,
    dependencyEdges: [...keys].reduce((sum, key) => sum + scriptRegistry.graph.parentsOf(key).size, 0),
    liveRequests: requestRefs.filter(reference => reference.deref()).length,
    liveRequestClosures: requestClosureRefs.filter(reference => reference.deref()).length,
    stalePlans, requests, publications,
    sidecar: Object.keys(serverSidecarRegistry.getAllScripts()).length,
    activeRequests, pendingCompression: pendingCompression.size,
    pending: boundary.pending(),
    resources: process.getActiveResourcesInfo().sort(),
    fileVersions: filePaths.map(path => scriptRegistry.generationOf(resolve(path))), memory,
    ...(beforeHeaders ? { cancellation: { ...cancellationCounts } } : {}),
    ...(staticAssetEnabled ? {
      assetLifecycle: {
        observationGeneration: assetGeneration,
        publications: assetPublications,
        liveAssetPaths: (await readdir("src/pages")).filter(file => file === "asset.txt").map(file => resolve("src/pages", file)),
        representations: getCompressedCacheEntriesCount(),
        inFlight: getInFlightCompressionsCount(),
        openHandles: getOpenStreamedAssetHandles(),
        listeners: ["build-error", "asset-changed", "transpiled"].map(event => eventEmitter.listenerCount(event)),
        pending: Number(Boolean(armed)),
      },
    } : {}),
    ...(buildDepEnabled ? {
      buildDepLifecycle: {
        observationGeneration: assetGeneration,
        publications,
        liveHelperPaths: (await readdir("src/lib")).filter(file => file === "build-helper.ts").map(file => resolve("src/lib", file)),
        pages: mem.pages().length,
        listeners: ["build-error", "asset-changed", "transpiled"].map(event => eventEmitter.listenerCount(event)),
        pending: Number(Boolean(armed)),
      },
    } : {}),
  };
  for (const references of [requestRefs, requestClosureRefs, loadRefs]) {
    for (let index = references.length - 1; index >= 0; index--) if (!references[index].deref()) references.splice(index, 1);
  }
  for (let index = planRefs.length - 1; index >= 0; index--) if (!planRefs[index].deref()) planRefs.splice(index, 1);
  if (snapshot) {
    assert(memory.heapUsed < 256 * 1024 * 1024 && memory.rss < 768 * 1024 * 1024, "retention snapshot memory safeguard exceeded");
    result.snapshot = writeHeapSnapshot(join(directory, `${phase}.heapsnapshot`));
    await chmod(result.snapshot, 0o600);
  }
  return result;
}

process.on("exit", () => {
  restoreHooks?.();
});

process.on("message", async (message: {
  id: number;
  action: string;
  path: string;
  kind: string;
  phase: string;
  completed: number;
  snapshot: boolean;
  publications: number;
  token: string;
  generation?: number;
  watchEvent?: string;
  expectPending?: ("dispatch" | "transport" | "tls")[];
}) => {
  try {
    let result: unknown;
    if (message.action === "prime") {
      const memory = process.memoryUsage();
      assert(memory.heapUsed < 256 * 1024 * 1024 && memory.rss < 768 * 1024 * 1024, "retention snapshot memory safeguard exceeded");
      writeHeapSnapshot(join(directory, "priming.heapsnapshot"));
    } else if (message.action === "arm") {
      assert(!armed, "only one source observation may be armed");
      observePlans();
      armed = { path: resolve(message.path), kind: message.kind, publications: message.publications, completion: Promise.withResolvers<void>() };
      if (message.kind === "asset-lifecycle") {
        assert(staticAssetEnabled, "asset lifecycle requires its fixture");
        assert.equal(armed.path, resolve("src/pages/asset.txt"), "exact asset source path");
        assert.equal(message.generation, ++assetGeneration, "monotonic asset observation generation");
        armed.asset = { path: armed.path, generation: message.generation, watchEvent: "", publications: [] };
        armed.expectedWatchEvent = message.watchEvent;
      } else if (message.kind === "build-dependency-lifecycle") {
        assert(buildDepEnabled, "build-dependency lifecycle requires its fixture");
        assert.equal(armed.path, resolve("src/lib/build-helper.ts"), "exact build-dependency source path");
        assert.equal(message.generation, ++assetGeneration, "monotonic build-dependency observation generation");
        armed.asset = { path: armed.path, generation: message.generation, watchEvent: "", publications: [] };
        armed.expectedWatchEvent = message.watchEvent;
      }
    } else if (message.action === "asset-idle") {
      assert(staticAssetEnabled || buildDepEnabled, "asset/dependency idle requires its fixture");
      await boundary.join();
    } else if (message.action === "completed") {
      assert(armed, "edit must be armed");
      try {
        await armed.completion.promise;
        if (armed.asset) {
          assert.equal(message.generation, armed.asset.generation, "completed asset/dependency generation");
          assert.equal(armed.asset.watchEvent, armed.expectedWatchEvent, "completed asset/dependency watch event");
          if (buildDepEnabled) {
            const expectedPub = armed.expectedWatchEvent === "unlink" ? ["build-error"] : ["transpiled"];
            assert.deepEqual(armed.asset.publications, expectedPub, "completed build-dependency publication");
          } else {
            assert.deepEqual(armed.asset.publications, ["asset-changed"], "completed asset publication");
          }
          result = armed.asset;
        }
        if (armed.kind === "page" || armed.kind === "component") {
          assert.deepEqual(JSON.parse(await readFile("dist/post.json", "utf8")), { complete: true });
          const html = await readFile("dist/inline.html", "utf8");
          assert(html.includes("</html>"), "source cycle disk publication must complete");
        }
      } finally {
        armed = undefined;
      }
    } else if (message.action === "sample") {
      result = await sample(message.phase, message.completed, message.snapshot, message.expectPending);
    } else if (message.action === "hold-next-dispatch") {
      boundary.hold("dispatch");
      result = { armed: true };
    } else if (message.action === "release-held-dispatch") {
      boundary.release("dispatch");
      result = { released: true };
    } else if (message.action === "hold-next-tls-cleanup") {
      boundary.hold("tls");
      result = { armed: true };
    } else if (message.action === "release-held-tls-cleanup") {
      boundary.release("tls");
      result = { released: true };
    } else if (message.action === "tls-calibration") {
      result = {
        hookInstalled,
        secureConnections,
        destroyedFixtureSockets,
        foreignDestroyCalls,
        serverIdentityMismatches,
        restored: false,
      };
    } else if (message.action === "tls-calibration-inject-foreign") {
      const foreignSocket = new tls.TLSSocket(new net.Socket(), { isServer: false });
      const foreignResolver = Promise.withResolvers<void>();
      foreignDestroyResolvers.set(foreignSocket, foreignResolver);
      foreignSocket.destroy();
      await foreignResolver.promise;
      result = { injected: true };
    } else if (message.action === "cancel-arm") {
      assert(cancellationEnabled, "cancel-arm requires cancellation mode");
      assert(!cancellationGate, "cancel-arm: previous gate not yet settled");
      cancellationGate = {
        token: message.token as string,
        entered: Promise.withResolvers<{ headersSent: boolean }>(),
        dispatch: Promise.withResolvers<void>(),
        closed: Promise.withResolvers<void>(),
        ...(afterPrefix ? {
          pullPending: Promise.withResolvers<void>(),
          producer: Promise.withResolvers<void>(),
        } : {}),
      };
      cancellationCounts.pending++;
      result = { armed: true };
    } else if (message.action === "cancel-pull-pending") {
      assert(afterPrefix, "cancel-pull-pending requires afterPrefix mode");
      assert(cancellationGate && cancellationGate.token === (message.token as string), "cancel-pull-pending: token mismatch");
      await cancellationGate.pullPending!.promise;
      result = { pullPending: true };
    } else if (message.action === "cancel-entered") {
      assert(cancellationEnabled, "cancel-entered requires cancellation mode");
      assert(cancellationGate && cancellationGate.token === (message.token as string), "cancel-entered: gate token mismatch");
      result = await cancellationGate.entered.promise;
    } else if (message.action === "cancel-settled") {
      assert(cancellationEnabled, "cancel-settled requires cancellation mode");
      const gate = cancellationGate;
      assert(gate && gate.token === (message.token as string), "cancel-settled: gate token mismatch");
      // Wait for: (1) dispatch finally ran, (2) response closed, (3) all boundary transports settled.
      // If afterPrefix, also wait for the producer to settle.
      if (afterPrefix) {
        await gate.producer!.promise;
        const midBody = cancellationCounts.midBody!;
        midBody.dispatchSettled = cancellationCounts.dispatchSettled;
        midBody.transportSettled = cancellationCounts.transportSettled + 1; // including this transport
        assert(gate.body, "missing authored body");
        midBody.lockedBodies = Number(gate.body.locked);
        midBody.prefix = Buffer.concat(gate.bytes || []).toString("utf8");
      }
      await gate.dispatch.promise;
      await gate.closed.promise;
      await boundary.join();
      cancellationCounts.transportSettled++;
      if (afterPrefix && cancellationCounts.midBody) {
        cancellationCounts.midBody.transportSettled = cancellationCounts.transportSettled;
        cancellationCounts.midBody.dispatchSettled = cancellationCounts.dispatchSettled;
      }
      cancellationCounts.pending--;
      cancellationGate = undefined;
      result = { cancellation: { ...cancellationCounts } };
    } else if (message.action === "cancel-healthy") {
      assert(cancellationEnabled, "cancel-healthy requires cancellation mode");
      cancellationCounts.healthy++;
      result = { healthy: cancellationCounts.healthy };
    } else if (message.action === "clear") {
      scriptRegistry.clear();
      serverSidecarRegistry.clear();
      for (const page of mem.pages()) mem.removePage(page.absolutePagePath);
      assertRegistryReleased(scriptRegistry);
    } else if (message.action === "stop") {
      await boundary.join();
      const restorationReport = restoreHooks?.() ?? {
        destroySSL: true,
        createSecureServer: true,
        createServer: true,
      };
      process.send!({ id: message.id, result: { restored: restorationReport } });
      process.kill(process.pid, "SIGTERM");
      return;
    } else throw new Error(`Unknown retention action: ${message.action}`);
    process.send!({ id: message.id, result });
  } catch (error) { process.send!({ id: message.id, error: String(error) }); }
});

try {
  if (mode === "dev") {
    const { runTranspile } = await import("../transpile.ts");
    await runTranspile({ exitOnError: false });
    await Promise.all(watcherReadiness);
  } else {
    const { startProdServer } = await import("./server-prod.ts");
    await startProdServer();
  }
  assert.equal(apiRouteRegistry.getRoutes().length, realistic ? 4 : cancellationEnabled ? 3 : 2, "fixture API route count");
  process.send!({ ready: true });
} catch (error) {
  restoreHooks?.();
  process.send!({ error: String(error) });
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
}