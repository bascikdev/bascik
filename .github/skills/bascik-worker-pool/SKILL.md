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

1. **Process Arguments (`process.argv`):** Worker threads do not automatically inherit `process.argv` modifications made on the main thread. Configuration must be passed explicitly via worker data or task payloads. Page workers load the config file themselves, so the page pool forwards an explicit `--config <path>` through the pool's `argv` option (`explicitConfigArgv` in `config-file-names.ts`); other flags reach workers through the environment (`bootEnvironment`).
2. **Global State & Singletons:** Module-level caches or singletons in `pkg/src/` do not share memory across threads.
3. **Filesystem Side-Effects:** During `bascik --build` the worker writes `dist/` output itself inside `transpilePage`; in dev mode the main thread stores the transferred bytes in memory and writes them to disk. Return bytes, not strings, for anything large.
4. **No Direct DOM or Window:** Worker environments are pure Node.js environments.

---

## 3. Worker Lifecycle & Pool Sizing

- **Pool Size:** `processAllPages` starts the pool as soon as the page list is known (before component loading and route expansion) with one worker per page, capped by `os.cpus().length` and `SYSTEM_MAX_CHILD_PROCESSES`; never fewer than 1. Starting at the page count rather than the CPU count keeps a small site with a dynamic route from loading the compiler in workers it never uses (a worker cannot be stopped until it has loaded). After expansion the pool is fitted to the job count with the same caps: `WorkerPool.grow` adds workers when a dynamic route expanded to more jobs than there are pages, `WorkerPool.shrink` trims it when a routes script found no routes. On any change the workers get a `bascik:child-worker-count` settings message so each re-divides the build-script child budget. A resized pool replaces crashed workers only up to its new size.
- **Never stop a worker that is still loading:** Node 24 can abort the whole process (`Check failed: (location_) != nullptr`) when a worker is terminated, or the process exits, while the worker is still evaluating an ES module graph with top-level await, and the page worker's graph has them. `page-worker.ts` posts `{ ready: true }` once its entry module has evaluated; with `readySignal: true` (set by `processAllPages`) the pool waits for that signal before stopping a trimmed worker or tearing the pool down. The signal is not a task result.
- **A slow worker is waited for, only a stuck one is terminated:** every page worker loads the user's config through `userConfig.ts`'s top-level await, so a `bascik.config.ts` (or a module it imports) that works for more than 10 s at load time keeps the worker evaluating, and a `terminate()` or any process exit then aborts every time (Node 24 `(location_) != nullptr`, Node 26 `!is_null()`, in `SourceTextModule::ExecuteAsyncModule`). Past `READY_GRACE_MS` (10 s) the pool calls `onSlowLoad` once (`processAllPages` prints `A page worker is still loading after 10 s`) and samples the worker's `performance.eventLoopUtilization()` every `LOAD_CHECK_MS` (1 s): it terminates the worker only after an interval spent waiting (under 5 % active: a promise that never settles), never while it runs JavaScript, and counts an unreadable sample as busy. Terminating a worker that is waiting is safe (only a wait that ends in the same instant could race it); there is no time bound on one that is evaluating. Do not add one: a hard deadline here is exactly the abort. `pool.terminate({ abandon: true })` never calls `onSlowLoad`.
- **Wasm code GC is off on Node 24:** Node strips the types of every `.ts` module and `text/typescript` script with Amaro, swc compiled to wasm, so every Bascik thread runs wasm. V8 13.6 shares wasm-to-JS import wrappers across all threads, and when one thread tiers an import up (`Runtime_TierUpWasmToJSWrapper`) while the last thread that used the wrapper is torn down, wasm code GC frees the wrapper twice and the process aborts: `Check failed: jit_page.has_value()` or `jit_page_->allocations_.erase(addr) == 1` (SIGTRAP), or a SIGSEGV on the same path (nodejs/node#66366, fixed upstream in V8 `9b8ca54d5a` and `68210d500a`, backport nodejs/node#66376 still open at the time of writing). CI's abort had exactly that stack, with no `terminate()` on it: how the ending thread stops does not matter, so the stop message below does not prevent it. `WorkerPool` (and the syntax checker in `typescript.ts`) call `avoidWasmWrapperRace()` (`wasm-code-gc.ts`) before their first worker starts: on V8 13 it runs `v8.setFlagsFromString("--no-wasm-code-gc")` once for the process, unless the user passed `--wasm-code-gc`. V8 reads the flag whenever code dies, so setting it at run time works; without the GC a dying wrapper is never freed. `early-page-pool.integration.test.ts` checks it under `--stress-wasm-code-gc`: no worker isolate may take part in a wasm code GC. Never pass V8 flags in a worker's `execArgv` (Node rejects them with `ERR_WORKER_INVALID_EXEC_ARGV`); set them with `setFlagsFromString` in the main thread.
- **Wasm wrapper tier-up is held off on Node 26 on arm64:** V8 14 on arm64 can kill the process with SIGILL when several threads run the same wasm and one jumps into a shared wasm-to-JS import wrapper that another thread just recompiled (tier-up after `--wasm-wrapper-tiering-budget` calls, 1000; nodejs/node#67467). Page workers that each strip a lot of TypeScript cross the budget together: four workers stripping 12,000 times each crashed 6 of 608 runs on an M-series Mac, and 0 of 608 with the guard. On V8 14 with `process.arch === "arm64"`, `avoidWasmWrapperRace()` sets `--wasm-wrapper-tiering-budget=1000000000` instead, unless the user set that budget; stripping took no measurably longer. Not seen on x64 or Node 24; CI has no arm64 runner, so the unit tests carry it. Do not run multi-thread stripping loops on V8 14 in CI tests (see the comment above the V8 13 test in `early-page-pool.integration.test.ts`).
- **Node flags reach workers through an explicit `execArgv`, minus what Node refuses:** `WorkerPool` starts every worker through `startWorker` (`worker-exec-argv.ts`), which passes `process.execArgv` without `--input-type` (any spelling, with its separate value). Node validates an explicit `execArgv` and `new Worker` throws `ERR_WORKER_INVALID_EXEC_ARGV` for every V8 or per-process flag in it (`--max-old-space-size`, `--stack-size`, `--expose-gc`, `--title`, `--jitless`, `--secure-heap`, ...): passing the list on as is made `node --max-old-space-size=4096 bascik --build` fail every page with "no viable workers". `startWorker` retries without exactly the arguments Node's message names (`Initiated Worker with invalid execArgv flags: --max-old-space-size=4096, --title`), each with its separate value, as often as Node names more, and remembers the result per `process.execArgv`; when the message names nothing it was given, it falls back to omitting `execArgv` (unless `--input-type` was dropped). Keep no list of refused flags: it differs between Node versions, and V8 flags apply to every thread anyway. Do not switch to omitting `execArgv`: with an explicit `env` (the page pool passes one), Node parses the parent's flags again for the worker and stops at a per-process flag's separate value, so `--title x --import ./preload.mjs` gives the worker only `--title`. `NODE_OPTIONS` is read from the worker's environment, where V8 and per-process flags are allowed even with an explicit `env`. `worker-exec-argv.integration.test.ts` runs the real CLI under those flags.
- **Stop workers by message, terminate only as the fallback:** an external `worker.terminate()` stops a thread wherever it is, in the middle of a build script or a module evaluation. With `stopSignal: true` (set by `processAllPages`) the pool posts `{ stop: true }` (after the ready signal) and waits for the worker's `exit` up to `STOP_GRACE_MS` (3 s), calling `terminate()` only for a worker that did not exit. `page-worker.ts` answers with `endPageWorker`: it stops its nested syntax checker the same way (`stopSharedCheckerGracefully` in `typescript.ts`, 500 ms grace), closes its port so the event loop drains and the thread ends with code 0, and keeps an unref'd 1 s `process.exit(0)` for a loop that something a build script left open still holds. Every message after the stop is dropped. A worker script that does not handle the message is still stopped, 3 s later, by `terminate()`.
- **Worker Recycling & Error Boundaries:**
  - If a worker encounters an unhandled exception or termination (`worker.on('error')`, `worker.on('exit')` with non-zero exit code), the pool must reject the active task, remove the dead worker instance, and instantiate a new worker thread to maintain capacity.
  - If a result cannot be deserialized on the main thread (`worker.on('messageerror')`, for example a value only the worker's realm can rebuild), the pool rejects that task with a plain `Error` (`Worker result could not be received ...`, which `processing.ts` reports under the page's path with the `worker transpile` stage) and keeps the worker, which is still healthy, for the next task. Never leave a task pending on an event the pool does not listen for.
- **Clean Shutdown:** `pool.terminate()` rejects queued and in-flight tasks and stops every worker (by the stop message with `stopSignal`), including ones `shrink` is still stopping. `processAllPages` terminates the pool on every path, including a component load or route expansion that fails before any page is dispatched, and a failure to terminate never replaces the build's own error. `stopPagePools()` stops the pool of a phase that is still running; `watchFiles` calls it in a build when the static asset copy fails first, so the CLI never exits while workers are still loading.
- **Every exit path stops the pools first:** `processing.ts` registers the page pools with `exit-stoppers.ts`. The crash net (`crash-net.ts`), the CLI's own exits (`exitAfterStopping`) and `runShutdownHandlers` (the dev server's SIGINT / SIGTERM shutdown, an exec failure stop) wait for them with no deadline: `process.exit()` while a worker evaluates aborts just as `terminate()` does, and a crash still waiting 3 s in says so on stderr (`EXIT_WAIT_NOTICE_MS`). The pools register as `teardownOnly` stoppers: a signal's exit never needs them, since a death by signal runs no exit teardown. A build's own Ctrl-C ends by re-raising the signal and does not wait for the pools; the server's signal shutdown waits for them only `SIGNAL_EXIT_TEARDOWN_WAIT_MS` (1 s), then `endProcess` exits with its code, or re-raises the signal while a pool stop is still running, so no Ctrl-C waits on a slow config or aborts. The exit stopper terminates with `pool.terminate({ abandon: true })`: the running phase's tasks (and any later `run`) are dropped without settling, so the phase never reports "WorkerPool terminated" page errors or a page count while the exit waits; the crash or the Ctrl-C stays the only thing reported. While `exitAfterStopping` waits, no SIGINT / SIGTERM listener is left (a second Ctrl-C ends the process at once), a failing exit keeps stdout quiet (no progress or "Build complete" after a crash), and a further crash is logged as `[bascik] Another error while exiting:`, not as a second fatal one. In dev the server's first signal removes both its SIGINT and SIGTERM handlers; the production server (`bascik --server`) keeps the other one, so a SIGTERM after a Ctrl-C cannot cut its connection drain short. With nothing running, the exit stays synchronous. `page-pool-exit.integration.test.ts` crashes and signals the real CLI during worker warm-up repeatedly and checks that stderr carries only the user's failure.

---

## 4. Testing & Verifying Worker Pools

- Always test both single-threaded fallback mode and multi-threaded worker execution.
- Ensure tests clean up worker threads in `afterEach` / `afterAll` hooks to prevent hanging Vitest test processes.

```sh
# Run worker pool unit tests
npx vitest run pkg/src/lib/worker-pool.test.ts pkg/src/lib/page-worker.test.ts
```
