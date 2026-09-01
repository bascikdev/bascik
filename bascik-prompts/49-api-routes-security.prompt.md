# 49: API routes, security

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/api-runtime.ts`, `pkg/src/lib/server.ts`, `http.ts`, `http2.ts`,
`file-system.ts`, `check.ts`. Implements `http.maxBodySize` and `http.apiTimeout`, which prompt 03
declared without behavior.

**Depends on prompt 48**, which built routing and dispatch.

**Every item here is mandatory and needs a test. This section is the feature**, not polish on top
of it. Prompt 48 made Bascik an application server; this prompt makes it a safe one.

---

## Part 1: the request body

Today `adaptHttp1` and `adaptHttp2` build `BascikRequest` from **headers only**. The
`IncomingMessage` and `ServerHttp2Stream` readable side is **discarded**. So exposing a body
requires changing both adapters.

| Requirement                                | Detail                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expose the body as a stream**            | Convert the Node readable with `Readable.toWeb()` and construct the `Request` with **`duplex: 'half'`**, which Node requires for a streaming body                                                                   |
| **Enforce a maximum size**                 | `http.maxBodySize`, default `1048576` (1 MB). **Count bytes as they stream** and abort past the limit. **Never buffer an unbounded body to measure it**, which is the denial-of-service the limit exists to prevent |
| **Reject oversized bodies correctly**      | Respond **413**, destroy the stream, and **do not invoke the handler**                                                                                                                                              |
| **Trust `content-length` for nothing**     | It is a hint from the client. Enforce on **actual bytes read**. A mismatched or absent `content-length` must not bypass the limit                                                                                   |
| **Do not parse anything automatically**    | The handler calls `request.json()`, `.text()`, `.formData()`, or `.arrayBuffer()` itself. No content-type sniffing, no magic parsing                                                                                |
| **A malformed body is the author's error** | `await request.json()` on invalid JSON throws **inside** the handler. An uncaught throw becomes a 500 per part 3                                                                                                    |

Coordinate with prompt 43, which added body draining on rejected methods. API paths **do** read
bodies, so the drain must not consume them first.

---

## Part 2: timeouts and limits

| Requirement                  | Detail                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-request timeout**      | `http.apiTimeout`, default `10000` ms. **Shorter than `scripts.timeout`** because APIs should be fast and a hung handler holds a connection        |
| **Cooperative cancellation** | Pass an `AbortSignal` on the `Request` so well-behaved handlers abort their own downstream work. Reuse prompt 46's mechanism                       |
| **Hard timeout**             | If the handler has not resolved when the timeout elapses, respond **504** and log                                                                  |
| **The honest caveat**        | As in prompts 46 and 47, this **cannot interrupt synchronous code**. Document it and **pin it with a test**                                        |
| **Rate limiting**            | Prompt 40's limiter runs **before** routing, so it covers API routes. **Add a test proving it.** Consider whether API routes want their own budget |
| **Concurrency**              | Node handles it natively. **Do not add a queue**                                                                                                   |

---

## Part 3: errors and information disclosure

| Requirement                           | Detail                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Never leak internals**              | A thrown handler error produces **500 with a generic body**. No stack trace, no message, no file path in the response                                                                        |
| **Log fully server-side**             | The real error to stderr with the route path, reusing `cleanStackTrace` from `pkg/src/lib/stack-trace.ts`                                                                                    |
| **Never crash the server**            | Wrap every invocation. An unhandled rejection in a handler must not take down the process. Prompt 37 added a process-level net; **this is defense in depth, not a substitute**               |
| **Client disconnects are not errors** | Reuse `isNetworkResetError`, which prompt 37 extended                                                                                                                                        |
| **A broken module is contained**      | A route file with a syntax error fails **that route** with 500 and a clear server-side log. Other routes and all pages keep working. Prompt 46's registry provides this; **verify it holds** |

---

## Part 4: handler source must never reach the client

Same class of bug as server script source leaking into static builds, which prompt 27 solved with
a sidecar.

- `src/api/` is **outside** `directory.pages`, so `copyStaticAssets()` should not reach it.
  **Prompt 10 replaced the deny-list with a shared, corrected predicate.** **Verify against that
  implementation with an explicit test** rather than assuming.
- `bascik --build` must never emit handler source into `directory.out`.
- Assert that **no `.ts` file under `directory.api` appears anywhere** in the output, and that
  **no source substring appears in any emitted HTML**. Use a distinctive marker string in the
  fixture so the assertion cannot pass by accident.

---

## Part 5: headers and transport

| Requirement                      | Detail                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security headers still apply** | Prompt 45's set applies first, then handler headers override                                                                                    |
| **No CORS by default**           | Same-origin only. **Adding permissive defaults would be an opinion with security consequences**                                                 |
| **Path traversal**               | The existing guard runs before routing and must keep applying. **Add a test with encoded traversal (`%2e%2e%2f`)** since decoding happens first |
| **Dot-segment guard**            | Prompt 10 added it. A route file must not be reachable through a dot path                                                                       |
| **Null bytes**                   | Prompt 43 made `%00` a 400. Confirm that holds before routing                                                                                   |
| **Header injection**             | **Reject or strip CR and LF in handler-supplied header values.** The `Headers` class largely enforces this; **add a test to prove it**          |
| **HTTP/2 parity**                | Every behavior must hold **identically** on HTTP/1.1 and HTTP/2. Pseudo-headers must not leak into the `Request`                                |

---

## Part 6: secrets

Handlers run in-process with **full `process.env` access**. That is correct and expected for a
Node server, but it **must be documented alongside part 4**, because the combination of "handlers
can read secrets" and "handler source is never served" is what keeps them safe.

Prompt 47 made the same decision for server scripts. **Be consistent and cross-link.**

---

## Part 7: `bascik --check`

Extend the static analysis in `pkg/src/lib/check.ts`:

- **error**: a file under `directory.api` that exports **no** recognized method handler.
- **error**: two route files resolving to the **same URL**.
- **warning**: an exported name that looks like a method but is not recognized, for example
  `Post` or `get`.

**Prompt 50 restructures `--check` output into sections.** If it has landed, add these in the new
sectioned format. If not, add them in the current format and **note them for prompt 51 to fold
in**.

---

## TDD steps

Write each failing test first.

1. A body under the limit succeeds and is readable via `.json()`, `.text()`, and `.formData()`.
2. `duplex: 'half'` is set; a GET with no body constructs cleanly.
3. **Over the limit responds 413 and the handler is never invoked.**
4. **A lying `content-length`**, a small header with a large body, is still caught on actual bytes.
5. **An absent `content-length` with a large chunked body** is caught.
6. The stream is **destroyed**, not drained.
7. A hung handler hits `apiTimeout`, responds **504**, and the `AbortSignal` fires.
8. **A synchronous infinite loop is not interrupted**, pinning the documented limitation.
9. Rate limiting applies to API routes.
10. A thrown error yields **500 with no stack, message, or path** in the body, proven with a marker.
11. The full error is logged server-side with the route path.
12. A route file with a syntax error fails **only that route**.
13. A client disconnect mid-handler is not logged as a server fault.
14. An unhandled rejection does not crash the process.
15. **No `.ts` file under `directory.api` appears in the output**, and no source substring appears
    in any emitted HTML.
16. `copyStaticAssets()` never reads the api directory.
17. Encoded path traversal (`%2e%2e%2f`) is blocked.
18. A dot-path attempt at a route file is blocked.
19. `%00` still returns 400 before routing.
20. CR and LF in a handler-supplied header value are rejected or stripped.
21. HTTP/2 pseudo-headers do not leak into the `Request`.
22. The three `--check` validations, including exit code 1 on error.

## Testing

**Unit:** all of the above that can be tested without a live server.

**E2E:** run against **all four** configs.

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  - **413 on an oversized body**, and the handler provably did not run, by asserting a side
    effect the handler would have produced.
  - **504 on a hung handler.**
  - A thrown error returns 500 with the marker string **absent** from the body.
  - Encoded traversal and dot-path attempts are blocked.
  - **Identical behavior on both protocols.** Run the same assertions in both and compare.
  - Concurrent requests to a failing route do not affect a concurrent request to a working one,
    coordinating with prompt 47's load helper.
- `playwright.dev.config.ts`: the body limit, the timeout, and the error containment, proving
  parity.
- `playwright.config.ts` (static build): **assert no handler source appears anywhere in the
  output**, using the marker. This is the part-4 proof.

## Documentation

| File                             | Change                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/api-routes.md`     | Extend prompt 48's page: body handling with the size limit and how to change it; errors, timeouts, and **what the client sees versus what gets logged**; **security notes**: no CORS by default, secrets via `process.env`, handler source is never served |
| `docs/content/configuration.md`  | `http.maxBodySize` and `http.apiTimeout`                                                                                                                                                                                                                   |
| `docs/content/cli.md`            | The new `--check` validations                                                                                                                                                                                                                              |
| `docs/content/compatibility.md`  | **Required by repo policy.** Body limits, streaming, the no-CORS default, and header injection handling                                                                                                                                                    |
| `docs/content/deploying.md`      | Handler source never ships; secrets in `process.env` are safe for that reason                                                                                                                                                                              |
| `docs/content/faq.md`            | "How big a request body can an API route accept?" and "Why did my API route return 504?"                                                                                                                                                                   |
| `docs/src/pages/assets/SKILL.md` | Body limit, timeout, no CORS, source never served. Gotchas explicit. Sync `create/assets/SKILL.md`                                                                                                                                                         |

