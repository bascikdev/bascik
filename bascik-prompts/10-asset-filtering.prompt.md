# 10: Static asset filtering

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/file-system.ts`, `pkg/src/lib/watch.ts`, `pkg/src/lib/mime.ts`,
`pkg/src/lib/server.ts`. Implements `directory.public` and `assets.exclude`, which prompt 03
declared without behavior.

**Severity: ships secrets and source to production.**

---

## The problem

`copyStaticAssets` (`file-system.ts#L219-L232`) filters with an **inverted allowlist**, which
is really a deny-list of four things:

```ts
/\.[a-zA-Z0-9]+$/.test(filePath) &&
  !filePath.endsWith(".html") &&
  !filePath.endsWith(".ts") &&
  !/\.(test|spec)\.[a-zA-Z0-9]+$/.test(filePath) &&
  !isInlineStylesheet(filePath);
```

Everything else ships:

| File under the pages directory           | Ships?                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `.env`                                   | **Yes**, and `mime.ts#L86` maps `.env` to `text/plain`, so the server renders it as readable text rather than downloading it |
| `bundle.js.map`                          | Yes                                                                                                                          |
| `README.md`, `notes.md`                  | Yes                                                                                                                          |
| `.DS_Store`, `.gitignore`, `.npmrc`      | Yes                                                                                                                          |
| `helper.mjs`, `helper.cjs`, `helper.mts` | Yes; only `.ts` is excluded                                                                                                  |
| a nested `node_modules/**`               | Yes; `deepReadDir` has no ignore list                                                                                        |
| `bascik.config.js` if placed under pages | Yes                                                                                                                          |

---

## Fix 1: one shared predicate

Build and dev **disagree today**:

- the build allows **any** extension
- the dev watcher uses an extension allowlist derived from `MIME_MAP` (`watch.ts#L36-L48`)

So a file with an extension not in `MIME_MAP`, such as `.avifs`, `.jsonc`, `.mdx`, or `.hbs`,
is **absent in dev but present in the build output**. That is a dev-versus-build parity break,
which is exactly the class of bug the E2E matrix exists to catch.

Extract one function and use it in both places. Test the function directly, and assert both
call sites import it rather than reimplementing.

While you are in `watch.ts#L36-L39`: the `ignored` predicate runs
`Array.from(MIME_MAP.keys()).some(...)` on **every filesystem event**, allocating a
~110-element array each time. Fix that as part of the extraction.

---

## Fix 2: the deny-list

Exclude:

- any dotfile or dot-directory, at any depth
- `node_modules` at any depth
- `.map`
- `.mjs`, `.cjs`, `.mts`, `.cts`
- `.md`

Keep the existing exclusions for `.html`, `.ts`, test and spec files, and inline stylesheets.

---

## Fix 3: `assets.exclude`

Glob patterns, matched against the path **relative to `directory.pages`**. Default `[]`.

Document that this is for project-specific exclusions and that the built-in deny-list always
applies regardless.

---

## Fix 4: `directory.public`

Contents copy to `directory.out` verbatim, preserving relative structure. The same deny-list
applies. Default `undefined`, meaning off.

This is the **real** fix for the whole problem: static assets stop needing to live inside
`src/pages`. Document it as the recommended home.

Decide and document what happens when a file exists in both `directory.public` and
`directory.pages` at the same output path. An error naming both is the safest choice, matching
how prompt 25 treats duplicate component names.

---

## Fix 5: `.env` should have no MIME type

Remove it from `MIME_MAP` (`mime.ts#L86`). It should never have been mapped. Check the map for
other entries that only make a leak more readable: `.yaml`, `.toml`, `.ini`, `.lock`, `.sh`,
`.py`, `.rb`, `.go`, `.java`, `.c`. Decide which belong in a static-site MIME map at all.

---

## Fix 6: 404 any dot-segment path

In the request pipeline in `server.ts`, **before** the static branch, return 404 for any
request whose decoded path contains a segment starting with `.`.

This is defense in depth for everything above, and it also protects the `dist/.bascik/`
directory that prompts 26, 27, and 29 introduce.

Place it after `decodeURIComponent` so an encoded dot is caught. Note the existing guard order
at `server.ts#L129-L451`: rate limit, method guard, empty path, decode, traversal check, static
branch. Insert after the traversal check.

---

## TDD steps

1. **Write the leakage tests first.** For each of `.env`, `bundle.js.map`, `.DS_Store`,
   `.gitignore`, `helper.mjs`, `README.md`, and a nested `node_modules/pkg/index.js`, assert it
   does **not** reach `directory.out`. They must fail.
2. Assert a request for `/.env` returns 404. It must fail.
3. Extract the shared predicate; assert build and dev produce identical decisions for a file
   with an extension outside `MIME_MAP`.
4. `assets.exclude` globs are honored, and the built-in deny-list still applies on top.
5. `directory.public` copies verbatim, preserves nesting, applies the deny-list, and errors on
   a collision with a pages-directory file.
6. `.env` is absent from `MIME_MAP`.
7. The dot-segment 404 fires for `/.env`, `/.git/config`, `/foo/.hidden`, and an encoded form
   such as `/%2Egit/config`.
8. The watcher no longer allocates a keys array per event.

## Testing

**Unit:** all of the above.

**E2E:** this is the prompt where the E2E matrix earns its keep. Add a fixture with a
`src/pages/.env` containing a distinctive marker string, a `secret.js.map`, and a
`directory.public` asset.

- `playwright.config.ts` (static build): assert the marker string appears in **no file** in the
  build output, and that the public asset is present.
- `playwright.dev.config.ts`: assert `/.env` returns 404 and the public asset is served.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: same 404 and same
  public asset, proving parity across protocols.

The parity check matters here specifically because build and dev used different predicates.

## Documentation

| File                               | Change                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/configuration.md`    | `directory.public` and `assets.exclude`, with the collision behavior                                                                                   |
| `docs/content/deploying.md`        | What ships and what does not; recommend `directory.public` for assets                                                                                  |
| `docs/content/faq.md`              | Update "Which files in `src/pages/` are copied to `dist/` and which are excluded?" with the new deny-list. Add: "Where should I put images and fonts?" |
| `docs/content/internals/server.md` | The dot-segment guard and where it sits in the pipeline                                                                                                |
| `docs/src/pages/assets/SKILL.md`   | `directory.public` is the recommended asset home; the deny-list. Sync `create/assets/SKILL.md`                                                         |

## Acceptance criteria

- [ ] Every leakage test failed before and passes after.
- [ ] One predicate, shared by build and dev, proven by testing the function and asserting both
      call sites import it.
- [ ] A file with an extension outside `MIME_MAP` behaves identically in dev and build.
- [ ] `.env`, `.map`, dotfiles, `node_modules`, `.mjs`/`.cjs`/`.mts`/`.cts`, and `.md` never
      reach the output directory.
- [ ] `assets.exclude` works; the built-in deny-list always applies.
- [ ] `directory.public` copies verbatim and errors on a collision.
- [ ] `.env` is not in `MIME_MAP`.
- [ ] Any dot-segment path returns 404, including an encoded form.
- [ ] The watcher does not allocate per event.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to **all four** configs; the marker string appears nowhere; the user has run
      `yarn e2e:all`.

## Do not do

- Do not clean the output directory. Prompt 11.
- Do not change the traversal or decode guards. They are correct; prompt 43 covers the
  remaining gaps.
- Do not run Playwright or pre-push scripts.
