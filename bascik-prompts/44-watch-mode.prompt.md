# 44: Watch mode

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/watch.ts`, `pkg/src/lib/processing.ts`.

---

## Why the existing tests do not help

`watch.test.ts` has **69 tests that mock chokidar entirely** and assert only that handlers were
wired.

Every bug below is **structurally invisible** to that suite, because none of them is about
whether a handler exists. They are about what happens when real filesystem events arrive in real
sequences.

**Write real-filesystem tests in isolated temp directories.** That is the core deliverable of
this prompt, more than any individual fix.

---

## Bug 1: editor atomic saves cause two rebuilds and a 404 window

vim, IntelliJ, and any tool that writes to a temp file then renames over the target produce
**`unlink` followed by `add`**, not `change`.

For a page, the `unlink` handler runs
`removePage(path).then(() => processAllPages())` (`#L88-L90`), **and then** the `add` handler
runs `processAllPages()` again (`#L84-L86`).

So one save causes **two full-site rebuilds**, with a window in between where the page is
**missing from memory and requests 404**.

### Fix

Enable chokidar's `atomic` handling, or coalesce an `unlink` immediately followed by an `add` of
the same path into a single `change`.

**The 404 window is the part that matters most.** A save should never make a page temporarily
unavailable.

---

## Bug 2: adding any file triggers a full rebuild

Adding **any** page or component triggers `processAllPages()`, which is O(all pages).

On a large site, creating one file rebuilds everything. Prompt 33 built targeted-build machinery
and `selectivelyProcessPages` already exists; use it.

A new **component** genuinely can affect any page that references it, but a page that does not
reference it needs no work. A new **page** affects only itself.

---

## Bug 3: no `awaitWriteFinish`

A large file can be **read mid-write**, producing a spurious parse error and a stale page. The
developer sees an error for a file that is perfectly valid.

Enable `awaitWriteFinish` with a sensible stability threshold.

---

## Bug 4: no debounce

Rapid successive edits, or a `git checkout` touching 200 files, produce a rebuild per event.

Add an application-level debounce. Prompt 32 needs the same mechanism for exec re-runs; build it
once and share it.

---

## Bug 5: two watchers on the same directory

`#L34` and `#L81` both watch the pages directory, **doubling file-descriptor and inotify
consumption**. On Linux, inotify watch limits are a real constraint on large trees.

Consolidate.

---

## Bug 6: the ignore predicate allocates per event

`#L36-L39` runs `Array.from(MIME_MAP.keys()).some(...)` on **every filesystem event**,
allocating a roughly 110-element array each time.

Prompt 10 extracted a shared asset predicate and was told to fix this. **Confirm it is done**; if
not, do it here.

---

## Bug 7: symlinks can loop

`followSymlinks` is left at chokidar's default of `true`, so a **cyclic symlink** under the pages
directory will loop.

Set it to `false`, or handle the cycle. If you set it to `false`, note that a symlinked content
directory stops being watched, which some people rely on. Document whichever you choose.

---

## Bug 8: the config file is not watched

Editing `bascik.config.ts` has **no effect and produces no message**. The developer changes a
setting, sees nothing happen, and assumes the setting does not work.

**Do not implement hot reload.** Config is deep-frozen at module load (prompt 06 fixed the
mutation bug but kept the freeze), and reloading it correctly would mean re-deriving everything
downstream.

**Watch the config file and print a clear restart hint.** That is the whole fix.

Prompt 41 decided how `SIGHUP` is handled; be consistent with it.

---

## Already fixed elsewhere: confirm, do not redo

Prompt 12 fixed the dropped-rebuild-after-failure bug in `pageProcessingQueues`
(`processing.ts#L772-L786`), where `current.then(...)` with no rejection handler meant a fix saved
right after a syntax error was **skipped entirely**.

**Confirm that fix is present.** If it is not, stop and do prompt 12 first, because the real
filesystem tests you are about to write will fail confusingly without it.

---

## TDD steps

Write each failing test first, **using real filesystem events in isolated temp directories**.

1. An **atomic save**, write to a temp file then rename over the target, causes **one** rebuild,
   not two.
2. During an atomic save, the page is **never missing** from the in-memory store. Poll during the
   operation.
3. Adding a page rebuilds **only** that page.
4. Adding a component rebuilds only the pages that reference it.
5. A large file written slowly is **not** read mid-write.
6. Rapid successive edits debounce into one rebuild.
7. A `git checkout`-shaped burst of many file changes produces a bounded number of rebuilds.
8. Only one watcher exists per directory.
9. The ignore predicate does not allocate per event.
10. A cyclic symlink does not loop.
11. Editing the config file prints a restart hint and does not attempt a reload.
12. A save-broken then save-fixed sequence recovers, confirming prompt 12's fix still holds.

Tests 1, 2, and 12 are the ones that justify this prompt.

## Testing

**Unit:** all of the above, with real filesystem operations in temp directories. Keep the mocked
suite where it still adds value, but **do not add new tests to it**.

**E2E:**

- `playwright.dev.config.ts`: **the only relevant config.**
  - Save a page with an editor-style atomic write and assert the page updates **without ever
    404ing**. Poll during the save if the harness allows.
  - Add a new page at runtime and assert it becomes available.
  - Add a new component and assert a page using it updates.
  - Edit the config and assert the restart hint appears in server output, if the harness can
    capture it.
- The other three configs: watch mode does not exist in build or server mode. **State that
  reasoning** rather than skipping silently.

Coordinate with prompt 42's dev E2E, which also exercises save-and-reload. Share the helper.

## Documentation

| File                                   | Change                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/developer-experience.md` | Atomic saves are handled; adds are incremental; config changes need a restart and Bascik tells you                                                                                           |
| `docs/content/internals/server.md`     | The watch configuration and why each option is set as it is                                                                                                                                  |
| `docs/content/configuration.md`        | The symlink decision, since it affects anyone with a symlinked content directory                                                                                                             |
| `docs/content/faq.md`                  | "Why do I need to restart after changing my config?" and "Why did my page 404 right after saving?" Now fixed, but searchable                                                                 |
| `docs/content/internals/testing.md`    | **The testing approach changed**: real filesystem watch tests now exist alongside the mocked suite. The repo policy says to update this page when test _patterns_ change, and this qualifies |
| `docs/src/pages/assets/SKILL.md`       | Config changes require a restart. Sync `create/assets/SKILL.md`                                                                                                                              |

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after, **using real filesystem events**.
- [ ] An atomic save causes **one** rebuild and **no 404 window**.
- [ ] Adds are incremental, not full-site.
- [ ] `awaitWriteFinish` prevents mid-write reads.
- [ ] Edits debounce, sharing one mechanism with prompt 32.
- [ ] One watcher per directory; the ignore predicate does not allocate per event.
- [ ] Symlink loops are prevented, with the decision documented.
- [ ] Editing the config prints a restart hint; **no hot reload was implemented**.
- [ ] Prompt 12's queue fix was confirmed present.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] Dev E2E added; the user has run `yarn e2e:all`.
- [ ] `docs/content/internals/testing.md` reflects the new real-filesystem test pattern.

## Do not do

- Do not implement config hot reload.
- Do not add new tests to the fully-mocked chokidar suite.
- Do not build a second debounce mechanism. Share prompt 32's.
- Do not change SSE or the error overlay. **Prompt 42.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
