# 08: Public API, bin guard, and `bascik init`

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/package.json`, `pkg/bin/bascik.js`, `pkg/src/lib/init.ts`, `pkg/src/index.ts`,
plus dead-code removal in `exec.ts` and `index.ts`.

---

## Part 1: lock down the public API

`pkg/package.json` currently has:

```json
"exports": { "./config": { ... }, "./*": "./*" }
```

Two problems:

- The `"./*"` wildcard exposes **the entire package**, including `src/`, `bin/`, and every
  internal module, as public API. There is no encapsulation boundary, so anything anyone
  imports becomes a contract Bascik cannot break after 1.0.
- There is **no `"."` export**, so `import ... from '@bascik/bascik'` does not resolve at all.
  Only subpath imports work.

### Required

- Add a `"."` export exposing `defineConfig` and the public types.
- Keep `"./config"`; the docs reference it.
- **Remove the `"./*"` wildcard.**
- Set `files` so the published tarball contains only what is needed.
- `"types": "./src/lib/defineConfig.ts"` points at raw TypeScript source. Confirm that resolves
  for consumers on a range of TypeScript versions and with `allowImportingTsExtensions` off. If
  it does not, point it at a declaration file.
- `"engines": { "node": ">=22.18.0" }` is **not enforced at runtime**. A Node 20 user gets a
  syntax error on the `.ts` config import rather than an engine message. Add a runtime version
  check with a clear message, early enough to fire before anything else fails.

Adjust every internal import that relied on the wildcard. `yarn typecheck:all` will find them.

### Test

- `import { defineConfig } from '@bascik/bascik'` resolves.
- `import ... from '@bascik/bascik/config'` still resolves.
- An internal path such as `@bascik/bascik/src/lib/types` **no longer** resolves.
- A simulated below-minimum Node version produces the engine message, not a syntax error.

---

## Part 2: guard `bin/bascik.js`

`pkg/bin/bascik.js#L3` is:

```js
await import("../dist/index.js");
```

If `dist/` is missing, from an unbuilt checkout, a failed install, or a `files`
misconfiguration, the user sees a raw `ERR_MODULE_NOT_FOUND` stack.

Catch it and print an actionable message telling them to build the package. Keep the guard
narrow: only catch a module-not-found for that specific path, so a genuine error inside the
package still surfaces normally.

---

## Part 3: fix `bascik init`

Three problems in `pkg/src/lib/init.ts`:

### 3a. It silently rewrites the user's `package.json`

`#L115-L118` sets `"type": "module"` with no prompt and no backup. On an existing CommonJS
project this **breaks every `require()` in the repo**.

Detect the situation. If the field is already `"module"`, do nothing. If it is absent, setting
it is reasonable but should be reported. If it is `"commonjs"`, explain and refuse, or ask.
Never silently overwrite.

Remember that a build runs in CI where there is no TTY, so any prompt needs a non-interactive
path. Detect a non-TTY and fail with instructions rather than hanging.

### 3b. It does not add the dependency

`@bascik/bascik` is never added to `dependencies`, so the `dev` and `build` scripts it writes
**will not run**.

### 3c. It writes a config file containing nothing

`#L34-L52` writes `bascik.config.js` whose entire config is commented out, leaving only a
`build` export. So a freshly initialized project has a config file that does nothing, and the
`defineConfig` import path, which is the one thing that gives autocomplete, is never exercised.

It also writes `.js` while the docs recommend `.ts`, and the loader prefers `.js`, so an
`init`-written file would **shadow** a user's later `.ts` config.

Given that prompt 02 established a defaults-only config as an anti-pattern, the right answer
is: **do not write a config file at all** unless the user explicitly asks for one.

Instead:

- Write `.gitignore` entries for `directory.out` and `node_modules/.cache/bascik/`, appending
  rather than overwriting an existing file, and not duplicating an entry that is already there.
- Print a pointer to the configuration docs.

---

## Part 4: dead code in these files

| Item                                           | Location            | Action                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process.env.BASCIK_BUILD_LOG`                 | `index.ts#L38`      | Written, never read anywhere. The only other mention is a comment in `pkg/bin/update-e2e-coverage.ts`. Delete                                                                                                                                                          |
| `runExecOnBuild`                               | `exec.ts#L57`       | Exported and fully unit-tested, with **no production caller**. It also has different semantics from the phase dispatch `runTranspile` actually uses, running `parallel` entries synchronously, so wiring it up would silently change behavior. Delete it and its tests |
| Duplicate `KNOWN_SUBCOMMANDS` export           | `cli.ts#L132`       | Prompt 07 started using the constant. Remove the redundant re-export                                                                                                                                                                                                   |
| `prodServerDefaultConfig.prodServer.rateLimit` | `config.ts#L32-L34` | A no-op duplicating the base default. Should already be gone from prompt 03's restructure; confirm                                                                                                                                                                     |

---

## Part 5: make `chokidar` lazy

`chokidar` is a runtime dependency pulled in even for `bascik --build` and `bascik --check`,
neither of which ever watches. `watch.ts#L22-L26` returns early on `isBuild`, but `exec.ts#L2`
imports chokidar **unconditionally** at module scope.

Make the import dynamic so a build does not pay for it.

---

## TDD steps

Write each failing test first.

1. The three import-resolution tests from part 1, plus the engine-version message.
2. `bin/bascik.js` with a missing `dist/` prints the actionable message and exits nonzero,
   while a genuine in-package error still surfaces its own message.
3. `init` on a CommonJS project does not silently set `"type": "module"`.
4. `init` adds `@bascik/bascik` to `dependencies`.
5. `init` writes no config file.
6. `init` appends `.gitignore` entries without duplicating existing ones, and without
   clobbering an existing file.
7. `init` in a non-TTY environment does not hang.
8. Each dead item is gone and `yarn typecheck:all` is clean.
9. `chokidar` is not loaded during a build. Assert by spying on the module load, not by
   inspecting source.

## Testing

**Unit:** all of the above. `init` tests must run in an isolated temp directory and leave
nothing behind.

**E2E:** none. Package resolution and scaffolding are not exercised by any E2E config. State
that reasoning.

**Verification:** run `bascik init` in a scratch directory outside the repo and confirm the
result is a working project, then delete it.

## Documentation

| File                                   | Change                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/content/getting-started.md`      | `init` no longer writes a config; explain what it does write and why                  |
| `docs/content/configuration.md`        | Create a config only when a value differs from a default                              |
| `docs/content/internals/create-app.md` | If it describes `init` behavior, update it                                            |
| `docs/src/pages/assets/SKILL.md`       | The public API surface, and the `init` behavior change. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] Each of the nine tests failed before its fix and passes after.
- [ ] `"./*"` is gone; `"."` resolves; internal paths do not.
- [ ] `files` limits the published tarball.
- [ ] A below-minimum Node version produces an engine message, not a syntax error.
- [ ] A missing `dist/` produces an actionable message; a real error still surfaces normally.
- [ ] `init` never silently changes `"type"`, adds the dependency, writes no config file, and
      appends `.gitignore` entries idempotently.
- [ ] `init` does not hang without a TTY.
- [ ] Every dead item in part 4 is deleted.
- [ ] `chokidar` is not loaded during a build.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn pkg:build && yarn docs:build` succeed.
- [ ] No test left a file behind outside a temp directory.

## Do not do

- Do not change transpiler or server behavior.
- Do not add an interactive prompt without a non-interactive path.
- Do not remove `"./config"`; the docs depend on it.
- Do not run Playwright or pre-push scripts.
