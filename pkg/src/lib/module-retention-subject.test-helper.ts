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
const rejectAfterAbort = faultFlag === "reject-after-abort";
const fixedFailedImport = faultFlag === "fixed-failed-import";
const cancellationEnabled = beforeHeaders || afterPrefix || rejectAfterAbort;
const staticAssetEnabled = faultFlag === "static-asset";
const buildDepEnabled = faultFlag === "build-dependency";
const devModuleInlineEnabled = faultFlag === "dev-module-inline";
const devModuleExternalEnabled = faultFlag === "dev-module-external";
const devModuleApiEnabled = faultFlag === "dev-module-api";
const devModuleEnabled = devModuleInlineEnabled || devModuleExternalEnabled || devModuleApiEnabled;
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
let holdBuildDepCallback = false;
let heldBuildDepGate: {
  entered: ReturnType<typeof Promise.withResolvers<void>>;
  release: ReturnType<typeof Promise.withResolvers<void>>;
} | undefined;

async function enterHeldBuildDepGate(event: string): Promise<void> {
  if (!holdBuildDepCallback || !heldBuildDepGate) return;
  // The held gate discriminates by event only. This is safe for the current
  // single-path build-dependency fixture (src/lib/build-helper.ts); if the gate
  // is ever reused for a multi-path fixture, it must also match the canonical path.
  if (armed && armed.expectedWatchEvent !== event) return;
  heldBuildDepGate.entered.resolve();
  await heldBuildDepGate.release.promise;
}

