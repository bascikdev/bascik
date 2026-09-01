# 52: Cleanup sweep

Read `.github/prompts/00-README.md` first.

**Scope:** repo-wide, mostly `pkg/src/lib/`.

Dead code, duplication, and naming. Last among the code prompts, because several items below were
assigned to earlier prompts and this is where you confirm they actually landed.

**This prompt changes no behavior.** If a rename or deletion reveals a bug, **note it** rather
than fixing it here, unless the fix is trivial.

---

## Part 1: dead code

Delete each. After each removal run `yarn typecheck:all` to catch orphaned imports.

| Item                            | Location                              | Note                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stripAnsiEscapeCodes`          | `routes.ts#L39`                       | Defined and never called, while **three other copies** exist in `build-scripts.ts#L148` and `server-scripts.ts#L81`. Prompt 30 was told to consolidate to one during the `runModule` deduplication. **Verify exactly one remains and it is actually called** |
| `createDir`                     | `file-system.ts#L302`                 | Exported, only reachable from its own test                                                                                                                                                                                                                   |
| `fileStatSizeToString`          | `server.ts#L44`                       | A one-line wrapper around `size.toString(36)` used **once**, in the function directly above it. Prompt 39 replaced mtime ETags, so it may already be gone. Confirm                                                                                           |
| `delete respHeaders[":status"]` | `http.ts#L23-L25`, `http2.ts#L41-L43` | **No caller ever sets `:status`** in the headers object. Dead defensive branches, both covered by tests, **inflating coverage**                                                                                                                              |
| `export { _rateLimiter }`       | `http2.ts#L16`                        | A test-only re-export in a production module. The underscore prefix plus a JSDoc saying "Exported for test cleanup only" signals the module needs a **reset hook**, not an exported mutable Map                                                              |
| `export { makeEtag }`           | `server.ts#L17`                       | Pure pass-through re-export existing so tests can mock through one module                                                                                                                                                                                    |
| `export { cleanStackTrace }`    | `server-scripts.ts#L54`               | Same                                                                                                                                                                                                                                                         |
| `escapeXml`                     | `sitemap.ts#L36`                      | Exported for tests only                                                                                                                                                                                                                                      |
| `deepReadDir`                   | `file-system.ts#L164`                 | Exported; the only consumer is `deepReadDirFlat` in the same file. **Unexport it.** It also returns `Promise<any[]>` with a comment excusing the `any`; a recursive `type NestedPaths = (string \| NestedPaths)[]` expresses it fine                         |
| `SECURITY_HEADERS`              | `server.ts`                           | Exported **and** separately spread inside `getSecurityHeaders`. Only the function is ever needed                                                                                                                                                             |

For the **test-only re-exports**: the right fix is usually an explicit **reset or test hook**
rather than exposing internals. Add one where the tests genuinely need it, then delete the
re-export.

---

## Part 2: duplication

| Duplicated thing                                                        | Locations                                                                                   | Action                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BARE_TOKEN`, `ATTR_VALUE`, `ATTR`, `SCRIPT_TAG_PREFIX` regex fragments | copy-pasted **verbatim** in `build-scripts.ts`, `routes.ts`, `server-scripts.ts`            | **One shared module.** These fragments are load-bearing for quote-awareness, and a divergence between copies is a **silent correctness bug**. Prompt 16 fixed a missed `ATTR_VALUE` call site; this is how that happens |
| The `[bascik] … error in "file" at (line X, column Y)` block            | **six times** in `executeBuildScripts`, four more in `executeRoutesScript`                  | Prompt 31 was told to factor the script-runner ones. **Verify and finish**                                                                                                                                              |
| Cache-key hashing and `readFile` plus SHA-256 comparison                | **twice** inside `copyReplicatePath`, CSS branch and JS branch, differing only by extension | Factor out                                                                                                                                                                                                              |
| `runModule`                                                             | `build-scripts.ts#L81`, `routes.ts#L44`                                                     | Prompt 30 owns this. **Verify it is one implementation** with the semaphore, ANSI stripping, and `maxBuffer`                                                                                                            |
| `resolveCssImports` and `resolveCssImportsSync`                         | `styles.ts#L474-L620`                                                                       | ~55 lines duplicated verbatim except `await readFile` versus `readFileSync`. Prompts 18 and 35 both flagged it. **Verify**                                                                                              |

**Add a test for the shared regex module** asserting all three consumers import it, so a future
copy-paste is caught.

---

## Part 3: naming

| Current                                                                 | Problem                                                                                                                                                                                                     | Action                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `getRelativePath(path, parentDir)`                                      | `parentDir` typed as `string`, but only two values are meaningful; any other **silently falls through** to the components branch. Inside, `parentDir` and `parentPath` mean different things one line apart | Prompt 09 was told to fix this. **Verify**           |
| `toDistPath` versus `getDistPagePath`                                   | **Near-identical names, different semantics**: the former handles absolute and already-prefixed inputs, the latter blindly rewrites segment zero                                                            | Rename both to say what they do                      |
| `runScript` (exec), `runScriptFiles` (build-script-runner), `runModule` | Similar names for genuinely different execution mechanisms                                                                                                                                                  | Rename so each says which mechanism it is            |
| `ExecEntry.script`                                                      | A **Node file path**, not a shell command, and nothing says so                                                                                                                                              | Prompt 32 was told to rename or document. **Verify** |
| `getSecurityHeaders(req?)`                                              | The optional parameter **silently produces different headers**                                                                                                                                              | Prompt 40 was told to make it explicit. **Verify**   |

