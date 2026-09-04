---
name: bascik-worker-pool
description: Architecture, IPC communication, lifecycle management, and error handling for Node.js worker_threads in Bascik. Use when modifying worker pools, page compilation workers, task queues, or thread concurrency.
---

# Node.js Worker Pool & Thread Orchestration in Bascik

Bascik accelerates multi-page builds using Node.js `worker_threads` via `pkg/src/lib/worker-pool.ts` and `pkg/src/lib/page-worker.ts`. By distributing heavy AST parsing, PostCSS transformations, and JS scoping across available CPU cores, build throughput scales linearly with core count.

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

Each worker is initialized once with `workerData = { componentList, globalStylesHtml }` and then receives one `PageJob` (or a bare page path string) per `postMessage`. The pool tracks exactly one in-flight job per worker, so replies carry no correlation id. Shapes below are the real exports from `page-worker.ts`:

```ts
// Request: a PageJob from processing.ts (cloned; small)
{ pagePath, route, relativePagePath, preCleanedHtml }

// Response (PageWorkerMessage)
| { ok: true; result: PageWorkerResult | null }
| { ok: false; error: string }

// PageWorkerResult = TranspilePageResult minus distHtml, plus:
{ distHtmlBytes: Uint8Array }
```

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

* **Pool Size:** Defaults to `Math.max(1, os.cpus().length - 1)` to prevent CPU starvation on host systems while reserving 1 core for watcher/main thread I/O.
* **Worker Recycling & Error Boundaries:**
  * If a worker encounters an unhandled exception or termination (`worker.on('error')`, `worker.on('exit')` with non-zero exit code), the pool must reject the active task, remove the dead worker instance, and instantiate a new worker thread to maintain capacity.
* **Clean Shutdown:** Calling `pool.destroy()` sends termination signals to all active workers and drains pending queues.

---

## 4. Testing & Verifying Worker Pools

* Always test both single-threaded fallback mode and multi-threaded worker execution.
* Ensure tests clean up worker threads in `afterEach` / `afterAll` hooks to prevent hanging Vitest test processes.

```sh
# Run worker pool unit tests
npx vitest run pkg/src/lib/worker-pool.test.ts pkg/src/lib/page-worker.test.ts
```
