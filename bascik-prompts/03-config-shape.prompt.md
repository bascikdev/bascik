# 03: Restructure the config shape

Read `.github/prompts/00-README.md` first. It carries the **agreed config shape**, which is a
decision, not a suggestion.

**Scope:** `pkg/src/lib/config.ts`, `types.ts`, `defineConfig.ts`, plus every consumer of a
moved key. Plus `docs/bascik.config.ts` and `pkg/e2e/bascik.config.ts`, which must be migrated.

**This prompt changes no behavior.** Only the names and locations of options change. If a test
in `processing.test.ts` or `server.test.ts` changes meaning, you have gone too far.

---

## Why the current shape is wrong

- `prodServer` holds settings the **dev** server reads. `server.ts#L465-L468` reads `hostname`
  and `port` from `prodServer` regardless of mode, while `devServer` has only `logging`.
- `useWorkers` and `buildScriptCache` sit at top level next to `siteUrl`, mixing pipeline
  mechanics with site identity.
- A separate `build` named export means "overrides during `--build`", which is a different axis
  entirely from where an option lives.

The fix separates the two axes: **concern** determines where an option lives, **mode**
determines what value it takes.

---

## Where each existing option moves

| Today                                     | New location                                         |
| ----------------------------------------- | ---------------------------------------------------- |
| `directory.pages`                         | `directory.pages` (unchanged)                        |
| `directory.components`                    | `directory.components` (unchanged)                   |
| `scopeScriptBlocks`                       | `scoping.scriptBlocks`                               |
| `inheritAttributes`                       | `scoping.inheritAttributes`                          |
| `scopeAttribute.{class,id,name}`          | `scoping.attributes.{class,id,name}`                 |
| `skipTranspilingElementContents`          | `scoping.preserve`                                   |
| `deduplicateCss`                          | `scoping.deduplicateCss`                             |
| `minify.*`                                | `minify.*` (unchanged)                               |
| `inlineStyles`                            | `assets.inlineStyles`                                |
| `generate.{sitemap,robots}`               | `generate.{sitemap,robots}` (unchanged)              |
| `siteUrl`                                 | **removed entirely**, prompt 04 owns the replacement |
| `watch`                                   | `pipeline.watchPaths`                                |
| `exec`                                    | `pipeline.exec`                                      |
| `useWorkers`                              | `pipeline.workers`                                   |
| `buildScriptCache`                        | `scripts.cache`                                      |
| `onScriptError`                           | **split into three**, see below                      |
| `onMinifyError`                           | top level, unchanged (not a script concern)          |
| `cacheHttp`                               | `http.httpCache`                                     |
| `prodServer.port`                         | `http.port`                                          |
| `prodServer.hostname`                     | `http.hostname`                                      |
| `prodServer.{keyFile,certFile,enableTls}` | `http.tls.{keyFile,certFile,enabled}`                |
| `prodServer.rateLimit`                    | `http.rateLimit`                                     |
| `prodServer.scriptTimeout`                | `scripts.timeout`                                    |
| `devServer.logging.*`                     | `logging.*`                                          |
| `prodServer.logging.*`                    | `logging.*`                                          |

Delete `prodServer` and `devServer` as containers.

---

## Split `onScriptError`

One option currently governs three different situations:

| Consumer                 | Situation                                                |
| ------------------------ | -------------------------------------------------------- |
| `build-scripts.ts#L503`  | a build script fails during transpilation                |
| `routes.ts#L439`         | a routes script fails while expanding a dynamic template |
| `server-scripts.ts#L263` | a server script fails **at request time**                |

A server script failing on a live request and a build script failing during `--build` want
different defaults. Split into `scripts.onBuildScriptError`, `scripts.onRoutesScriptError`, and
`scripts.onServerScriptError`.

Preserve today's effective defaults per mode. Note that `build-scripts.ts#L503` falls back to
`"error"` while `defaultConfig.onScriptError` is `"warn"`. That fallback is unreachable today
but is a landmine. Make every default explicit.

### Delete the `"halt"` value

