import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  validateResponses,
  validateArtifact,
  validatePrivateDirectory,
  cleanGeneratorEnvironment,
  summarizeCpuProfile,
  validateProcessCoverage,
  validateCpuCaptureArtifacts,
  validateCompression,
} from "../../bench/profile-workload.ts";

const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "bascik-profile-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const body = Buffer.from("exact response $1 $& <html>seed-128</html>");
const expected = [{ id: "asset:0", body }];
const response = { id: "asset:0", status: 200, encoding: "identity", body, durationMs: 1 };

describe("profiling workload acceptance", () => {
  it("requires single-flight asynchronous codecs and settled compression", () => {
    const valid = { calls: 1, active: 0, maxActive: 1, syncCalls: 0, pending: 0 };
    expect(() => validateCompression(valid, 1)).not.toThrow();
    for (const invalid of [
      { ...valid, calls: 0 }, { ...valid, calls: 80 },
      { ...valid, syncCalls: 80 }, { ...valid, active: 1 },
      { ...valid, pending: 1 }, { ...valid, maxActive: 2 },
    ]) expect(() => validateCompression(invalid, 1)).toThrow(/compression/);
    expect(() => validateCompression({ ...valid, calls: 0, maxActive: 0 }, 0)).not.toThrow();
  });
  it("rejects identity fallback when Brotli was required", () => {
    const required = [{ ...expected[0], encoding: "br" }];
    expect(() => validateResponses(required, [response])).toThrow(/encoding/);
  });
  it.each(["identity", "br", "gzip"])("checks decoded %s bytes", (encoding) => {
    const encoded = encoding === "br" ? brotliCompressSync(body) : encoding === "gzip" ? gzipSync(body) : body;
    expect(validateResponses(expected, [{ ...response, encoding, body: encoded }])).toMatchObject({ completed: 1 });
  });
  it("rejects an injected failed request even when its body is correct", () => {
    expect(() => validateResponses(expected, [{ ...response, status: 500 }])).toThrow(/status/);
  });
  it("rejects truncated and same-length corrupt bodies", () => {
    for (const corrupt of [body.subarray(1), Buffer.alloc(body.length, 120)]) {
      expect(() => validateResponses(expected, [{ ...response, body: corrupt }])).toThrow(/body/);
    }
  });
  it("rejects missing, extra, duplicate and unknown task completions", () => {
    for (const responses of [[], [response, response], [{ ...response, id: "unknown" }]]) {
      expect(() => validateResponses(expected, responses)).toThrow(/task|completion/);
    }
    expect(() => validateResponses([...expected, ...expected], [response, response])).toThrow(/duplicate/);
  });
  it("rejects malformed compression, unsupported encodings and invalid timings", () => {
    expect(() => validateResponses(expected, [{ ...response, encoding: "br" }])).toThrow();
    expect(() => validateResponses(expected, [{ ...response, encoding: "unknown" }])).toThrow(/encoding/);
    for (const durationMs of [NaN, Infinity, -1]) {
      expect(() => validateResponses(expected, [{ ...response, durationMs }])).toThrow(/duration/);
    }
  });
  it("removes instrumentation from the generator without mutating its parent environment", () => {
    const environment = { NODE_OPTIONS: "--cpu-prof --require doctor", NODE_V8_COVERAGE: "/private/coverage", BASCIK_PROFILE_CAPTURE: "cpu", PATH: "/bin" };
    expect(cleanGeneratorEnvironment(environment)).toEqual({ PATH: "/bin" });
    expect(environment.NODE_OPTIONS).toContain("--cpu-prof");
  });
});

const cpu = {
  startTime: 1, endTime: 10,
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: "codec", url: "node:zlib", lineNumber: 100 }, children: [3] },
    { id: 3, callFrame: { functionName: "processChunkSync", url: "node:zlib", lineNumber: 200 } },
  ],
  samples: [2, 3, 3], timeDeltas: [1, 1, 1],
};

