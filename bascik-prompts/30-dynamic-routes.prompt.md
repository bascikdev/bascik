# 30: Dynamic route fixes

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/routes.ts`, `pkg/src/lib/processing.ts`, `pkg/src/lib/build-scripts.ts`.

---

## What is already correct: do not change it

`parseRouteList` (`routes.ts#L139-L245`) is solid. It rejects non-arrays, missing or non-object
`params`, missing param names, non-string and non-number values, empty strings, `..`, `/`, `\`,
and `[<>:"|?*\x00-\x1F]`. Malformed JSON produces a truncated 200-character preview. Warnings
are per-item and skipping; errors are per-script and honor the error mode.

**Leave that alone.** The gaps are elsewhere.

---

## Bug 1: no cross-template or static-versus-dynamic collision detection

`dedupeRoutes` (`#L247-L282`) only dedupes **within one template's own route list**.

Not detected:

- `src/pages/blog/hello.html` (static) plus `src/pages/blog/[slug].html` yielding
  `slug: "hello"`. **Both write the same output file.**
- `src/pages/[slug].html` and `src/pages/[id].html` in the same directory producing overlapping
  values.
- A route param of `"index"` colliding with a real `index.html`.

All jobs are written via `Promise.all` in `processPageBatch` (`processing.ts#L565-L630`), so the
winner is **nondeterministic** and no warning is emitted. That directly undermines prompt 24's
determinism work.

**Fix: error**, consistent with prompt 25's decision that duplicate component names error. Name
both sources: the template and the conflicting static page, or the two templates and the param
value that collided.

---

## Bug 2: route params are not URL-safe

`resolveRoutePath` (`#L85-L95`) substitutes the raw value into the filename.

`INVALID_PARAM_CHARS_RE` permits **spaces, `#`, `%`, `&`, `'`, `+`, and leading dots**.

Consequences:

- A param of `"a#b"` produces `dist/blog/a#b.html`, which is **unreachable over HTTP on any
  static host** because `#` is a fragment delimiter.
- A leading dot produces a hidden file, which prompt 10's dot-segment guard now 404s.
- Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, `LPT1`
  through `LPT9`) are not blocked and cannot be created on Windows.
- The sitemap encodes correctly, so **the sitemap URL and the actually-served URL diverge.**

**Fix:** define **one** slugification or encoding rule. Apply it to the filename **and** the
sitemap entry. Prove they agree with a round-trip test: take a param value, produce the
filename, produce the sitemap URL, request that URL, and land on that file.

Decide whether to slugify silently or reject. Rejecting with a clear message is more honest,
because silent slugification can collapse two distinct params into one route, which reintroduces
bug 1. If you slugify, you must detect the resulting collision.

---

## Bug 3: unbounded concurrent route-script processes

`processAllPages` does:

```ts
const jobBatches = await Promise.all(pageList.map(expandPageToJobs));
```

(`processing.ts#L683`)

`expandPageToJobs` calls `executeRoutesScript`, which calls `runModule` (`routes.ts#L44-L69`).
Unlike the build-script runner, **it has no semaphore**. A site with 40 dynamic templates spawns
**40 simultaneous Node processes**.

`routes.ts`'s `runModule` is a verbatim copy of the one in `build-scripts.ts#L81` **minus** the
concurrency control, **minus** the ANSI stripping, and **minus** `maxBuffer` handling.

**Fix:** deduplicate into one shared implementation with all three features.

---

## Bug 4: `stripAnsiEscapeCodes` is defined and never called

`routes.ts#L39`. Meanwhile **three other copies exist** in `build-scripts.ts#L148` and
`server-scripts.ts#L81`.

A routes script run under CI that forces color emits ANSI into stdout, which then fails
`JSON.parse` with a message whose 200-character preview shows escape codes.

`FORCE_COLOR=0` and `NO_COLOR=1` are set for children, which mitigates but does not cover a
script that hardcodes escapes.

**Fix:** one implementation, wired into the shared `runModule` from bug 3.

---

## Bug 5: routes scripts are never cached

`routes-io.test.ts#L107` **explicitly asserts** no cache read or write.

