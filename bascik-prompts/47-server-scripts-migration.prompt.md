# 47: Migrate server scripts to the registry

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server-scripts.ts`, `pkg/src/lib/server.ts`, `pkg/src/lib/serve.ts`.

**Depends on prompt 46**, which built the registry, and **prompt 27**, which moved server script
source into a sidecar.

---

## The problem being removed

### It is a fork bomb

`server-scripts.ts#L113`:

```ts
const MAX_CONCURRENT_SCRIPTS = Math.max(
  4,
  os.availableParallelism?.() ?? os.cpus().length,
);
```

That cap is applied **inside a single `executeServerScripts()` call** (`#L215-L220`), that is,
**per request**. There is **no process-wide semaphore**.

**100 concurrent requests to one server-script page on an eight-core box spawns up to 800
concurrent `node` processes.** Prompt 40's rate limiter does not constrain this, because its
budget is far above the fatal threshold.

The result is memory exhaustion, PID exhaustion, or an OOM kill.

Prompt 37 was **explicitly told not to add a semaphore here**, because this prompt removes the
problem by construction. There are no forks to bomb.

### It is slow

Per request, per block: `mkdir`, `writeFile`, `spawn`, `unlink`, plus a full regex re-scan of the
page HTML (`server.ts#L404-L424`). Roughly **30 to 80 milliseconds of pure overhead** per block
per request.

---

## What to build

Route `<script data-bascik-server>` execution through prompt 46's registry.

### Input is the sidecar, not the page

Prompt 27 moved server script **source** out of the emitted HTML into
`dist/.bascik/server-scripts.json`, leaving an opaque placeholder in the page.

So the registry's input is **the sidecar**. Load it at boot, register each script by its
placeholder identity, and resolve a placeholder to a loaded module at request time.

In **dev**, where pages are served from memory, the registry must work from the in-memory
representation. **Handle both paths behind one interface**, so there is no second code path to
drift.

### Pre-parse the extraction

`server.ts#L418` re-runs the extraction regex **on every request**. Prompt 36 was told to
pre-parse it at store time. **Confirm that landed**, and cache the placeholder identities
alongside the page rather than re-parsing.

---

## The contract change

This is the part that needs the most care, because it is user-facing.

### Context delivery

Server scripts today receive context through **environment variables on the child process**:
`BASCIK_REQUEST` (`server-scripts.ts#L137`), plus the page context variables.

In-process there is no child, and **`process.env` is process-global**, so concurrent requests
would race. Passing request data through it is not merely inelegant, it is **wrong**.

**Prefer passing context as an explicit argument.**

Decide whether to preserve the `process.env.BASCIK_REQUEST` reading path for compatibility.
Bascik is unreleased, so **breaking it is allowed**. Just be deliberate and **write the migration
down**.

### Output delivery

Today the script's **stdout is injected into the page verbatim** (`#L253`, `#L275-L280`).

In-process, `console.log` writes to the **server's** stdout, not to a per-request buffer. And the
monkey-patching approach used by `build-script-runner.ts#L31` is **not concurrency-safe**
in-process.

**Prefer a return value.** Whatever you choose, document the migration clearly, because this is
the most visible change for anyone with existing server scripts.

### Escaping

Stdout is injected into the page **verbatim** today, so a script echoing `searchParams` is
**reflected XSS**.

**Provide an escaping helper and document it prominently.** This is the same class of issue
prompt 13 fixed for props, and the same answer applies: escape by default, provide a documented
path for deliberate raw HTML.

---

## Errors

- A thrown error must not crash the server and must not affect any other request.
- **A broken module fails only its own block**, not the page and not other scripts.
- The client-visible outcome is governed by `scripts.onServerScriptError`, which prompt 03 split
  out from the combined option.
- Log the real error server-side with the script's identity and a cleaned stack.
- **No source, path, or stack frame in any response**, including on error and on timeout.

---

## Timeout

Pass `scripts.timeout` into the registry, which prompt 46 made a parameter.

On timeout, respond per `onServerScriptError` and log.

**Document honestly that this cannot interrupt synchronous code.** Prompt 46 pinned that with a
test; cross-reference rather than repeating it.

---

## Temporary file hardening

If any path still writes one, fix all three problems in `#L221-L224`:

```ts
const tmpPath = join(
  tempDir,
  `server-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
);
```

- **`Math.random()` is not cryptographically random.** Use `crypto.randomUUID()`.
- **`writeFile` follows symlinks and does not use `flag: 'wx'`.** A local attacker, or a hostile
  dependency's postinstall, who can create `node_modules/.cache/bascik/server-<guess>.mjs` as a
  symlink gets an **arbitrary-file-write primitive at server privilege**.
- **Cleanup is `finally { await unlink(tmpPath).catch(() => {}) }`** (`#L268`). On SIGKILL, OOM,
  or a hard crash, `.mjs` files accumulate with **no startup sweep and no TTL**.

