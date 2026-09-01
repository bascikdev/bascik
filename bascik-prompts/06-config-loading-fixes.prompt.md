# 06: Config loading bug fixes

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/userConfig.ts`, `config.ts`, `defineConfig.ts`, `types.ts`.

Four independent bugs in how the user's config file is discovered, loaded, merged, and frozen.

---

## Bug 1: an ENOENT thrown inside the user's config is misreported

`userConfig.ts#L52-L57`:

```ts
} catch (err) {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    console.warn("[bascik] No bascik.config found. Using defaults.");
    return { config: {}, build: {} };
  }
```

The `try` wraps **both** the `access()` probe **and** the `import()`.

So a config that calls `readFileSync('./data/site.json')` on a missing file, or imports a module
that does, is **silently swallowed**. The entire user config is discarded, the build proceeds
with defaults, and the printed message is actively misleading: it says there is no config file
when there is one that threw.

**Fix:** narrow the `try` to the `access()` probe only. An error thrown from inside the
imported module must propagate with its real message, wrapped with the config file's path for
context.

**Test:** a fixture config that throws ENOENT from inside must surface that error, not the
"no config found" path.

---

## Bug 2: a syntax error surfaces as an unhandled rejection

The non-ENOENT path throws (`userConfig.ts#L58-L63`) but nothing catches it. `config.ts` is
dynamically imported from inside `runCli`'s switch, and `runCli` is awaited at module top level
in `index.ts#L136`.

So the carefully worded `[bascik] Failed to load bascik.config:` message is printed as an
unhandled top-level rejection with a full Node stack and a warning banner.

**Fix:** catch it at the CLI boundary and print cleanly. Prompt 07 wraps the remaining CLI
paths; this one is specific to config loading and belongs here.

---

## Bug 3: `deepFreeze` mutates objects the caller owns

`initBascikConfig` spreads `safeUserConfig` **by reference** for array-valued options, then
calls `deepFreeze(BascikConfig)` (`config.ts#L282`).

This freezes:

- the arrays inside the **user's own config module**
- `defaultConfig.watch` and `defaultConfig.skipTranspilingElementContents` (`config.ts#L60`,
  `#L68`), which is a global side effect on an **exported** object

`config.test.ts` line 27 already carries a comment acknowledging the leak.

**Fix:** deep-clone before freezing.

**Test:** after `initBascikConfig`, mutating an array on the user's config object must not
throw, and `defaultConfig` must be unmodified. Both assertions, because they are different
symptoms of the same bug.

---

## Bug 4: two divergent `defineConfig`, and three things named `BascikConfig`

Both `pkg/src/lib/defineConfig.ts#L13-L17` and `pkg/src/lib/userConfig.ts#L15-L19` export a
type named `BascikConfig` and a function named `defineConfig`, with **different definitions**:

- `defineConfig.ts` omits `minify` and re-adds it as `boolean | Partial<MinifyOptions>`, so it
  accepts `minify: true`.
- `userConfig.ts` does not omit it, so its type **rejects** `minify: true` even though
  `config.ts#L169-L176` accepts it at runtime.

And `BascikConfig` is **also** the name of the resolved runtime singleton (`config.ts#L283`).
Three concepts, one name.

**Fix:**

- Delete the `userConfig.ts` copies. The published export is `defineConfig.ts`.
- Give the three concepts three distinct names: the user-facing input type, the resolved
  runtime type, and the runtime value.
- Record the chosen names in a comment at the top of `types.ts`, one line each.

**Also:** `isProdServer` is omitted from neither user-facing type, so a user can legally write
`isProdServer: true` in their config, have it type-check, and have it silently discarded at
`config.ts#L269`. Omit it alongside `isBuild`.

---

## Smaller items in the same files

| Item                                           | Location                | Action                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export let config` / `export let buildConfig` | `userConfig.ts#L70-L71` | `let` but never reassigned                                                                                                                                                                                                                                                                |
| `UserConfigModule`                             | `userConfig.ts#L21-L24` | Exported but only used internally by `importUserConfig`. Unexport                                                                                                                                                                                                                         |
| The zero-config warning                        | `userConfig.ts#L54`     | Fires on **every** zero-config run, and once per worker thread when `pipeline.workers` is on because `config.ts` is re-evaluated per worker. It contradicts the "completely zero configuration" positioning. **Delete it.** A warning should mean something is wrong                      |
| Config file discovery                          | `userConfig.ts#L66-L71` | Hardcoded to `process.cwd()`, `.js` preferred over `.ts`. Add `--config <path>` support here; prompt 07 owns the flag parsing but the loader must accept the path. Document the `.js`-over-`.ts` preference, because an `init`-written `.js` file currently shadows a user's `.ts` config |
| `types.ts#L301`                                | port default            | Says `8443`; the actual default is `8080` because TLS is off by default. The IDE tooltip is wrong while the docs are right                                                                                                                                                                |

Not supported today and worth documenting rather than adding: `.mjs`, `.cjs`, `.mts`, `.cts`, a
`config/` subdirectory, or a parent-directory search. TypeScript configs work only because of
Node 24 native type stripping, so a config using non-erasable syntax such as `enum` fails with
a raw Node error. Document that.

---

## TDD steps

Write each failing test before its fix.

1. An ENOENT thrown **inside** the config propagates with its real message.
2. A syntax error produces a clean CLI error, not an unhandled rejection with a stack.
3. Mutating the caller's config object after resolution does not throw.
4. `defaultConfig` is unmodified after resolution.
5. Only one `defineConfig` exists, and it accepts `minify: true`.
6. `isProdServer` and `isBuild` are not assignable in the user-facing type.
7. A zero-config run emits **no** warning.
8. `--config <path>` loads from an alternate location.
9. `.js` is preferred over `.ts`, documented and tested.
10. A config using non-erasable TypeScript syntax produces a comprehensible error.

## Testing

**Unit:** all of the above.

**E2E:** none. Config loading happens before any server or output exists. State that reasoning.

**Verification:** run `yarn docs:build` and confirm no zero-config warning appears anywhere,
including under `pipeline.workers`.

## Documentation

| File                             | Change                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`  | Discovery order, `--config`, the `.js`-over-`.ts` preference, and the non-erasable-syntax limitation |
| `docs/content/faq.md`            | "Why is my `bascik.config.ts` being ignored?" covering the shadowing case                            |
| `docs/src/pages/assets/SKILL.md` | Confirm nothing now claims a warning appears with no config. Sync `create/assets/SKILL.md`           |

## Acceptance criteria

- [ ] Each of the ten tests failed before its fix and passes after.
- [ ] An error thrown inside a user config is never reported as "no config found".
- [ ] A syntax error produces a clean error with no Node stack banner.
- [ ] `deepFreeze` mutates neither `defaultConfig` nor the caller's objects.
- [ ] One `defineConfig`; three distinct names for the three `BascikConfig` concepts, recorded
      in a comment.
- [ ] `isProdServer` and `isBuild` are omitted from the user-facing type.
- [ ] The zero-config warning is gone, including in worker threads.
- [ ] `--config <path>` is honored by the loader.
- [ ] `types.ts` port default says `8080`.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn pkg:build && yarn docs:build` succeed with no warning output.

## Do not do

- Do not add support for `.mjs`, `.cjs`, or a parent-directory search. Document the limitation.
- Do not attempt hot config reload. Prompt 44 prints a restart hint instead.
- Do not change the CLI parser beyond accepting the config path. Prompt 07 owns it.
- Do not run Playwright or pre-push scripts.