## VS Code extension

Add an **info** diagnostic: `request.json()` called without a surrounding try/catch, noting it
throws on malformed input. Add a test.

## Acceptance criteria

- [ ] All twenty-two tests failed before their fixes and pass after.
- [ ] **Body size is enforced on bytes read, not `content-length`**; oversize yields 413 **without
      invoking the handler**.
- [ ] The stream is destroyed rather than drained; no unbounded buffering occurs.
- [ ] `apiTimeout` yields 504 and fires the `AbortSignal`; the synchronous limitation is pinned.
- [ ] Rate limiting applies to API routes.
- [ ] **Thrown errors yield 500 with zero internal detail**, proven with a marker, and are logged
      in full server-side.
- [ ] A broken route file does not affect other routes or pages.
- [ ] **No handler source appears in the output or in any emitted HTML.**
- [ ] Encoded traversal, dot-paths, and null bytes are all blocked before routing.
- [ ] CR and LF header injection is rejected.
- [ ] **Behavior is identical on HTTP/1.1 and HTTP/2**, proven by running the same assertions in
      both.
- [ ] No unhandled rejection can crash the server.
- [ ] The three `--check` validations exist and exit 1 on error.
- [ ] **No CORS headers are added by default.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.
- [ ] `compatibility.md` updated; both SKILL.md copies in sync.

## Do not do

- Do not buffer a body to measure it.
- Do not trust `content-length`.
- Do not parse bodies automatically.
- Do not add CORS headers, middleware, or validation. Prompt 48's non-goals still apply.
- Do not compress API responses.
- Do not claim protection against synchronous infinite loops.
- Do not run Playwright, bind a port, or `curl` in the sandbox.
