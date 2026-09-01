# 43: Request pipeline gaps and access logging

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server.ts`.

Small, independent fixes in the request path. None is large; together they close the remaining
correctness gaps.

---

## The pipeline is mostly correct: do not restructure it

For reference, the guard order (`server.ts#L129-L451`), plus what earlier prompts inserted:

1. Rate limit, production only (`#L154`), reworked by prompt 40
2. Method guard, GET and HEAD only (`#L164`)
3. Empty path becomes 400 (`#L171`)
4. Strip `?` and `#`, then `decodeURIComponent` (`#L180-L189`)
5. Traversal string check (`#L192-L202`)
6. Dot-segment guard, added by prompt 10
7. Base prefix strip, added by prompt 23
8. Static branch: strip the leading slash, `resolve()`, `startsWith(distDir + sep)` (`#L205-L212`)
9. SSE branch (`#L283`)
10. In-memory page lookup (`#L353`)

**Assessment: this is solid.** Decode-then-check is the **correct** order; checking before
decoding would be the bug. Double encoding is safe because the second decode never happens. The
`resolve` plus `startsWith` backstop covers Windows backslashes and any string-check bypass.

**Do not reorder it.** Fix the gaps below in place.

---

## Gap 1: null bytes produce a 500

`%00` decodes to `\0`. `stat()` then throws `ERR_INVALID_ARG_VALUE`, **not `ENOENT`**, so the
response is **500 instead of 400** (`#L216-L222`).

A 500 for malformed client input is wrong: it says the server broke when the client did. It also
pollutes error logs with client noise.

**Fix:** reject a decoded path containing a null byte with a **400**, before the static branch.

Check for other control characters while you are there. A path containing a raw newline or
carriage return is similarly malformed and similarly should not reach `stat()`.

---

## Gap 2: no `realpath` check

A symlink **inside** the output directory pointing outside it passes `startsWith` and is
**served**.

Low severity, since it requires a hostile or misconfigured output directory. But `--server` runs
against **arbitrary user-provided directories**, and prompt 10 just tightened what gets copied
in, so this is the remaining hole.

**Fix:** resolve the real path and confirm it is still inside the output directory before
serving.

Be careful about cost. `realpath` is a syscall per request. Cache the result alongside the file
metadata, the same way prompt 39 caches the content hash, or perform the check once at load time
where the file set is known.

---

## Gap 3: 404 bodies have no `content-type`

`#L219-L221` and `#L380-L382` send a text body with **no `content-type`**, combined with
`nosniff` from the security headers.

The result is a browser that refuses to render the body. Prompt 38 added a 500 body with a
content type; do the same here.

Note prompt 38 also added the `src/pages/500.html` convention. The plain-text 404 path here is
the **fallback** when no `/404` page exists; the page path already works.

---

## Gap 4: request bodies are never drained on a rejected method

Before `res.end("Method Not Allowed")` (`#L164-L169`), the request body is not consumed.

On a keep-alive connection, an undrained body means the **next** request on that socket starts
reading the leftover bytes. That is a request-smuggling shape, and even benignly it produces
confusing parse errors.

**Fix:** drain or destroy the request before responding.

Note that prompt 48 adds API routes, which accept non-GET methods and **will** read bodies. The
method guard will move for those paths. Make this fix in a way that does not conflict; coordinate
by leaving the drain in the rejection path specifically.

---

## Gap 5: static file requests are never logged

**This is the one with the most day-to-day impact.**

`logAccess()` runs in the `finally` block (`#L452-L455`) and returns early
`if (responseStatus === 0)` (`#L142`).

For the static branch, `responseStatus = 200` is assigned inside the **async**
`fileStream.on("open")` callback (`#L268`), which fires **after** the handler has already
returned.

So **every successful static asset request is silently unlogged.** Only the 404 and 500
pre-stream paths log.

The same ordering means:

- SSE connections log 200 **at connect time**, not at close.
- Page responses log **before the body is actually flushed**, so the recorded duration **excludes
  transfer time**.

### Fix

Move logging to fire when the response actually completes. For a streamed response that means the
stream's `finish` or `close`, not the handler's return.

While you are there, consider adding a **request ID** and a structured JSON log option. Both are
cheap and both are the first thing anyone asks for in production. **Do not let that expand the
prompt beyond the correctness fix**; if either grows, defer it and say so.

Prompt 41 excluded the health endpoint from access logs. Confirm that still holds after the
reordering.

---

## TDD steps

Write each failing test first.

1. `%00` in a path returns **400**, not 500.
2. A raw control character in a decoded path returns 400.
3. A symlink inside the output directory pointing outside it is **refused**.
4. The realpath check does not add a syscall per request. Assert by instrumenting.
5. A 404 body carries a `content-type`.
6. A 500 body carries a `content-type`. Prompt 38 should have done this; confirm.
7. A rejected non-GET request with a body drains it before responding.
8. **A successful static asset request is logged**, with a status and a duration.
9. The logged duration **includes transfer time**, not just handler time.
10. An SSE connection logs at close, not at connect.
11. The health endpoint is still excluded from logs.
12. Every guard still fires: traversal, dot-segment, and base prefix, unchanged.

Test 12 matters. This prompt touches the pipeline, and the guards are the part that must not
regress.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  Request `/%00`, `/../../etc/passwd`, and `/.env`, asserting 400, blocked, and 404 respectively.
  Request a static asset and assert it succeeds. If the harness can capture server stdout, assert
  the static request **was logged**; if not, cover logging at the unit level and say so.
- `playwright.dev.config.ts`: the same guard assertions, proving parity. Dev serves static assets
  through the same path.
- `playwright.config.ts` (static build): no new tests. No Bascik process. State that reasoning.

## Documentation

| File                               | Change                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/server.md` | **Source of truth.** The full guard order including prompt 10's and prompt 23's insertions. The realpath check and where its cost is paid. The logging lifecycle |
| `docs/content/server.md`           | Access logging covers static assets; durations include transfer                                                                                                  |
| `docs/content/configuration.md`    | Any new logging option, if you added one                                                                                                                         |
| `docs/content/faq.md`              | "Why are my static asset requests missing from the logs?" Now fixed, but searchable                                                                              |
| `docs/content/compatibility.md`    | **Required by repo policy** only if a scoping capability changed. Almost certainly none here; **confirm rather than assume**                                     |

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after.
- [ ] `%00` and control characters return 400, not 500.
- [ ] A symlink escaping the output directory is refused, without a per-request syscall.
- [ ] 404 and 500 bodies carry a `content-type`.
- [ ] Rejected non-GET requests drain their body.
- [ ] **Successful static requests are logged, with a duration that includes transfer.**
- [ ] SSE logs at close; the health endpoint stays excluded.
- [ ] **Every existing guard still fires**, and the pipeline order is otherwise unchanged.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to dev and both server configs; the user has run `yarn e2e:all`.

## Do not do

- Do not reorder the pipeline. Decode-then-check is correct.
- Do not remove the `resolve` plus `startsWith` backstop when adding realpath. Keep both.
- Do not expand into structured logging if it grows beyond a small addition. Defer and say so.
- Do not change the watcher or TLS. Prompts 44 and 45.
- Do not run Playwright, bind a port, or `curl` in the sandbox.
