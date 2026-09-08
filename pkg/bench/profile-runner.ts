import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { cpus, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { createFixture, seed } from "./profile-fixture.ts";
import { profileJournal } from "./profile-diagnostics.ts";
import { cleanGeneratorEnvironment, digest, summarizeCpuProfile, summarizeAllocationProfile, workerCpuLimitation, validatePrivateDirectory, validateArtifact, validateProcessCoverage, validateCpuCaptureArtifacts, validateCompression, type ProcessCoverage } from "./profile-workload.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const subject = fileURLToPath(new URL("./profile-subject.ts", import.meta.url));
const require = createRequire(import.meta.url);
async function decodeClinicDataset(tool: string, dataset: string) {
  if (tool === "heapprofiler") {
    const profile = JSON.parse(await readFile(dataset, "utf8"));
    const summary = summarizeAllocationProfile(profile);
    await new Promise<void>((resolve, reject) => require("@clinic/heap-profiler/src/analysis/index.js").analyse(dataset, (error: Error | null, result: { data?: unknown }) => {
      if (error) reject(error); else if (!result.data) reject(new Error("allocation conversion missing tree")); else resolve();
    }));
    return { tool, ...summary };
  }
  const counts: Record<string, number> = {};
  for (const [suffix, decoder] of Object.entries({ systeminfo: "system-info", stacktrace: "stack-trace", traceevent: "trace-event" })) {
    const paths = (await filesUnder(dataset)).filter((path) => path.endsWith(suffix));
    assert.equal(paths.length, 1, `missing Bubbleprof ${suffix}`);
    const Decoder = require(`@clinic/bubbleprof/format/${decoder}-decoder.js`);
    counts[suffix] = 0;
    await pipeline(createReadStream(paths[0]), new Decoder(), new Writable({ objectMode: true, write(_record, _encoding, callback) { counts[suffix]++; callback(); } }));
    assert(counts[suffix] > 0, `empty decoded Bubbleprof ${suffix}`);
  }
  return { tool, records: counts.traceevent, counts };
}
class CaptureCanceled extends Error { }
/** Clinic's consent prompt never settles in a fresh, non-interactive environment (Insight resolves without
 * invoking the promisified callback), so collection silently exits zero without a dataset. `NO_INSIGHT` is
 * Clinic's supported opt-out; it is set only in the child's environment and never writes user consent. */
export function clinicEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...cleanGeneratorEnvironment(environment), NO_INSIGHT: "1" };
}
async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await filesUnder(join(root, entry.name)));
    else if (entry.isFile()) files.push(join(root, entry.name));
  }
  return files;
}
async function bounded<Result>(promise: Promise<Result>, milliseconds: number, label: string): Promise<Result> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds); })]);
  } finally { clearTimeout(deadline); }
}
async function pollUntil(condition: () => boolean, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
/**
 * Runs one owned command and settles its whole process group before reporting any outcome.
 *
 * On POSIX the child leads a detached process group, so descendants that outlive the leader (ignored stdio and
 * `unref()`, or inherited pipes that keep `close` pending) are terminated with bounded SIGTERM then SIGKILL
 * escalation and the group is checked for absence; nothing is signaled outside that group. Windows has no
 * process groups: only the leader is owned and settlement waits for its exit and stream closure.
 *
 * The original outcome (exit code, spawn error, cancellation) is preserved; a settlement failure is reported as
 * the error when the command itself succeeded, otherwise attached as `cause`.
 */
export async function execute(command: string[], cwd: string, directory: string, env = cleanGeneratorEnvironment(process.env)) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const journal = profileJournal(directory);
  await writeFile(join(directory, "command.json"), JSON.stringify({ command, cwd, startedAt: Date.now() }, null, 2));
  const logPath = join(directory, "process.log");
  const log = createWriteStream(logPath, { mode: 0o600 });
  const logClosed = Promise.withResolvers<void>();
  log.once("close", () => logClosed.resolve());
  const groups = process.platform !== "win32";
  const child = spawn(command[0], command.slice(1), { cwd, env, detached: groups, stdio: ["ignore", "pipe", "pipe"] });
  journal("subject-spawned", { childPid: child.pid });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const spawnFailure = Promise.withResolvers<never>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const closed = Promise.withResolvers<void>();
  const cancellation = Promise.withResolvers<never>();
  for (const settled of [spawnFailure.promise, cancellation.promise]) void settled.catch(() => { });
  child.once("error", (error) => spawnFailure.reject(error));
  child.once("exit", (code, signal) => { journal("subject-exit", { childPid: child.pid, code, signal }); exited.resolve({ code, signal }); });
  child.once("close", () => closed.resolve());
  const groupAlive = () => {
    if (!child.pid) return false;
    // Windows: no process group; Node sets exitCode/signalCode synchronously with the leader's `exit` event.
    if (!groups) return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    journal("group-signal", { childPid: child.pid, signal });
    try { process.kill(groups ? -child.pid : child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  let settlement: Promise<void> | undefined;
  const settle = () => settlement ??= (async () => {
    if (groupAlive()) {
      signalGroup("SIGTERM");
      if (!await pollUntil(() => !groupAlive(), 500)) {
        signalGroup("SIGKILL");
        assert(await pollUntil(() => !groupAlive(), 1000), `owned process group ${child.pid} survived SIGKILL`);
      }
    }
    await bounded(closed.promise, 1000, "subject stream closure");
    journal("group-settled", { childPid: child.pid });
  })();
  let cancellationError: Error | undefined;
  const cancel = (error: Error) => {
    if (cancellationError) return;
    cancellationError = error;
    journal("capture-canceled", { childPid: child.pid, error: String(error) });
    cancellation.reject(error);
  };
  const interrupt = () => { process.exitCode = 130; cancel(new CaptureCanceled("capture interrupted by SIGINT")); };
  const terminate = () => { process.exitCode = 143; cancel(new CaptureCanceled("capture interrupted by SIGTERM")); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const diagnosticDeadline = setTimeout(() => journal("capture-pre-deadline", { childPid: child.pid, cpu: process.cpuUsage(), resources: process.getActiveResourcesInfo(), usage: process.resourceUsage() }), 90_000);
  const deadline = setTimeout(() => cancel(new Error(`capture deadline exceeded; private diagnostics: ${directory}`)), 110_000);
  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let failure: Error | undefined;
  let settlementFailure: Error | undefined;
  try {
    outcome = await Promise.race([exited.promise, spawnFailure.promise, cancellation.promise]);
  } catch (error) {
    failure = error as Error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(diagnosticDeadline);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    try { await settle(); } catch (error) { settlementFailure = error as Error; journal("group-settlement-failed", { childPid: child.pid, error: String(error) }); }
    const pipes = [child.stdout, child.stderr].map((stream) => stream.closed ? Promise.resolve() : new Promise<void>((resolve) => stream.once("close", resolve)));
    child.stdout.destroy();
    child.stderr.destroy();
    log.end();
    try { await bounded(Promise.all([logClosed.promise, ...pipes]), 1000, "process log closure"); } finally { log.destroy(); }
  }
  if (failure) {
    if (settlementFailure) (failure as Error & { cause?: unknown }).cause ??= settlementFailure;
    throw failure;
  }
  if (settlementFailure) throw settlementFailure;
  assert(outcome && outcome.code === 0, `capture failed (exit ${outcome?.code ?? outcome?.signal}): ${(await readFile(logPath, "utf8")).slice(-4000)}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
export async function runProfiles() {
  const { values } = parseArgs({
    options: {
      "report-dir": { type: "string" }, tools: { type: "string", default: "control,doctor,0x,cpu" }, scenarios: { type: "string", default: "http1,http2,static,dev,serial,workers" },
      rounds: { type: "string", default: "20" }, "inject-failure": { type: "boolean", default: false },
    }
  });
  assert(values["report-dir"], "--report-dir requires an absolute private directory");
  const root = await validatePrivateDirectory(values["report-dir"], [repository]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(root, [repository]);
  assert.equal((await readdir(root)).length, 0, "report directory must be empty; never reuse stale artifacts");
  const rounds = Number(values.rounds);
  assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 100, "rounds must be 1..100");
  const captures: object[] = [];
  const failures: object[] = [];
  const versions = Object.fromEntries(["0x", "clinic", "@clinic/doctor", "@clinic/bubbleprof", "@clinic/heap-profiler", "typescript", "vitest"].map((name) => [name, require(`${name}/package.json`).version]));
  const zeroCli = require.resolve("0x/cmd.js");
  const clinicCli = require.resolve("clinic/bin.js");
  if (values.tools!.split(",").includes("0x")) await execute([process.execPath, zeroCli, "--help"], root, join(root, "0x-help"));
  for (const tool of ["doctor", "bubbleprof", "heapprofiler"]) if (values.tools!.split(",").includes(tool)) await execute([process.execPath, clinicCli, tool, "--help"], root, join(root, `${tool}-help`), clinicEnvironment());
  const sourceHashes = Object.fromEntries(await Promise.all(["server.ts", "processing.ts", "page-worker.ts", "worker-pool.ts", "script-runner.ts", "caching.ts"].map(async (file) => [file, digest(await readFile(join(repository, "pkg/src/lib", file)))])));
  const harnessHashes = Object.fromEntries(await Promise.all(["profile-workload.ts", "profile-runner.ts", "profile-fixture.ts", "profile-load.ts", "profile-subject.ts", "profile-observers.ts", "profile-isolate.ts", "profile-diagnostics.ts"].map(async (file) => [file, digest(await readFile(join(repository, "pkg/bench", file)))])));
  const metadata = {
    seed, rounds, lanes: 4, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), sourceHashes, harnessHashes, libuvPoolSize: process.env.UV_THREADPOOL_SIZE ?? "4 (Node default)", runtime: process.versions, platform: process.platform, arch: process.arch, os: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    versions, benchmark124: "not available; standalone correctness-checked profiling fixture, not release budgets", diskState: "fresh process/application cache; OS disk cache not evicted or claimed cold", root,
    limitations: ["No kernel/DTrace capture or native libuv-thread attribution", "Doctor and 0x cover target main isolate only; worker and script-child CPU use separately labeled inspector captures", "Static file serving has no API/stream execution; dev stream fidelity is covered by E2E, not this workload", "Capture overhead is not a release benchmark or an optimization budget", "Fresh and warm script/application caches do not establish OS disk-cold measurements"]
  };
  for (const tool of values.tools!.split(",")) for (const scenario of values.scenarios!.split(",")) for (const encoding of ["identity", "br"]) {
    if (["serial", "workers", "static", "dev"].includes(scenario) && encoding === "br") continue;
    const label = `${tool}-${scenario}-${encoding}`;
    const directory = join(root, label);
    const project = join(directory, "project");
    try {
      assert(["control", "doctor", "bubbleprof", "heapprofiler", "0x", "cpu"].includes(tool), "unsupported profiler");
      assert(["http1", "http2", "static", "dev", "serial", "workers"].includes(scenario), "unsupported scenario");
      assert(!(tool === "cpu" && scenario === "workers" && workerCpuLimitation()), workerCpuLimitation());
      await createFixture(project, scenario === "workers", await freePort(), scenario === "http2");
      const profiles = join(directory, "profiles");
      await mkdir(profiles, { recursive: true, mode: 0o700 });
      if (!["dev", "serial", "workers"].includes(scenario)) await execute([process.execPath, subject, "prepare"], project, join(directory, "prepare"));
      const target = [process.execPath, ...(tool === "cpu" ? ["--cpu-prof", `--cpu-prof-dir=${profiles}`] : []), subject, scenario, directory, encoding, String(rounds), String(values["inject-failure"])];
      const clinicTool = ["doctor", "bubbleprof", "heapprofiler"].includes(tool);
      const command = clinicTool ? [process.execPath, clinicCli, tool, "--collect-only", "--open=false", "--dest", profiles, "--", ...target]
        : tool === "0x" ? [process.execPath, zeroCli, "--tree-debug", "--output-dir", profiles, "--", ...target] : target;
      const environment = clinicTool ? clinicEnvironment() : { ...cleanGeneratorEnvironment(process.env), ...(tool === "cpu" ? { BASCIK_PROFILE_CAPTURE_DIR: profiles } : {}) };
      await execute(command, project, join(directory, "capture"), environment);
      let decoded;
      if (tool === "bubbleprof" || tool === "heapprofiler") {
        const datasets = (await readdir(profiles)).filter((name) => name.endsWith(`.clinic-${tool}`));
        assert.equal(datasets.length, 1, `missing or ambiguous ${tool} dataset`);
        const dataset = join(profiles, datasets[0]);
        decoded = await decodeClinicDataset(tool, dataset);
        await execute([process.execPath, clinicCli, tool, "--visualize-only", dataset, "--open=false", "--dest", profiles], project, join(directory, "visualize"), clinicEnvironment());
      }
      if (tool === "doctor") {
        const dataset = (await readdir(profiles)).find((name) => name.endsWith(".clinic-doctor"));
        assert(dataset, "Doctor dataset missing");
        for (const suffix of ["systeminfo", "traceevent", "processstat"]) {
          const matches: string[] = (await filesUnder(join(profiles, dataset))).filter((path) => path.endsWith(suffix));
          assert.equal(matches.length, 1, `missing Doctor ${suffix}`);
          await validateArtifact(matches[0], "binary");
        }
        await execute([process.execPath, clinicCli, "doctor", "--visualize-only", join(profiles, dataset), "--open=false", "--dest", profiles], project, join(directory, "visualize"), clinicEnvironment());
      }
      const artifact = await validateArtifact(join(directory, "result.json"), "json");
      const result = JSON.parse(await readFile(artifact.path, "utf8"));
      if (result.compression) {
        validateCompression(result.compression, encoding === "br" ? 9 : 0);
        for (const phase of result.phaseMetrics) {
          validateCompression(phase.compression, encoding === "br" ? phase.phase === "distinct-assets" ? 9 : 1 : 0);
          if (phase.phase === "distinct-assets") assert(phase.filesystemProbe.completed > 0 && phase.filesystemProbe.active === 0, "filesystem pressure probe must complete and settle");
        }
      }
      const artifacts = [artifact];
      const coverage: (ProcessCoverage & Record<string, unknown>)[] = [{ role: "main", pid: result.pid, tool, startup: true, steadyState: true }];
      const cpuAttribution: object[] = [];
      for (const path of await filesUnder(profiles)) {
        artifacts.push(await validateArtifact(path, path.endsWith(".cpuprofile") ? "cpu" : path.endsWith(".json") ? "json" : path.endsWith(".html") ? "html" : "binary"));
        if (path.endsWith(".metadata.json")) {
          const entry = JSON.parse(await readFile(path, "utf8"));
          if (entry.role === "script-child") delete entry.threadId;
          coverage.push({ ...entry, tool: "node-inspector", artifact: path.replace(/\.metadata\.json$/, () => ".cpuprofile") });
        }
        if (path.endsWith(".cpuprofile")) {
          const profile = JSON.parse(await readFile(path, "utf8"));
          cpuAttribution.push({
            path, startTime: profile.startTime, endTime: profile.endTime, samples: profile.samples.length,
            hotspots: Object.fromEntries(["processChunkSync", "brotli", "recursivelyTranspile", "transpilePage", "compileSourceTextModule"].map((name) => [name, summarizeCpuProfile(profile, name)]))
          });
        }
      }
      if (tool === "cpu") {
        await validateCpuCaptureArtifacts(artifacts.map((artifact) => artifact.path), result.pid, (result.subjectEvents ?? []).filter((event: ProcessCoverage) => event.role !== "native-child"));
        validateProcessCoverage((result.subjectEvents ?? []).filter((event: ProcessCoverage) => event.role !== "native-child"), coverage);
        for (const event of result.subjectEvents ?? []) if (event.role === "native-child") coverage.push({ ...event, captured: false, tool: "none", limitation: "native child requires separately authorized kernel profiling" });
      }
      else for (const event of result.subjectEvents ?? []) coverage.push({ ...event, tool: "none", captured: false, limitation: "separate Node CPU capture required" });
      if (clinicTool || tool === "0x") assert(artifacts.some((item) => item.path.endsWith(".html")), "missing rendered capture");
      const config = await readFile(join(project, "bascik.config.ts"), "utf8");
      captures.push({ label, tool, scenario, encoding, config, configSha256: digest(config), result, artifacts, coverage, cpuAttribution, decoded });
    } catch (error) {
      if (error instanceof CaptureCanceled) throw error;
      failures.push({ label, error: String(error) });
      console.error(`${label}: ${error}`);
    }
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...metadata, success: failures.length === 0, captures, failures }, null, 2));
  console.log(`Profile manifest: ${join(root, "manifest.json")}`);
  if (failures.length) process.exitCode = 1;
}