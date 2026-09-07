import assert from "node:assert/strict";
import { writeHeapSnapshot } from "node:v8";
import { setImmediate as nextTurn } from "node:timers/promises";
import { resolve, join } from "node:path";
import { chmod, readFile } from "node:fs/promises";
import { registryEntries, assertRegistryReleased, retentionHelperPaths, type RetentionCheckpoint } from "./module-retention.test-helper.ts";
import chokidar from "chokidar";
import zlib from "node:zlib";

const [directory, mode, realisticFlag] = process.argv.slice(2);
const realistic = realisticFlag === "true";
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
  return watcher;
};

const { scriptRegistry } = await import("./script-registry.ts");
const { mem } = await import("./mem.ts");
const { eventEmitter } = await import("./events.ts");
const { apiRouteRegistry } = await import("./server-api.ts");
const { moduleKeyForPath } = await import("./module-graph.ts");
const { serverSidecarRegistry } = await import("./server-sidecar.ts");
const requestRefs: WeakRef<object>[] = [];
const requestClosureRefs: WeakRef<object>[] = [];
const planRefs: WeakRef<object>[] = [];
const seenPlans = new WeakSet<object>();
const loadRefs: WeakRef<object>[] = [];
const seenLoads = new WeakSet<object>();
let activeRequests = 0;
let requests = 0;
let publications = 0;
let armed: { path: string; kind: string; publications: number; completion: ReturnType<typeof Promise.withResolvers<void>>; } | undefined;

Reflect.set(globalThis, Symbol.for("bascik.retention.observe"), (request: object, context: object, closure: object) => {
  requests++;
  requestRefs.push(new WeakRef(request), new WeakRef(context));
  requestClosureRefs.push(new WeakRef(closure));
});

const invoke = scriptRegistry.invoke;
scriptRegistry.invoke = async function <Result>(...args: Parameters<typeof invoke>) {
  activeRequests++;
  try { return await invoke.call(this, ...args) as import("./script-registry.ts").ScriptExecutionResult<Result>; }
  finally { activeRequests--; }
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
eventEmitter.on("transpiled", () => {
  publications++;
  if (armed?.kind === "page" || armed?.kind === "component") {
    armed.publications--;
    if (armed.publications === 0) armed.completion.resolve();
  }
});
eventEmitter.on("api-route-changed", (event: { path: string; }) => {
  if (armed?.kind === "api" && resolve(event.path) === armed.path) armed.completion.resolve();
});
eventEmitter.on("build-error", error => process.send!({ error: JSON.stringify(error) }));

function observePlans() {
  for (const page of mem.pages()) {
    const plan = page.serverScriptPlan;
    if (plan && !seenPlans.has(plan)) { seenPlans.add(plan); planRefs.push(new WeakRef(plan)); }
  }
}

async function sample(phase: string, completed: number, snapshot: boolean): Promise<RetentionCheckpoint> {
  assert.equal(activeRequests, 0, "sample requires settled request handlers");
  observePlans();
  await Promise.all([...pendingCompression]);
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
    activeRequests, pendingCompression: pendingCompression.size, resources: process.getActiveResourcesInfo().sort(),
    fileVersions: filePaths.map(path => scriptRegistry.generationOf(resolve(path))), memory,
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

process.on("message", async (message: { id: number; action: string; path: string; kind: string; phase: string; completed: number; snapshot: boolean; publications: number; }) => {
  try {
    let result: unknown;
    if (message.action === "prime") {
      const memory = process.memoryUsage();
      assert(memory.heapUsed < 256 * 1024 * 1024 && memory.rss < 768 * 1024 * 1024, "retention snapshot memory safeguard exceeded");
      writeHeapSnapshot(join(directory, "priming.heapsnapshot"));
    } else if (message.action === "arm") {
      observePlans();
      armed = { path: resolve(message.path), kind: message.kind, publications: message.publications, completion: Promise.withResolvers<void>() };
    } else if (message.action === "completed") {
      assert(armed, "edit must be armed");
      await armed.completion.promise;
      if (armed.kind === "page" || armed.kind === "component") {
        assert.deepEqual(JSON.parse(await readFile("dist/post.json", "utf8")), { complete: true });
        const html = await readFile("dist/inline.html", "utf8");
        assert(html.includes("</html>"), "source cycle disk publication must complete");
      }
      armed = undefined;
    } else if (message.action === "sample") result = await sample(message.phase, message.completed, message.snapshot);
    else if (message.action === "clear") {
      scriptRegistry.clear();
      serverSidecarRegistry.clear();
      for (const page of mem.pages()) mem.removePage(page.absolutePagePath);
      assertRegistryReleased(scriptRegistry);
    } else if (message.action === "stop") {
      process.send!({ id: message.id });
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
  assert.equal(apiRouteRegistry.getRoutes().length, realistic ? 4 : 2, "fixture API route count");
  process.send!({ ready: true });
} catch (error) {
  process.send!({ error: String(error) });
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
}