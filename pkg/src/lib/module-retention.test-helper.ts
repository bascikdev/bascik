import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import http2 from "node:http2";
import { cleanGeneratorEnvironment, validatePrivateDirectory, digest } from "../../bench/profile-workload.ts";
import { execute } from "../../bench/profile-runner.ts";
import type { ScriptRegistry } from "./script-registry.ts";
import { analyzeRetentionHeap } from "./module-retention-heap.test-helper.ts";

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
  resources: string[];
  snapshot?: string;
  memory: NodeJS.MemoryUsage;
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

const requestObservation = 'function retentionRequestClosure129() { return request.url; } globalThis[Symbol.for("bascik.retention.observe")](request, context, retentionRequestClosure129);';
export const inlineSource = (revision: number, generation: number) => `<!DOCTYPE html><html><head></head><body><p data-testid="generation">generation-${generation}</p><script data-bascik-server>export default function retentionInline129(request, context) { ${requestObservation} return "inline-${revision}:" + new URL(request.url).searchParams.get("request"); }</script></body></html>`;

export const retentionHelperPaths = (realistic: boolean): string[] => realistic
  ? Array.from({ length: 10 }, (_, chain) => {
    const root = chain === 9 ? "api" : "src/lib";
    const name = chain === 1 || chain === 9 ? "helper" : `helper-${chain}`;
    return [join(root, `${name}.mjs`), join(root, `${name}-middle.mjs`), join(root, `${name}-leaf.mjs`)];
  }).flat()
  : ["src/lib/helper.mjs", "api/helper.mjs"];

