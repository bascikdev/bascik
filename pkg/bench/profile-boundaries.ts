import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as checkpoint } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Session } from "node:inspector/promises";
import { createFixture } from "./profile-fixture.ts";
import { createResourceProbe, summarizeAllocationProfile, validatePrivateDirectory, validateResourceBoundary, validateIndependentGates, type GateEvent } from "./profile-workload.ts";
import type { BascikResponse } from "../src/lib/server.ts";

const root = await validatePrivateDirectory(process.argv[2], [fileURLToPath(new URL("../../", import.meta.url))]);
const sampleAllocation = process.argv.includes("--allocation");
await mkdir(root, { recursive: true, mode: 0o700 });
assert.equal((await readdir(root)).length, 0, "boundary report directory must be empty");
process.umask(0o077);
const project = join(root, "project");
await createFixture(project, false, 3000, false);
process.chdir(project);
process.argv = process.argv.slice(0, 2);
await mkdir("dist", { recursive: true });
await mkdir("scripts", { recursive: true });
const { ScriptRegistry } = await import("../src/lib/script-registry.ts");
const { streamApiResponse } = await import("../src/lib/server-api.ts");
const { createResponseSink } = await import("../src/lib/response-sink.ts");
const { createSourceCycle } = await import("../src/lib/source-cycle.ts");
const { runScript, getActiveExecChildrenCount, execShutdownHandler } = await import("../src/lib/exec.ts");
const { runModule, Semaphore } = await import("../src/lib/script-runner.ts");
const { WorkerPool } = await import("../src/lib/worker-pool.ts");
process.stdout.write("");
process.stderr.write("");
const sampler = sampleAllocation ? new Session() : undefined;
const allocationStartedAt = performance.timeOrigin + performance.now();
if (sampler) {
  sampler.connect();
  await sampler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
}
let allocation;
const probe = createResourceProbe();
const gc: { at: number; durationMs: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) gc.push({ at: entry.startTime, durationMs: entry.duration });
});
observer.observe({ entryTypes: ["gc"] });
const checkpoints: object[] = [];
const baseline = probe.snapshot();
let previousTime = performance.now();
let previousCpu = process.cpuUsage();
let previousUtilization = performance.eventLoopUtilization();
async function sample(phase: string) {
  await checkpoint();
  await checkpoint();
  const resources = probe.snapshot();
  const now = performance.now();
  const cpu = process.cpuUsage();
  const utilization = performance.eventLoopUtilization();
  checkpoints.push({ phase, at: now, durationMs: now - previousTime, cpuMicros: process.cpuUsage(previousCpu), eventLoop: performance.eventLoopUtilization(utilization, previousUtilization), memory: process.memoryUsage(), resources });
  await writeFile(join(root, "progress.json"), JSON.stringify({ baseline, checkpoints, gc }, null, 2));
  validateResourceBoundary(baseline, resources);
  previousTime = now;
  previousCpu = cpu;
  previousUtilization = utilization;
}

