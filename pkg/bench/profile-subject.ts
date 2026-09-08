import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import zlib from "node:zlib";
import http from "node:http";
import { cleanGeneratorEnvironment, digest } from "./profile-workload.ts";
import { pageCount, componentsPerPage, pageSource, assetBytes, fixtureTlsFiles } from "./profile-fixture.ts";
import { observeSubjects } from "./profile-observers.ts";
import { profileJournal } from "./profile-diagnostics.ts";

const [scenario, reportDirectory, encoding, rounds, injectFailure] = process.argv.slice(2);
const stopHeapSampling = process.env.HEAP_PROFILER_PATH ? process.listeners("SIGINT")[0] : undefined;
process.argv = process.argv.slice(0, 2);
delete process.env.BASCIK_BUILD;
delete process.env.BASCIK_SERVER;
const startedAt = Date.now();
const start = performance.now();
const subjectEvents = observeSubjects(process.env.BASCIK_PROFILE_CAPTURE_DIR);
const journal = profileJournal(process.env.BASCIK_PROFILE_CAPTURE_DIR);
journal("subject-started", { scenario });
const diagnosticDeadline = setTimeout(() => journal("subject-pre-deadline", { cpu: process.cpuUsage(), memory: process.memoryUsage(), resources: process.getActiveResourcesInfo(), usage: process.resourceUsage(), subjectEvents }), 90_000);
diagnosticDeadline.unref();
const compression = { calls: 0, active: 0, maxActive: 0, callbackMs: 0, syncCalls: 0, syncMs: 0 };
const pendingCodecs = new Set<Promise<void>>();
function codecCompletion() {
  const completion = Promise.withResolvers<void>();
  pendingCodecs.add(completion.promise);
  return () => { pendingCodecs.delete(completion.promise); completion.resolve(); };
}
const brotli = zlib.brotliCompress;
zlib.brotliCompress = ((...args: Parameters<typeof brotli>) => {
  const finish = codecCompletion();
  compression.calls++;
  compression.active++;
  compression.maxActive = Math.max(compression.maxActive, compression.active);
  const begin = performance.now();
  const callback = args.pop() as (error: Error | null, result: Buffer) => void;
  return Reflect.apply(brotli, zlib, [...args, (error: Error | null, result: Buffer) => {
    compression.active--;
    compression.callbackMs += performance.now() - begin;
    try { callback(error, result); } finally { finish(); }
  }]);
}) as typeof brotli;
const gzip = zlib.gzip;
zlib.gzip = ((...args: Parameters<typeof gzip>) => {
  const finish = codecCompletion();
  const callback = args.pop() as (error: Error | null, result: Buffer) => void;
  return Reflect.apply(gzip, zlib, [...args, (error: Error | null, result: Buffer) => {
    try { callback(error, result); } finally { finish(); }
  }]);
}) as typeof gzip;
const syncBrotli = zlib.brotliCompressSync;
zlib.brotliCompressSync = ((...args: Parameters<typeof syncBrotli>) => {
  const begin = performance.now();
  compression.syncCalls++;
  try { return syncBrotli(...args); } finally { compression.syncMs += performance.now() - begin; }
}) as typeof syncBrotli;

async function validateBuild() {
  const files = [];
  for (let index = 0; index < pageCount; index++) {
    const html = await readFile(join(process.cwd(), `dist/page-${index}.html`), "utf8");
    assert.equal(html.match(/component-128/g)?.length, componentsPerPage, "component expansion count");
    assert.equal(html.match(/slot-\d+/g)?.length, componentsPerPage, "slot count");
    assert.equal(html.match(/build-128/g)?.length, 1, "build script completion");
    assert(!html.includes("<profile-card"), "unexpanded component");
    assert(html.includes("bascik__"), "missing scoped output");
    files.push({ path: `page-${index}.html`, bytes: Buffer.byteLength(html), sha256: digest(html) });
  }
  return { completed: pageCount, files };
}

