import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { cpus, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { createFixture, seed } from "./profile-fixture.ts";
import { cleanGeneratorEnvironment, digest, summarizeCpuProfile, validatePrivateDirectory, validateArtifact, validateProcessCoverage, validateCpuCaptureArtifacts, validateCompression, type ProcessCoverage } from "./profile-workload.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const subject = fileURLToPath(new URL("./profile-subject.ts", import.meta.url));
const require = createRequire(import.meta.url);
class CaptureCancelled extends Error { }
async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await filesUnder(join(root, entry.name)));
    else if (entry.isFile()) files.push(join(root, entry.name));
  }
  return files;
}
export async function execute(command: string[], cwd: string, directory: string, env = cleanGeneratorEnvironment(process.env)) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "command.json"), JSON.stringify({ command, cwd, startedAt: Date.now() }, null, 2));
  const logPath = join(directory, "process.log");
  const log = createWriteStream(logPath, { mode: 0o600 });
  const child = spawn(command[0], command.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const cancellation = Promise.withResolvers<never>();
  let cleanup: Promise<void> | undefined;
  let cancellationError: Error | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const cancel = (error: Error) => {
    if (cleanup) return;
    cancellationError = error;
    cleanup = (async () => {
      killGroup("SIGTERM");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      killGroup("SIGKILL");
      let reapDeadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed.catch(() => { }), new Promise<void>((resolve) => { reapDeadline = setTimeout(resolve, 1000); })]);
      } finally { clearTimeout(reapDeadline); }
    })();
    void cleanup.then(() => cancellation.reject(error), (failure) => cancellation.reject(failure));
  };
  const interrupt = () => { process.exitCode = 130; cancel(new CaptureCancelled("capture interrupted by SIGINT")); };
  const terminate = () => { process.exitCode = 143; cancel(new CaptureCancelled("capture interrupted by SIGTERM")); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const deadline = setTimeout(() => cancel(new Error("capture deadline exceeded")), 120_000);
  try {
    const code = await Promise.race([closed, cancellation.promise]);
    if (cleanup) { await cleanup; throw cancellationError; }
    await new Promise<void>((resolve) => log.end(resolve));
    assert(code === 0, `capture failed (exit ${code}): ${(await readFile(logPath, "utf8")).slice(-4000)}`);
  } finally {
    await cleanup;
    clearTimeout(deadline);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    child.stdout.destroy();
    child.stderr.destroy();
    log.end();
  }
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
  const versions = Object.fromEntries(["0x", "clinic", "@clinic/doctor", "typescript", "vitest"].map((name) => [name, require(`${name}/package.json`).version]));
  const zeroCli = require.resolve("0x/cmd.js");
  const clinicCli = require.resolve("clinic/bin.js");
  if (values.tools!.split(",").includes("0x")) await execute([process.execPath, zeroCli, "--help"], root, join(root, "0x-help"));
  if (values.tools!.split(",").includes("doctor")) await execute([process.execPath, clinicCli, "doctor", "--help"], root, join(root, "doctor-help"));
  const sourceHashes = Object.fromEntries(await Promise.all(["server.ts", "processing.ts", "page-worker.ts", "script-runner.ts", "caching.ts"].map(async (file) => [file, digest(await readFile(join(repository, "pkg/src/lib", file)))])));
  const harnessHashes = Object.fromEntries(await Promise.all(["profile-workload.ts", "profile-runner.ts", "profile-fixture.ts", "profile-load.ts", "profile-subject.ts", "profile-observers.ts", "profile-isolate.ts"].map(async (file) => [file, digest(await readFile(join(repository, "pkg/bench", file)))])));
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
      assert(["control", "doctor", "0x", "cpu"].includes(tool), "unsupported profiler");
      assert(["http1", "http2", "static", "dev", "serial", "workers"].includes(scenario), "unsupported scenario");
      await createFixture(project, scenario === "workers", await freePort(), scenario === "http2");
      const profiles = join(directory, "profiles");
      await mkdir(profiles, { recursive: true, mode: 0o700 });
      if (!["dev", "serial", "workers"].includes(scenario)) await execute([process.execPath, subject, "prepare"], project, join(directory, "prepare"));
      const target = [process.execPath, ...(tool === "cpu" ? ["--cpu-prof", `--cpu-prof-dir=${profiles}`] : []), subject, scenario, directory, encoding, String(rounds), String(values["inject-failure"])];
      const command = tool === "doctor" ? [process.execPath, clinicCli, "doctor", "--collect-only", "--open=false", "--dest", profiles, "--", ...target]
        : tool === "0x" ? [process.execPath, zeroCli, "--tree-debug", "--output-dir", profiles, "--", ...target] : target;
      const environment = { ...cleanGeneratorEnvironment(process.env), ...(tool === "cpu" ? { BASCIK_PROFILE_CAPTURE_DIR: profiles } : {}) };
      await execute(command, project, join(directory, "capture"), environment);
      if (tool === "doctor") {
        const dataset = (await readdir(profiles)).find((name) => name.endsWith(".clinic-doctor"));
        assert(dataset, "Doctor dataset missing");
        for (const suffix of ["systeminfo", "traceevent", "processstat"]) {
          const matches: string[] = (await filesUnder(join(profiles, dataset))).filter((path) => path.endsWith(suffix));
          assert.equal(matches.length, 1, `missing Doctor ${suffix}`);
          await validateArtifact(matches[0], "binary");
        }
        await execute([process.execPath, clinicCli, "doctor", "--visualize-only", join(profiles, dataset), "--open=false", "--dest", profiles], project, join(directory, "visualize"));
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
      if (["doctor", "0x"].includes(tool)) assert(artifacts.some((item) => item.path.endsWith(".html")), "missing rendered capture");
      const config = await readFile(join(project, "bascik.config.ts"), "utf8");
      captures.push({ label, tool, scenario, encoding, config, configSha256: digest(config), result, artifacts, coverage, cpuAttribution });
    } catch (error) {
      if (error instanceof CaptureCancelled) throw error;
      failures.push({ label, error: String(error) });
      console.error(`${label}: ${error}`);
    }
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...metadata, success: failures.length === 0, captures, failures }, null, 2));
  console.log(`Profile manifest: ${join(root, "manifest.json")}`);
  if (failures.length) process.exitCode = 1;
}