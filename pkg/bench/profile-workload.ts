import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createReadStream, createWriteStream, fstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
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
  // First seen on v24.17.0; still reproduces on later Node 24 releases (see nativeWorkerCpuLimitation).
  if (platform === "darwin" && /^v24\./.test(version)) return `Unsupported worker CPU capture on Node ${version}/macOS: native built-in loader lock stall; unprofiled worker timelines remain available`;
}
/**
 * Real-project dev timelines (eight page workers): with native --cpu-prof inherited by page workers, captures
 * stall on Node 24/macOS with workers blocked on a process-wide rwlock (builtin loader or OpenSSL provider
 * store) while being sampled. Main-isolate-only profiling did not stall. Small fixtures may not reproduce it.
 */
export function nativeWorkerCpuLimitation(platform: string = process.platform, version: string = process.version) {
  if (platform === "darwin" && /^v24\./.test(version)) return `Native page-worker CPU capture stalls on Node ${version}/macOS: sampled workers block on a process-wide rwlock`;
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
/**
 * Environment for a profiled subject's own descendants (page workers and script children).
 *
 * Clinic instruments its target through `NODE_OPTIONS` preloads and trace flags, plus a `NODE_PATH` entry for its
 * inject directory. Every Node descendant that inherits them runs its own sampler: script children write extra
 * `<pid>.clinic-*` datasets and `node_trace.*.log` rotations into the shared cwd, and worker threads (same PID as
 * the target) write into the target's own dataset files. Descendants must run unprofiled unless a harness opts
 * them into a separately labeled capture.
 */
export function profilerFreeEnvironment(environment: NodeJS.ProcessEnv) {
  const clean = cleanGeneratorEnvironment(environment);
  if (clean.NODE_PATH !== undefined) {
    const kept = clean.NODE_PATH.split(delimiter).filter((entry) => entry && !/[\\/]@clinic[\\/]/.test(entry));
    if (kept.length) clean.NODE_PATH = kept.join(delimiter);
    else delete clean.NODE_PATH;
  }
  return clean;
}
/**
 * Clinic's CLI announces exactly one dataset for its profiled command. Instrumented descendants can leave further
 * `<pid>.clinic-<tool>` datasets beside it; those never represent the target and must not be decoded or visualized
 * in its place (directory order sorts PIDs as text, so "first dataset" is arbitrary).
 */
export function mainClinicDataset(log: string, profiles: string, tool: string): string {
  const owner = resolve(profiles);
  const announced = new Set([...log.matchAll(/^Output file is (.+)$/gm)].map((match) => resolve(match[1].trim())));
  const owned = [...announced].filter((path) => dirname(path) === owner && /^\d+\.clinic-/.test(basename(path)) && basename(path).endsWith(`.clinic-${tool}`));
  assert.equal(owned.length, 1, `missing or ambiguous main Clinic ${tool} dataset`);
  return owned[0];
}
/** Datasets in `profiles` other than the announced main dataset; nonzero means descendants were instrumented. */
export async function descendantClinicDatasets(profiles: string, tool: string, main: string): Promise<string[]> {
  return (await readdir(profiles)).filter((name) => name.endsWith(`.clinic-${tool}`) && join(resolve(profiles), name) !== resolve(main)).sort();
}
/** Distinct `"pid"` values in a Chrome trace-event file, streamed so large Bubbleprof/Doctor traces stay bounded. */
export async function traceEventPids(path: string): Promise<Set<number>> {
  const pids = new Set<number>();
  const pattern = /"pid"\s*:\s*(\d+)/g;
  let carry = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = carry + (chunk as string);
    // A field split across chunks is matched once it is complete; keep only an unfinished tail.
    let consumed = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index! + match[0].length === text.length) break;
      pids.add(Number(match[1]));
      consumed = match.index! + match[0].length;
    }
    carry = text.slice(Math.max(consumed, text.length - 32));
  }
  for (const match of carry.matchAll(pattern)) pids.add(Number(match[1]));
  return pids;
}