async function gateServer() {
  const arrivals: Socket[] = [];
  const waiters: (() => void)[] = [];
  const server = createServer((socket) => {
    arrivals.push(socket);
    waiters.shift()?.();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    port, arrivals,
    async arrived(count: number) {
      while (arrivals.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(index: number) { arrivals[index].end("release"); },
    async close() {
      for (const socket of arrivals) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

try {
  const registry = new ScriptRegistry({ isDev: false });
  const module = `data:text/javascript,${encodeURIComponent("export default async (enter, gate) => { enter(); await gate; return 'exact'; }")}`;
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const entries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const events: GateEvent[] = [];
  const jobs = releases.map((release, index) => {
    const gate = String(index);
    return registry.invoke(module, [() => { events.push({ gate, event: "start", at: performance.now() }); entries[index].resolve(); }, release.promise], { timeoutMs: 5000 }).then((result) => {
      assert.equal(result.value, "exact");
      events.push({ gate, event: "end", at: performance.now() });
    });
  });
  await Promise.all(entries.map((entry) => entry.promise));
  for (const [index, release] of releases.entries()) { events.push({ gate: String(index), event: "release", at: performance.now() }); release.resolve(); }
  await Promise.all(jobs);
  validateIndependentGates(events, ["0", "1"]);
  await sample("script-success");
  const syntax = await registry.invoke("data:text/javascript,export default (", [], { timeoutMs: 5000 });
  assert.equal(syntax.ok, false);
  await sample("script-syntax-failure");
  const entered = Promise.withResolvers<void>();
  const upstream = new AbortController();
  const cancelModule = `data:text/javascript,${encodeURIComponent("export default (enter, {signal}) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), {once:true}); enter(); });")}`;
  const pending = registry.invoke(cancelModule, [entered.resolve], { signal: upstream.signal, timeoutMs: 5000 });
  await entered.promise;
  upstream.abort(new Error("fixture cancellation"));
  assert.equal((await pending).ok, false);
  assert.equal(getEventListeners(upstream.signal, "abort").length, 0);
  registry.clear();
  await sample("script-cancel");

  for (const disconnect of [false, true]) {
    const emitter = new EventEmitter();
    const written = Promise.withResolvers<void>();
    const aborted = new AbortController();
    const bytes: Buffer[] = [];
    let pulls = 0;
    let cancels = 0;
    let ended = false;
    let destroyed = false;
    const response: BascikResponse = {
      headersSent: false,
      get destroyed() { return destroyed; },
      writable: emitter as unknown as NodeJS.WritableStream,
      respond() { },
      write(chunk) { bytes.push(Buffer.from(chunk)); written.resolve(); return false; },
      end() { ended = true; },
      close() { destroyed = true; emitter.emit("close"); },
      on(event, listener) { emitter.on(event, listener); },
      off(event, listener) { emitter.off(event, listener); },
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls === 1) controller.enqueue(Buffer.from("exact")); else controller.close(); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 });
    const sink = createResponseSink(response, aborted);
    const stream = streamApiResponse(body, 200, {}, {}, response, aborted, sink);
    await written.promise;
    await checkpoint();
    assert.equal(pulls, 1);
    assert.equal(emitter.listenerCount("drain"), 1);
    if (disconnect) response.close(); else emitter.emit("drain");
    await stream;
    await checkpoint();
    assert.equal(ended, !disconnect);
    assert.equal(cancels, Number(disconnect));
    assert.equal(body.locked, false);
    assert.equal(emitter.listenerCount("drain"), 0);
    assert.equal(emitter.listenerCount("close"), 0);
    assert.equal(getEventListeners(aborted.signal, "abort").length, 0);
    assert.equal(Buffer.concat(bytes).toString(), "exact");
    await sample(disconnect ? "stream-disconnect" : "stream-success");
  }

  await writeFile("scripts/success.mjs", "console.log('module-exact');");
  await writeFile("scripts/failure.mjs", "export default (");
  const semaphore = new Semaphore(1);
  assert.equal((await runModule("scripts/success.mjs", {}, [], 5000, 1024, semaphore)).stdout.trim(), "module-exact");
  await assert.rejects(runModule("scripts/failure.mjs", {}, [], 5000, 1024, semaphore));
  assert.equal(semaphore.getActiveCount(), 0);
  await sample("script-child-success-and-failure");

  const producer = await gateServer();
  const sourceEvents: GateEvent[] = [];
  const execTimings: { script: string; durationMs: number }[] = [];
  const emitter = new EventEmitter();
  let compilations = 0;
  let publications = 0;
  emitter.on("transpiled", () => { publications++; });
  const compileEntered = Promise.withResolvers<void>();
  const compileRelease = Promise.withResolvers<void>();
  const parallelComplete = Promise.withResolvers<void>();
  await writeFile("scripts/pre.mjs", "import {writeFile} from 'node:fs/promises'; await writeFile('dist/pre.txt','pre');");
  await writeFile("scripts/post.mjs", "import {writeFile} from 'node:fs/promises'; await writeFile('dist/post.txt','post');");
  await writeFile("scripts/parallel.mjs", `import {createConnection} from 'node:net'; const socket=createConnection({host:'127.0.0.1',port:${producer.port}}); socket.on('data',()=>socket.end());`);
  const cycle = createSourceCycle({
    entries: [
      { script: "scripts/pre.mjs", watch: ["src/pages/"] },
      { script: "scripts/parallel.mjs", phase: "parallel", watch: ["src/pages/"] },
      { script: "scripts/post.mjs", phase: "post", watch: ["src/pages/"] },
    ], emitter,
    run: async (entry) => {
      if (entry.phase === "parallel") sourceEvents.push({ gate: "parallel", event: "start", at: performance.now() });
      const durationMs = await runScript(entry);
      assert(Number.isFinite(durationMs) && durationMs >= 0);
      execTimings.push({ script: entry.script, durationMs });
      if (entry.phase === "parallel") { sourceEvents.push({ gate: "parallel", event: "end", at: performance.now() }); parallelComplete.resolve(); }
    },
    compile: async (_paths, publish) => {
      compilations++;
      assert.equal(await readFile("dist/pre.txt", "utf8"), "pre");
      sourceEvents.push({ gate: "compile", event: "start", at: performance.now() });
      compileEntered.resolve();
      await compileRelease.promise;
      await writeFile("dist/compiled.txt", "published");
      sourceEvents.push({ gate: "compile", event: "end", at: performance.now() });
      publish("transpiled");
    },
  });
  try {
    cycle.enqueue("src/pages/page-0.html");
    await compileEntered.promise;
    await producer.arrived(1);
    sourceEvents.push({ gate: "compile", event: "release", at: performance.now() });
    compileRelease.resolve();
    await cycle.idle();
    assert.equal(await readFile("dist/post.txt", "utf8"), "post");
    assert.equal(publications, 1);
    sourceEvents.push({ gate: "parallel", event: "release", at: performance.now() });
    producer.release(0);
    await parallelComplete.promise;
    await cycle.idle();
    assert.equal(compilations, 1);
    assert.equal(publications, 1);
    validateIndependentGates(sourceEvents, ["parallel", "compile"]);
  } finally { cycle.close(); await producer.close(); }
  assert.equal(getActiveExecChildrenCount(), 0);
  await sample("source-cycle");

  if (sampler) {
    const { profile } = await sampler.post("HeapProfiler.stopSampling");
    sampler.disconnect();
    await writeFile(join(root, "main.heapprofile"), JSON.stringify(profile));
    allocation = { ...summarizeAllocationProfile(profile), coverage: "main script and source-cycle window only", pid: process.pid, threadId: 0, startedAt: allocationStartedAt, endedAt: performance.timeOrigin + performance.now(), samplingInterval: 4096, collectedObjectsIncluded: true };
  }

  const workerGate = await gateServer();
  const workerPath = join(project, "scripts/worker.mjs");
  await writeFile(workerPath, `import {parentPort,workerData,threadId} from 'node:worker_threads'; import {createConnection} from 'node:net';
    parentPort.on('message', async task => {
      const enteredAt=performance.timeOrigin+performance.now();
      await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port:workerData.port});socket.on('data',()=>socket.end());socket.on('close',resolve);});
      const encodingStartedAt=performance.timeOrigin+performance.now(); const bytes=new TextEncoder().encode(task);
      const replyAt=performance.timeOrigin+performance.now(); parentPort.postMessage({ok:true,result:{bytes,enteredAt,encodingStartedAt,replyAt,threadId}},[bytes.buffer]);
    });`);
  interface WorkerResult { bytes: Uint8Array; enteredAt: number; encodingStartedAt: number; replyAt: number; threadId: number }
  const pool = new WorkerPool<string, WorkerResult>(workerPath, 2, { port: workerGate.port });
  const timings: { index: number; queuedAt: number; receivedAt: number; diskStartedAt: number; diskCompletedAt: number; enteredAt: number; encodingStartedAt: number; replyAt: number; threadId: number; bytes: number }[] = [];
  try {
    const tasks = Array.from({ length: 4 }, (_, index) => {
      const queuedAt = performance.timeOrigin + performance.now();
      return pool.run(`task-${index}`).then(async (result) => {
        const receivedAt = performance.timeOrigin + performance.now();
        assert.equal(Buffer.from(result.bytes).toString(), `task-${index}`);
        const diskStartedAt = performance.timeOrigin + performance.now();
        await writeFile(`dist/worker-${index}.txt`, result.bytes);
        const diskCompletedAt = performance.timeOrigin + performance.now();
        assert.equal(await readFile(`dist/worker-${index}.txt`, "utf8"), `task-${index}`);
        timings.push({ index, queuedAt, receivedAt, diskStartedAt, diskCompletedAt, ...result, bytes: result.bytes.length });
      });
    });
    await workerGate.arrived(2);
    assert.equal(workerGate.arrivals.length, 2);
    workerGate.release(0); workerGate.release(1);
    await workerGate.arrived(4);
    workerGate.release(2); workerGate.release(3);
    await Promise.all(tasks);
  } finally { await pool.terminate(); await workerGate.close(); }
  const concurrencyEvents = timings.flatMap((task) => [{ at: task.enteredAt, delta: 1 }, { at: task.replyAt, delta: -1 }]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maxActive = 0;
  for (const event of concurrencyEvents) { active += event.delta; maxActive = Math.max(maxActive, active); }
  assert.equal(active, 0);
  assert.equal(maxActive, 2);
  await sample("worker-success");
  const cancelGate = await gateServer();
  const cancelPool = new WorkerPool<string, WorkerResult>(workerPath, 1, { port: cancelGate.port });
  const canceled = Promise.allSettled([cancelPool.run("one"), cancelPool.run("two"), cancelPool.run("three")]);
  try { await cancelGate.arrived(1); await cancelPool.terminate(); }
  finally { await cancelPool.terminate(); await cancelGate.close(); }
  const cancellations = await canceled;
  assert(cancellations.every((result) => result.status === "rejected"));
  await sample("worker-cancel");
  await execShutdownHandler();
  await sample("shutdown");
  await writeFile(join(root, "boundaries.json"), JSON.stringify({ success: true, pid: process.pid, versions: process.versions, baseline, checkpoints, gc, allocation, scriptGates: events, sourceCycle: { compilations, publications, events: sourceEvents, execTimings }, worker: { completed: timings.length, maxActive, canceled: cancellations.length, timings }, limitations: ["WorkerPool fixture timings are not page-worker CPU samples", "Queue-to-entry includes startup and IPC; reply-to-receive includes scheduling", "Async resource tracking begins after module setup; descriptor inventory is process-wide where supported", "Resource probe excludes Promise retention; use the separate retention harness", "Response capacity and disconnect are controlled at the real stream bridge"] }, null, 2));
} finally {
  sampler?.disconnect();
  probe.close();
  observer.disconnect();
}