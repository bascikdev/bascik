# 28: Sitemap and robots.txt

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/sitemap.ts`, `pkg/src/lib/processing.ts`, `pkg/src/lib/watch.ts`.
Implements `generate.sitemapLastmod`, which prompt 03 declared without behavior.

---

## Bug 1: generation races asset copying

`processAllPages()` ends by calling `generateSitemapFiles` (`processing.ts#L760`), and build
orchestration is:

```ts
await Promise.all([copyStaticAssets(), processAllPages()]);
```

So generation runs **concurrently** with asset copying. If the user authors
`src/pages/robots.txt`, whichever operation finishes last wins.

**The same source tree can produce different output on different runs.** Fix the race first;
everything below depends on a deterministic ordering.

---

## Bug 2: generated files silently clobber authored ones

There is no existence check, no warning, and no way to opt out.

### Check the SOURCE tree, never the output tree

The existence check must be against `{directory.pages}/robots.txt`, **not**
`{directory.out}/robots.txt`.

**This distinction is the whole feature.** Checking the output tree would mean a stale artifact
from a previous build blocks regeneration **forever**, and the site would silently stop getting
an updated sitemap with no visible failure. Worse, local and CI would diverge depending on
whether the output directory had been cleaned, and prompt 11 now cleans it on every run.

Source existence is a reliable signal of intent precisely because the output directory is
gitignored and the source is checked in. A file in `src/pages/` was deliberately authored by a
human.

Check **only the pages root**, not recursively. Both files are meaningful only at the site root,
so a nested `about/robots.txt` is an unrelated file and must be ignored.

### Required behavior

Evaluate `robots.txt` and `sitemap.xml` **independently**. Authoring one must not suppress
generation of the other.

For each file, when its generator is enabled **and** the authored file exists in the pages root:

- **Do not** write the generated file. The authored file, already copied, is the output.
- Emit a **warning**, not an info message. Having the file in source while generation is enabled
  is a contradictory configuration, and the author should resolve it rather than have it
  silently ignored on every build forever.
- The warning states **all three resolutions**, so it is actionable without opening the docs:

```text
warning: src/pages/robots.txt exists, so generate.robots did not write dist/robots.txt.
  - To keep your authored file and silence this warning, set generate.robots: false
  - To use Bascik's generated file, delete src/pages/robots.txt
  - Your authored robots.txt should include its own "Sitemap:" line
```

The third line applies to `robots.txt` **only**. Bascik's generated version includes a
`Sitemap:` pointer; an authored one will not unless the user adds it, and losing that pointer is
an easy silent SEO regression.

Warn once per file per build.

### Rejected alternatives, do not implement

**Merging generated output into the authored file.** Rejected for three reasons:

1. **Not idempotent.** If build N+1 merges into build N's output, the result depends on build
   history rather than on source. That destroys reproducible builds, makes CI and local diverge,
   and means a sitemap can only ever grow: URLs deleted from the site would never leave.
2. **`robots.txt` is not safely mergeable.** Directives are order-dependent and scoped to
   `User-agent` groups. Injecting an `Allow:` line into a group that intentionally disallows
   everything **inverts its meaning**. A merge tool cannot know the author's intent.
3. **It is magic.** Bascik's model is deterministic transpilation: same source, same output.

**An interactive prompt.** Builds run in CI where there is no TTY, so a prompt would either hang
the pipeline or require a flag to auto-answer, at which point the flag is the real API.

### The composition answer

The legitimate need behind merging already has a correct answer: an `exec` entry with
`phase: 'post'`. A post-phase script reads the freshly generated `dist/sitemap.xml` and edits
it, adding hand-curated URLs or splitting into a sitemap index.

This stays deterministic because the script derives its output from **this build's** output, not
from a checked-in artifact carried across builds.

**Document this in `docs/content/sitemap.md` directly beneath the precedence rule**, so the
person who hits the warning finds the composable answer immediately.

---

## Feature: per-page exclusion

```html
<meta name="bascik-sitemap" content="exclude" />
```

Real sites have pages that exist for legacy URL reasons and immediately redirect elsewhere.
Advertising them to crawlers is actively harmful.

**Rejected alternative:** a config array of glob patterns. It splits page metadata away from the
page, and the repo has established that page-local concerns are declared in the page.

The 404 page is already excluded via `is404Page`. Confirm that still works alongside the new
mechanism.

---

## Feature: optional `lastmod`

`generate.sitemapLastmod`, default `false`. When enabled, use the source page file's mtime.

**Keep it opt-in.** Mtimes are unstable across CI checkouts and would otherwise churn the
sitemap on every build, which directly undermines prompt 24's determinism work.

**Do not add `changefreq` or `priority`.** Google has publicly stated it ignores both. Adding
them is permanent API surface for zero benefit.

---

## Other defects