### The rename sweep

Grep the **whole repo** including `docs/`, `create/`, `extensions/vscode-bascik/`, `pkg/e2e/`,
and `.github/skills/` for any remaining pre-rename identifier from prompt 03:

`--serve`, `prodServer`, `devServer`, `cacheHttp`, `skipTranspilingElementContents`,
`onScriptError`, `BASCIK_PROD_SERVER`, `BASCIK_SERVE_PORT`, `BASCIK_ENABLE_TLS`,
`BASCIK_SOURCE_FILE`, `useWorkers`, `buildScriptCache`, `inlineStyles` at top level, `siteUrl` as
a config key.

A hit in a docs file or a skill file is just as bad as one in source, because that is what agents
read.

---

## Part 4: test hygiene

### The mocked watcher suite

`watch.test.ts` mocks chokidar entirely: **69 tests, all asserting handlers were wired.**

Prompt 44 added real-filesystem tests. **Verify they exist**, and check whether the mocked suite
is now giving **false confidence** about behavior it structurally cannot observe.

Do not delete it wholesale; some of it genuinely tests wiring. **Do** remove any test whose only
assertion is that a mock was called, where a real test now covers the behavior.

### Coverage will drop, and that is correct

Several dead items in part 1 are **covered by tests**, which raises the coverage number without
testing anything real.

After deleting them, re-run coverage and update `pkg/test-coverage.json` and
`pkg/e2e-test-coverage.json` per the repo's process.

**Note in the pull request that a coverage decrease here is expected and healthy.** Deleting
tested dead code is exactly the case where a lower number means a better codebase.

---

## TDD steps

This prompt is mostly deletion, so the method is inverted: **the existing suite is the test.**

1. Before deleting anything, run `yarn unit:all` and record the counts. That is your baseline.
2. Delete one item at a time. After each: `yarn typecheck:all`, then `yarn unit:all`.
3. For each **test-only re-export** removed, add the reset or test hook **first**, confirm the
   tests still pass through it, **then** delete the re-export.
4. For the shared regex module, **write the import-assertion test first**, watch it fail, then
   consolidate.
5. For each rename, rely on the type checker. If a rename compiles with no other changes, it was
   not actually ambiguous; reconsider whether it was worth doing.
6. After the full sweep, run `yarn pkg:build && yarn docs:build`.

## Testing

**Unit:** the existing suite must pass unchanged in **meaning**, minus the tests for deleted code.

**E2E:** **all four configs must pass unchanged.** That is the entire safety net for a
behavior-neutral sweep, and it is why this prompt is last.

State that you added no new E2E because the change is behavior-neutral by construction. Then ask
the user to run `yarn e2e:all`.

**Also verify:** `yarn docs:build` output is **byte-identical** to before this prompt. Prompt 24
made that a meaningful signal; use it.

## Documentation

| File                                | Change                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/internals/testing.md` | If the mocked watcher suite changed shape, say so. Repo policy requires updating this page when test **patterns** change                                           |
| `docs/content/internals/*.md`       | Any page naming a renamed symbol                                                                                                                                   |
| `docs/src/pages/assets/SKILL.md`    | Only if a user-facing name changed. If nothing user-facing changed, **say so explicitly** rather than making a token edit. Sync `create/assets/SKILL.md` if edited |

No new user-facing documentation is expected from a cleanup sweep.

## Acceptance criteria

- [ ] Every item in part 1 is deleted, with a reset or test hook added where one was needed.
- [ ] Every duplication in part 2 is consolidated, with a test guarding the shared regex module.
- [ ] Every rename in part 3 is done.
- [ ] **A repo-wide grep finds no pre-rename identifier**, including in `docs/`, `create/`,
      `extensions/`, and `.github/skills/`.
- [ ] The items assigned to earlier prompts were **verified**, and any that did not land are noted
      or completed.
- [ ] Tests whose only assertion is that a mock was called, where a real test now exists, are
      removed.
- [ ] Coverage files updated; the expected decrease is noted in the pull request.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] **`yarn docs:build` output is byte-identical to before.**
- [ ] All four E2E configs pass unchanged; the user has run `yarn e2e:all`.
- [ ] **No behavior changed.** Any bug found during the sweep is noted, not silently fixed.

## Do not do

- Do not change behavior. Note bugs rather than fixing them, unless trivial.
- Do not delete the whole mocked watcher suite. Trim it.
- Do not chase the coverage number back up by writing tests for code you just deleted.
- Do not rename anything that is already unambiguous.
- Do not run Playwright or pre-push scripts.
