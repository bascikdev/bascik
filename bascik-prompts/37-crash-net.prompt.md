# 37: Crash net

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/http.ts`, `pkg/src/lib/http2.ts`, `pkg/src/lib/server.ts`,
`pkg/src/index.ts`.

**A single misbehaving client can kill the production server today.** This is the highest-severity
server prompt and the smallest diff. Do it first among the server work.

---

## Bug 1: HTTP/1.1 has no response-stream error handler

`pkg/src/lib/http2.ts#L23-L26` attaches one:

```ts
stream.on("error", (err) => {
  if (isNetworkResetError(err)) return;
  console.error("[bascik] HTTP/2 stream error:", err);
});
```

`pkg/src/lib/http.ts#L9-L39` has **no equivalent** on `resMsg` or `reqMsg.socket`.

This matters because **TLS defaults to off**, so **HTTP/1.1 is the default path for both dev and
`--server`**. The protocol with the handler is the one fewer people use.

`server.ts#L272` does:

```ts
fileStream.pipe(res.writable);
```

**`pipe()` does not forward destination errors.** If the client aborts mid-download, `resMsg`
emits `error` (EPIPE or ECONNRESET) with **no listener**, which is an unhandled `error` event,
which **crashes the process**.

---

## Bug 2: the request handler's promise is never caught

`http.ts#L52-L55`:

```ts
server.on("request", async (...) => { await handleRequest(...) })
```

The returned promise is never `.catch()`ed.

Any throw escaping `handleRequest`, for example from `logAccess` in the `finally`, or a re-throw
inside `onError`, becomes an **unhandled rejection**.

Check `http2.ts` for the same pattern.

---

## Bug 3: no process-level safety net

A grep across `pkg/src/` finds **zero** `uncaughtException` or `unhandledRejection` handlers.

On Node 15 and later, an unhandled rejection **terminates the process**. There is also no
supervisor or restart logic, and no documented expectation that one is required.

### What to add

Handlers that **log with full context** and then **exit deliberately** rather than crashing
opaquely.

Do **not** treat `uncaughtException` as a recovery mechanism. Node's own documentation is
explicit: it is a crude last resort, and resuming after one leaves the application in an
undefined state. The correct use is synchronous cleanup before shutting down.

So: log, run whatever cleanup is safe and synchronous, exit non-zero.

**Document that a supervisor is expected in production**: systemd, a container restart policy, or
a process manager. Prompt 41 adds graceful shutdown; this is the ungraceful path.

Be careful not to swallow errors during tests. A handler that silently absorbs failures makes
every other prompt's tests less trustworthy. Make sure the exit code and the log are both loud.

---

## Bug 4: `isNetworkResetError` is incomplete

`server.ts#L90-L99` does not include:

- `ERR_STREAM_WRITE_AFTER_END`
- `ERR_STREAM_DESTROYED`
- `ERR_HTTP2_INVALID_SESSION`

All three occur on **client disconnect** and are currently logged as **server errors**, which
buries real faults in noise.

Add them. Check for others by reading the Node error code list for stream and HTTP/2 teardown.

---

## TDD steps

Write each failing test first.

1. **The headline test:** a client aborting mid-download does not crash the process on HTTP/1.1.
   Simulate by making the response stream emit `error` during a piped file response, and assert
   the process survives and nothing is logged as a server fault.
2. The same on HTTP/2, confirming the existing handler still works and was not regressed.
3. A throw escaping `handleRequest` is caught and produces a 500 rather than an unhandled
   rejection.
4. A throw from `logAccess` in the `finally` is caught.
5. `unhandledRejection` and `uncaughtException` handlers exist, log with context, and set a
   non-zero exit code.
6. Each of the three added codes is recognized by `isNetworkResetError` and produces **no**
   error log.
7. A genuine server error still logs loudly and is not swallowed by the new handlers.

Test 7 matters: the risk of adding a process-level net is that it hides real problems.

`http.test.ts` has six tests, **none** covering stream or socket error paths. That is exactly the
gap this prompt fills.

## Testing

**Unit:** all of the above.

**E2E:** the abort case needs a real client.

- `playwright.server.config.ts`: **the primary config**, since HTTP/1.1 is the default and the
  unprotected path. Start a download of a reasonably large static asset and abort it mid-flight,
  then assert the server is **still responding** to a subsequent request. That is the whole
  feature.
- `playwright.server-http2.config.ts`: the same abort, confirming parity.
- `playwright.dev.config.ts`: the same abort. Dev also serves static assets through the same
  path, and a dev server that dies on a cancelled request is its own annoyance.
- `playwright.config.ts` (static build): no new tests. There is no Bascik process. State that
  reasoning.

Aborting a request from Playwright can be done by navigating away mid-load or by using an
explicit `AbortController` in a `page.evaluate` fetch. Pick whichever the harness supports and
say which.

## Documentation

| File                               | Change                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/server.md` | **Source of truth.** The crash net: where stream errors are handled, what `isNetworkResetError` covers, and that the process-level handlers log and exit rather than recover |
| `docs/content/deploying.md`        | **A process supervisor is expected in production.** Give a concrete example for systemd and for a container restart policy                                                   |
| `docs/content/faq.md`              | "Do I need a process supervisor?" and "Why did my server exit?"                                                                                                              |
| `docs/src/pages/assets/SKILL.md`   | Production deployments need a supervisor. Sync `create/assets/SKILL.md`                                                                                                      |

## Acceptance criteria

- [ ] All seven tests failed before their fixes and pass after.
- [ ] **A client aborting mid-download does not crash the process on HTTP/1.1**, proven by an
      E2E that makes a subsequent request.
- [ ] The request handler's promise is caught, in both adapters.
- [ ] `unhandledRejection` and `uncaughtException` handlers exist, log with context, and exit
      non-zero.
- [ ] **A genuine server error still logs loudly** and is not swallowed.
- [ ] `isNetworkResetError` covers the three added codes and produces no error log for them.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to dev and both server configs; the user has run `yarn e2e:all`.
- [ ] The supervisor expectation is documented with concrete examples.

## Do not do

- Do not treat `uncaughtException` as a recovery mechanism. Log and exit.
- Do not add a semaphore for server scripts. **Prompt 47 removes that problem by construction**,
  so adding one here is wasted work.
- Do not implement graceful shutdown. **Prompt 41.**
- Do not change compression, caching, or headers. Prompts 38, 39, 45.
- Do not run Playwright, bind a port, or `curl` in the sandbox.
