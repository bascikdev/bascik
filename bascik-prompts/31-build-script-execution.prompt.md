# 31: Build script execution

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/build-scripts.ts`, `pkg/src/lib/build-script-runner.ts`.

---

## Bug 1: cache invalidation is a regex guess that fails silently

`extractScriptDeps` (`#L236-L254`):

```js
/['`"]((?:\.{1,2}\/|[a-zA-Z0-9_$-]+\/)[^'`"\n:]+\.(?:md|mjs|js|jsx|ts|tsx|json|yaml|yml|css|html|txt|csv|svg))['`"]/g;
```

Missed dependencies, **each producing permanently stale output with no warning**:

| Pattern                                      | Why it is missed                                                |
| -------------------------------------------- | --------------------------------------------------------------- |
| `readFile('data.json')`                      | The pattern **requires a slash**                                |
| `.xml`, `.toml`, `.mdx`, `.geojson`, `.wasm` | Outside the extension allowlist                                 |
| `readdir('./content/posts')`                 | Directory reads, so a new post never invalidates                |
| `join(dir, name)`                            | Computed paths                                                  |
| `` `./content/${slug}.md` ``                 | The `${` breaks the literal match                               |
| An import of a package that reads files      | Not visible at all                                              |
| Environment variables                        | Not part of the key                                             |
| Network fetches                              | Not part of the key, so an API-backed script **caches forever** |

Stale output is the worst failure mode precisely because it is **invisible**: the build succeeds,
the site looks fine, and the content is wrong.

### The config shape

**Decision, do not re-litigate.** `scripts.cache` is
`boolean | { enabled?, include?, exclude? }`, using the shared normalizer from prompt 03.

```ts
scripts: {
  cache: {
    enabled: true,
    exclude: ['src/pages/blog/**', 'src/components/live-feed/**'],
  },
}
```

Paths are matched against the **file containing the script**.

The cache key is computed at `#L257-L290` from the script content, build mode, source file, page
file, page path, site URL, and route params, plus transitive deps. **Add the component file
path** so a per-file opt-out can key correctly.

Prompt 30 brings route scripts under the same policy. Coordinate: one mechanism, both consumers.

### Document the limits loudly

In `docs/content/build-scripts.md` and `docs/content/configuration.md`. Tell people plainly that
a script reading from the network, from a computed path, or from a directory listing **must** be
excluded. Do not bury it.

---

## Bug 2: the cache directory grows without bound

`node_modules/.cache/bascik/script-cache/` holds one JSON file per distinct key and is **never
pruned**, growing across every build and every code edit. A long-lived working copy accumulates
thousands of dead entries.

**Fix:** prune. Either drop entries not touched in the last N builds, or apply a TTL. Record the
policy in a one-line comment so it is not mistaken for a bug later.

---

## Bug 3: the batch fallback silently re-executes every script

`#L573-L599`:

```js
} else {
  // Fallback if runner did not produce JSON (e.g. mocked execFile in tests)
  for (const task of uncachedTasks) {
    const { stdout: singleStdout } = await runModule(task.tmpPath, extraEnv);
```

The runner captures output by monkey-patching `process.stdout.write`
(`build-script-runner.ts#L31`).

Any script that bypasses it, via `fs.writeSync(1, …)`, a native addon, or a child process
inheriting stdio, **corrupts the JSON envelope**, `parsedResults` becomes `null`, and **every
script on the page runs a second time**.

Scripts with side effects (writing files, sending requests, incrementing counters) **execute
twice with no indication.**

**Fix:** make the envelope robust, or detect corruption and **fail loudly**. **Never re-run a
side-effecting script as a recovery strategy.** Re-running is only safe for pure scripts, and
Bascik cannot know which are pure.

---

## Bug 4: error double-wrapping

The `throw` inside the parsed-results loop (`#L559`) is lexically inside the `try` whose
`catch (err)` sits at `#L601`.

So a single failing script's error is caught by the outer handler, which then loops **all** tasks
and reports the same message for each, wrapping it again:

```text
[bascik] build script error … [bascik] build script error …
```

In warn mode, **every sibling script's output is also zeroed out**, so one broken script blanks
the whole page.

**Fix:** scope the catch correctly so one script's failure affects only that script.

---

## Bug 5: batch isolation is undocumented and leaky

All batched scripts share **one Node process and one global scope**.

| Leak                                         | Effect                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `process.exit()` in script one               | Kills scripts two through N, reported as a runner failure, then re-run individually per bug 3 |
| Module-level state                           | Persists across scripts on the same page                                                      |
| `process.chdir`                              | Affects subsequent scripts                                                                    |
| Patched globals                              | Affects subsequent scripts                                                                    |
| Unhandled rejections                         | Attributed to the wrong script                                                                |
| Async output after `await import()` resolves | Attributed to the **next** script                                                             |

**Document these constraints prominently.** They are surprising and currently invisible.

Consider whether a script should be able to opt out of batching. If the surface is not worth it,
say so, but at minimum make the failure modes **visible** rather than silent.

---

## Smaller items

| Item                         | Detail                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A script that writes nothing | Produces an empty tag replacement with **no warning**, which reads identically to a silently-cached-empty result. Distinguish them                                                                                                                        |
| `maxBuffer`                  | `stdout` is buffered entirely in memory with **no `maxBuffer` override**, so a script emitting more than Node's 1 MB default fails with a truncated, confusing error. Raise the limit and produce a clear message when exceeded                           |
| Timeout                      | Hardcoded 60 seconds at `#L154` with `SIGTERM`. Route it through `scripts.timeout` from prompt 03                                                                                                                                                         |
| Error formatting             | The `[bascik] … error in "file" at (line X, column Y)` block is copy-pasted **six times** in `executeBuildScripts` and four more in `executeRoutesScript`. Factor it out. Prompt 52 finishes the repo-wide sweep; do these here since you are in the file |

---

## TDD steps

Write each failing test first.

1. `scripts.cache` object form works: `enabled`, `include`, `exclude`, and a path matching both.
2. A script in an excluded path is **never** cached, even across runs.
3. The cache key includes the component file path.
4. The cache directory is pruned per the chosen policy.
5. **A corrupted runner envelope fails loudly and does not re-run any script.** Assert the
   side-effecting script ran exactly **once**.
6. One failing script reports **one** error, not one per sibling.
7. In warn mode, one failing script does not zero out its siblings' output.
8. A script producing empty output is distinguishable from a cached-empty result.
9. A script emitting more than 1 MB succeeds, or fails with a clear message naming the limit.
10. `scripts.timeout` governs the timeout; the hardcoded 60 seconds is gone.
11. A `process.exit()` in one batched script produces a clear diagnostic naming that script.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): a fixture with a build script whose output is visible in
  the page. Build, change the script's **data file**, rebuild, and assert the page updated. That
  proves cache invalidation works for the case it **does** handle.
- Add the inverse: a script reading a **computed** path, with an `exclude` entry, where changing
  the data file **does** update the page. That proves the escape hatch works.
- `playwright.dev.config.ts`: editing a build script updates the page without a restart.
- The two server configs: no new tests. Build scripts are build-time. State that reasoning.

## Documentation

| File                                    | Change                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/build-scripts.md`         | **The cache invalidation limits, in detail, with the exclusion pattern.** Batch isolation constraints. What happens when a script writes nothing. The output size limit |
| `docs/content/configuration.md`         | `scripts.cache` object form and `scripts.timeout`                                                                                                                       |
| `docs/content/faq.md`                   | "Why is my build script output stale?" with the exclusion answer                                                                                                        |
| `docs/content/internals/diagnostics.md` | The error format and that one failure affects one script                                                                                                                |
| `docs/src/pages/assets/SKILL.md`        | **Exclude any script that reads from the network or a computed path.** This is the highest-value gotcha in the file. Sync `create/assets/SKILL.md`                      |

## Acceptance criteria

- [ ] All eleven tests failed before their fixes and pass after.
- [ ] `scripts.cache` supports the object form with path scoping, shared with route scripts.
- [ ] The cache key includes the component file path; the cache directory is pruned.
- [ ] **A corrupted envelope fails loudly and never re-runs a side-effecting script.**
- [ ] One failing script reports one error and does not zero out siblings.
- [ ] Empty output is distinguishable from cached-empty.
- [ ] `maxBuffer` is raised with a clear message on overflow.
- [ ] The timeout routes through config.
- [ ] Batch isolation constraints are documented.
- [ ] The error-format block exists once in this file.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added; the user has run `yarn e2e:all`.
- [ ] The cache limits are documented loudly, not buried.

## Do not do

- Do not re-run scripts as a recovery strategy.
- Do not attempt to make dependency detection complete. It cannot be. Document the limits and
  provide the exclusion.
- Do not build a separate cache for route scripts. Prompt 30 shares this one.
- Do not run Playwright or pre-push scripts.
