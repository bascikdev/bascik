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

Tasks dispatched to workers are strongly typed. All IPC communication happens via structured cloning:

```ts
// Request payload to worker
interface WorkerTaskRequest {
  id: number;
  filePath: string;
  sourceHtml: string;
  config: SerializedBascikConfig;
}

// Response payload from worker
interface WorkerTaskResponse {
  id: number;
  success: boolean;
  html?: string;
  error?: {
    message: string;
    stack?: string;
  };
}
```

---

## 2. Thread Safety & Environment Parity

Worker threads run in isolated V8 contexts. When working on worker tasks, keep these constraints in mind:

1. **Process Arguments (`process.argv`):** Worker threads do not automatically inherit `process.argv` modifications made on the main thread. Configuration must be passed explicitly via worker data or task payloads.
2. **Global State & Singletons:** Module-level caches or singletons in `pkg/src/` do not share memory across threads.
3. **Filesystem Side-Effects:** Worker tasks must write build outputs (`dist/`) directly to disk or return final HTML strings for the main thread to write atomically.
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