| Defect                         | Detail                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicates are not removed     | `processAllPages` returns paths that may contain the same path twice, for example a static page plus a dynamic route resolving to the same file, producing duplicate `<loc>` entries                            |
| Sorting happens after encoding | URL paths are sorted (`#L133`), which is good, but **after** `encodeURIComponent`, so ordering is by encoded form. Decide whether that is intended and document it                                              |
| Bracket leakage                | Confirm routes produced by `data-bascik-routes` appear with correctly percent-encoded segments, and that **no literal `[` or `]` can ever reach `sitemap.xml`**. Add a regression test even if it already holds |
| `mkdir` before writing         | Prompt 12 should have fixed the bare-relative-path write at `#L136` and `#L145`. Confirm                                                                                                                        |
| Base composition               | Prompt 23 provided a composition helper for site URL plus base plus path. Use it; do not concatenate at the call site                                                                                           |

---

## TDD steps

Write each failing test first.

1. Generation no longer runs concurrently with asset copying. Assert ordering with a spy.
2. An authored `src/pages/robots.txt` means the generated file is not written, and the warning
   names all three resolutions.
3. Same for `sitemap.xml`, independently.
4. **The regression guard for the whole section:** a stale `dist/robots.txt` with **no** authored
   source file is still regenerated. This is the ambiguity that motivated the source-tree rule.
5. A nested `src/pages/about/robots.txt` is ignored and does not suppress generation.
6. With the generator disabled and an authored file present, **no warning** is emitted.
7. With no authored file, the generated file is written exactly as before.
8. `<meta name="bascik-sitemap" content="exclude">` removes the page.
9. The 404 page is still excluded.
10. `generate.sitemapLastmod` off emits no `<lastmod>`; on, it emits one derived from mtime.
11. Duplicate `<loc>` entries are removed.
12. No `[` or `]` appears in output for any dynamic route.
13. URLs compose site URL, base, and path with no doubled or missing slash.
14. Two builds produce a byte-identical sitemap when `sitemapLastmod` is off.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): **the primary config.** Fetch `/sitemap.xml` from the
  built output and assert it contains the expected pages, excludes the marked page, excludes
  404, and contains no bracket. Fetch `/robots.txt` and assert the `Sitemap:` line resolves.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: both files are served
  correctly with a sensible content type.
- `playwright.dev.config.ts`: generation is build-only, so state that reasoning if you skip it.
  If dev does emit them after prompt 11's write restoration, test it.

Add a fixture with an **authored** `src/pages/robots.txt` in a separate build to assert the
precedence and the warning, if the harness supports a second fixture site.

## Documentation

| File                             | Change                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/sitemap.md`        | Authored-file precedence, **checked against the source tree and why it is not an output-tree check**. The `phase: 'post'` exec pattern for generation-plus-additions, placed **directly beneath the precedence rule**. The `bascik-sitemap` exclusion meta. `sitemapLastmod` and why it is opt-in. **Why `changefreq` and `priority` are intentionally absent** |
| `docs/content/configuration.md`  | `generate.sitemapLastmod`                                                                                                                                                                                                                                                                                                                                       |
| `docs/content/dynamic-routes.md` | Generated routes appear in the sitemap, correctly encoded                                                                                                                                                                                                                                                                                                       |
| `docs/content/faq.md`            | "Why did my hand-written robots.txt get overwritten?" Now fixed, but searchable                                                                                                                                                                                                                                                                                 |
| `docs/src/pages/assets/SKILL.md` | Authored files win and warn; use the exclusion meta for redirect-only pages. **Cross-reference prompt 02's migration procedure**, which tells an agent to inspect and delete rather than copy and disable. Sync `create/assets/SKILL.md`                                                                                                                        |

## Acceptance criteria

- [ ] All fourteen tests failed before their fixes and pass after.
- [ ] Generation does not race asset copying.
- [ ] Authored files are never overwritten; the warning names all three resolutions.
- [ ] **The existence check reads the source tree; a stale output artifact never blocks
      regeneration.**
- [ ] Robots and sitemap precedence are independent in both directions.
- [ ] A nested file is ignored; a disabled generator emits no warning.
- [ ] `bascik-sitemap` exclusion works; 404 still excluded.
- [ ] `sitemapLastmod` defaults off; two builds are byte-identical with it off.
- [ ] Duplicates removed; no brackets; base composed via the shared helper.
- [ ] **No `changefreq` or `priority` was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added; the user has run `yarn e2e:all`.
- [ ] Docs updated with the post-phase composition pattern beneath the precedence rule; both
      SKILL.md copies in sync.

## Do not do

- Do not merge generated output into authored files.
- Do not add an interactive prompt.
- Do not add `changefreq` or `priority`.
- Do not check the output tree for existence.
- Do not add a config array of excluded paths. Use the page-level meta.
- Do not run Playwright or pre-push scripts.
