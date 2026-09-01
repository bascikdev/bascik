# 36: Regex reuse and server boot

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/javascript.ts`, `pkg/src/lib/serve.ts`, `pkg/src/lib/mem.ts`.

Two unrelated performance items, grouped because each is small. Both must be **byte-neutral** for
the transpiler half; the boot half changes only allocation and concurrency.

---

## Part 1: `attributesToReplace` is never deduplicated

`javascript.ts#L339` pushes one entry per **occurrence**, not per unique class.

A class used on 50 elements produces **50 identical entries**.

The script-rewrite loop (`#L470-L600`) then iterates all of them **per `<script>` block**,
compiling roughly **eight fresh `RegExp` objects** and running several full-string `.replace()`
passes each time.

Only the JavaScript-only discovery path uses a `knownClasses` Set. Output is idempotent, so this
is pure cost, but it is a large multiplier.

### Fixes

**Deduplicate with a Set** before the rewrite loop. This alone may be sufficient; measure before
going further.

**Cache the compiled regexes** keyed by the token, so the same class in two components compiles
once. **Bound the cache** so a pathological input cannot grow it without limit.

**Consider combining passes.** The eight separate passes over the script text might collapse into
fewer. **Measure before restructuring**; the dedup alone may make this irrelevant, and combining
passes is where a byte-neutral refactor is most likely to stop being byte-neutral.

### Precondition

Prompt 14 normalized class tokens, which eliminated the empty-string token that previously
produced a catastrophic regex here.

**Confirm that fix is in place before optimizing.** An empty token in a cache key is worse than
an empty token in a list. If prompt 14 has not landed, stop.

---

## Part 2: server boot allocation and concurrency

`serve.ts#L67-L88` loads **all** of the output directory with an **unbounded `Promise.all`**:

| Problem               | Effect                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unbounded concurrency | **EMFILE risk** on a large site, since every file open is issued at once                                                                                                 |
| Buffer round trip     | `readFile(absPath).toString()` then `Buffer.from(pageContent, "utf8")` in `mem.ts#L40` does Buffer to String to Buffer, roughly **tripling peak allocation** during boot |
| No progress output    | Boot is slow and memory-spiky with nothing but a single summary line                                                                                                     |

### Fixes

**Bound the concurrency.** Pick a limit tied to something real, such as available parallelism,
rather than a magic number, and say why.

**Keep the data as a `Buffer` end to end.** The string round trip exists for no reason; the
content is written back to a Buffer immediately.

**Emit progress for large sites.** Only above a threshold, so a small site still boots with one
line.

### Also: pre-parse server-script extraction

`htmlHasServerScripts` (`mem.ts#L71`) runs a regex over every page **at store time**, which is
fine. But the **actual extraction regex re-runs on every request** in the server-script path
(`server.ts#L418`) rather than being pre-parsed at store time.

Pre-parse it. Store the parsed positions or the placeholder identities alongside the page.

**Coordinate with prompts 27 and 47.** Prompt 27 replaced embedded source with a placeholder and
a sidecar; prompt 47 replaces the execution model. Check what has landed and cache the right
representation. If prompt 47 has landed, its registry may already do this; do not duplicate.

---

## What is already correct: do not change

- The **brotli callback guard** in `mem.ts#L118`, `if (current && current.content === buffer)`,
  correctly prevents a stale compression result from attaching to a newer page.
- **`#openPages` refcounting** (`mem.ts#L184-L196`) is correct and balanced against the SSE close
  handler.
- **`getPage()` falling back to `/404`** (`mem.ts#L124`) is correct.

---

## The memory ceiling: measure, do not necessarily fix

`mem.ts` retains, per page, **forever**: the `content` Buffer, the `compressedContent` Buffer,
the `usedComponentsSet`, and the `fileDependenciesSet`. **No eviction, no LRU, no bound.**

1000 pages at 80 KB of HTML is roughly 80 MB raw plus 25 MB compressed, plus V8 overhead. At
5000 pages this is a real constraint on a small container, and there is no fallback to disk
streaming.

**For this prompt: measure and document.** Add a test that reports retained size for a synthetic
1000-page site so the number is **visible**, and document the ceiling in
`docs/content/internals/server.md`.

If a bounded cache with disk fallback is cheap, add it behind a config option. If it is not,
**record it as a known limit with the measured numbers**. Do not let this expand the prompt.

---

## TDD steps

Write each failing test first.

1. A class used on 50 elements produces **one** entry in `attributesToReplace`.
2. `RegExp` construction per script block is proportional to **unique** classes, not occurrences.
   Instrument and assert.
3. The compiled-regex cache is **bounded**.
4. The byte-identical harness from prompt 34 passes for the transpiler changes.
5. Boot concurrency is bounded. Assert the maximum simultaneous open count, not just completion.
6. No Buffer to String to Buffer round trip. Assert by spying, or by measuring peak allocation on
   a synthetic large output directory.
7. Progress output appears above the threshold and not below it.
8. Server-script extraction is pre-parsed at store time and not re-run per request. Assert the
   regex is not invoked during a request.
9. The retained-size measurement runs and reports a number.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): no new tests for part 1, since it is byte-neutral. The
  existing suite is the regression check. State that reasoning.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: boot the server against a
  fixture with a larger-than-usual page count and assert it starts successfully and serves.
  **This is the EMFILE check**; if the fixture is not large enough to be meaningful, say so and
  cover it at the unit level with a mocked filesystem.
- `playwright.dev.config.ts`: no new tests. State that reasoning.

## Documentation

| File                                       | Change                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/server.md`         | Bounded boot concurrency. **The memory ceiling with measured numbers.** Server-script extraction is pre-parsed |
| `docs/content/deploying.md`                | The memory ceiling, so someone sizing a container has the number                                               |
| `docs/content/internals/scoping-system.md` | Compiled regexes are cached per token                                                                          |
| `docs/content/performance.md`              | Only if numbers materially improved. Use recorded measurements                                                 |

No SKILL.md change expected. Say so explicitly if none is needed.

## Acceptance criteria

- [ ] All nine tests failed before their fixes and pass after.
- [ ] `attributesToReplace` is deduplicated; regex construction scales with unique classes.
- [ ] The compiled-regex cache is bounded.
- [ ] **The byte-identical harness passes and `docs/dist` is unchanged.**
- [ ] Boot concurrency is bounded, with the limit justified rather than magic.
- [ ] No Buffer round trip during boot.
- [ ] Progress output appears only above a threshold.
- [ ] Server-script extraction is pre-parsed, coordinated with whatever prompts 27 and 47 landed.
- [ ] The memory ceiling is **measured and documented with real numbers**.
- [ ] Prompt 14's class-token fix was confirmed present before optimizing.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The user has run `yarn e2e:all`.

## Do not do

- Do not change transpiler output.
- Do not optimize before confirming prompt 14 landed.
- Do not combine the eight rewrite passes without measuring first.
- Do not restructure `mem.ts`'s refcounting or brotli guard.
- Do not add page eviction unless it is cheap. Measure and document instead.
- Do not run Playwright or pre-push scripts.
