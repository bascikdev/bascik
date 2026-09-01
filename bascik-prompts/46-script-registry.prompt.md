# 46: In-process script registry

Read `.github/prompts/00-README.md` first.

**Scope:** a new registry module in `pkg/src/lib/`. This prompt builds the runtime **only**;
prompt 47 migrates server scripts onto it and prompt 48 builds API routes on it.

**Decision, do not re-litigate:** server scripts and API routes share **one** in-process
execution model.

---

## Why a registry, and why in-process

`pkg/src/lib/server-scripts.ts` executes every `<script data-bascik-server>` block by writing a
temporary `.mjs` file and running `execFile(process.execPath, [path])`: **a fresh Node process per
script block per request.**

Per request, per block: `mkdir`, `writeFile`, `spawn`, `unlink`, plus a full regex re-scan of the
page HTML. Roughly **30 to 80 milliseconds of pure overhead**, with no caching and no module
reuse.

Prompt 47 documents the fork-bomb consequence. This prompt builds the replacement.

### Rejected alternatives, do not implement

**A child process per request.** That is the current model. Interpreter startup plus temporary
file I/O per request is not competitive with what people are migrating from, and speed is the
premise of Bascik.

**A `worker_threads` pool.** Better fault isolation, but it costs structured-clone serialization
on every request **and body**, adds a pool lifecycle to maintain, and complicates streaming
responses. The mitigations below address the realistic failure modes at far lower complexity.
Revisit only if in-process proves insufficient in practice.

---

## What to build

A module registry: **dynamic `import()`, cached by resolved file path.**

| Mode                    | Behavior                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Production (`--server`) | Load once at boot, or on first request. **Never re-read per request.**                                                        |
| Development             | **Invalidate on file change** so edits apply without a restart, matching the existing watch behavior for pages and components |

Node 24 strips TypeScript types natively, so `.ts` files run directly with **no transpile step**.

---

## The contract

Define this precisely. Prompts 47 and 48 both build on it, and a vague contract here becomes two
divergent implementations there.

### Loading

- Key by **resolved** file path, so two specifiers pointing at one file share an instance.
- A module that **throws on load** is contained: it fails its own entry and does not poison the
  registry for others.
- A module that throws on load must be **retryable** after the file changes, not permanently
  poisoned.

### Invocation

- The caller passes a **context object**; the registry does not invent one. Prompts 47 and 48
  pass different shapes.
- **Per-request state must not leak between concurrent invocations.** See the isolation section
  below; this is the single most important correctness property.

### Errors

- A thrown error must **not crash the server** and must **not affect any other request**.
- Log the real error to stderr with the module's identity, reusing `cleanStackTrace` from
  `pkg/src/lib/stack-trace.ts`.
- The **caller** decides what the client sees. The registry surfaces a structured failure; it
  does not format an HTTP response.
- **Client disconnects are not errors.** Reuse `isNetworkResetError`, which prompt 37 extended.

### Timeout and cancellation

- Route the timeout through `scripts.timeout` from prompt 03. Prompt 48 adds a separate
  `http.apiTimeout`; the registry takes a timeout **parameter** rather than reading config
  directly, so both callers can pass their own.
- Provide an **`AbortSignal`** so a well-behaved module can abort its own downstream work.
- **Document honestly that an in-process timeout cannot forcibly stop synchronous code.** A
  `while(true)` loop blocks the event loop regardless of any timeout. Say so rather than implying
  protection you cannot provide, and **pin it with a test**.

### Concurrency

**Do not add a queue.** Node handles concurrency natively for async handlers, and the fork bomb
disappears because there are no forks.

---

## Isolation: the critical risk

With a child process per request, per-request state was isolated **for free**. In-process it is
not.

**Enumerate every piece of per-request state and prove it cannot leak between concurrent
requests.** At minimum:

- The context object passed in.
- Anything the module reads from `process.env`. Note that the current model passes request data
  **through environment variables** (`server-scripts.ts#L137` sets `BASCIK_REQUEST`), and
  `process.env` is **process-global**. Concurrent requests would race. **Prefer passing context
  as an explicit argument.** Prompt 47 owns the migration decision; the registry must make the
  correct approach possible.
- Anything the module writes to a module-level variable. This one you **cannot** prevent, and
  should document as an author responsibility.
- Captured output, if the caller wants any. `console.log` writes to the server's stdout, and the
  monkey-patching approach used by `build-script-runner.ts#L31` is **not concurrency-safe
  in-process**. Prefer a return value.

