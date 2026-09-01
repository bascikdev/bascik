# 33: Targeted builds

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/cli.ts`, `pkg/src/transpile.ts`, `pkg/src/lib/processing.ts`,
`pkg/src/lib/sitemap.ts`.

Adds `bascik --build --only <glob>`.

---

## Why this is cheap

Most of the machinery already exists:

- `selectivelyProcessPages` (`processing.ts#L656-L665`) transpiles the pages that use a given
  component.
- `selectivelyProcessPagesForWatchPath` (`#L636-L654`) does the same for a watched path.
- `processPageBatch` (`#L565-L630`) transpiles an arbitrary list.
- `mem` already tracks `usedComponentsSet` and `fileDependenciesSet`.

What is missing is a CLI entry point and correct handling of the whole-site artifacts.

---

## The flag

```sh
bascik --build --only 'src/pages/blog/**'
bascik --build --only 'src/pages/blog/**' --only 'src/pages/about.html'
```

- The glob matches page paths **relative to `directory.pages`**.
- **Repeatable**, so multiple globs union.
- Follows prompt 07's CLI conventions: `--only=<glob>` and `--only <glob>` both work.
- Only valid with `--build`. Combined with `--server` or bare `bascik`, reject it, consistent
  with prompt 07's conflicting-flag rejection.
- **A glob matching nothing is an error**, not a silent success. Silently building zero pages and
  exiting 0 is exactly the class of failure prompt 12 removed.

---

## The hard parts

### Do not clean the output directory

Prompt 11 cleans `directory.out` at the top of `runTranspile()` for both dev and build, and left
a one-line comment marking the spot for this prompt.

**A targeted build must skip that clean.** Cleaning would delete every page not being rebuilt,
which turns a targeted build into a destructive one.

Document this prominently. It is the behavior difference a user is most likely to be surprised
by.

### Update the manifest, do not replace it

Prompt 26 writes `dist/.bascik/manifest.json` listing every emitted file, recorded as writes
happen.

A targeted build only writes some files, so a naive manifest write would **shrink the manifest
to just those files**, destroying the record of everything else in the output directory.

**Read the existing manifest, merge the newly written entries, and write the union.** Remove
entries only for files the targeted build **should** have produced but did not, for example a
page that was deleted from a glob-matched directory. Be conservative: it is better to leave a
stale entry than to drop a live one.

If `generate.manifest` is off, there is nothing to merge and this is moot.

### The sitemap cannot be regenerated from a partial page list

`generateSitemapFiles` enumerates the pages the build produced. On a targeted build that list is
a subset, so regenerating would produce a sitemap containing **only the rebuilt pages**, which
would then deploy and delist the rest of the site.

Two acceptable resolutions:

1. **Skip sitemap and robots generation on a targeted build, with a warning** telling the user
   the sitemap is now stale and how to regenerate it. Simple and honest.
2. **Derive the sitemap from the manifest** rather than from the build's page list, so it
   reflects the full output directory. More useful, and only possible because prompt 26 exists.

Option 2 is better if the manifest is enabled. Since `generate.manifest` defaults **off**, you
likely need option 1 as the fallback and option 2 as the enhancement. Pick, implement, and
document the behavior in both cases.

**Whatever you choose, never silently emit a partial sitemap.**

### Static assets

Decide whether `--only` also scopes asset copying.

Copying all assets is safe and cheap, since `copyReplicatePath` already hashes and skips
unchanged files. Scoping them adds a second glob semantic for little gain.

**Recommend copying all assets** and document that `--only` scopes **pages**, not assets. Say so
explicitly, because the flag name does not imply it.

### Prompt 29's CSP hashes

Same problem as the sitemap: a partial build produces partial hashes. Merge with the existing
file rather than replacing it, or skip with a warning. Be consistent with whatever you chose for
the sitemap.

---

## TDD steps

Write each failing test first.

1. `--only` with a glob builds only the matching pages.
2. Repeated `--only` flags union.
3. `--only=<glob>` and `--only <glob>` both parse.
4. `--only` without `--build` is rejected.
5. **A glob matching nothing is an error.**
6. **A targeted build does not clean the output directory.** Assert an unrelated pre-existing
   file survives.
7. The manifest is **merged**, not replaced: an unrelated entry survives, and a rebuilt page's
   entry is updated with its new hash.
8. The sitemap behaves per the chosen resolution, and never emits a partial list silently.
9. CSP hashes behave consistently with the sitemap decision.
10. Static assets are copied per the documented decision.
11. A targeted rebuild of a page produces **byte-identical output** to a full build of that page,
    preserving prompt 24's determinism.
12. A page matched by the glob whose **component** changed is rebuilt correctly, using the
    existing dependency tracking.

Test 11 is the important one: a targeted build must not be a second code path that drifts.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): **the primary config.** Do a full build, then a targeted
  build of one page with changed content, then assert (a) that page updated, (b) every other page
  is still present and unchanged, and (c) the sitemap behaves per the documented decision.

  That three-part assertion is the whole feature.

- `playwright.server.config.ts`: serve the output of a targeted build and confirm the site is
  intact, since serving a half-deleted output directory is the failure this prompt exists to
  prevent.
- `playwright.dev.config.ts` and `playwright.server-http2.config.ts`: no new tests. `--only` is
  build-only. State that reasoning.

## Documentation

| File                             | Change                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/cli.md`            | `--build --only`, repeatable, glob semantics, and **that it does not clean the output directory**. The sitemap behavior. That it scopes pages, not assets |
| `docs/content/deploying.md`      | When a targeted build is appropriate, and the caveat that the sitemap may be stale                                                                        |
| `docs/content/faq.md`            | "Can I rebuild only part of my site?"                                                                                                                     |
| `docs/src/pages/assets/SKILL.md` | `--only` exists. **Gotcha: it does not clean, and the sitemap may be stale.** Sync `create/assets/SKILL.md`                                               |

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after.
- [ ] `--only` is repeatable, parses both forms, and is rejected outside `--build`.
- [ ] A glob matching nothing errors.
- [ ] **The output directory is not cleaned**, and unrelated files survive.
- [ ] The manifest is merged, not replaced.
- [ ] The sitemap never silently emits a partial list; the chosen behavior is documented.
- [ ] CSP hashes behave consistently with the sitemap decision.
- [ ] Asset copying behavior is decided and documented.
- [ ] **A targeted rebuild produces byte-identical output to a full build of the same page.**
- [ ] Component dependency tracking drives correct rebuilds.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E asserts the three-part invariant; the user has run `yarn e2e:all`.

## Do not do

- Do not clean the output directory on a targeted build.
- Do not replace the manifest wholesale.
- Do not emit a partial sitemap silently.
- Do not build a second transpilation path. Reuse `processPageBatch`.
- Do not add scheduled or webhook-triggered rebuilds. Explicitly rejected.
- Do not run Playwright or pre-push scripts.