On a large site this is the dominant build cost, paid in full on every run **including every dev
restart**.

**Fix:** bring routes scripts under the same `scripts.cache` policy as build scripts. Prompt 31
owns the cache implementation; coordinate so both use one mechanism.

**Document the invalidation limits honestly**, the same way prompt 31 must. A routes script that
fetches from a network API will cache forever, which is exactly the case where a site silently
stops updating.

---

## Bug 6: zero routes is an info message

`routes.ts#L293` logs at info level when a template produces no routes.

So a routes script that silently returns `[]` because of an upstream API failure produces a
**quietly smaller site**. That is a deploy-a-broken-site failure mode.

**Fix:** make it a warning. Consider whether it should be an error under `--check --strict`;
prompt 51 can decide.

---

## TDD steps

Write each failing test first.

1. A static page and a dynamic route resolving to the same output path **error**, naming both.
2. Two templates producing an overlapping param value error, naming both and the value.
3. A param of `"index"` colliding with a real `index.html` errors.
4. A param containing `#` produces a **reachable** URL, and the sitemap entry matches. Round-trip
   test.
5. A param with a leading dot is handled per the chosen rule and does not produce a file the
   dot-segment guard would 404.
6. Windows reserved device names are handled.
7. If slugifying, two distinct params that slugify to the same value **error**.
8. Route scripts run under a semaphore; 40 templates do not spawn 40 concurrent processes.
   Assert the concurrency bound, not just that it completes.
9. ANSI escapes in routes-script stdout are stripped before `JSON.parse`.
10. `runModule` exists **once**; `routes.ts` imports it rather than defining its own.
11. Route scripts honor `scripts.cache`, including a per-path exclusion.
12. A template producing zero routes **warns**.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): a fixture with a dynamic template producing several
  routes, including one with a character that needed encoding. Assert every generated page is
  reachable at the URL the sitemap advertises. **That is the bug-2 proof.**
- `playwright.dev.config.ts`: the same routes resolve in dev, proving parity. Editing the routes
  script regenerates them.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: the generated pages are
  served correctly, including the encoded one.

Add a **negative** build test: a fixture with a deliberate static-versus-dynamic collision fails
the build with the expected message. If the harness cannot assert a build failure, cover it at
the unit level and say so.

## Documentation

| File                             | Change                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/dynamic-routes.md` | Collision errors and how to resolve them. The param safety rule, with examples of what is accepted and what is rejected or slugified. Route scripts are cached, **with the invalidation limits stated loudly**. Zero routes now warns |
| `docs/content/sitemap.md`        | Generated route URLs match the served URLs                                                                                                                                                                                            |
| `docs/content/configuration.md`  | `scripts.cache` applies to route scripts too                                                                                                                                                                                          |
| `docs/content/faq.md`            | "Why did my dynamic route 404?" and "Why is my route script not re-running?"                                                                                                                                                          |
| `docs/content/compatibility.md`  | **Required by repo policy.** Which characters are valid in a route param                                                                                                                                                              |
| `docs/src/pages/assets/SKILL.md` | Route params must be URL-safe; collisions error; network-fetching route scripts should be cache-excluded. Sync `create/assets/SKILL.md`                                                                                               |

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after.
- [ ] Static-versus-dynamic and cross-template collisions **error**, naming every source.
- [ ] **Route params produce reachable URLs and the sitemap agrees, proven by a round-trip.**
- [ ] Windows reserved names and leading dots are handled.
- [ ] Slugification collisions, if slugifying, are detected.
- [ ] **One** `runModule`, with semaphore, ANSI stripping, and `maxBuffer`.
- [ ] `stripAnsiEscapeCodes` exists once and is actually called.
- [ ] Route scripts honor `scripts.cache` with the limits documented.
- [ ] Zero routes warns.
- [ ] Two builds produce identical route output, preserving prompt 24's determinism.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.

## Do not do

- Do not change `parseRouteList`'s validation. It is correct.
- Do not build a separate cache for route scripts. Share prompt 31's.
- Do not downgrade collisions to warnings.
- Do not run Playwright or pre-push scripts.