export async function runRetentionExperiment(directory: string, changing: boolean, generations: number, mode: "dev" | "http1" | "http2" = "dev", realistic = false): Promise<RetentionCheckpoint[]> {
  assert(Number.isInteger(generations) && generations >= 2 && generations <= 100 && generations % 2 === 0, "generations must be even, 2..100");
  assert(mode === "dev" || !changing, "production captures require stable source");
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
    mode, changing, generations, realistic, sourceHashes, directory, startedAt: new Date().toISOString(),
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
  await writeFile(join(project, "bascik.config.ts"), `export default ${JSON.stringify({
    directory: { pages: "src/pages", components: "src/components", out: "dist", api: "api" },
    pipeline: { workers: false, exec: [{ script: "scripts/post.mjs", phase: "post", watch: ["src/pages/**/*.html", "src/components/**/*.html"] }] },
    minify: false, http: { hostname: "127.0.0.1", port, tls: { enabled: mode === "http2" }, rateLimit: false },
    logging: { level: "error" }, generate: { sitemap: false, robots: false },
  })};`);
  await writeFile(join(project, "scripts/post.mjs"), 'import { mkdir, writeFile } from "node:fs/promises"; await mkdir("dist", {recursive:true}); await writeFile("dist/post.json", "{\\"complete\\":true}");');
  await writeFile(join(project, "src/pages/inline.html"), inlineSource(0, 0));
  await writeFile(join(project, "src/pages/external.html"), '<!DOCTYPE html><html><head></head><body><script data-bascik-server src="../lib/handler.mjs"></script></body></html>');
  await writeFile(join(project, "src/lib/handler.mjs"), `import {revision} from "./helper.mjs"; export default function retentionSrc129(request, context) { ${requestObservation} return "src-" + revision + ":" + new URL(request.url).searchParams.get("request"); }`);
  await writeFile(join(project, "api/probe.mjs"), `import {revision} from "./helper.mjs"; export function GET(request, context) { ${requestObservation} return new Response("api-" + revision + ":" + new URL(request.url).searchParams.get("request")); }`);
  for (const path of ["src/lib/helper.mjs", "api/helper.mjs"]) await writeFile(join(project, path), 'export const revision = 0;');

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
    await writeFile(join(project, "src/pages/external.html"), '<!DOCTYPE html><html><head></head><body><script data-bascik-server src="../lib/handler.mjs"></script><retention-shared></retention-shared></body></html>');
    for (let page = 0; page < 18; page++) {
      await writeFile(join(project, `src/pages/page-${page}.html`), `<!DOCTYPE html><html><head></head><body><p>page-${page}</p><retention-shared></retention-shared></body></html>`);
    }
  }

  const environment = cleanGeneratorEnvironment(process.env);
  for (const key of Object.keys(environment)) if (key.startsWith("BASCIK_") || key.startsWith("VITEST") || key === "NODE_ENV") delete environment[key];
  if (mode !== "dev") await execute([process.execPath, fileURLToPath(new URL("../transpile.ts", import.meta.url)), "--build"], project, join(directory, "build"), environment);
  const child = fork(fileURLToPath(new URL("./module-retention-subject.test-helper.ts", import.meta.url)), [directory, mode, String(realistic)], {
    cwd: project, execArgv: ["--expose-gc"], env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const log = createWriteStream(join(directory, "process.log"), { mode: 0o600 });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }>();
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number | null>();
  const closed = Promise.withResolvers<void>();
  const logClosed = Promise.withResolvers<void>();
  const cancellation = Promise.withResolvers<never>();
  const requests = new AbortController();
  let failure: Error | undefined;
  void ready.promise.catch(() => { });
  void cancellation.promise.catch(() => { });
  const fail = (error: Error) => {
    failure ??= error;
    ready.reject(failure);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(failure); }
    pending.clear();
  };
  const onError = (error: Error) => { exited.resolve(null); fail(error); };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited.resolve(code);
    fail(new Error(`retention child exited: ${code}/${signal}`));
  };
  const onClose = (code: number | null) => {
    exited.resolve(code);
    closed.resolve();
    fail(new Error(`retention child closed: ${code}`));
  };
  const onLogClose = () => logClosed.resolve();
  child.on("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);
  log.on("error", fail);
  log.once("close", onLogClose);
  const onMessage = (message: { id?: number; ready?: boolean; error?: string; result?: unknown; }) => {
    if (message.ready) ready.resolve();
    if (message.error && message.id === undefined) fail(new Error(message.error));
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(message.id!);
    if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
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
      await bounded(closed.promise, 500, "termination grace").catch(() => { });
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
    return new Promise<Result>((resolveResult, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`retention ${action} deadline exceeded`)); }, 20_000);
      pending.set(id, { resolve: value => resolveResult(value as Result), reject, timer });
      child.send({ id, action, ...options }, error => { if (error) fail(error); });
    });
  };
  const bootDeadline = setTimeout(() => fail(new Error("retention boot deadline exceeded")), 20_000);
  const checkpoints: RetentionCheckpoint[] = [];
  const artifacts: { path: string; bytes: number; sha256: string; }[] = [];
  let requestCount = 0;
  const origin = `${mode === "http2" ? "https" : "http"}://127.0.0.1:${port}`;
  async function readResponse(path: string): Promise<{ status: number; text: string; }> {
    if (mode !== "http2") {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]), headers: { connection: "close" } });
      return { status: response.status, text: await response.text() };
    }
    const session = http2.connect(origin, { rejectUnauthorized: false });
    const stream = session.request({ ":path": path });
    const deadline = setTimeout(() => session.destroy(new Error("HTTP2 retention request deadline exceeded")), 10_000);
    try {
      return await new Promise((resolveResponse, reject) => {
        let status = 0;
        const chunks: Buffer[] = [];
        session.once("error", reject); stream.once("error", reject);
        stream.on("response", headers => { status = Number(headers[":status"]); });
        stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
        stream.once("end", () => resolveResponse({ status, text: Buffer.concat(chunks).toString("utf8") }));
        stream.end();
      });
    } finally { clearTimeout(deadline); stream.close(); session.destroy(); }
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
    for (const [path, label] of [["/inline", "inline"], ["/external", "src"], ["/api/probe", "api"]]) {
      const request = String(requestCount++);
      const response = await readResponse(`${path}?request=${request}`);
      assert.equal(response.status, 200, `${label} status`);
      const text = response.text;
      assert(text.includes(`${label}-${revision}:${request}`), `${label} completed response: ${text}`);
      if (label === "inline") assert(text.includes(`generation-${generation}</p>`), "published page generation");
    }
  }
  async function checkpoint(phase: string, completed: number, snapshot = false) {
    checkpoints.push(await command<RetentionCheckpoint>("sample", { phase, completed, snapshot }));
    await writeFile(join(directory, "checkpoints.json"), JSON.stringify({ node: process.version, mode, changing, generations, checkpoints }, null, 2), { mode: 0o600 });
  }
  async function edit(path: string, source: string, kind: string) {
    await command("arm", { path, kind, publications: kind === "component" ? 20 : 1 });
    await writeFile(join(project, path), source);
    await command("completed");
  }
  try {
    await ready.promise;
    clearTimeout(bootDeadline);
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
    await command("stop");
    assert.equal(await bounded(Promise.race([exited.promise, cancellation.promise]), 10_000, "shutdown"), 0, "retention child shutdown");
    const heaps = [];
    for (const checkpoint of checkpoints) {
      if (!checkpoint.snapshot) continue;
      heaps.push({ phase: checkpoint.phase, ...analyzeRetentionHeap(JSON.parse(await readFile(checkpoint.snapshot, "utf8")), project) });
    }
    await writeFile(join(directory, "heaps.json"), JSON.stringify(heaps, null, 2), { mode: 0o600 });
    for (const name of ["priming.heapsnapshot", "baseline.heapsnapshot", "batch-2.heapsnapshot", "reverted.heapsnapshot", "cleared.heapsnapshot", "heaps.json", "checkpoints.json"]) {
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