const TRACE_LOG_PREFIX = '{"traceEvents":[';

/**
 * Node rotates `node_trace.<n>.log` every 2^19 events, so a large Bubbleprof target writes several files.
 * Clinic's multi-file join (multistream + end-of-stream) reports "premature close" on Node 24 before writing the
 * closing `]}`, leaving a truncated traceevent. This joins the rotated files in rotation order by streaming each
 * file's event array, after checking every file is a complete Node trace log written only by `pid`.
 * Inputs are removed after a successful join, matching Clinic.
 */
export async function joinNodeTraceLogs(directory: string, output: string, pid: number) {
  const files = (await readdir(directory))
    .map((name) => ({ name, rotation: /^node_trace\.(\d+)\.log$/.exec(name)?.[1] }))
    .filter((entry) => entry.rotation !== undefined)
    .sort((a, b) => Number(a.rotation) - Number(b.rotation))
    .map((entry) => join(directory, entry.name));
  assert(files.length > 0, `no node_trace logs to join in ${directory}`);
  const ranges: { file: string; start: number; end: number }[] = [];
  for (const file of files) {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const head = Buffer.alloc(Math.min(size, TRACE_LOG_PREFIX.length));
      await handle.read(head, 0, head.length, 0);
      assert.equal(head.toString("latin1"), TRACE_LOG_PREFIX, `${basename(file)}: not a Node trace log`);
      const tailLength = Math.min(size - TRACE_LOG_PREFIX.length, 64);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      const trimmed = tail.toString("latin1").replace(/[ \t\r\n]+$/, "");
      assert(trimmed.endsWith("]}"), `${basename(file)}: incomplete Node trace log`);
      ranges.push({ file, start: TRACE_LOG_PREFIX.length, end: size - tailLength + trimmed.length - 2 });
    } finally {
      await handle.close();
    }
    const foreign = [...await traceEventPids(file)].filter((value) => value !== pid);
    assert.equal(foreign.length, 0, `${basename(file)}: trace events from foreign PIDs ${foreign.slice(0, 5).join(", ")}`);
  }
  const populated = ranges.filter((range) => range.end > range.start);
  await pipeline(async function* () {
    yield TRACE_LOG_PREFIX;
    for (const [index, range] of populated.entries()) {
      if (index) yield ",";
      yield* createReadStream(range.file, { start: range.start, end: range.end - 1 });
    }
    yield "]}";
  }, createWriteStream(output, { mode: 0o600 }));
  const expected = TRACE_LOG_PREFIX.length + 2 + Math.max(0, populated.length - 1)
    + populated.reduce((total, range) => total + range.end - range.start, 0);
  const bytes = (await stat(output)).size;
  assert.equal(bytes, expected, "joined trace size does not match its inputs");
  for (const file of files) await unlink(file);
  return { files: files.map((file) => basename(file)), bytes };
}

/**
 * True only for Clinic's trace-join failure after a target that exited normally: "Analysing data" followed by
 * "Error: premature close", with no dataset announcement and no abnormal-exit report.
 */
export function isClinicTraceJoinFailure(log: string) {
  // Clinic prints the error's stack (end-of-stream frames) after the message; nothing else may follow.
  // Each frame ends at a newline or the end of input, so frames cannot overlap and matching stays linear.
  return /(?:^|\n)Analysing data\r?\nError: premature close\r?\n(?:[ \t]+at [^\r\n]*\r?(?:\n|$))*$/.test(log)
    && !log.includes("Output file is") && !/process exited (?:with exit code|by signal)/.test(log);
}

