# 32: `exec` improvements

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/exec.ts`, `pkg/src/lib/types.ts` (`ExecEntry`),
`pkg/src/transpile.ts`.

---

## What is already correct

Phase ordering. `runTranspile` runs `pre`, then `parallel` fire-and-forget, then `watchFiles()`,
then `post`. Within a phase, entries run sequentially in array order. That is predictable and
should stay.

`spawn` is used **without** `shell: true`, which is the right call security-wise. Keep it.

---

## Bug 1: `parallel` failures are swallowed and the phase races transpilation

`#L50-L52`:

```ts
runScript(entry.script).catch((err) => {
  console.error("[bascik] parallel exec error:", err);
});
```

Two problems:

**A failed parallel script logs and the build exits 0.** A script that was supposed to generate
content simply did not, and CI goes green.

**`parallel` is never awaited, even in build mode.** So a script generating content that page
transpilation consumes **races against it**, and the output is timing-dependent. On a fast
machine it works; in CI it does not; and nothing explains why.

### Fix

A `parallel` failure must **fail the build**.

For the race: either await parallel scripts before transpilation begins, or document the race so
plainly that nobody uses `parallel` for content generation.

**Prefer failing the build and adding a join point before transpilation.** The phase stays
genuinely parallel with each other, but the build does not proceed past them into work that
might depend on their output. That preserves the performance intent while removing the
nondeterminism.

If you keep it fully fire-and-forget, the docs must say in bold that `parallel` output must not
be consumed by transpilation.

`pre` and `post` failures already propagate correctly and reach `process.exit(1)`. Leave that.

---

## Bug 2: no `cwd`, `env`, or `args`

`ExecEntry` is only `{ script, watch?, phase? }`, and the spawn is:

```ts
spawn(process.execPath, [scriptPath], { cwd: process.cwd() });
```

So scripts **cannot take arguments**, **cannot receive Bascik context** (no build mode, no site
URL, no base, unlike build scripts), and **cannot run anything that is not a Node file**.

### Fix

Add `cwd`, `env`, and `args`.

Pass the same Bascik context environment variables that build scripts receive: build mode, page
directory, site URL from prompt 04, and `BASCIK_BASE` from prompt 23. An exec script that
generates a sitemap supplement or a `_headers` file needs these.

Keep `spawn` without `shell: true`. If someone needs a shell command, they write a Node script
that spawns it, which keeps the escaping their problem rather than Bascik's.

### Naming

`ExecEntry.script` is a **Node file path**, not a shell command, and nothing in the name or the
type says so. Rename it, or type it in a way that makes it obvious. A user writing
`script: 'npm run build:data'` gets a confusing failure today.

---

## Bug 3: no timeout, and orphaned children

`exec` spawns with `stdio: 'inherit'` and registers only `watcher.close()` as a shutdown handler
(`#L120`).

On Ctrl+C, **in-flight and long-running exec children are orphaned** and keep running after
Bascik exits. There is also **no timeout**, so a hung script hangs the build forever.

### Fix

Track every spawned child. Kill them on shutdown, with a grace period before escalating.

Add a timeout. Decide whether it shares `scripts.timeout` or gets its own. An exec script doing a
real build step legitimately takes longer than a page build script, so a separate value is
defensible; say which you chose and why.

Coordinate with prompt 41, which implements graceful shutdown. Exec children must be part of
that drain, not a separate mechanism.

---

## Bug 4: dev re-runs do not debounce

The `running`/`pending` latch in `startExecDev` (`#L83-L100`) coalesces to at most one queued
re-run, which is reasonable, but there is **no chokidar debounce**.

A `git checkout` touching 200 files triggers an immediate run **plus** one queued run of every
watched exec script.

Fix: add a debounce. Prompt 44 adds debouncing to the page and component watchers; use the same
mechanism rather than a second one.

---

## Bug 5: writing to the source tree is unenforced convention