describe("capture artifact integrity", () => {
  it("rejects an existing world-readable report root", async () => {
    const root = join(await temporaryRoot(), "unsafe");
    await mkdir(root, { mode: 0o755 });
    await expect(validatePrivateDirectory(root, [])).rejects.toThrow(/permission|private/);
  });
  it("rejects startup-only, wrong-task and non-covering worker profiles", () => {
    const task = { role: "page-worker", pid: 20, threadId: 1, taskId: "page-7", startedAt: 100, endedAt: 200 };
    for (const capture of [
      { role: task.role, pid: task.pid, threadId: task.threadId },
      { ...task, taskId: "page-8" },
      { ...task, startedAt: 101 },
      { ...task, endedAt: 199 },
    ]) expect(() => validateProcessCoverage([task], [capture])).toThrow(/coverage/);
    expect(() => validateProcessCoverage([task], [task])).not.toThrow();
  });
  it("cannot substitute a child CPU profile for a missing main or metadata companion", async () => {
    const root = await temporaryRoot();
    const child = join(root, "script-child-21-0-0.cpuprofile");
    const main = join(root, "CPU.20260907.120000.20.0.001.cpuprofile");
    const metadata = join(root, "page-worker-20-1-0.metadata.json");
    await writeFile(child, JSON.stringify(cpu));
    await expect(validateCpuCaptureArtifacts([child], 20)).rejects.toThrow(/main CPU/);
    await writeFile(main, JSON.stringify(cpu));
    await writeFile(metadata, "{}");
    await expect(validateCpuCaptureArtifacts([main, child, metadata], 20)).rejects.toThrow();
    await expect(validateCpuCaptureArtifacts([main, child], 20)).resolves.toBeUndefined();
  });
  it("rejects missing or mismatched subprocess CPU attribution", () => {
    const events = [{ role: "page-worker", pid: 20, threadId: 1 }, { role: "script-child", pid: 21 }];
    expect(() => validateProcessCoverage(events, [])).toThrow(/coverage/);
    expect(() => validateProcessCoverage(events, [{ role: "page-worker", pid: 20, threadId: 2 }, { role: "script-child", pid: 21 }])).toThrow(/coverage/);
    expect(() => validateProcessCoverage(events, events)).not.toThrow();
  });
  it("provides only bounded private profiling package scripts", async () => {
    const { scripts } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(scripts["profile:workload"]).toBe("node bench/profile-workload.ts");
    expect(Object.entries(scripts).filter(([name]) => name.startsWith("profile:")).every(([, command]) => !String(command).includes("docs"))).toBe(true);
  });
  it("rejects missing, empty, undecodable and structurally invalid CPU artifacts", async () => {
    const path = join(await temporaryRoot(), "capture.cpuprofile");
    await expect(validateArtifact(path, "cpu")).rejects.toThrow();
    for (const content of ["", "{broken", "{}", JSON.stringify({ ...cpu, samples: [99] })]) {
      await writeFile(path, content);
      await expect(validateArtifact(path, "cpu")).rejects.toThrow();
    }
    await writeFile(path, JSON.stringify(cpu));
    await expect(validateArtifact(path, "cpu")).resolves.toMatchObject({ path, bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("distinguishes inclusive ancestry from self samples", () => {
    expect(summarizeCpuProfile(cpu, "codec")).toEqual({ samples: 3, inclusive: 3, self: 1 });
    expect(summarizeCpuProfile(cpu, "processChunkSync")).toEqual({ samples: 3, inclusive: 2, self: 2 });
  });
  it("rejects CPU trees with duplicate ids, missing children or cycles", () => {
    for (const nodes of [[...cpu.nodes, cpu.nodes[0]], [{ ...cpu.nodes[0], children: [99] }], [{ ...cpu.nodes[0], children: [1] }]]) {
      expect(() => summarizeCpuProfile({ ...cpu, nodes }, "codec")).toThrow();
    }
  });
  it("requires an absolute report root outside forbidden trees, including symlinks", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repo");
    const outside = join(root, "private");
    await mkdir(repository);
    await mkdir(outside, { mode: 0o700 });
    await symlink(repository, join(outside, "alias"));
    await expect(validatePrivateDirectory("relative", [repository])).rejects.toThrow(/absolute/);
    await expect(validatePrivateDirectory(join(repository, "docs", "dist"), [repository])).rejects.toThrow(/private|outside/);
    await expect(validatePrivateDirectory(join(outside, "alias", "new"), [repository])).rejects.toThrow(/private|outside/);
    await expect(validatePrivateDirectory(outside, [repository])).resolves.toBe(await realpath(outside));
  });
});

describe("bounded real profiling runner", () => {
  const runner = fileURLToPath(new URL("../../bench/profile-workload.ts", import.meta.url));
  it.each(["SIGINT", "SIGTERM"] as const)("cancels disposable descendants on %s even when the leader exits first", async (signal) => {
    const root = await temporaryRoot();
    const stubborn = `process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); console.log(JSON.stringify({leader:process.ppid, descendant:process.pid})); setInterval(() => {}, 1000);`;
    const leader = `import {spawn} from 'node:child_process'; spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], {stdio:'inherit'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
    const wrapper = `import {execute} from ${JSON.stringify(new URL("../../bench/profile-runner.ts", import.meta.url).href)}; await execute([process.execPath, '--input-type=module', '-e', ${JSON.stringify(leader)}], ${JSON.stringify(root)}, ${JSON.stringify(root)}).catch(() => {process.exitCode=1});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", wrapper], { env: cleanGeneratorEnvironment(process.env), stdio: "ignore" });
    const exited = once(child, "exit");
    let descendants: { leader: number; descendant: number } | undefined;
    try {
      await expect.poll(async () => {
        const text = await readFile(join(root, "process.log"), "utf8").catch(() => "");
        if (text.trim()) descendants = JSON.parse(text.trim());
        return !!descendants;
      }, { timeout: 5000 }).toBe(true);
      child.kill(signal);
      await exited;
      await expect.poll(() => {
        try { process.kill(descendants!.descendant, 0); return true; } catch { return false; }
      }, { timeout: 4000 }).toBe(false);
      expect(child.exitCode === 0 && child.signalCode === null).toBe(false);
    } finally {
      if (descendants) { try { process.kill(-descendants.leader, "SIGKILL"); } catch { } }
      child.kill("SIGKILL");
    }
  }, 12_000);
  it("runs real HTTP1 controls with complete byte-checked task counts", async () => {
    const root = await temporaryRoot();
    await promisify(execFile)(process.execPath, [runner, "--tools", "control", "--scenarios", "http1", "--rounds", "20", "--report-dir", root], { timeout: 60_000, env: cleanGeneratorEnvironment(process.env) });
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(manifest.success).toBe(true);
    expect(manifest.captures).toHaveLength(2);
    for (const capture of manifest.captures) {
      expect(capture.result.phases.map((phase: { completed: number }) => phase.completed)).toEqual([160, 160, 80, 240]);
      expect(capture.result.generator.execArgv).toEqual([]);
      expect(capture.result.generator.nodeOptions).toBeNull();
      expect(capture.result.compression.calls).toBe(capture.encoding === "br" ? 9 : 0);
      expect(capture.result.compression.active).toBe(0);
      expect(capture.result.compression.maxActive).toBeLessThanOrEqual(9);
      const pressure = capture.result.phaseMetrics.find((phase: { phase: string }) => phase.phase === "distinct-assets").filesystemProbe;
      expect(pressure.completed).toBeGreaterThan(0);
      expect(pressure.maxMs).toBeGreaterThanOrEqual(pressure.meanMs);
      expect(pressure.active).toBe(0);
      const distinct = capture.result.phases.find((phase: { phase: string }) => phase.phase === "distinct-assets");
      expect(new Set(distinct.tasks.filter((task: { id: string }) => task.id.endsWith(".txt")).map((task: { id: string }) => task.id.split(":").at(-1))).size).toBe(8);
      if (capture.encoding === "identity") expect(capture.result.compression.callbackMs).toBe(0);
    }
  }, 60_000);
  it("fails the capture instead of publishing success after an injected request failure", async () => {
    const root = await temporaryRoot();
    await expect(promisify(execFile)(process.execPath, [runner, "--tools", "control", "--scenarios", "http1", "--rounds", "1", "--report-dir", root, "--inject-failure"], { timeout: 60_000, env: cleanGeneratorEnvironment(process.env) })).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(manifest.success).toBe(false);
    expect(manifest.failures.length).toBeGreaterThan(0);
  }, 60_000);
  it.each(["http2", "static", "dev", "serial", "workers"])("validates real %s work and labeled CPU coverage", async (scenario) => {
    const root = await temporaryRoot();
    await promisify(execFile)(process.execPath, [runner, "--tools", "cpu", "--scenarios", scenario, "--rounds", "1", "--report-dir", root], { timeout: 120_000, env: cleanGeneratorEnvironment(process.env) });
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(manifest.success).toBe(true);
    expect(manifest.captures.length).toBeGreaterThan(0);
    for (const capture of manifest.captures) {
      expect(capture.artifacts.some((artifact: { path: string }) => artifact.path.endsWith(".cpuprofile"))).toBe(true);
      if (scenario === "workers") {
        expect(capture.coverage.some((entry: { role: string }) => entry.role === "page-worker")).toBe(true);
        expect(capture.coverage.some((entry: { role: string }) => entry.role === "script-child")).toBe(true);
        const events = capture.result.subjectEvents.filter((event: { role: string }) => event.role !== "native-child");
        const tasks = events.filter((event: { taskId?: string }) => event.taskId !== undefined);
        expect(tasks).toHaveLength(18);
        const paths = capture.artifacts.map((artifact: { path: string }) => artifact.path);
        const taskArtifacts = capture.coverage.filter((entry: { role: string; taskId?: string }) => entry.role === "page-worker" && entry.taskId !== undefined);
        expect(taskArtifacts).toHaveLength(18);
        const removed = new Set<string>();
        for (const entry of taskArtifacts) {
          removed.add(entry.artifact);
          removed.add(entry.artifact.replace(/\.cpuprofile$/, ".metadata.json"));
        }
        for (const path of removed) await rm(path);
        await expect(validateCpuCaptureArtifacts(paths.filter((path: string) => !removed.has(path)), capture.result.pid, events)).rejects.toThrow(/coverage/);
      }
      if (scenario === "dev") expect(capture.result.edit.completed).toBe(1);
      if (scenario === "serial" || scenario === "workers") expect(capture.result.builds.map((build: { completed: number }) => build.completed)).toEqual([8, 8]);
    }
  }, 120_000);
  it.each(["doctor", "0x"])("requires decodable real %s output before accepting the capture", async (tool) => {
    const root = await temporaryRoot();
    await promisify(execFile)(process.execPath, [runner, "--tools", tool, "--scenarios", "http1", "--rounds", "2", "--report-dir", root], { timeout: 120_000, env: cleanGeneratorEnvironment(process.env) });
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(manifest.success).toBe(true);
    for (const capture of manifest.captures) {
      expect(capture.artifacts.some((artifact: { path: string }) => artifact.path.endsWith(".html"))).toBe(true);
      expect(capture.artifacts.every((artifact: { bytes: number; sha256: string }) => artifact.bytes > 0 && artifact.sha256.length === 64)).toBe(true);
    }
  }, 120_000);
});