`"halt"` is declared in `types.ts#L239` and `#L249`, but every consumer does
`if (behavior === "halt" || behavior === "error")`. Three values, two behaviors. Delete it.

---

## Mode overrides via named exports

```ts
export default defineConfig({
  /* shared */
});

export const dev = { minify: false, http: { port: 3000 } };
export const build = { minify: true };
export const server = {
  minify: true,
  http: { port: 443, tls: { enabled: true } },
};
```

- Resolution order: built-in defaults, then the default export, then the named export for the
  active mode.
- **Deep merge, not shallow replace.**
- All three named exports are optional.

### This fixes a real bug

`config.ts#L250-L257` merges `devServer` from `defaultConfig` and `safeUserConfig` but **never
threads `safeBuildOverride`**, unlike `prodServer` immediately below at `#L258-L268`. So
`export const build = { devServer: {...} }` is silently discarded today. Write the test that
would have caught it.

### Rejected alternatives, do not implement

- A `modes: { dev, build, server }` key inside the default export. `modes.server.http.port`
  reads worse than `export const server`, and it collides conceptually with the `http` block.
- A function-form config, `defineConfig(({ mode }) => ({...}))`. It makes the config
  non-serializable and non-inspectable, for no gain here.

---

## New keys, declaration only

Add these to the type and the defaults, with **no behavior**. Later prompts implement them.

| Key                       | Default                        | Implemented by         |
| ------------------------- | ------------------------------ | ---------------------- |
| `directory.out`           | `"dist"`                       | this prompt, see below |
| `directory.public`        | `undefined`                    | prompt 10              |
| `directory.api`           | `"src/api"`                    | prompt 48              |
| `base`                    | `'/'`                          | prompt 22              |
| `assets.exclude`          | `[]`                           | prompt 10              |
| `generate.sitemapLastmod` | `false`                        | prompt 28              |
| `generate.cspHashes`      | `false`                        | prompt 29              |
| `generate.manifest`       | `false`                        | prompt 26              |
| `http.trustProxy`         | `false`                        | prompt 40              |
| `http.cacheControl`       | today's `public, max-age=3600` | prompt 39              |
| `http.compression`        | on                             | prompt 39              |
| `http.timeouts`           | Node defaults                  | prompt 41              |
| `http.maxBodySize`        | `1048576`                      | prompt 49              |
| `http.apiTimeout`         | `10000`                        | prompt 49              |

`http.rateLimit` becomes `boolean | { window?, max? }`, preserving today's effective 500
requests per 10 seconds as the defaults. Behavior stays in prompt 40.

### `directory.out` must actually be wired

Unlike the others, implement this one now, because everything downstream depends on it. The
string `"dist"` is hardcoded in at least:

- `pkg/src/lib/file-system.ts#L230`, `#L242`
- `pkg/src/lib/processing.ts#L1035`
- `pkg/src/lib/sitemap.ts#L136`
- `pkg/src/lib/serve.ts#L47`
- `pkg/src/lib/server.ts#L130`
- `pkg/src/lib/watch.ts#L55`

Grep for every occurrence; that list may be incomplete.

**One decision to make and document in a single-line comment:** `directory.pages` and
`directory.components` are `resolve()`d to absolute paths at `config.ts#L276-L281`, so
`BascikConfig.directory.pages` is **not** the string the user wrote. Several consumers then
compare it as if it were relative, for example `file-system.ts#L35-L48` doing
`startsWith(pagesDir)` and `includes('/' + pagesDir + '/')` on an absolute path. Do not
replicate that confusion. Decide whether `directory.out` is stored resolved or raw, and make
every consumer agree.

---

## The scopable-option convention

`boolean | { enabled?, include?, exclude? }` is the repo-wide convention for options that can
be scoped to paths. Implement the normalizer **once**, in a shared helper, so every consumer
resolves it identically. Apply it to `scripts.cache` now; later prompts reuse it.

---

## Rename the flag and its family

