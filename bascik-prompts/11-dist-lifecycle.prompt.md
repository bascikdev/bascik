# 11: Output directory lifecycle and dev page writes

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/transpile.ts`, `pkg/src/lib/processing.ts`, `pkg/src/lib/watch.ts`,
`pkg/src/lib/serve.ts`.

Two related changes: clean the output directory on every run, and restore the dev-mode page
writes that regressed.

---

## Part 1: clean the output directory

`directory.out` is **never cleaned**. There is no `rm` of it anywhere in the package. The build
path is simply:

```ts
if (BascikConfig.isBuild) {
  await Promise.all([copyStaticAssets(), processAllPages()]);
  return;
}
```

(`watch.ts#L23-L26`)

Consequences:

- Deleting `src/pages/old.html` and rebuilding leaves `dist/old.html`, which then deploys and
  serves.
- Renaming `styles.css` to `main.css` leaves both.
- A page removed from a routes script leaves its generated HTML. The stale-route cleanup via
  `templateToGeneratedRelativePaths` (`processing.ts#L481`) only works **within a single process
  lifetime**, so it never helps a fresh `bascik --build`.

### Required behavior

Clean `directory.out` at the **top of `runTranspile()`** in `pkg/src/transpile.ts`, for **both**
dev and build.

**Ordering is load-bearing.** The verified startup sequences are:

_Build:_ `runExecPhase("pre")`, `startExecParallel()`, `watchFiles()` (which for build runs
`copyStaticAssets()` and `processAllPages()`), `runExecPhase("post")`.

_Dev:_ `runExecPhase("pre")`, `startExecParallel()`, `startServer()`, `startExecDev()`,
`watchFiles()` (its ready handler runs `copyStaticAssets()` then `processAllPages()`),
`runExecPhase("post")`.

The clean must happen **before `runExecPhase("pre")`**, because a pre-phase exec script can
legitimately write into the output directory. Putting it anywhere later destroys that output.

**`bascik --server` must never clean.** `serve.ts` reads the output directory and does not call
`runTranspile()`, so placing the clean inside `runTranspile()` is naturally safe. Add an
explicit test asserting the server path deletes nothing.

Apply prompt 09's guard: the clean must throw if the resolved `directory.out` is not inside the
project root.

### Note for later

Prompt 33 adds `bascik --build --only <glob>`. A targeted build must **skip** this clean,
because cleaning would delete every page not being rebuilt. Leave a one-line comment marking
the spot so prompt 33 finds it.

---

## Part 2: restore dev-mode page writes

**This is a regression, not a design choice.**

Today, `processing.ts#L1035`:

```ts
// Only write to disk during build. Dev server serves from memory.
if (BascikConfig.isBuild) {
```

So dev never writes pages. But `copyStaticAssets()` **does** run in dev, and the watcher
deletes output files in dev, so dev leaves a half-built output directory containing assets but
no HTML. That hybrid is worse than either extreme, and it is why developers cannot inspect
their transpiled output during development.

### The intended behavior

Dev writes transpiled pages to `directory.out` **asynchronously, after the in-memory store is
populated**, so that serving the updated page is **never delayed by even one cycle** of file
I/O.

Requirements:

- The write is issued **after** `mem.storePage()` resolves. See `processing.ts#L585-L598`.
- The write is **not awaited** on the path that makes the page available to the server.
- A write failure logs and does not affect serving, and does not reject the transpile promise.
- Concurrent writes for the same page must not interleave. Reuse or extend the existing
  `pageProcessingQueues` serialization rather than inventing a second mechanism.
- **Build mode is unchanged:** it awaits the write, and prompt 12 makes it fail on error.

### Test this precisely

A test that merely asserts "a file appears" does **not** prove the write is non-blocking.

Assert that the promise returned by the serving path resolves **before** the write completes.
Do it by making the mocked write hang on a deferred promise, then asserting the page is already
retrievable from `mem` while the write is still pending.

---

## TDD steps

1. **Write the stale-output test first.** Build a fixture with two pages, build, delete one
   page, build again, and assert the deleted page's output is gone. It must fail.
2. **Write the dev-write test first.** In dev, assert a transpiled page appears in
   `directory.out`. It must fail.
3. **Write the non-blocking test first**, per the note above. It must fail, because there is no
   write at all yet.
4. Clean runs for dev and for build.
5. Clean runs **before** the pre-phase exec script. Assert ordering with a spy, not by reading
   the source.
6. `serve.ts` never cleans. Assert no delete call occurs on that path.
7. The clean throws when `directory.out` resolves outside the project root.
8. A dev write failure logs and does not reject the transpile promise.
9. Concurrent edits to the same page do not interleave writes.
10. Build mode still awaits its write.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): after a build, a page whose source was deleted between
  runs is absent from the output.
- `playwright.dev.config.ts`: **the key test.** Start dev, request a page, and assert the
  corresponding file exists in `directory.out` shortly afterward while the page was already
  served. This proves both halves of part 2.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: assert the server does
  not clean, by starting it against an existing build and confirming the files are still there.

## Documentation

| File                                               | Change                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/transpilation-pipeline.md` | **Correct the dev-mode disk-write description.** Prompt 02 flagged this section; this is the prompt that makes the new description true. Pages are written asynchronously after the memory store, so serving is never delayed |
| `docs/content/deploying.md`                        | The output directory is cleaned on every dev and build run                                                                                                                                                                    |
| `docs/content/developer-experience.md`             | You can inspect transpiled output in dev                                                                                                                                                                                      |
| `docs/content/faq.md`                              | "Why did my deleted page keep showing up?" and "Can I see the transpiled HTML during development?"                                                                                                                            |
| `docs/src/pages/assets/SKILL.md`                   | Remove the "known gap" note prompt 02 added; state the real behavior. Sync `create/assets/SKILL.md`                                                                                                                           |

## Acceptance criteria

- [ ] The three step-1-to-3 tests failed before and pass after.
- [ ] `directory.out` is cleaned for dev and build, **before** the pre-phase exec script,
      proven by an ordering spy.
- [ ] `bascik --server` never cleans.
- [ ] The clean throws on an out-of-project target.
- [ ] A comment marks the spot prompt 33 must skip for targeted builds.
- [ ] Dev writes pages asynchronously after `mem.storePage`.
- [ ] **The serving path is provably not blocked by the write.**
- [ ] A write failure does not affect serving or reject the transpile.
- [ ] Concurrent edits do not interleave writes.
- [ ] Build mode still awaits.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.
- [ ] The transpilation-pipeline page and SKILL.md now describe the real behavior.

## Do not do

- Do not implement targeted builds. Prompt 33; just leave the comment.
- Do not change build failure handling. Prompt 12.
- Do not change asset filtering. Prompt 10 owns it.
- Do not run Playwright or pre-push scripts.
