# Benchmarks and Profiling Harness

Contributor tooling for measuring Bascik itself. Nothing in this directory ships in the npm package. The public overview lives on the [Testing Internals](https://bascik.dev/internals/testing) page; this file holds the operational detail for running and interpreting captures.

| Command (from the repository root) | Entry point | Purpose |
| --- | --- | --- |
| `yarn pkg:bench` | `*.bench.ts` | Vitest throughput benchmarks on fixed inputs |
| `yarn workspace @bascik/bascik profile:workload` | `profile-workload.ts` | Bounded runtime captures (servers, dev, builds) on a synthetic fixture |
| `yarn workspace @bascik/bascik profile:compiler` | `compiler-timeline.ts` | Dev and build timelines on a copy of a real project |
| `yarn workspace @bascik/bascik profile:compare` | `compiler-compare.ts` | Paired baseline versus candidate compiler runs on one fixture |
| `node pkg/bench/profile-boundaries.ts <report-dir>` | `profile-boundaries.ts` | Resource-boundary capture with optional allocation sampling |

Supporting modules: `profile-runner.ts` (bounded, process-group-owned command execution), `profile-fixture.ts` and `profile-tls.ts` (synthetic project and private TLS trust), `profile-subject.ts` and `compiler-timeline-subject.ts` (the processes being measured), `profile-load.ts` (load generator), `profile-observers.ts`, `profile-isolate.ts`, and `profile-diagnostics.ts` (worker/child observation, inspector profiling, and event journals).

## Throughput Benchmarks

Benchmarks use Vitest's built-in `bench` API and measure the transpilation pipeline on fixed, repeatable inputs:

```ts
import { bench, describe } from "vitest";
import { recursivelyTranspile } from "../src/lib/processing.ts";

describe("recursivelyTranspile", () => {
  bench("simple page - one component", () => {
    recursivelyTranspile(simpleHtml, componentList);
  });

  bench("complex page - nested components", () => {
    recursivelyTranspile(complexHtml, componentList);
  });
});
```

## Report Directories

Every profiling command writes to a report directory you pass explicitly. The same rules apply to all of them:

- The path must be absolute and outside the repository and every served, watched, or cleaned output tree.
- The directory must be new or empty. An existing directory must belong to the current user and have mode `0700`. Unsafe roots are rejected before anything is written.
- Manifests and raw captures can contain source code and filesystem paths. Keep them private.
- Run one tool at a time. There are no automatic retries.
- When a profiling unit or integration test fails, it keeps its report directory and prints the path. Successful test runs remove theirs.

`mktemp -d` creates a suitable directory on POSIX systems. The examples below use a `REPORT_DIR` variable set this way:

```sh
REPORT_DIR="$(mktemp -d)"
```

## Runtime Workload Captures (`profile:workload`)

```sh
yarn workspace @bascik/bascik profile:workload --report-dir "$REPORT_DIR"
```

The default matrix runs unprofiled controls, Clinic Doctor, top-level 0x, and Node CPU sampling across HTTP/1.1, HTTP/2 with TLS, static file serving, live development, serial builds, and worker builds. Select a bounded subset with `--tools`, `--scenarios`, and `--rounds`:

```sh
yarn workspace @bascik/bascik profile:workload --tools bubbleprof --scenarios http1 --rounds 20 --report-dir "$REPORT_DIR"
```

Tool choices are `control`, `doctor`, `bubbleprof`, `heapprofiler`, `0x`, and `cpu`. Rounds must be between 1 and 100.

### What makes a capture valid

The fixtures check byte-identical asset delivery, API responses, complete streamed responses, source-edit publication, and serial/worker build output. Static hosting checks file delivery only. Failed commands, missing output, invalid response bytes, incomplete tasks, and missing required profiles invalidate the run; exit code zero alone is not enough. Clinic datasets must decode and render. Allocation samples must reference nodes in their captured tree. Incomplete or unattributed captures fail and stay private.

Cold and warm phases describe application-cache state, not physical disk-cache state. The load generator runs without profiler flags.

### Deadlines and process ownership

Every capture command has a 150-second deadline, which leaves cleanup time before the worker profiling test's 180-second limit. At 120 seconds the runner records its own resource state. On macOS it also writes `sample` stack reports for up to four processes in the capture's process group, so a stalled capture keeps evidence of where its threads were waiting.

On POSIX systems, every command (successful, failed, interrupted, or past its deadline) settles its own process group before reporting an outcome. Remaining descendants receive termination, get 500 ms to exit, and are then force-killed, and group absence is checked within one second. The command's exit code or error is preserved, and a settlement failure is reported alongside it. Windows has no process groups, so only the leader is owned there. Cancellation stops the capture loop. This does not cover uncatchable parent termination or descendants that deliberately leave the process group.

### Event journals

CPU captures append owner-only event journals as worker dispatch, listener entry, inspector operations, artifact writes, replies, and termination occur. Build and shutdown markers do not depend on a successful final result. At 120 seconds, responsive runner and subject event loops record resource snapshots before the capture deadline. Journals help diagnose incomplete work, but they do not replace the required task counts or CPU attribution checks.

### Manifests

Manifests record runtime and profiler versions, hardware, source hashes, configuration, commands, task counts, response hashes, phase timings, memory, and artifact hashes. The profiler and its target must use the same stable project working directory.

### HTTP/2 and TLS

HTTP/2 harness clients verify TLS normally. `profile-tls.ts` issues a private fixture certificate authority and a server certificate whose subject alternative name matches the connection host. The fixture config passes the key and certificate through `http.tls`, and clients trust only that fixture CA. Wrong-CA and hostname-mismatch controls confirm that verification is active rather than bypassed.

### Clinic integration

- Clinic commands (collection, visualization, and help) run with Clinic's supported `NO_INSIGHT` opt-out set in the child environment only. Without it, a fresh non-interactive environment never starts collection and exits zero with no dataset. The runner never reads or writes the user's saved consent, and the fresh-environment unit tests use a disposable `HOME` and XDG directories so an existing consent file cannot mask a false start.
- Clinic instruments its target through `NODE_OPTIONS`, which every Node descendant would otherwise inherit. Profiling subjects therefore start page workers, build-script children, and config `exec` children without Clinic's preloads, trace flags, or inject path.
- Node rotates trace-event logs every 2^19 events, so a large Bubbleprof target writes several `node_trace.<n>.log` files. Clinic's multi-file join can fail on Node 24 with `premature close` and leave a truncated trace. When that is the only failure and the subject completed, `profile:compiler` joins the main process's rotated logs itself, after checking each one is complete and contains only that process's events, and then visualizes the dataset.
- Only the dataset Clinic announces for the main target is decoded and visualized. Any other `<pid>.clinic-<tool>` dataset beside it fails the capture.
- Before a Doctor dataset is visualized, every `processstat` frame is decoded with Doctor's own schema and must form one complete stream with a nondecreasing clock. A truncated or interleaved stream fails with its byte offset instead of a later decoder error.

## Resource Boundaries

`src/lib/profile-resource-boundaries.integration.test.ts` uses isolated native processes and explicit producer and consumer gates. Injected controls verify detection of live timers, open descriptors, serialized independent work, and unfinished streams. Real boundary checks exercise script settlement, response backpressure and disconnect, child permits, source-cycle ordering, worker transfer, disk publication, and cancellation.

Resource samples follow explicit cleanup and event-loop checkpoints. Async hooks track resources created after module setup, including unreferenced timers. Supported platforms also inspect process-wide open descriptors. Closed file handles are not counted as open resources. These checks do not establish Promise reclamation or native allocator behavior.

The standalone entry point accepts a report directory and an optional `--allocation` flag:

```sh
node pkg/bench/profile-boundaries.ts "$REPORT_DIR" --allocation
```

Allocation sampling covers the main script and source-cycle window and stops before worker execution. CPU time, elapsed wait, sampled allocation, and retained heap are separate measurements. Worker queue-to-entry and reply-to-receive timings include scheduling costs, and the controlled worker fixture is not a page-worker CPU profile. HeapProfiler request captures stop through the profiler's own writer after framework cleanup; they do not measure full server shutdown. Use the module retention experiments below for snapshots and retainer paths.

## Compiler Timelines (`profile:compiler`)

`profile:compiler` copies a real Bascik project into a private fixture and times complete dev and build runs against an immutable snapshot of the built compiler. It defaults to the repository docs site. Pass `--source` for another project and `--site-url` to set `BASCIK_SITE_URL`.

```sh
yarn workspace @bascik/bascik profile:compiler --tools control,cpu --modes build --rounds 3 --report-dir "$REPORT_DIR"
```

Tools are `control`, `cpu`, `doctor`, `bubbleprof`, `heapprofiler`, `0x`, and `flame`. Each fixture gets a real, private cache directory, so a capture never reads or clears the original project's script cache.

`timeline-manifest.json` records the compiler `dist` digest, runtime, options, every run, and any failure. `complete` stays `false` unless the whole matrix finished.

The `cpu` tool requires the main isolate's profile and records page-worker profiles against observed worker starts. Build-script children are not covered by that tool. `--worker-cpu` chooses how page workers are profiled:

| Value | Behavior |
| --- | --- |
| `all` | Inherit native `--cpu-prof` in every worker |
| `first` | Inherit native `--cpu-prof` in the first worker only |
| `inspector` | Start the inspector profiler from a preload after worker bootstrap and write one profile per task |
| `none` | Profile the main isolate only |
| `auto` (default) | `all`, unless native worker capture is known to stall on the current runtime, then `none` |

`--edits` measures dev edits until validated output reaches disk, not until a browser refreshes. On the docs site it edits a page, a Markdown file, and a shared helper. For another project, `--edit-page src/pages/<page>.html` edits one page and implies `--edits`. Pass `--edit-output` when the page does not map to `dist/` under the default directories.

## Paired Compiler Comparisons (`profile:compare`)

`profile:compare` alternates a baseline and a candidate compiler on one prepared private fixture and stops if their emitted HTML differs. Use it to show that a performance change keeps output byte-identical and to compare timings under the same conditions.

```sh
yarn workspace @bascik/bascik profile:compare \
  --project <fixture>/docs \
  --baseline <baseline>/pkg \
  --candidate <candidate>/pkg \
  --mode build --rounds 5 --site-url https://bascik.dev \
  --report-dir "$REPORT_DIR"
```

Inputs:

- **Fixture (`--project`).** A Bascik project outside the repository with a real (not symlinked) `node_modules` directory. The project copy that a `profile:compiler` run leaves in its report directory works. Deterministic instance IDs hash absolute source paths, so emitted HTML is only comparable between builds of the same fixture path.
- **Compilers (`--baseline`, `--candidate`).** Each needs built `dist/`, `bin/`, and `package.json`. A `git worktree` checkout of the baseline revision also records its commit. For the candidate, copy those entries out of `pkg/` into a private directory so later edits do not change the snapshot.

Before each build, the fixture's `node_modules/@bascik/bascik` symlink is pointed at the compiler under test, so config imports and exec scripts use the same snapshot as the compile. The tool refuses to replace anything that is not a symlink.

Rounds (1 to 10) swap which compiler runs first. Cold runs remove the fixture's application cache before each build. Warm runs reuse whatever cache the previous build left, which may come from the other compiler. `comparison.json` reports `byteIdentical`, per-compiler and per-cache-state medians with their samples, and keeps partial results and the failure when a run stops early.

## Module Retention Experiments

`src/lib/module-retention.integration.test.ts` runs bounded native-process experiments with changing-source and stable-source controls. It checks completed responses, framework-owned references, and strong heap retainer paths separately. Framework cache cleanup does not evict Node's ESM cache, and allocation samples alone do not prove reclamation. See [Module Lifetime](https://bascik.dev/internals/server#module-lifetime) for the runtime behavior being measured.

To keep a capture for inspection, run the helper directly from the repository root. This example keeps a changing-source dev capture of 60 rounds in a new temporary directory:

```sh
node --input-type=module -e '
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRetentionExperiment } from "./pkg/src/lib/module-retention.test-helper.ts";
const directory = await mkdtemp(join(tmpdir(), "bascik-retention-"));
await runRetentionExperiment(directory, true, 60);
console.log(directory);
'
```

Arguments after the directory:

- **Changing source.** `true` edits source between rounds; `false` runs the stable control with the same count.
- **Count.** Must be even and between 2 and 100.
- **Production protocol (optional).** `"http1"` or `"http2"` measures stable-source production requests without edits. Production rounds are request rounds, not compilation generations.

Only disposable subject processes receive GC and snapshot flags. Captures use external deadlines and fail on incomplete requests or publication. Reports include runtime versions, source hashes, checkpoints, and snapshot metadata. Snapshots are written with mode `0600`. Test runs remove temporary artifacts, while explicit captures keep them.

Interruption cancels the capture and terminates its owned POSIX process group with bounded graceful-close and force-kill deadlines. This cannot cover uncatchable parent termination or descendants that leave the group, and Windows does not provide the POSIX group guarantee.

## Interpreting Results

- Compare controls with profiled runs using completed useful work and validated response bytes, not wall time alone.
- Consult separate startup and workload timings before attributing CPU samples.
- Main-isolate CPU profiles do not establish worker or child-process CPU cost. Worker and build-script child profiles are labeled independently.
- Native helpers and libuv threads require separate low-level profiling.
- Inclusive samples describe ancestry, while self samples identify the sampled leaf.
- Instrumentation adds overhead, and a finite fixture does not establish a universal memory or latency budget.

## Known Platform Limitations

- **Worker CPU profiling on macOS with Node 24.** Sampled page workers can block indefinitely on a process-wide native loader lock. `profile:workload` rejects worker CPU recording there, and `profile:compiler` refuses `--worker-cpu all` and `first`. `inspector` usually completes but can still stall, in which case the capture deadline stops it. Unprofiled worker execution and timelines remain available.
- **Clinic trace joins on Node 24.** See [Clinic integration](#clinic-integration) for the `premature close` recovery.
- **Windows.** Process-group ownership and the `sample` stack reports are POSIX and macOS features. Only the leader process is owned on Windows.
