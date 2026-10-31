---
name: bascik-worker-pool
metadata:
  internal: true
description: Architecture, IPC communication, lifecycle management, and error handling for Node.js worker_threads in Bascik. Use when modifying worker pools, page compilation workers, task queues, or thread concurrency.
---

# Node.js Worker Pool & Thread Orchestration in Bascik

Bascik accelerates multi-page builds using Node.js `worker_threads` via `pkg/src/lib/worker-pool.ts` and `pkg/src/lib/page-worker.ts`. By distributing heavy HTML parsing, CSS scoping, and JS scoping across available CPU cores, build throughput scales linearly with core count.

---

## 1. Architecture & Message Protocol

```
                     [Main Thread: WorkerPool]
                                 │
           ┌─────────────────────┼─────────────────────┐
           ▼                     ▼                     ▼
     [Worker 1]            [Worker 2]            [Worker N]
  (page-worker.ts)      (page-worker.ts)      (page-worker.ts)
```

### Message Structure

The pool is started before the component list is loaded, so a worker gets its compile inputs from a settings message, `{ kind: "bascik:page-worker-init", componentList, globalStylesHtml }`, posted with `WorkerPool.configure` before any page (`page-worker-messages.ts`). It then receives one `PageJob` (or a bare page path string) per `postMessage`. Settings messages get no reply; `configure` replays them, in order, to any replacement worker before its first task. A page that arrives before the init message is failed, never compiled without components. The pool tracks exactly one in-flight job per worker, so replies carry no correlation id. Shapes below are the real exports from `page-worker.ts`:

```ts
// Request: a PageJob from processing.ts (cloned; small)
{ pagePath, route, relativePagePath, preCleanedHtml }

// Response (PageWorkerMessage)
| { ok: true; result: PageWorkerResult | null }
| { ok: false; error: string; detail?: PageWorkerFailure }

// PageWorkerResult = TranspilePageResult minus distHtml, plus:
{ distHtmlBytes: Uint8Array }

// PageWorkerFailure (page-worker-errors.ts), plain data
{ message, stage?, location?: { sourceFile, line, column }, failedDependencies? }
```