**Write the concurrency test that proves isolation before you write the registry.** Many
concurrent invocations with distinct context, each asserting it sees only its own.

---

## Dev invalidation

- Editing, adding, and deleting a module all apply without a restart.
- **ES module caches are keyed by URL**, so a plain re-`import()` of the same path returns the
  cached module. Use a cache-busting query parameter or another documented technique.
- **Note the tradeoff:** old module instances are not garbage collected. Bound it if the leak is
  material in a long dev session, or document it if not.
- A module that fails to load leaves the previous working version in place, **or** fails only its
  own entry. Pick one, document it, and make sure the dev server survives either way.

---

## Security

| Item                  | Requirement                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment access    | Modules run in-process with full `process.env`. Decide and document whether that stays. It is correct and expected for a Node server, but it must be documented alongside the fact that module source never reaches a client      |
| Event-loop starvation | **Document it.** An infinite loop blocks every other request. This is the standard trade every Node framework makes, and authors deserve to know rather than discover it                                                          |
| Process crash         | A native crash takes the process down. Prompt 37 documented that a supervisor is expected; cross-link rather than repeating                                                                                                       |
| Temporary files       | If any path still writes one, use `crypto.randomUUID()` rather than `Date.now()` plus `Math.random()`, open with `flag: 'wx'` so it cannot follow a symlink, and sweep orphans at startup. Ideally the registry needs none at all |

---

## TDD steps

Write each failing test first.

1. Loading by resolved path returns the **same** module instance twice.
2. Two specifiers resolving to one file share an instance.
3. A module that throws on load is contained and does not poison other entries.
4. After the file changes, a previously-failing module can load successfully.
5. **Many concurrent invocations with distinct context each see only their own.** Run enough
   concurrency to be meaningful, not two.
6. A thrown error surfaces as a structured failure without crashing, and the caller decides the
   response.
7. The real error is logged with the module identity and a cleaned stack.
8. A client disconnect is **not** logged as a server fault.
9. An unhandled rejection inside a module does not crash the process.
10. A hung **async** module hits the timeout and the `AbortSignal` fires.
11. **A synchronous infinite loop is NOT interrupted**, pinning the documented limitation.
12. Dev invalidation: edit, add, and delete all apply without a restart.
13. No temporary file is created, **or** the hardening properties hold.

## Testing

**Unit:** all of the above. The registry is a pure module system with no HTTP involvement, so
almost everything belongs here.

**E2E:** **none in this prompt.** Nothing consumes the registry yet.

State that reasoning explicitly. Prompts 47 and 48 add the E2E coverage across all four configs
once there is something to exercise.

## Documentation

| File                                | Change                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/server.md`  | The module registry: caching, invalidation, timeout, cancellation, and **the recorded rationale for in-process over a child process or a worker pool**, including the rejected alternatives so nobody reopens the question |
| `docs/content/internals/testing.md` | If the registry needs a test helper, document it. Repo policy says to update this page when test _patterns_ change                                                                                                         |

No user-facing docs yet. Prompts 47 and 48 own those. **Say so explicitly** rather than making a
token edit.

## Acceptance criteria

- [ ] All thirteen tests failed before their fixes and pass after.
- [ ] Modules are cached by resolved path; production loads once; dev invalidates on change.
- [ ] A broken module is contained and retryable.
- [ ] **Concurrent invocations with distinct context never see each other's state**, proven with
      real concurrency.
- [ ] Errors surface as structured failures; the caller decides the response.
- [ ] Client disconnects are not logged as faults; unhandled rejections do not crash.
- [ ] The timeout takes a **parameter**, so prompts 47 and 48 can pass different values.
- [ ] `AbortSignal` fires on timeout.
- [ ] **A test pins that synchronous code is not interruptible**, matching the documentation.
- [ ] No temporary files, or they are hardened.
- [ ] The environment-access decision is made and documented.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The contract is documented precisely enough that prompts 47 and 48 build on it without
      re-deriving anything.

## Do not do

- Do not build a `worker_threads` pool.
- Do not add a request queue.
- Do not migrate server scripts. **Prompt 47.**
- Do not implement API routes. **Prompt 48.**
- Do not claim protection against synchronous infinite loops.
- Do not read config directly for the timeout. Take a parameter.
- Do not run Playwright or pre-push scripts.
