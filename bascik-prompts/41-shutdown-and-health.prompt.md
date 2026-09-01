# 41: Graceful shutdown, health endpoint, and port conflicts

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server.ts`, `pkg/src/lib/http.ts`, `pkg/src/lib/http2.ts`,
`pkg/src/lib/exec.ts`. Implements `http.timeouts`, which prompt 03 declared without behavior.

---

## Part 1: shutdown is not graceful

`server.ts#L503-L534`:

```ts
if (onShutdown) { try { onShutdown(); } catch {} }        // destroys ALL sockets/sessions
if (typeof (server as any).closeAllConnections === "function") { ... }
runShutdownHandlers().catch(() => { });                    // not awaited
server.close((err) => { ...; process.exit(0); });
```

| Problem                        | Detail                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-flight requests are severed | `onShutdown` in `http.ts#L58-L65` and `http2.ts#L107-L114` calls `socket.destroy()` and `session.destroy()` on **all** connections, then `closeAllConnections()` kills survivors. A user mid-download gets a truncated response |
| Watchers race the exit         | `runShutdownHandlers()` (chokidar watchers, exec watchers) is **fire-and-forget**, and `process.exit(0)` can beat it                                                                                                            |
| No pre-drain phase             | No way to fail a health check first, no `connection: close` on in-flight keep-alive responses                                                                                                                                   |
| Listener leak                  | `process.setMaxListeners(process.getMaxListeners() + 2)` (`#L529`) is **never decremented** on close, a slow leak in test and embedded usage that restarts servers                                                              |
| No `SIGHUP`                    | And no config reload                                                                                                                                                                                                            |

### Required sequence

1. **Mark the server unhealthy** so a load balancer stops sending traffic. See part 2.
2. **Stop accepting new connections.**
3. **`closeIdleConnections()`**, and add `connection: close` to in-flight keep-alive responses so
   clients do not reuse a dying socket.
4. **Wait a configurable drain window** for in-flight requests to finish.
5. **Await `runShutdownHandlers()`.**
6. Only then force-close survivors and exit.

Make the drain window configurable under `http.timeouts`.

**Decrement the max-listener bump on close.**

Coordinate with prompt 32, which tracks spawned `exec` children. They must be part of this drain,
not a separate mechanism.

Coordinate with prompt 37, which added the process-level crash handlers. Those are the
**ungraceful** path; this is the graceful one. Both must exist and they must not fight: a crash
handler should not attempt a drain.

### `SIGHUP`

Decide whether to handle it. Config reload is **not** possible today, because config is
deep-frozen at module load. Prompt 44 prints a restart hint for config edits instead.

So either handle `SIGHUP` as a plain shutdown, or leave it alone. **Do not implement config
reload.** Say which you chose.

---

## Part 2: health and readiness endpoint

There is none today, so nothing can drain correctly and no orchestrator can tell whether the
server is ready.

### Requirements

- Returns **200 when up and pages are loaded**; a non-200 during boot and during the shutdown
  drain.
- **Cheap:** no disk I/O, no page transpilation, no compression.
- **Not rate-limited**, or given its own generous budget, so a health check cannot trip prompt
  40's limiter.
- **Not cached.**
- **Excluded from access logs**, or logged at debug level, so it does not drown the log.
- **Must not collide with a user page.**

### The path

Prompt 10 added a guard that 404s any path containing a dot-segment. A dot-prefixed health path
would be caught by it.

So either add an **explicit exception before that guard**, or pick a path under a reserved prefix
that cannot collide with a page. Whichever you choose, **document it**, and add a test asserting
a user page at a similar path still works.

Distinguish liveness from readiness if it is cheap. An orchestrator wants "is the process alive"
and "should it receive traffic" separately, and the drain phase is exactly when those differ.

---

## Part 3: port conflicts

`server.ts#L474-L490`:

```ts
if (err.code === "EADDRINUSE") {
  console.warn(`Port ${p} is in use, trying ${p + 1}…`);
  tryPort(p + 1);
}
```

Convenient in dev, **wrong in production**. A deployment configured for a specific port will
happily bind the next one, and only a `console.warn` records it. Health checks and reverse
proxies then point at a dead port, and the failure looks like a networking problem.