| Old                  | New                      |
| -------------------- | ------------------------ |
| `--serve`            | `--server`               |
| `serveProduction()`  | a name matching the flag |
| `BASCIK_PROD_SERVER` | `BASCIK_SERVER`          |

`isProdServer` stays; it is already unambiguous and the repo convention cites it.

Also rename `BASCIK_SOURCE_FILE` to something unambiguous. In `routes.ts#L412-L413` it is set
to the **same** value as `BASCIK_PAGE_FILE`; in `build-scripts.ts#L475-L476` they differ (the
component file versus the owning page). The names give no hint of the difference.

Grep the whole repo including `docs/`, `create/`, `extensions/vscode-bascik/`, `pkg/e2e/`, and
`.github/skills/`. Note that `pkg/e2e/bascik.config.ts#L30-L31` uses `BASCIK_SERVE_PORT` and
`BASCIK_ENABLE_TLS`, which are e2e-local conventions but should still be updated for
consistency. `.github/skills/bascik-server-architecture/SKILL.md` documents `BASCIK_ENABLE_TLS`
as a package feature and mentions a `--no-tls` flag that does not exist; correct it.

---

## TDD steps

1. **Write the `export const build` override test first.** It must fail, proving the
   `devServer` bug. That is your anchor.
2. Defaults exist for every new key, at the right path, with the right value.
3. Deep merge: the default export over built-in defaults, then the mode export over that.
   Include a nested case such as `http.tls.enabled`.
4. The scopable-option normalizer: `true`, `false`, `{ enabled: false }`, `{ include }`,
   `{ exclude }`, both, neither, and a path matching both.
5. The three split error options each govern their own consumer, with the correct per-mode
   default.
6. `"halt"` is no longer accepted by the type or the runtime.
7. `directory.out` reaches every former `"dist"` call site. Assert by configuring a
   non-default value and checking output lands there.
8. Rename sweep: a repo-wide grep finds no old identifier.

## Testing

**Unit:** all of the above, in `config.test.ts` and `defineConfig.test.ts`.

**E2E:** all four configs must still pass unchanged, because this prompt changes no behavior.
That is the point of the exercise. Migrate `pkg/e2e/bascik.config.ts` to the new shape and
confirm the existing suite is green. Add no new E2E tests.

**Verification:** `yarn pkg:build && yarn docs:build` after migrating `docs/bascik.config.ts`.

## Documentation

| File                                                 | Change                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `docs/content/configuration.md`                      | Rewrite for the new shape. Every key, its default, and its concern group |
| `docs/content/cli.md`                                | `--serve` becomes `--server`                                             |
| `docs/src/pages/assets/SKILL.md`                     | The full new shape and the renamed flag. Sync `create/assets/SKILL.md`   |
| `.github/skills/bascik-server-architecture/SKILL.md` | Correct the env var and flag claims                                      |

## Acceptance criteria

- [ ] The `export const build` override test failed before and passes after.
- [ ] Every option in the move table is at its new location with **no alias** for the old one.
- [ ] `prodServer` and `devServer` no longer exist as containers.
- [ ] `onScriptError` is split into three, `"halt"` is gone, and defaults are explicit.
- [ ] Deep merge works for all three mode exports, including nested keys.
- [ ] The scopable normalizer is implemented once and shared.
- [ ] Every new key exists with the right default and no behavior.
- [ ] `directory.out` reaches every former `"dist"` site; the resolved-versus-raw decision is
      documented in one line.
- [ ] `--server`, `BASCIK_SERVER`, and the renamed file env var are used everywhere.
- [ ] `docs/bascik.config.ts` and `pkg/e2e/bascik.config.ts` are migrated.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn pkg:build && yarn docs:build` succeed.
- [ ] The existing E2E suite passes unchanged; the user has confirmed.
- [ ] No transpilation or request-handling behavior changed.

## Do not do

- Do not implement behavior for any declaration-only key.
- Do not add deprecation aliases.
- Do not add validation. That is prompt 05.
- Do not touch config loading or the CLI parser. Those are prompts 06 and 07.
- Do not run Playwright or pre-push scripts.
