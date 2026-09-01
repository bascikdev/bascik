# 09: Path safety

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/file-system.ts`, `pkg/src/lib/paths.ts`, `pkg/src/lib/sitemap.ts`,
`pkg/src/lib/routes.ts`.

**Severity: one bug here can delete the user's source directory.**

---

## Bug 1: `getRelativePath` can return a bare directory name

`file-system.ts#L11-L31`:

```ts
const suffix = normalizedPath.includes(`${parentPath}/`)
  ? normalizedPath.split(`${parentPath}/`)[1]
  : ...
const relative = (suffix ?? "").replace(/^\.?\//, "").replace(/^\//, "");
return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
```

`String.prototype.split(sep)[1]` returns the segment **between the first and second
occurrence**, not the tail.

With `directory.pages` named `pages` and a project at `/Users/x/my-pages/pages/`:

- `"/Users/x/my-pages/pages/assets".split("pages/")` yields `["/Users/x/my-", "", "assets"]`
- index `[1]` is `""`, so `relative` is falsy, so the function returns the bare string `"pages"`

`toDistPath` (`#L252-L262`) does `rel.replace(/^pages[\/]/, "dist/")`, which does **not** match
`"pages"` because there is no trailing slash, so it returns `"pages"` verbatim. `deleteDistDir`
(`#L285-L296`) then executes:

```ts
await rm("pages", { recursive: true, force: true });
```

**That deletes the user's source directory.**

Trigger: any project whose absolute path contains `<pagesDir>/` more than once. Real examples:
`/Users/x/my-pages/pages/`, `/srv/src/pages/demo/src/pages/`. A three-occurrence path hits a
milder variant where the **middle** segment is returned and the filename is truncated, so the
wrong output file is deleted or overwritten.

### Two fixes, both required

1. Use "everything after the **last** occurrence". `paths.ts#L6` already does this correctly
   with `lastIndexOf`.
2. **Add a hard guard.** `toDistPath`, `deleteDistFile`, and `deleteDistDir` must **throw** on
   any resolved target that is not inside `directory.out`. Throw rather than silently no-op, so
   a recurrence is loud. **This guard is the real protection**; fix 1 alone would leave the
   next path bug just as dangerous.

---

## Bug 2: `getDistPagePath` blindly rewrites segment zero

`file-system.ts#L239-L245` replaces `split("/")[0]` with `"dist"`. For an absolute path
`/pages/myPage.html` it yields `dist/pages/myPage.html`, and **`file-system.test.ts#L151`
asserts that as correct**, enshrining the bug. It only works because callers always pass
`pages/`-relative strings.

Fix it, and fix the test.

---

## Bug 3: three path-to-URL functions that disagree

Given `pages/blog/index.html`:

| Function            | File             | Output   | Used by                              |
| ------------------- | ---------------- | -------- | ------------------------------------ |
| `getHttpPath`       | `paths.ts#L1`    | `/blog/` | server and in-memory page keys       |
| `pagePathToUrlPath` | `sitemap.ts#L55` | `/blog`  | `sitemap.xml`                        |
| `computePagePath`   | `routes.ts#L104` | `/blog/` | `BASCIK_PAGE_PATH` for build scripts |

So **the sitemap advertises a URL that differs from the canonical one a build script
computes**. On most static hosts `/blog` 301-redirects to `/blog/`, meaning every
directory-index entry in the sitemap is a redirect.

Consolidate into one function. Pick the trailing-slash form or not, document the choice, and
make all three call sites use it.

---

## Bug 4: unreachable branches in `getHttpPath`

`paths.ts#L5-L13`:

```ts
if (normalized.includes("/pages/")) { … }
else if (normalized.includes("/src/pages/")) { … }   // unreachable
else if (normalized.startsWith("src/pages/")) { … }  // unreachable
```

`"/src/pages/"` contains `"/pages/"`, and `"src/pages/x"` contains `"/pages/"`, so branches two
and three can **never** execute. `paths.test.ts#L42-L47` tests those inputs and passes only
because branch one happens to produce the right answer.

Delete the dead branches. Keep the tests.

---

## Bug 5: `getHttpPath` ignores `directory.pages`

It hardcodes the literal segment `pages`. It works today only because every caller
pre-normalizes through `getRelativePath`. A new caller passing a raw source path with
`directory.pages: 'src/html'` gets garbage. Make it respect the configured directory.

---

## Bug 6: `index` is filtered from every segment

`sitemap.ts#L64`:

```ts
.filter((s) => s.length > 0 && s !== "index")
```