### Fixes

**Under `--server`, EADDRINUSE is a hard failure** with a clear message naming the port.

**In dev, keep the auto-increment but bound it.** Walking hundreds of ports is not helpful. Print
the final URL prominently.

**On retry, `server.listen()` is called again without `server.close()`.** Node tolerates this,
but each attempt registers a fresh `once("error")`. Clean that up.

---

## TDD steps

Write each failing test first.

1. An in-flight request **completes** during drain rather than being severed.
2. A new connection is refused once drain begins.
3. In-flight keep-alive responses carry `connection: close`.
4. The drain window is configurable and observed.
5. After the drain window, survivors are force-closed and the process exits.
6. `runShutdownHandlers()` is **awaited** before exit.
7. Exec children from prompt 32 are killed as part of the drain.
8. The max-listener count returns to its original value after close.
9. The health endpoint returns 200 when ready, non-200 during boot, and non-200 during drain.
10. The health endpoint is not rate limited and not cached.
11. The health endpoint does not collide with a user page, and a page at a similar path still
    works.
12. Health checks are excluded from access logs, or logged at debug level.
13. `--server` **fails hard** on EADDRINUSE with a message naming the port.
14. Dev increments, **bounded**, and prints the final URL.
15. Retrying a port does not accumulate error listeners.

## Testing

**Unit:** all of the above that can be tested without binding a port.

**E2E:**

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  Start a slow request, send the shutdown signal, and assert the request **completes** rather
  than erroring. Then assert the health endpoint returned non-200 before the process exited.
  That pair is the whole feature.
- Assert the health endpoint returns 200 during normal operation and is not rate limited under
  load, coordinating with prompt 40's load helper.
- `playwright.dev.config.ts`: assert the dev server shuts down cleanly on Ctrl+C without
  orphaning exec children, if the harness can observe that. If not, say so and cover it at the
  unit level.
- `playwright.config.ts` (static build): no new tests. No Bascik process. State that reasoning.

The EADDRINUSE cases are awkward in Playwright. Cover them at the unit level with a mocked
`listen` and say so.

## Documentation

| File                               | Change                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/server.md`           | Graceful shutdown and the drain window. The health endpoint and its path. Fail-fast on port conflict under `--server`                                                                         |
| `docs/content/deploying.md`        | **A worked example**: the health path to configure in a load balancer or orchestrator, and the drain window to pair with its deregistration delay. Cross-link prompt 37's supervisor guidance |
| `docs/content/configuration.md`    | `http.timeouts` including the drain window                                                                                                                                                    |
| `docs/content/internals/server.md` | The shutdown sequence, step by step, and how it relates to the crash handlers from prompt 37                                                                                                  |
| `docs/content/faq.md`              | "Why did my deployment bind the wrong port?" and "How do I do a zero-downtime deploy?"                                                                                                        |
| `docs/src/pages/assets/SKILL.md`   | A health endpoint exists; `--server` fails fast on a port conflict. Sync `create/assets/SKILL.md`                                                                                             |

## Acceptance criteria

- [ ] All fifteen tests failed before their fixes and pass after.
- [ ] **An in-flight request completes during drain**, proven by E2E.
- [ ] New connections are refused; keep-alive responses carry `connection: close`.
- [ ] The drain window is configurable; `runShutdownHandlers()` is awaited; exec children are
      killed.
- [ ] The max-listener bump is decremented.
- [ ] A health endpoint exists, is cheap, is not rate limited or cached, is excluded from logs,
      and cannot collide with a user page.
- [ ] It reports non-200 during boot and during drain.
- [ ] **`--server` fails hard on EADDRINUSE**; dev increments within a bound.
- [ ] Retrying does not accumulate listeners.
- [ ] The `SIGHUP` decision is made and documented; **no config reload was implemented**.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to both server configs; the user has run `yarn e2e:all`.

## Do not do

- Do not implement config hot reload.
- Do not attempt a drain from the crash handlers. Prompt 37 owns the ungraceful path.
- Do not build a second child-process tracking mechanism. Reuse prompt 32's.
- Do not change SSE behavior. **Prompt 42.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
