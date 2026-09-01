# 26: Build manifest

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/processing.ts`, `pkg/src/lib/file-system.ts`, `pkg/src/transpile.ts`.
Implements `generate.manifest`, which prompt 03 declared without behavior.

---

## Why

A manifest of what the build emitted enables three things that are impossible today:

1. **Answering "did this refactor change the output?"** Prompt 24 made builds deterministic, so
   comparing manifests between two commits is now meaningful.
2. **A deploy layer with something to consume.** Prompt 29's CSP hashes and prompt 56's
   fingerprinting recipe both want to know what shipped.
3. **Surgical cleanup.** Prompt 11 cleans the whole output directory. Prompt 33's targeted build
   cannot do that, and needs a record of what a previous run wrote.

---

## The artifact

Write `dist/.bascik/manifest.json` when `generate.manifest` is on. Default off.

**The dot-prefixed directory is deliberate:** prompt 10 added a request guard that 404s any path
containing a dot-segment, so the manifest is never served even though it lives in the output
directory. Confirm that guard covers it, with a test.

### Contents

For every file the build emitted into `directory.out`:

- the path, **relative to the output directory**, using forward slashes on every platform
- a content hash
- the byte size

Plus top-level metadata: the Bascik version, and whatever else a consumer plausibly needs.
**Do not include a timestamp**, because that would make the manifest itself
non-deterministic and defeat the primary purpose.

### Ordering

**Sorted by path, byte-wise.** Two builds of the same source must produce a byte-identical
manifest.

### When it is written

**Last**, after every other artifact including the sitemap, robots file, and any post-phase
`exec` output that writes into the output directory.

That ordering is awkward, because `runExecPhase("post")` runs after `watchFiles()` in
`transpile.ts`. Decide whether the manifest includes post-phase exec output. Including it is
more useful and more honest about what actually shipped. If you include it, the manifest write
must move after the post phase, and you must document that a post-phase script cannot read its
own manifest.

State the decision and its consequence in the docs.

---

## What counts as emitted

Everything Bascik wrote:

- transpiled pages, including pages generated from dynamic routes
- copied static assets from the pages directory
- copied assets from `directory.public`
- generated `sitemap.xml` and `robots.txt`
- prompt 27's server-script sidecar
- prompt 29's CSP hashes, if enabled

Do **not** include the manifest itself.

Files written by an `exec` script are the ambiguous case, resolved by the decision above.

---

## Implementation note

Do not compute the manifest by re-scanning the output directory at the end. That would include
stale files if the clean ever failed, and it would double the I/O.

Instead, **record each write as it happens.** Thread a collector through the write paths. That
also makes it correct for prompt 33's targeted build, where a re-scan would be wrong by
definition.

---

## TDD steps

Write each failing test first.

1. `generate.manifest: false` writes no manifest. This is the default, so assert it explicitly.
2. `generate.manifest: true` writes `dist/.bascik/manifest.json`.
3. Every emitted file appears, with a content hash and size.
4. The manifest does not include itself.
5. Paths are relative to the output directory and use forward slashes, including on Windows-style
   input paths.
6. Entries are sorted byte-wise by path.
7. **Two builds of the same source produce a byte-identical manifest.**
8. No timestamp appears anywhere in the file.
9. A request for `/.bascik/manifest.json` returns **404**, proving prompt 10's guard covers it.
10. Generated pages from dynamic routes appear.
11. Assets from `directory.public` appear.
12. The manifest is written after the sitemap and robots file, asserted by ordering, not by
    reading the source.
13. The post-phase exec decision behaves as documented.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): build a fixture with `generate.manifest: true`, assert
  the manifest exists and lists the expected pages and assets.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: assert
  `/.bascik/manifest.json` returns 404. **This is the important one**, because a leaked manifest
  discloses the full file inventory of the site.
- `playwright.dev.config.ts`: assert the same 404. Dev writes pages to the output directory
  after prompt 11, so the guard must hold there too.

## Documentation

| File                                     | Change                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/configuration.md`          | `generate.manifest`, default off, and what the file contains                                                                   |
| `docs/content/deploying.md`              | The manifest as a deploy-layer input. Give a short illustrative example of consuming it, framed as a recipe rather than an API |
| `docs/content/faq.md`                    | "What is `dist/.bascik/`?" covering the manifest and noting that prompts 27 and 29 add more files there                        |
| `docs/content/internals/architecture.md` | Writes are recorded as they happen, not by re-scanning                                                                         |
| `docs/src/pages/assets/SKILL.md`         | `dist/.bascik/` exists and is never served. Sync `create/assets/SKILL.md`                                                      |

## Acceptance criteria

- [ ] All thirteen tests failed before their fixes and pass after.
- [ ] `generate.manifest` defaults off.
- [ ] Every emitted file is listed with a hash and size; the manifest excludes itself.
- [ ] Paths are output-relative with forward slashes on every platform.
- [ ] Entries are byte-wise sorted.
- [ ] **Two builds produce a byte-identical manifest, and no timestamp is present.**
- [ ] `/.bascik/manifest.json` returns 404 in dev and both server modes.
- [ ] Writes are recorded as they happen, not re-scanned.
- [ ] The post-phase exec decision is made, documented, and tested.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.

## Do not do

- Do not include a timestamp or any other non-deterministic value.
- Do not compute the manifest by re-scanning the output directory.
- Do not use the manifest to change the clean behavior. Prompt 11 owns the clean; prompt 33 owns
  the targeted-build interaction.
- Do not add fingerprinting. That is a documented recipe in prompt 56.
- Do not run Playwright or pre-push scripts.