So `pages/index/deep.html` becomes `/deep` instead of `/index/deep`. Only the **last** segment
should be dropped. Untested today.

---

## The input matrix

Every consolidated path function must tolerate all of these. Build a table-driven test covering
every cell. The cells marked untested are where the bugs live.

| Input shape                                   | Status today                                                  |
| --------------------------------------------- | ------------------------------------------------------------- |
| `pages/x.html`                                | tested                                                        |
| `src/pages/x.html`                            | untested for `getRelativePath` and `toDistPath`               |
| absolute `/p/src/pages/x.html`                | tested for a **single** occurrence only                       |
| Windows `C:\p\src\pages\x.html`               | untested for `getRelativePath` and `pagePathToUrlPath`        |
| bare `x.html`                                 | untested for `getRelativePath` and `toDistPath`               |
| **duplicate `pages/` in the prefix**          | **untested, and this is bug 1**                               |
| trailing slash or a directory path            | mostly untested                                               |
| custom `directory.pages` not named `pages`    | broken and untested for `getHttpPath` and `pagePathToUrlPath` |
| non-ASCII, space, `#`, or `%` in the filename | untested everywhere                                           |
| `index` as a mid-path directory               | untested, and it is bug 6                                     |
| collapsed double slashes                      | untested for most                                             |

**Nothing verifies percent-encoding round-trips.** Only `pagePathToUrlPath` encodes. Add a test
that an encoded sitemap URL round-trips back to the on-disk filename through the server's
`decodeURIComponent` at `server.ts#L181`.

---

## Naming

`getRelativePath(path, parentDir)` types `parentDir` as `string`, but only `"pages"` and
`"components"` are meaningful; any other value silently falls through to the components branch.
Make it a union type.

Inside the function, `parentDir` and `parentPath` mean different things one line apart. Rename
one.

---

## TDD steps

### Step 1: prove the deletion bug, before any fix

```
"getRelativePath returns the tail when the pages segment appears twice in the path"
```

Input `/Users/x/my-pages/pages/assets/logo.png` with `directory.pages` named `pages`. Expect
`pages/assets/logo.png`. **It must fail**, returning `"pages"`.

```
"deleteDistDir refuses a target outside the output directory"
```

Assert it throws when handed `"pages"`. **It must fail** by calling `rm`.

These two are your regression anchors. Fix nothing until both fail for the right reason.

### Steps 2 to 7

2. The full input matrix, table-driven, for every path function.
3. The guards: `toDistPath`, `deleteDistFile`, `deleteDistDir` refuse absolute paths, `..`
   traversal, a bare filename, and a Windows-style path outside the output directory.
4. Consolidate the three path-to-URL functions; assert all three former call sites now agree.
5. Delete the unreachable branches; the existing tests still pass.
6. `getHttpPath` honors a custom `directory.pages`.
7. `index` is dropped only from the last segment; the percent-encoding round-trip holds.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): a page at a nested directory index is reachable at the
  URL the sitemap advertises. This is the behavioral proof that bug 3 is fixed.
- `playwright.dev.config.ts`: the same page is reachable in dev, proving parity.
- The two server configs: same page reachable. Cheap to add and they cover the `getHttpPath`
  keying path.

Add a fixture page with a non-ASCII filename to exercise the encoding round-trip in all four.

## Documentation

| File                                     | Change                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `docs/content/internals/architecture.md` | One path-to-URL function; document the trailing-slash decision        |
| `docs/content/sitemap.md`                | Sitemap URLs now match the canonical served URL                       |
| `docs/content/faq.md`                    | "Why did my sitemap URLs redirect?" if it is worth a searchable entry |

## Acceptance criteria

- [ ] The two step-1 tests failed before and pass after.
- [ ] `getRelativePath` uses last-occurrence semantics.
- [ ] `toDistPath`, `deleteDistFile`, and `deleteDistDir` **throw** on any target outside `directory.out`.
- [ ] `getDistPagePath` is fixed and the test that enshrined its bug is corrected.
- [ ] One path-to-URL function; sitemap, server, and build scripts agree.
- [ ] Unreachable branches deleted, tests still pass.
- [ ] `getHttpPath` respects `directory.pages`.
- [ ] `index` is dropped only from the last segment.
- [ ] The full input matrix is covered.
- [ ] An encoded sitemap URL round-trips to the on-disk filename.
- [ ] `getRelativePath`'s second parameter is a union type.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.

## Do not do

- Do not change asset filtering. Prompt 10.
- Do not add or change the output-directory clean. Prompt 11.
- Do not run Playwright or pre-push scripts.