if (["prepare", "serial", "workers"].includes(scenario)) {
  process.argv.push("--build");
  const { runTranspile } = await import("../src/transpile.ts");
  const startupMs = performance.now() - start;
  const builds = [];
  for (const phase of scenario === "prepare" ? ["prepare"] : ["cache-cold", "cache-warm"]) {
    const begin = performance.now();
    const cpuStart = process.cpuUsage();
    const beginEpoch = Date.now();
    journal("build-start", { phase });
    await runTranspile();
    journal("build-returned", { phase });
    const durationMs = performance.now() - begin;
    builds.push({ phase, startedAt: beginEpoch, endedAt: Date.now(), durationMs, cpuMicros: process.cpuUsage(cpuStart), ...await validateBuild() });
    journal("build-validated", { phase });
  }
  const { runShutdownHandlers } = await import("../src/lib/events.ts");
  journal("shutdown-start");
  await runShutdownHandlers();
  journal("shutdown-completed");
  clearTimeout(diagnosticDeadline);
  if (scenario !== "prepare") await writeFile(join(reportDirectory, "result.json"), JSON.stringify({ pid: process.pid, startedAt, endedAt: Date.now(), startupMs, builds, subjectEvents, memory: process.memoryUsage() }, null, 2));
} else {
  let origin: string;
  let staticServer: http.Server | undefined;
  if (scenario === "dev") {
    const { runTranspile } = await import("../src/transpile.ts");
    await runTranspile({ exitOnError: false });
    const { BascikConfig } = await import("../src/lib/config.ts");
    origin = `http://127.0.0.1:${BascikConfig.http.port}`;
  } else if (scenario === "static") {
    staticServer = http.createServer(async (request, response) => {
      const path = request.url;
      if (!["/asset.txt", "/readiness.json", "/page-0.html"].includes(path ?? "")) { response.writeHead(404).end("Not Found"); return; }
      try { response.end(await readFile(join(process.cwd(), "dist", path!.slice(1)))); }
      catch { response.writeHead(500).end("Read failed"); }
    });
    await new Promise<void>((resolve) => staticServer!.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(staticServer.address() as import("node:net").AddressInfo).port}`;
  } else {
    process.argv.push("--server");
    const { startProdServer } = await import("../src/lib/server-prod.ts");
    origin = await startProdServer();
  }
  const listeningMs = performance.now() - start;
  await Promise.all([...pendingCodecs]);
  const startupMs = performance.now() - start;
  const startupCompression = { ...compression };
  compression.calls = 0;
  compression.maxActive = 0;
  compression.callbackMs = 0;
  compression.syncCalls = 0;
  compression.syncMs = 0;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const phaseMetrics: object[] = [];
  let cpuStart = process.cpuUsage();
  let result: Record<string, unknown> | undefined;
  let probing = false;
  let probeWork: Promise<void> | undefined;
  let probeError: unknown;
  const filesystemProbe = { completed: 0, active: 0, totalMs: 0, maxMs: 0, meanMs: 0 };
  const probeBytes = assetBytes();
  const child = fork(fileURLToPath(new URL("./profile-load.ts", import.meta.url)), [origin, encoding, rounds, injectFailure, scenario, join(process.cwd(), fixtureTlsFiles.ca)], { execArgv: [], env: cleanGeneratorEnvironment(process.env), stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.on("message", async (message: { event: string; phase: string; phases: unknown; generator: unknown }) => {
    if (message.event === "start") {
      delay.reset(); delay.enable(); cpuStart = process.cpuUsage();
      if (message.phase === "distinct-assets") {
        probing = true;
        probeWork = (async () => {
          while (probing) {
            filesystemProbe.active = 1;
            const begin = performance.now();
            assert((await readFile("dist/asset.txt")).equals(probeBytes), "filesystem probe integrity");
            const durationMs = performance.now() - begin;
            filesystemProbe.completed++;
            filesystemProbe.totalMs += durationMs;
            filesystemProbe.maxMs = Math.max(filesystemProbe.maxMs, durationMs);
            filesystemProbe.meanMs = filesystemProbe.totalMs / filesystemProbe.completed;
            filesystemProbe.active = 0;
          }
        })().catch((error) => { probeError = error; child.kill(); });
      }
    }
    if (message.event === "end") {
      probing = false;
      await probeWork;
      delay.disable();
      phaseMetrics.push({ phase: message.phase, monotonicMicros: Number(process.hrtime.bigint() / 1000n), cpuMicros: process.cpuUsage(cpuStart), eventLoopP99Ms: delay.count ? delay.percentile(99) / 1e6 : null, eventLoopSamples: delay.count, memory: process.memoryUsage(), compression: { ...compression, pending: pendingCodecs.size }, ...(message.phase === "distinct-assets" ? { filesystemProbe } : {}) });
    }
    if (message.event === "complete") result = { phases: message.phases, generator: message.generator };
    child.send({ event: "ack" });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`generator failed: ${code}`)));
    });
    assert(result, "missing generator completion");
    if (probeError) throw probeError;
    const requestCompression = { ...compression, pending: pendingCodecs.size };
    let edit;
    if (scenario === "dev") {
      const begin = performance.now();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { observer.close(); reject(new Error("edit publication timeout")); }, 15_000);
        const observer = watch("dist", async (_event, filename) => {
          if (filename !== "page-0.html") return;
          const html = await readFile("dist/page-0.html", "utf8").catch(() => "");
          if (!html.includes("page-0-edited") || !html.includes("</html>") || html.match(/component-128/g)?.length !== componentsPerPage) return;
          clearTimeout(deadline);
          observer.close();
          resolve();
        });
        observer.on("error", (error) => { clearTimeout(deadline); observer.close(); reject(error); });
        writeFile("src/pages/page-0.html", pageSource(0, true)).catch((error) => { clearTimeout(deadline); observer.close(); reject(error); });
      });
      const html = await readFile("dist/page-0.html", "utf8");
      assert(html.includes("page-0-edited"), "edit must reach disk publication");
      await Promise.all([...pendingCodecs]);
      edit = { ...await validateBuild(), completed: 1, durationMs: performance.now() - begin, sha256: digest(html), compression: { calls: compression.calls - requestCompression.calls, syncCalls: compression.syncCalls - requestCompression.syncCalls, active: compression.active, pending: pendingCodecs.size } };
    }
    await writeFile(join(reportDirectory, "result.json"), JSON.stringify({ ...result, pid: process.pid, startedAt, endedAt: Date.now(), listeningMs, startupMs, startupCompression, phaseMetrics, compression: requestCompression, edit, subjectEvents }, null, 2));
  } finally {
    probing = false;
    await probeWork;
    delay.disable();
    child.kill();
    if (staticServer) await new Promise<void>((resolve, reject) => staticServer!.close((error) => error ? reject(error) : resolve()));
    else if (stopHeapSampling) {
      const { runShutdownHandlers } = await import("../src/lib/events.ts");
      await runShutdownHandlers();
      stopHeapSampling("SIGINT");
    } else process.kill(process.pid, "SIGTERM");
  }
}