The copilot instructions state that exec output must be written to the output directory, but
there is **no sandbox, no path check, and no warning**.

Compounding: prompt 11 now cleans the output directory **before** the `pre` phase, so a `pre`
script writing there must create it. That is a real behavior change and must be documented.

### Fix

Document both facts clearly. Consider a **warning** when an exec script writes into
`directory.pages` or `directory.components`, since that pollutes the source tree and is almost
always a mistake.

Do not sandbox. Bascik cannot meaningfully prevent a Node script from writing anywhere, and
pretending otherwise is worse than being honest.

---

## Dead code

`runExecOnBuild` (`#L57`) should already be gone from prompt 08. **Confirm.** It was exported and
fully unit-tested with no production caller, and had different semantics from the phase dispatch
`runTranspile` actually uses.

---

## TDD steps

Write each failing test first.

1. A `parallel` script failure **fails the build** with a nonzero exit.
2. The chosen race resolution behaves as documented: either transpilation waits, or the docs
   state the constraint and a test pins the fire-and-forget behavior.
3. `cwd` is honored.
4. `args` reach the script's `process.argv`.
5. `env` entries reach the script, merged with the inherited environment rather than replacing it.
6. Bascik context variables reach an exec script, including `BASCIK_BASE`.
7. A spawned child is killed on shutdown, with the grace period observed.
8. A hung script hits the timeout and fails with a clear message.
9. Rapid file changes debounce into one re-run, not one per file.
10. An exec script writing into the pages directory warns.
11. A `pre` script can write into the output directory after the clean.
12. `runExecOnBuild` is gone.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): a fixture with a `pre` exec script that generates a data
  file consumed by a build script, and a `post` exec script that writes an extra file into the
  output directory. Assert both landed and the page reflects the generated data. **That is the
  ordering proof.**
- `playwright.dev.config.ts`: editing a watched exec script's input re-runs it and the page
  updates, without a restart.
- The two server configs: no new tests. `exec` is build-time. State that reasoning.

If you chose the join-point resolution for bug 1, the static-build E2E is also the proof that
the race is gone: the build script must reliably see the `pre` script's output.

## Documentation

| File                             | Change                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`  | `pipeline.exec` gains `cwd`, `env`, and `args`. The renamed `script` field. The timeout                                                                        |
| `docs/content/build-scripts.md`  | Or wherever `exec` is documented: the phase semantics, **the `parallel` failure and race behavior**, and the Bascik context variables now available            |
| `docs/content/deploying.md`      | `post`-phase scripts are the supported way to post-process output, cross-linking prompt 28's sitemap composition pattern and prompt 29's CSP header generation |
| `docs/content/faq.md`            | "Why did my `parallel` exec script's output not appear?"                                                                                                       |
| `docs/src/pages/assets/SKILL.md` | Exec scripts get Bascik context; write output to the output directory; `parallel` is not for content transpilation depends on. Sync `create/assets/SKILL.md`   |

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after.
- [ ] A `parallel` failure fails the build.
- [ ] **The race is resolved or documented in bold**, and a test pins the chosen behavior.
- [ ] `cwd`, `env`, and `args` all work; `env` merges rather than replaces.
- [ ] Bascik context variables including `BASCIK_BASE` reach exec scripts.
- [ ] Children are tracked and killed on shutdown with a grace period.
- [ ] A timeout exists with a documented value and rationale.
- [ ] Dev re-runs debounce, sharing prompt 44's mechanism.
- [ ] Writing into the source tree warns; the post-clean `pre`-phase behavior is documented.
- [ ] `ExecEntry.script` is named or typed so its meaning is obvious.
- [ ] `runExecOnBuild` is gone.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added; the user has run `yarn e2e:all`.

## Do not do

- Do not add `shell: true`.
- Do not sandbox filesystem access. Warn instead.
- Do not change phase ordering.
- Do not build a second debounce mechanism.
- Do not run Playwright or pre-push scripts.
