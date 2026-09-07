import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { fstatSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface ExpectedResponse { id: string; body: Buffer; encoding?: string }
export interface ObservedResponse { id: string; status: number; encoding: string; body: Buffer; durationMs: number; complete?: boolean }
export interface ResourceSnapshot { resources: Record<string, number>; descriptors: number[] | null }
export function createResourceProbe() {
  const active = new Map<number, { type: string; resource: WeakRef<object> }>();
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (/^(Timeout|TCPWRAP|TCPSERVERWRAP|HTTP2SESSION|PIPEWRAP|PROCESSWRAP|WORKER|MESSAGEPORT|FSEVENTWRAP|STATWATCHER|FILEHANDLE|FSREQCALLBACK|FSREQPROMISE)$/.test(type)) active.set(id, { type, resource: new WeakRef(resource) });
    },
    destroy(id) { active.delete(id); },
  }).enable();
  return {
    snapshot(): ResourceSnapshot {
      const resources: Record<string, number> = {};
      for (const { type, resource } of active.values()) {
        const handle = resource.deref();
        if (!handle || (type === "FILEHANDLE" && Reflect.get(handle, "fd") < 0)) continue;
        resources[type] = (resources[type] ?? 0) + 1;
      }
      let descriptors: number[] | null = null;
      if (process.platform === "darwin" || process.platform === "linux") {
        descriptors = readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd")
          .map(Number).filter((descriptor) => {
            try { fstatSync(descriptor); return true; } catch { return false; }
          }).sort((left, right) => left - right);
      }
      return { resources, descriptors };
    },
    close() { hook.disable(); active.clear(); },
  };
}
export function validateResourceBoundary(baseline: ResourceSnapshot, final: ResourceSnapshot) {
  for (const [type, count] of Object.entries(final.resources)) {
    assert(Number.isInteger(count) && count >= 0 && count <= (baseline.resources[type] ?? 0), `resource boundary: ${type} ${count} exceeds ${baseline.resources[type] ?? 0}`);
  }
  assert.equal(final.descriptors === null, baseline.descriptors === null, "resource boundary: descriptor coverage changed");
  if (baseline.descriptors && final.descriptors) {
    assert(final.descriptors.every((descriptor) => baseline.descriptors!.includes(descriptor)), "resource boundary: open descriptor survived cleanup");
  }
}
export interface GateEvent { gate: string; event: "start" | "release" | "end"; at: number }
export function validateIndependentGates(events: GateEvent[], gates: string[]) {
  assert(gates.length > 1 && new Set(gates).size === gates.length, "independent gates require distinct producers");
  assert(events.every((entry, index) => Number.isFinite(entry.at) && (index === 0 || entry.at >= events[index - 1].at)), "independent gates require monotonic timestamps");
  const firstRelease = events.findIndex((entry) => entry.event === "release");
  for (const gate of gates) {
    const indices = ["start", "release", "end"].map((event) => {
      const matches = events.flatMap((entry, index) => entry.gate === gate && entry.event === event ? [index] : []);
      assert.equal(matches.length, 1, `independent gates: missing or duplicate ${gate} ${event}`);
      return matches[0];
    });
    assert(indices[0] < firstRelease && indices[0] < indices[1] && indices[1] < indices[2], `independent gates serialized or out of order: ${gate}`);
  }
}
export interface CompressionMetrics { calls: number; active: number; maxActive: number; syncCalls: number; pending: number }
export function validateCompression(metrics: CompressionMetrics, expectedCalls: number) {
  assert.equal(metrics.calls, expectedCalls, "compression asynchronous single-flight count");
  assert.equal(metrics.syncCalls, 0, "compression must not run synchronously");
  assert.equal(metrics.active, 0, "compression must settle");
  assert.equal(metrics.pending, 0, "compression promises must settle");
  assert(Number.isInteger(metrics.maxActive) && metrics.maxActive >= (expectedCalls ? 1 : 0) && metrics.maxActive <= expectedCalls, "compression observed concurrency exceeds useful work");
}
export interface ProcessCoverage { role: string; pid: number; threadId?: number; taskId?: string; startedAt?: number; endedAt?: number; dispatchedAt?: number; completedAt?: number }
export function workerCpuLimitation(platform: string = process.platform, version: string = process.version) {
  if (platform === "darwin" && version === "v24.17.0") return "Unsupported worker CPU capture on Node v24.17.0/macOS: native built-in loader lock stall; unprofiled worker timelines remain available";
}
export function validateProcessCoverage(events: ProcessCoverage[], coverage: ProcessCoverage[]) {
  for (const event of events) {
    assert(coverage.some((capture) => capture.role === event.role && capture.pid === event.pid && capture.threadId === event.threadId
      && (event.taskId === undefined || (capture.taskId === event.taskId
        && Number.isFinite(capture.startedAt) && Number.isFinite(capture.endedAt) && capture.endedAt! >= capture.startedAt!
        && (event.dispatchedAt !== undefined
          ? Number.isFinite(event.completedAt) && capture.startedAt! >= event.dispatchedAt && capture.endedAt! <= event.completedAt!
          : Number.isFinite(event.startedAt) && Number.isFinite(event.endedAt)
          && event.endedAt! >= event.startedAt! && capture.startedAt! <= event.startedAt! && capture.endedAt! >= event.endedAt!)))), `missing process coverage: ${JSON.stringify(event)}`);
  }
}

