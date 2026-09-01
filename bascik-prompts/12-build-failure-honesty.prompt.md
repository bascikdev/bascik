# 12: Build failure honesty and dev server survival

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/processing.ts`, `pkg/src/lib/file-system.ts`, `pkg/src/lib/sitemap.ts`,
`pkg/src/lib/watch.ts`.

`bascik --build` currently reports success while omitting pages, and the dev server exits on a
single bad page. Both undermine every other prompt's verification.

---

## Part 1: the build lies about success

### 1a. Write errors are swallowed

`processing.ts#L1035-L1046`. `mkdir` failure is logged only. `writeFile` failure is logged, and
**`ENOENT` is discarded entirely**. The build then prints `✓ N pages transpiled` and
`✓ Build complete` and exits 0 with pages missing.

Real causes: `EACCES`, `ENOSPC`, `ENAMETOOLONG`, and a read-only filesystem in CI.

### 1b. An unreadable pages directory yields a successful empty build

`deepReadDir` (`file-system.ts#L163-L176`):

```ts
} catch (error) {
  console.error("Failed to read directory %s", dirPath, error);
  return [];
}
```

So a typo in `directory.pages` produces `✓ 0 pages transpiled`, `✓ Build complete`, exit 0, and
an empty output directory. `bascik --check` also prints
`✓ 0 pages and 0 components checked` and exits 0. **A typo in the config passes CI.**

Fix: a missing or unreadable **configured** directory is a hard error. A missing
**subdirectory** encountered during recursion stays a warning, since it can race with a file
deletion.

Prompt 05 added a `directory.pages` existence check to config validation, which catches the
typo earlier. This fix is still required, because it covers permission errors and races that
validation cannot.

### 1c. Other silent-success paths

| Failure                          | Location                            | Today                                                 | Should be                                |
| -------------------------------- | ----------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| page has no `<body>`             | `processing.ts#L809` returns `null` | warning; page silently absent from output and sitemap | error: the page cannot ship              |
| unresolved component tags remain | `processing.ts`                     | warning only; broken markup ships                     | warning, escalated by `--check --strict` |
| runaway component recursion      | `processing.ts#L340`                | `console.error`, returns partial HTML, exit 0         | error                                    |

Decide each, document the choice, and make them contribute to the aggregated error state.

The `parallel` exec failure that also exits 0 (`exec.ts#L50`) belongs to prompt 32. Leave it.

### 1d. Aggregate rather than dying on the first error

Today the first rejection in `Promise.all` propagates and terminates the build, while the
remaining in-flight page writes are neither awaited nor cancelled, so the output directory is
left **torn**. Fixing one error and re-running then reveals the next one, a serial debugging
loop across N failures.

Collect all page-level errors, report them together at the end, and exit nonzero. Keep the
existing behavior of continuing past a failed page.

Design the report the same way prompt 05 designed config errors: grouped, with the page path,
the stage, and the message.

### 1e. `mkdir` before the sitemap and robots writes

`sitemap.ts#L136` and `#L145` call `writeFile` with a bare relative path. The output directory
is only created as a side effect of the `mkdir` inside `transpilePage`. A project with zero
pages, or one where every page fails the `<body>` check, produces an unhandled `ENOENT` that
fails the build with a confusing message.

---

## Part 2: the dev server does not survive a bad page

### 2a. One bad page kills the process at boot

`processing.ts#L613` and `#L626` use `Promise.all(openJobs.map(runJob))` with **no per-job
catch**. One rejecting page rejects the whole batch, which propagates:

`processAllPages()` → the `watchFiles()` ready handler's `reject` (`watch.ts#L93-L96`) →
`runTranspile()` throws (`transpile.ts#L33`) → `runCli` → `process.exit(1)` (`index.ts#L124`).

Worse, `mem.setBootingDone()` and `eventEmitter.emit("boot-done")` (`transpile.ts#L36-L37`)
**never run**. So even if the exit were prevented, every page would be stuck on the boot page
forever.

Fix: per-job catch. A failing page records its error and does not take down the batch. Boot
completes. The failing page serves an error state rather than the boot page.

### 2b. A queued rebuild is dropped after a failure

`processing.ts#L772-L786`:

```ts
const current = pageProcessingQueues.get(pagePath) ?? Promise.resolve();
const next = current.then(async () => { ... });
```

`current.then(onFulfilled)` with **no rejection handler**: if `current` rejects, `next` rejects
**without ever running the handler**.

So when you save a page with a syntax error and then immediately save the fix, **the fix's
rebuild is skipped entirely** and the dev server keeps serving the broken page. The only way
out is a restart.

Fix: `current.catch(() => {}).then(...)`.

This is structurally invisible to the existing test suite, because `watch.test.ts` mocks
chokidar entirely and only asserts that handlers were wired. Write a real test for the queue
with a rejecting first job.

---

## TDD steps

Write each failing test before its fix.

1. A `writeFile` rejection makes the build exit nonzero. Cover `EACCES` and **`ENOENT`
   specifically**, since ENOENT is the one currently discarded.
2. An unreadable `directory.pages` is a hard error, not `✓ 0 pages`.
3. A missing subdirectory during recursion is still only a warning.
4. A page with no `<body>` is an error.
5. Runaway recursion is an error.
6. Four distinct page failures are aggregated into one report and exit nonzero, with each page
   path named.
7. The sitemap write does not ENOENT on a zero-page project.
8. One bad page does not prevent `boot-done` from firing, and does not exit the process.
9. A rejecting queued job does not drop the next one. Save-broken then save-fixed produces the
   fixed page.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.dev.config.ts`: **the most valuable test in this prompt.** Start dev with a page
  containing a deliberate error, assert the server is up and other pages render, then fix the
  page on disk and assert it recovers without a restart. That covers 2a and 2b together.
- `playwright.config.ts` (static build): a build with a deliberately unwritable output path
  exits nonzero. If that is impractical in the harness, cover it at the unit level and say so.
- The two server configs: no new tests. State that reasoning, since this is a build and dev
  concern.

## Documentation

| File                                    | Change                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `docs/content/cli.md`                   | What causes a nonzero exit, and that errors are aggregated                                               |
| `docs/content/developer-experience.md`  | The dev server survives a broken page and recovers on save                                               |
| `docs/content/internals/diagnostics.md` | The aggregated error report format                                                                       |
| `docs/content/faq.md`                   | Update "How does Bascik handle bad markup or invalid code? Does it crash?" with the new behavior         |
| `docs/src/pages/assets/SKILL.md`        | A build now fails loudly rather than reporting success with missing pages. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] Each of the nine tests failed before its fix and passes after.
- [ ] A page write failure fails the build with a nonzero exit, including `ENOENT`.
- [ ] An unreadable configured pages directory is a hard error; a missing subdirectory is not.
- [ ] Missing `<body>` and runaway recursion are errors.
- [ ] Errors are aggregated and reported together, naming each page.
- [ ] The sitemap write does not ENOENT on a zero-page project.
- [ ] One bad page does not prevent boot completion or exit the process.
- [ ] A rejecting queued rebuild does not drop the next one.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The dev-recovery E2E passes; the user has run `yarn e2e:all`.

## Do not do

- Do not fix the `parallel` exec swallow. Prompt 32.
- Do not add a build-error overlay in the browser. Prompt 42 owns the SSE error channel.
- Do not change the output-directory clean. Prompt 11 owns it.
- Do not run Playwright or pre-push scripts.