interface ProcessStatMessage { timestamp: number; delay: number; cpu: number; handles: number; memory: { rss: number; heapUsed: number } }
let processStatMessages: { decode(buffer: Buffer): ProcessStatMessage } | undefined;
function processStatMessageType() {
  if (processStatMessages) return processStatMessages;
  // Decode with Doctor's own schema and protobuf runtime, so validation matches what --visualize-only reads.
  const doctorRequire = createRequire(createRequire(import.meta.url).resolve("@clinic/doctor/package.json"));
  const protobuf = doctorRequire("protocol-buffers") as (schema: Buffer) => { ProcessStat: { decode(buffer: Buffer): ProcessStatMessage } };
  const schema = readFileSync(join(dirname(doctorRequire.resolve("@clinic/doctor/package.json")), "format/process-stat.proto"));
  return processStatMessages = protobuf(schema).ProcessStat;
}

/**
 * Doctor's processstat file is a sequence of uint16 big-endian length-prefixed ProcessStat frames written by
 * one sampler. A second writer (for example a page worker that loaded the sampler under the same PID)
 * interleaves frames and Doctor's decoder later fails with "Groups are not supported". Validate every frame,
 * a single nondecreasing clock, and a complete final frame before visualizing.
 */
export function validateDoctorProcessStat(bytes: Buffer, path = "processstat") {
  const type = processStatMessageType();
  let offset = 0;
  let frames = 0;
  let previous = -Infinity;
  let first: number | undefined;
  while (offset < bytes.length) {
    assert(offset + 2 <= bytes.length, `${path}: truncated frame prefix at byte ${offset} after ${frames} frames`);
    const length = bytes.readUInt16BE(offset);
    assert(length > 0, `${path}: empty frame at byte ${offset} after ${frames} frames`);
    assert(offset + 2 + length <= bytes.length, `${path}: truncated frame at byte ${offset} after ${frames} frames`);
    let message: ProcessStatMessage;
    try {
      message = type.decode(bytes.subarray(offset + 2, offset + 2 + length));
    } catch (error) {
      throw new Error(`${path}: undecodable frame at byte ${offset} after ${frames} frames: ${(error as Error).message}`);
    }
    assert(Number.isFinite(message.timestamp) && message.timestamp > 0, `${path}: invalid timestamp at byte ${offset}`);
    assert(message.timestamp >= previous, `${path}: timestamp moved backwards at byte ${offset} after ${frames} frames (second sampler?)`);
    previous = message.timestamp;
    first ??= message.timestamp;
    offset += 2 + length;
    frames++;
  }
  assert(frames > 0, `${path}: no ProcessStat frames`);
  return { frames, firstTimestamp: first!, lastTimestamp: previous, bytes: bytes.length };
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
  // V8's sampler records deltas from a different clock than the isolate; adjacent samples may carry small negative
  // deltas (DevTools and Lighthouse clamp them). Reject non-numeric deltas and any reconstructed sample time that
  // falls outside the profile interval, which is what actually invalidates a capture.
  let sampleTime = profile.startTime;
  for (const delta of profile.timeDeltas) {
    assert(typeof delta === "number" && Number.isFinite(delta), "invalid sample time");
    sampleTime += delta;
    assert(sampleTime >= profile.startTime && sampleTime <= profile.endTime, "invalid sample time: outside profile interval");
  }
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

const cpuProfileFilename = /^CPU\.(\d{8})\.(\d{6})\.(\d+)\.(\d+)\.(\d+)\.cpuprofile$/;
export function parseCpuProfileFilename(name: string) {
  const match = cpuProfileFilename.exec(name);
  if (!match) return undefined;
  return { date: match[1], time: match[2], pid: Number(match[3]), threadId: Number(match[4]), sequence: Number(match[5]) };
}
export async function validateCpuCaptureArtifacts(paths: string[], mainPid: number, events: ProcessCoverage[] = []) {
  assert(typeof mainPid === "number" && Number.isSafeInteger(mainPid) && mainPid > 0, `invalid main PID ${String(mainPid)}`);
  const main = paths.find((path) => {
    const parsed = parseCpuProfileFilename(basename(path));
    return parsed !== undefined && parsed.pid === mainPid && parsed.threadId === 0;
  });
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