export const digest = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
export function validateResponses(expected: ExpectedResponse[], responses: ObservedResponse[]) {
  const tasks = new Map(expected.map((task) => [task.id, task.body]));
  assert(tasks.size > 0 && tasks.size === expected.length, "empty or duplicate expected tasks");
  assert.equal(responses.length, expected.length, "incomplete task completion count");
  const seen = new Set<string>();
  for (const response of responses) {
    assert(tasks.has(response.id) && !seen.has(response.id), `unknown or duplicate task ${response.id}`);
    seen.add(response.id);
    assert.equal(response.status, 200, `status for ${response.id}`);
    assert(response.complete !== false, `stream completion for ${response.id}`);
    assert(Number.isFinite(response.durationMs) && response.durationMs >= 0, "invalid duration");
    assert(["identity", "br", "gzip"].includes(response.encoding), "unsupported encoding");
    const encoding = expected.find((task) => task.id === response.id)!.encoding;
    if (encoding !== undefined) assert.equal(response.encoding, encoding, `negotiated encoding for ${response.id}`);
    const options = { maxOutputLength: tasks.get(response.id)!.length + 1 };
    const decoded = response.encoding === "br" ? brotliDecompressSync(response.body, options)
      : response.encoding === "gzip" ? gunzipSync(response.body, options) : response.body;
    assert(decoded.equals(tasks.get(response.id)!), `body integrity for ${response.id}`);
  }
  return { completed: seen.size };
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}
export async function validatePrivateDirectory(path: string, forbidden: string[]) {
  assert(isAbsolute(path), "report directory must be absolute");
  const canonical = await canonicalPath(path);
  for (const tree of forbidden) {
    const distance = relative(await canonicalPath(tree), canonical);
    assert(distance.startsWith(`..${sep}`) || distance === ".." || isAbsolute(distance), "reports must be private and outside forbidden trees");
  }
  try {
    const info = await stat(canonical);
    assert(info.isDirectory() && (info.mode & 0o777) === 0o700 && info.uid === process.getuid?.(), "report directory must have private owner-only permissions (0700)");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return canonical;
}
export function cleanGeneratorEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(NODE_OPTIONS|NODE_V8_COVERAGE|NODE_CLINIC_.*|HEAP_PROFILER_.*|BASCIK_PROFILE_.*|CLINIC_.*|ZEROX_.*|VITEST(?:_.*)?)$/.test(key)));
}

