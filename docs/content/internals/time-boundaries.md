# Time Boundaries

Time is a first-class architecture boundary in Bascik. Internal subsystems that own deadlines, heartbeats, cleanup intervals, and shutdown windows use an explicit clock contract instead of ambient global timers. This keeps runtime behavior native in production and makes framework timing deterministic in focused unit tests.

## Why Time Is an Architecture Boundary

Without a boundary, timeout semantics become scattered across modules, and tests depend on wall clock delays. Bascik centralizes framework-owned time behavior so each subsystem can:

- enforce deadlines consistently
- clean up timers during teardown
- run deterministic unit tests with fake timers

The boundary is for framework internals. User code still runs on native Node.js timers, and Bascik communicates cancellation through standard `AbortSignal` APIs.

## FrameworkClock and Native Adapter

The internal contract lives in `pkg/src/lib/clock.ts`:

- `FrameworkClock.now()`
- `FrameworkClock.setTimeout()` / `clearTimeout()`
- `FrameworkClock.setInterval()` / `clearInterval()`

`nativeClock` is the default implementation. It is frozen and resolves Node.js global timers and `Date.now()` when each method is called. Production therefore stays on native time, while tests installed before subsystem construction can use Vitest's maintained fake-timer implementation. Bascik does not implement a virtual scheduler.

## Subsystem Ownership

Bascik uses explicit clock ownership in designated semantic-time modules, with static enforcement in `pkg/src/lib/time-boundary.test.ts`.

| Module | Framework-owned time semantics |
| --- | --- |
| `api-runtime.ts` | API handler deadlines (`http.apiTimeout`) and abort deadlines |
| `script-registry.ts` | In-process script invocation deadlines and timeout aborts |
| `debounce.ts` | Watch and exec trigger debouncing |
| `exec.ts` | Child process timeout and escalation windows |
| `rate-limit.ts` | Sliding-window bucket timing and cleanup sweep intervals |
| `script-cache.ts` | Cache prune throttle and TTL cutoff checks |
| `sse.ts` | Live-reload heartbeat intervals and stalled-client reaping |
| `server-lifecycle.ts` | Graceful shutdown drain deadlines |

## Cancellation and Lifecycle Rules

Across request timeout paths, Bascik applies the same lifecycle pattern:

1. create an `AbortController` for the operation
2. bridge upstream abort signals when present
3. schedule deadline timers through `clock.setTimeout(...)`
4. clear timers and signal listeners when the invocation settles

This is visible in both `api-runtime.ts` and `script-registry.ts`, where timeout handles are cleared after completion and upstream signal listeners are unsubscribed.

For repeating timers, owning subsystems provide explicit teardown. For example, `SseManager.destroy()` clears heartbeat intervals and closes clients, and `RateLimiter.destroy()` clears its sweep interval and tracking state.

## Runtime Boundaries and Non-Goals

The time boundary is intentionally narrow:

- **Framework internals:** owned by `FrameworkClock`
- **User handlers:** own their own timers
- **Cross-boundary cancellation:** done through `AbortSignal`

Non-goals:

- no forced interception of user `setTimeout` or `setInterval` calls
- no preemption of synchronous CPU-bound loops in user handlers
- no hidden network protocol for cross-process virtual time control

This matches current runtime behavior: timeouts can abort cooperative async operations, but they cannot interrupt a synchronous infinite loop on Node's event loop.

## Deterministic Test Model

Bascik uses a boundary-aware test model:

1. **Unit tests for framework internals:** fake timers drive deterministic timeout and heartbeat behavior (`api-runtime.test.ts`, `script-registry.test.ts`, `server-lifecycle.test.ts`).
2. **Static architecture enforcement:** `time-boundary.test.ts` prevents direct ambient timer usage in designated semantic-time modules.
3. **Cross-process integration tests:** Playwright E2E tests use short real deadlines because fake timers do not cross process boundaries (`api-routes.test.ts`).
4. **Browser-only timer tests:** Playwright `page.clock` is used only for browser context timing behavior.
5. **External watchdogs:** process startup, sockets, and filesystem events are validated on real wall clock time.

## User-Visible Timeout Behavior

Two timeout surfaces are directly visible to users:

- **API routes:** `http.apiTimeout` defaults to `10000` ms. On timeout, Bascik returns `504 Gateway Timeout` and aborts handler work via `AbortSignal`.
- **Server scripts:** `scripts.timeout` defaults to `30000` ms. Timeout is enforced through `ScriptRegistry` aborts. If `scripts.onServerScriptError` is `error`, request handling fails into the standard server error path. If set to `warn`, the timed-out script output is replaced with an empty string and the rest of the page continues rendering.

## Related Pages

- [Server Architecture](/internals/server)
- [Testing Internals](/internals/testing)
- [API Routes](/api-routes)