const originalWatch = chokidar.watch;
chokidar.watch = (...args: Parameters<typeof originalWatch>) => {
  const watcher = originalWatch(...args);
  const watchPathsTarget = args[0];
  const isWatchPaths = (Array.isArray(watchPathsTarget) ? watchPathsTarget : [watchPathsTarget])
    .some(p => typeof p === "string" && resolve(p) === resolve("src/lib/build-helper.ts"));

  if (isWatchPaths && buildDepEnabled) {
    const origOn = watcher.on;
    watcher.on = function(this: ReturnType<typeof originalWatch>, event: string, listener: (...lArgs: unknown[]) => unknown) {
      if (["add", "change", "unlink"].includes(event)) {
        const wrappedListener = async (...lArgs: unknown[]) => {
          // Capture immutable operation identity at actual compilation callback entry.
          const path = lArgs[0];
          const matchesArmed = armed?.kind === "build-dependency-lifecycle"
            && armed.expectedWatchEvent === event
            && typeof path === "string" && resolve(path) === armed.path;
          const operation = matchesArmed
            ? { event, path: armed!.path, generation: armed!.asset?.generation }
            : undefined;
          await enterHeldBuildDepGate(event);
          try {
            return await Reflect.apply(listener, this, lArgs);
          } finally {
            // Completion settles only after the real compilation callback settles.
            if (operation && armed?.kind === "build-dependency-lifecycle"
                && armed.expectedWatchEvent === operation.event
                && armed.asset?.generation === operation.generation) {
              resolveArmedCompletion();
            }
          }
        };
        return Reflect.apply(origOn, this, [event, wrappedListener]) as ReturnType<typeof originalWatch>;
      }
      return Reflect.apply(origOn, this, [event, listener]) as ReturnType<typeof originalWatch>;
    } as typeof watcher.on;
  }

  if (devModuleEnabled) {
    const watcherId = watcherReadiness.length;
    const originalClose = watcher.close;
    watcher.close = async () => {
      await originalClose.call(watcher);
      // Acknowledge completion, not merely invocation, of the real shutdown owner.
      await new Promise<void>((resolve, reject) => {
        process.send!({ watcherClosed: watcherId }, error => error ? reject(error) : resolve());
      });
    };
  }
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
      return;
    }
    if (devModuleEnabled) {
      if (!observation || resolve(path) !== observation.path) return;
      if (observation.watchEvent) {
        if (observation.watchEvent === event) return;
        process.send!({ error: `Unexpected dev-module watch event: ${event} ${path}, generation ${observation.generation}` });
        return;
      }
      if (event !== armed!.expectedWatchEvent) {
        process.send!({ error: `Unexpected dev-module watch event: ${event} ${path}, generation ${observation.generation}` });
        return;
      }
      observation.watchEvent = event;
      if (devModuleExternalEnabled) process.send!({ externalStage: { ...observation, stage: "watcher", action: armed?.kind } });
      if (devModuleApiEnabled) process.send!({ apiStage: { ...observation, stage: "watcher" } });
      if (armed?.kind === "dev-module-lifecycle") {
        if (devModuleInlineEnabled) {
          // Source-cycle publications follow joined disk writes and post scripts.
          // On unlink, the surviving external page acknowledges the same cycle.
        } else if (devModuleExternalEnabled) {
          // Only actual compilation publications acknowledge this operation.
        } else if (devModuleApiEnabled) {
          if (observation.publications.includes("api-route-changed")) {
            resolveArmedCompletion();
          }
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
const { pageWriteIdle } = await import("./processing.ts");
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
  completionResolved: boolean;
  asset?: InlinePageObservation;
  expectedWatchEvent?: string;
} | undefined;

/** Resolve the armed operation's completion exactly once, recording that it resolved. */
function resolveArmedCompletion(): void {
  if (!armed || armed.completionResolved) return;
  armed.completionResolved = true;
  armed.completion.resolve();
}
let assetGeneration = 0;
let assetPublications = 0;
let apiRoutePublications = 0;

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
} else if (mode === "http1" || staticAssetEnabled || buildDepEnabled || devModuleEnabled) {
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
  const isFaultInvocation = (beforeHeaders || rejectAfterAbort) && typeof args[0] === "string" && args[0].includes("fault");
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
  if (devModuleApiEnabled && armed && resolve(specifier) === armed.path) {
    process.send!({ apiStage: { ...armed.asset, stage: "invalidation", advanced } });
  }
  if (devModuleExternalEnabled && armed && resolve(specifier) === armed.path) {
    process.send!({ externalStage: { ...armed.asset, stage: "invalidation", advanced } });
  }
  if (advanced && armed?.kind === "module" && resolve(specifier) === armed.path) resolveArmedCompletion();
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
    return;
  }
  if (devModuleEnabled && armed?.kind === "dev-module-lifecycle") {
    if (devModuleInlineEnabled) {
      assert(armed.asset, "inline publication requires armed operation");
      assert.equal(armed.asset.watchEvent, armed.expectedWatchEvent, "inline publication follows watcher acknowledgment");
      const expectedPaths = armed.expectedWatchEvent === "unlink" ? ["pages/external.html"]
        : armed.expectedWatchEvent === "add" ? ["pages/external.html", "pages/inline.html"] : ["pages/inline.html"];
      assert(event?.relativePagePath && expectedPaths.includes(event.relativePagePath), "exact source-cycle publication path");
      const publication = `transpiled:${event.relativePagePath}`;
      assert(!armed.asset.publications.includes(publication), "one publication per page per source cycle");
      armed.asset.publications.push(publication);
      armed.asset.publications.sort();
      if (armed.asset.publications.length === expectedPaths.length) resolveArmedCompletion();
      return;
    }
    assert(armed.asset, "dev-module publication requires armed operation");
    if (devModuleExternalEnabled) {
      assert.equal(event?.relativePagePath, "pages/external.html", "exact external helper publication path");
      assert.notEqual(armed.expectedWatchEvent, "unlink", "deleted helper cannot publish success");
      process.send!({ externalStage: { ...armed.asset, stage: "publication", page: event.relativePagePath } });
    }
    if (!armed.asset.publications.includes("transpiled")) {
      armed.asset.publications.push("transpiled");
    }
    if (armed.asset.watchEvent) {
      resolveArmedCompletion();
    }
    return;
  }
  if (armed?.kind === "page" || armed?.kind === "component") {
    armed.publications--;
    if (armed.publications === 0) resolveArmedCompletion();
  }
});
eventEmitter.on("asset-changed", () => {
  if (!staticAssetEnabled) return;
  assert(armed?.asset, "asset publication requires an armed operation");
  assert.equal(armed.asset.watchEvent, armed.expectedWatchEvent, "asset publication follows exact watch event");
  assert.equal(armed.asset.publications.length, 0, "one asset publication per operation");
  armed.asset.publications.push("asset-changed");
  assetPublications++;
  resolveArmedCompletion();
});
eventEmitter.on("api-route-changed", (event: { path: string; type?: string; }) => {
  if (staticAssetEnabled) process.send!({ error: `Unexpected API change for static asset: ${event.path}` });
  if (devModuleEnabled && armed?.kind === "dev-module-lifecycle" && devModuleApiEnabled) {
    assert(armed.asset, "dev-module API publication requires armed operation");
    assert.equal(resolve(event.path), armed.path, "exact API publication path");
    assert.equal(event.type, armed.expectedWatchEvent, "exact API publication event");
    assert.equal(armed.asset.watchEvent, armed.expectedWatchEvent, "API publication follows watcher input");
    assert.equal(armed.asset.publications.length, 0, "one API publication per operation");
    armed.asset.publications.push("api-route-changed");
    apiRoutePublications++;
    // watch.ts emits this only after invalidateFile has awaited the route-table reload.
    process.send!({ apiStage: { ...armed.asset, stage: "reload" } });
    resolveArmedCompletion();
    return;
  }
  if (armed?.kind === "api" && resolve(event.path) === armed.path) resolveArmedCompletion();
});
eventEmitter.on("build-error", error => {
  if (buildDepEnabled && armed?.kind === "build-dependency-lifecycle" && armed.expectedWatchEvent === "unlink") {
    assert(armed.asset, "build-dependency publication requires armed operation");
    if (!armed.asset.publications.includes("build-error")) {
      armed.asset.publications.push("build-error");
    }
    return;
  }
  if (devModuleEnabled && armed?.kind === "dev-module-lifecycle" && devModuleExternalEnabled && armed.expectedWatchEvent === "unlink") {
    assert(armed.asset, "dev-module build-error publication requires armed operation");
    assert(JSON.stringify(error).includes("helper.mjs"), "external failure identifies the missing helper");
    process.send!({ externalStage: { ...armed.asset, stage: "build-error", error } });
    if (!armed.asset.publications.includes("build-error")) {
      armed.asset.publications.push("build-error");
    }
    if (armed.asset.watchEvent) {
      resolveArmedCompletion();
    }
    return;
  }
  process.send!({ error: JSON.stringify(error) });
});
eventEmitter.on("watch-path-processed", (event?: { path?: string }) => {
  publications++;
  if (buildDepEnabled && armed?.kind === "build-dependency-lifecycle") {
    // Validate the payload without treating it as a substitute publication.
    assert(armed.asset, "build-dependency watch-path-processed requires armed operation");
    assert(event?.path && resolve(event.path) === armed.path, "exact build-dependency watch-path-processed path");
    return;
  }
  if (devModuleEnabled && !devModuleInlineEnabled && !devModuleExternalEnabled && armed?.kind === "dev-module-lifecycle") {
    assert(armed.asset, "dev-module watch-path-processed publication requires armed operation");
    if (armed.expectedWatchEvent === "unlink") {
      if (devModuleExternalEnabled && !armed.asset.publications.includes("build-error")) {
        armed.asset.publications.push("build-error");
      }
    } else {
      if (!armed.asset.publications.includes("transpiled")) {
        armed.asset.publications.push("transpiled");
      }
    }
    if (armed.asset.watchEvent) {
      resolveArmedCompletion();
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
          return Reflect.apply(origWrite!, res, [chunk, ...writeArgs]);
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
  if (staticAssetEnabled || devModuleInlineEnabled || devModuleApiEnabled) {
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
    ...(cancellationEnabled ? { cancellation: { ...cancellationCounts, midBody: cancellationCounts.midBody ? { ...cancellationCounts.midBody } : undefined } } : {}),
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
    ...(devModuleEnabled ? {
      devModuleLifecycle: {
        observationGeneration: assetGeneration,
        publications: devModuleApiEnabled ? apiRoutePublications : publications,
        liveTargetPaths: devModuleInlineEnabled
          ? (await readdir("src/pages")).filter(file => file === "inline.html").map(file => resolve("src/pages", file))
          : devModuleExternalEnabled
            ? (await readdir("src/lib")).filter(file => file === "helper.mjs").map(file => resolve("src/lib", file))
            : (await readdir("api")).filter(file => file === "probe.mjs").map(file => resolve("api", file)),
        pages: mem.pages().length,
        listeners: ["build-error", "asset-changed", "transpiled", "api-route-changed"].map(event => eventEmitter.listenerCount(event)),
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
      armed = { path: resolve(message.path), kind: message.kind, publications: message.publications, completion: Promise.withResolvers<void>(), completionResolved: false };
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
      } else if (message.kind === "dev-module-lifecycle") {
        assert(devModuleEnabled, "dev-module lifecycle requires its fixture");
        const expectedPath = devModuleInlineEnabled
          ? resolve("src/pages/inline.html")
          : devModuleExternalEnabled
            ? resolve("src/lib/helper.mjs")
            : resolve("api/probe.mjs");
        assert.equal(armed.path, expectedPath, "exact dev-module source path");
        assert.equal(message.generation, ++assetGeneration, "monotonic dev-module observation generation");
        armed.asset = { path: armed.path, generation: message.generation, watchEvent: "", publications: [] };
        armed.expectedWatchEvent = message.watchEvent;
      }
    } else if (message.action === "asset-idle") {
      assert(staticAssetEnabled || buildDepEnabled || devModuleEnabled, "asset/dependency/dev-module idle requires its fixture");
      await boundary.join();
    } else if (message.action === "page-write-idle") {
      // Join the queued dev disk write for the page under observation. The
      // `transpiled` event is published before that write runs, so a caller
      // asserting exact dist/ bytes must await this first.
      assert(buildDepEnabled || devModuleInlineEnabled, "page-write-idle requires a page-edit fixture");
      await pageWriteIdle(resolve("src/pages/inline.html"));
      result = { idle: true };
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
          } else if (devModuleEnabled) {
            if (devModuleInlineEnabled) {
              const expectedPub = armed.expectedWatchEvent === "unlink" ? ["transpiled:pages/external.html"]
                : armed.expectedWatchEvent === "add" ? ["transpiled:pages/external.html", "transpiled:pages/inline.html"]
                  : ["transpiled:pages/inline.html"];
              assert.deepEqual(armed.asset.publications, expectedPub, "completed dev-module inline publication");
            } else if (devModuleExternalEnabled) {
              const expectedPub = armed.expectedWatchEvent === "unlink" ? ["build-error"] : ["transpiled"];
              assert.deepEqual(armed.asset.publications, expectedPub, "completed dev-module external publication");
            } else if (devModuleApiEnabled) {
              const expectedPub = ["api-route-changed"];
              assert.deepEqual(armed.asset.publications, expectedPub, "completed dev-module API publication");
            }
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
    } else if (message.action === "hold-next-build-dep-callback") {
      holdBuildDepCallback = true;
      heldBuildDepGate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      result = { armed: true };
    } else if (message.action === "await-build-dep-callback-entry") {
      assert(heldBuildDepGate, "await-build-dep-callback-entry requires an armed gate");
      await heldBuildDepGate.entered.promise;
      result = { entered: true, completionResolved: armed?.completionResolved ?? false };
    } else if (message.action === "release-held-build-dep-callback") {
      holdBuildDepCallback = false;
      heldBuildDepGate?.release.resolve();
      result = { released: true };
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
      }
      await gate.dispatch.promise;
      await gate.closed.promise;
      await boundary.join();
      cancellationCounts.transportSettled++;
      if (afterPrefix && cancellationCounts.midBody) {
        cancellationCounts.midBody.transportSettled = cancellationCounts.transportSettled;
        cancellationCounts.midBody.dispatchSettled = cancellationCounts.dispatchSettled;
        assert(gate.body, "missing authored body");
        cancellationCounts.midBody.lockedBodies = Number(gate.body.locked);
        cancellationCounts.midBody.prefix = Buffer.concat(gate.bytes || []).toString("utf8");
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
      process.send!({ id: message.id, result: { restored: restorationReport, watchers: watcherReadiness.length } });
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
  assert.equal(apiRouteRegistry.getRoutes().length, realistic ? 4 : (cancellationEnabled || fixedFailedImport) ? 3 : 2, "fixture API route count");
  process.send!({ ready: true });
} catch (error) {
  restoreHooks?.();
  process.send!({ error: String(error) });
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
}