interface AllocationNode { id: number; selfSize: number; callFrame: { functionName: string; url: string; lineNumber: number }; children: AllocationNode[] }
export function summarizeAllocationProfile(value: unknown) {
  assert(value && typeof value === "object", "invalid allocation profile");
  const profile = value as { head: AllocationNode; samples: { nodeId: number; size: number }[] };
  assert(Array.isArray(profile.samples) && profile.samples.length > 0, "missing allocation samples");
  const nodes = new Map<number, AllocationNode>();
  const visit = (node: AllocationNode) => {
    assert(node && Number.isInteger(node.id) && !nodes.has(node.id) && Number.isFinite(node.selfSize) && node.selfSize >= 0 && Array.isArray(node.children) && typeof node.callFrame?.functionName === "string", "invalid allocation node");
    nodes.set(node.id, node);
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  let sampledBytes = 0;
  const sites = new Map<number, number>();
  for (const sample of profile.samples) {
    assert(nodes.has(sample.nodeId) && Number.isFinite(sample.size) && sample.size > 0, "invalid allocation sample");
    sampledBytes += sample.size;
    sites.set(sample.nodeId, (sites.get(sample.nodeId) ?? 0) + sample.size);
  }
  return { records: profile.samples.length, nodes: nodes.size, sampledBytes, sites: [...sites].map(([nodeId, bytes]) => ({ ...nodes.get(nodeId)!.callFrame, sampledBytes: bytes })).sort((left, right) => right.sampledBytes - left.sampledBytes) };
}

interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface CpuProfile { nodes: CpuNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
function decodeCpuProfile(value: unknown): CpuProfile {
  assert(value && typeof value === "object", "invalid CPU profile");
  const profile = value as CpuProfile;
  assert(Array.isArray(profile.nodes) && profile.nodes.length > 0, "missing CPU nodes");
  assert(Array.isArray(profile.samples) && profile.samples.length > 0, "missing CPU samples");
  assert(Array.isArray(profile.timeDeltas) && profile.timeDeltas.length === profile.samples.length, "invalid CPU time deltas");
  assert(Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime) && profile.endTime > profile.startTime, "invalid CPU interval");
  assert(profile.timeDeltas.every((delta) => Number.isFinite(delta) && delta >= 0), "invalid sample time");
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  assert.equal(nodes.size, profile.nodes.length, "duplicate CPU node ids");
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    assert(Number.isInteger(node.id) && typeof node.callFrame?.functionName === "string", "invalid CPU node");
    for (const child of node.children ?? []) {
      assert(nodes.has(child) && !parents.has(child), "missing or multiply owned CPU child");
      parents.set(child, node.id);
    }
  }
  for (const node of profile.nodes) {
    const ancestry = new Set<number>();
    let current: number | undefined = node.id;
    while (current !== undefined) {
      assert(!ancestry.has(current), "cyclic CPU tree");
      ancestry.add(current);
      current = parents.get(current);
    }
  }
  assert(profile.samples.every((id) => nodes.has(id)), "unknown sampled CPU node");
  return profile;
}
export function summarizeCpuProfile(value: unknown, name: string) {
  const profile = decodeCpuProfile(value);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  let inclusive = 0;
  let self = 0;
  for (const sample of profile.samples) {
    if (nodes.get(sample)!.callFrame.functionName.includes(name)) self++;
    let current: number | undefined = sample;
    while (current !== undefined) {
      if (nodes.get(current)!.callFrame.functionName.includes(name)) { inclusive++; break; }
      current = parents.get(current);
    }
  }
  return { samples: profile.samples.length, inclusive, self };
}
export async function validateArtifact(path: string, kind: "cpu" | "json" | "html" | "binary") {
  assert((await stat(path)).isFile(), `not an artifact file: ${path}`);
  const content = await readFile(path);
  assert(content.length > 0, `empty artifact: ${path}`);
  if (kind === "cpu") decodeCpuProfile(JSON.parse(content.toString("utf8")));
  if (kind === "json") JSON.parse(content.toString("utf8"));
  if (kind === "html") assert(/<html[\s>]/i.test(content.toString("utf8")), "invalid rendered HTML artifact");
  return { path, bytes: content.length, sha256: digest(content) };
}

export async function validateCpuCaptureArtifacts(paths: string[], mainPid: number, events: ProcessCoverage[] = []) {
  const main = paths.find((path) => new RegExp(`^CPU\\.\\d{8}\\.\\d{6}\\.${mainPid}\\.0\\.\\d+\\.cpuprofile$`).test(basename(path)));
  assert(main, `missing main CPU profile for PID ${mainPid}`);
  await validateArtifact(main, "cpu");
  const coverage: ProcessCoverage[] = [];
  for (const path of paths.filter((path) => path.endsWith(".metadata.json"))) {
    const companion = path.replace(/\.metadata\.json$/, () => ".cpuprofile");
    await validateArtifact(companion, "cpu");
    const entry = JSON.parse(await readFile(path, "utf8"));
    const profile = JSON.parse(await readFile(companion, "utf8"));
    assert.equal(entry.profileStartTime, profile.startTime, "CPU metadata start mismatch");
    assert.equal(entry.profileEndTime, profile.endTime, "CPU metadata end mismatch");
    if (entry.role === "script-child") delete entry.threadId;
    coverage.push(entry);
  }
  validateProcessCoverage(events, coverage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  import("./profile-runner.ts").then(({ runProfiles }) => runProfiles()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}