**Ideally the new model needs no temporary files at all.** If so, say so explicitly and delete
the code.

---

## TDD steps

Write each failing test first.

1. **No `node` process is spawned per request.** Assert by instrumenting the spawn path, not by
   inspection.
2. The sidecar is loaded at boot and a placeholder resolves to the right module.
3. The dev in-memory path resolves through the **same interface**.
4. Context reaches the script.
5. **Concurrent invocations with distinct context never cross-contaminate.** Real concurrency,
   not two.
6. Output reaches the page.
7. The escaping helper works; a value containing `<script>` renders as text.
8. A thrown error yields the configured behavior with **no internal detail** in the response.
9. A module with a syntax error fails **only its own block**; other scripts, other pages, and the
   server keep working.
10. A client disconnect is not logged as a server fault.
11. An unhandled rejection inside a script does not crash the process.
12. A hung async script hits `scripts.timeout`.
13. **No source, path, or stack frame appears in any response**, proven with a distinctive marker.
14. Editing a script applies without a restart in dev.
15. No temporary file is created, or the hardening properties hold.

## Testing

**Unit:** all of the above.

**E2E:** this is where the fork-bomb fix is proven.

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  - **Many simultaneous requests** to a server-script page. Assert the process survives, no
    response is corrupt or cross-contaminated, and **the process count does not spike**.
  - **Per-request isolation end to end:** two concurrent requests with different query parameters
    each receive their own value. That is the test that justifies the whole model change.
  - A script that throws produces the configured response and does **not** affect a concurrent
    request to a different page.
  - The escaping helper: a request whose query parameter contains `<script>alert(1)</script>`
    renders as text with no dialog.
- `playwright.dev.config.ts`: the same isolation check, plus editing a script applies without a
  restart.
- `playwright.config.ts` (static build): server scripts do not execute. Assert the page renders
  with the region empty and **no console error**, confirming prompt 27's inert placeholder still
  holds.

Coordinate with prompts 37, 40, and 41, which also need load generation. **Share one helper.**

**Measure and record the latency improvement** against the old model for the pull request.

## Documentation

| File                                                 | Change                                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/server.md`                             | The new execution model. What a script receives and returns. **The migration note if the contract changed.** Timeouts and the `AbortSignal`. **The event-loop caveat, stated plainly.** The escaping helper with an example |
| `docs/content/internals/server.md`                   | How the registry is wired, the sidecar load at boot, and the dev in-memory path                                                                                                                                             |
| `docs/content/configuration.md`                      | `scripts.onServerScriptError` and `scripts.timeout` govern this path                                                                                                                                                        |
| `docs/content/testing/server-scripts.md`             | **How to test a server script directly, without starting a server.** This gets much easier under the new model; give it real estate                                                                                         |
| `docs/content/faq.md`                                | "Can a server script slow down other requests?" with an honest yes and the reason                                                                                                                                           |
| `docs/content/compatibility.md`                      | **Required by repo policy** if authoring-visible behavior changed. It did                                                                                                                                                   |
| `docs/src/pages/assets/SKILL.md`                     | The new contract, the escaping helper, the in-process gotcha. Sync `create/assets/SKILL.md`                                                                                                                                 |
| `.github/skills/bascik-server-architecture/SKILL.md` | **Replace the child-process description entirely**                                                                                                                                                                          |

## Acceptance criteria

- [ ] All fifteen tests failed before their fixes and pass after.
- [ ] **No `node` process is spawned per request**, proven by instrumentation.
- [ ] The sidecar and the dev in-memory path share one interface.
- [ ] **Concurrent requests never cross-contaminate**, proven by E2E with real concurrency.
- [ ] A broken script fails only its own block.
- [ ] **No source, path, or stack frame reaches a client**, proven with a marker.
- [ ] An escaping helper exists, is documented, and is tested against a reflected-XSS payload.
- [ ] `scripts.timeout` and `scripts.onServerScriptError` govern behavior.
- [ ] Editing a script applies without a restart in dev.
- [ ] No temporary files, or they are hardened.
- [ ] The contract change is documented with a migration note.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to **all four** configs; the user has run `yarn e2e:all`.
- [ ] Latency improvement measured and recorded.
- [ ] The server architecture skill file no longer describes child processes.

## Do not do

- Do not keep the child-process model as an option. **One model.**
- Do not add a request queue or a semaphore.
- Do not pass request data through `process.env`.
- Do not implement API routes. **Prompt 48.**
- Do not claim protection against synchronous infinite loops.
- Do not run Playwright, bind a port, or `curl` in the sandbox.