A structured clone keeps neither an error's class nor its own fields, so a page that fails in a worker sends what the main thread needs as data in `detail`. The pool rejects with a `WorkerTaskError` carrying it, and `processing.ts` rebuilds the error the serial path would have seen (`fromPageWorkerFailure`: a `BuildScriptError` inside the `PageProcessingError` stage), so the dev overlay names the build script's file and line, and records `failedDependencies` (the helpers the compile could not import, read from the worker's own `mem`) in the main thread's `mem`, which the watchers read. A worker crash or exit still rejects with a plain `Error` and keeps the `worker transpile` stage. Anything a worker records only in its own module state (its `mem`, counters, caches) is lost to the main thread unless it travels in a message.

### Zero-copy page output (transfer list, not structured clone)

The rendered page never crosses the thread boundary as a string. `page-worker.ts` encodes `distHtml` with `TextEncoder.encode()` into a `Uint8Array` that owns its whole `ArrayBuffer`, then posts it with that buffer in the transfer list:

```ts
port.postMessage({ ok: true, result }, [result.distHtmlBytes.buffer]);
```

Ownership moves to the main thread; the worker-side view is detached (length 0) after the call. On the main thread `processing.ts` wraps the bytes in a `Buffer` view (no copy) and hands that directly to `mem.storePage` and the disk writer. Nothing on the worker result path decodes the HTML back to a string.

Rules when touching this path:

- Use `TextEncoder.encode()`, never `Buffer.from(string)`, to produce the bytes. `Buffer.from` may return a slice of Node's shared 8 KB pool; transferring that `ArrayBuffer` would detach memory owned by unrelated buffers.
- Add new large payload fields as transferable `ArrayBuffer`s in the transfer list. Small metadata (paths, component names, dependency lists, server script entries) stays as cloned fields.
- A `null` result (page unreadable) is posted with no transfer list.
- Tests: `page-worker.test.ts` asserts the transfer list contents, `byteOffset === 0`, detachment after a real `MessageChannel` and `Worker` hop, and byte-identical decode.

---

## 2. Thread Safety & Environment Parity

Worker threads run in isolated V8 contexts. When working on worker tasks, keep these constraints in mind:

1. **Process Arguments (`process.argv`):** Worker threads do not automatically inherit `process.argv` modifications made on the main thread. Configuration must be passed explicitly via worker data or task payloads.
2. **Global State & Singletons:** Module-level caches or singletons in `pkg/src/` do not share memory across threads.
3. **Filesystem Side-Effects:** During `bascik --build` the worker writes `dist/` output itself inside `transpilePage`; in dev mode the main thread stores the transferred bytes in memory and writes them to disk. Return bytes, not strings, for anything large.
4. **No Direct DOM or Window:** Worker environments are pure Node.js environments.

---

## 3. Worker Lifecycle & Pool Sizing

- **Pool Size:** `processAllPages` starts the pool as soon as the page list is known (before component loading and route expansion) with one worker per page, capped by `os.cpus().length` and `SYSTEM_MAX_CHILD_PROCESSES`; never fewer than 1. Starting at the page count rather than the CPU count keeps a small site with a dynamic route from loading the compiler in workers it never uses (a worker cannot be stopped until it has loaded). After expansion the pool is fitted to the job count with the same caps: `WorkerPool.grow` adds workers when a dynamic route expanded to more jobs than there are pages, `WorkerPool.shrink` trims it when a routes script found no routes. On any change the workers get a `bascik:child-worker-count` settings message so each re-divides the build-script child budget. A resized pool replaces crashed workers only up to its new size.
- **Never stop a worker that is still loading:** Node 24 can abort the whole process (`Check failed: (location_) != nullptr`) when a worker is terminated, or the process exits, while the worker is still evaluating an ES module graph with top-level await, and the page worker's graph has them. `page-worker.ts` posts `{ ready: true }` once its entry module has evaluated; with `readySignal: true` (set by `processAllPages`) the pool waits for that signal, up to a 10 s grace period, before terminating a trimmed worker or tearing the pool down. The signal is not a task result.
- **Worker Recycling & Error Boundaries:**
  - If a worker encounters an unhandled exception or termination (`worker.on('error')`, `worker.on('exit')` with non-zero exit code), the pool must reject the active task, remove the dead worker instance, and instantiate a new worker thread to maintain capacity.
  - If a result cannot be deserialized on the main thread (`worker.on('messageerror')`, for example a value only the worker's realm can rebuild), the pool rejects that task with a plain `Error` (`Worker result could not be received ...`, which `processing.ts` reports under the page's path with the `worker transpile` stage) and keeps the worker, which is still healthy, for the next task. Never leave a task pending on an event the pool does not listen for.
- **Clean Shutdown:** `pool.terminate()` rejects queued and in-flight tasks and terminates every worker, including ones `shrink` is still stopping. `processAllPages` terminates the pool on every path, including a component load or route expansion that fails before any page is dispatched, and a failure to terminate never replaces the build's own error. `stopPagePools()` stops the pool of a phase that is still running; `watchFiles` calls it in a build when the static asset copy fails first, so the CLI never exits while workers are still loading.
- **Every exit path stops the pools first:** `processing.ts` registers the page pools with `exit-stoppers.ts`. The crash net (`crash-net.ts`), the CLI's own exits (`exitAfterStopping`) and `runShutdownHandlers` (the dev server's SIGINT / SIGTERM shutdown, an exec failure stop) wait for them, bounded by `STOP_BEFORE_EXIT_TIMEOUT_MS` (10 s). The exit stopper terminates with `pool.terminate({ abandon: true })`: the running phase's tasks (and any later `run`) are dropped without settling, so the phase never reports "WorkerPool terminated" page errors or a page count while the exit waits; the crash or the Ctrl-C stays the only thing reported. While `exitAfterStopping` waits, no SIGINT / SIGTERM listener is left (a second Ctrl-C ends the process at once), a failing exit keeps stdout quiet (no progress or "Build complete" after a crash), and a further crash is logged as `[bascik] Another error while exiting:`, not as a second fatal one. In dev the server's first signal removes both its SIGINT and SIGTERM handlers; the production server (`bascik --server`) keeps the other one, so a SIGTERM after a Ctrl-C cannot cut its connection drain short. With nothing running, the exit stays synchronous. `page-pool-exit.integration.test.ts` crashes and signals the real CLI during worker warm-up repeatedly and checks that stderr carries only the user's failure.

---

## 4. Testing & Verifying Worker Pools

- Always test both single-threaded fallback mode and multi-threaded worker execution.
- Ensure tests clean up worker threads in `afterEach` / `afterAll` hooks to prevent hanging Vitest test processes.

```sh
# Run worker pool unit tests
npx vitest run pkg/src/lib/worker-pool.test.ts pkg/src/lib/page-worker.test.ts
```
