# 56: New how-to guides

Read `.github/prompts/00-README.md` first.

**Scope:** four new pages under `docs/content/how-to/` and `docs/src/pages/how-to/`, plus
additions to `docs/content/faq.md` and `docs/content/components.md`.

**Depends on prompt 54** for the directory name and prompt 53 for the naming convention.

**No package code changes.** If a guide cannot be written honestly because the package lacks a
capability, **say so and stop**; do not add the capability here.

---

## Guide A: bundling an npm package that has no CDN build

### Verify the premise first

The docs currently imply that bare specifiers work in client-side scripts. **Read the transpiler
before writing a word of this page** and determine what actually happens to
`import x from 'some-package'` in a client `<script type="module">`.

If Bascik does not rewrite it, the browser will fail on a bare specifier, and the page must say
that plainly. **Write what the code does, not what the docs currently claim.** If you find a
mismatch, note it for a follow-up rather than fixing it here.

### The recipe

An `exec` pipeline step running esbuild or rollup, writing the bundle into `directory.public`, and
the page referencing the built file.

Cover: where the bundle lands, why `directory.public` rather than the pages tree, how the step
orders relative to the build, and what happens on watch.

Show it working end to end with one real package. An abstract description of "run a bundler" is
not a guide.

---

## Guide B: asset fingerprinting

### Frame it accurately

**Bascik inlines CSS and JavaScript**, so fingerprinting matters for **images, fonts, and any
file in `directory.public`**, not for stylesheets and scripts. Lead with that, because a reader
arriving from another framework will expect the opposite.

### Point at the real fix first

**Prompt 39 added content-hash ETags and a `http.cacheControl` option.** For most sites that is
the correct and sufficient answer, and it requires no build step.

Fingerprinting is for the case where you want **immutable, far-future caching** on a CDN. Say
that, then give the recipe.

### The recipe

An `exec` step that hashes assets, renames them, and rewrites references. Be honest about the
reference-rewriting problem: it is the hard part, and a naive string replace across HTML is
fragile.

### Do not overclaim

**Do not claim a Lighthouse improvement.** `uses-long-cache-ttl` is **unweighted in Lighthouse 10
and later**, so fingerprinting will not move the score. The repo's docs make performance claims
carefully; keep that discipline.

---

## Guide C: sharing components across projects

**Pairs with prompt 57**, which adds `bascik add`.

Cover the state of the world **as it is when you write it**: a components directory is plain
files, so sharing means copying, a git submodule, or a package.

If prompt 57 has landed, document `bascik add` as the primary path and the others as
alternatives. If it has not, write the manual approaches and leave a clear place for it.

**The constraint to state:** component **names are derived from filenames**, and prompt 25 made
duplicate names a build error. So a copied component that collides with a local one **fails the
build**, by design. That is the first thing someone sharing components hits.

---

## Guide D: micro sites with Bascik

The case Bascik is unusually good at: a landing page, a documentation site for one tool, a
conference site, an internal dashboard. Small, static, fast, no framework.

Cover what a minimal project actually looks like, which features matter at that size and which to
ignore, and deployment for a site with no server.

**This guide is the source material for the article in prompt 59.** Write the practical version
here; the article makes the argument.

Keep them distinct. A how-to guide tells you how; an article tells you why.

---

## Smaller additions

| File                         | Addition                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/components.md` | An aside: components may live in **subfolders**, which prompt 25 confirmed, and names are derived from filenames regardless of nesting. State the duplicate-name error here too |
| `docs/content/faq.md`        | "Can I use an npm package with no CDN build?", "Should I fingerprint my assets?", "How do I share components between projects?", "Is Bascik a good fit for a one-page site?"    |

---

## Requirements for all four

- **Every code block extracted from a real fixture** via `extractDemoBlock`. Write the fixtures.
- **Every guide must be verified by actually doing it.** If the esbuild recipe is not run, it is
  a guess. If the fingerprinting `exec` step is not run, the reference-rewriting problem will be
  understated.
- Register each page in `nav.ts` and the sidebar.
- h1 equals sidebar label, per prompt 53.
- A `<title>` and `<meta name="description">` on each shell.
- Cross-link from related pages so the guides are reachable, not orphaned.

## Testing

**Unit:**

- Each fixture builds and produces the claimed output.
- Every `extractDemoBlock` marker resolves. A typo renders an **empty block** and builds cleanly.
- Prompt 53's h1-equals-label test covers the four new pages. Confirm it does.
- Prompt 54's link-integrity test covers the new cross-links.

**E2E:** **none.** These are content pages with no interactive behavior and no package change.
**State that reasoning.**

**Verification:**

```sh
yarn docs:build
```

Every new page renders with content. No empty code blocks. Every cross-link resolves. The new
pages appear in `docs/dist/llms.txt` and in the search index, since both are generated at build
time.

## Documentation

The prompt is the documentation. Beyond the four pages and the two smaller additions:

| File                             | Change                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/deploying.md`      | Cross-link fingerprinting and the micro-site guide                                                                                   |
| `docs/content/performance.md`    | Cross-link fingerprinting, **with the same no-Lighthouse-claim honesty**                                                             |
| `docs/content/libraries.md`      | Cross-link the bundling guide                                                                                                        |
| `docs/src/pages/assets/SKILL.md` | The bundling constraint and the duplicate-component-name error, if not already present from prompt 25. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] All four guides exist, are registered in nav and the sidebar, and are cross-linked.
- [ ] **Guide A's premise was verified against the transpiler source**, and the page states what
      the code does. Any mismatch with existing docs is noted.
- [ ] Guide B leads with the CSS-and-JS-are-inlined framing, points at prompt 39 first, and
      **makes no Lighthouse claim**.
- [ ] Guide C states the filename-derived-name and duplicate-name constraints.
- [ ] Guide D is practical and **distinct from prompt 59's article**.
- [ ] **Every recipe was actually run**, not described.
- [ ] Every code block comes from a real fixture; every marker resolves, with a test.
- [ ] The `components.md` aside and the four FAQ entries are added.
- [ ] Prompt 53's naming test and prompt 54's link test both cover the new pages.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] The new pages appear in `llms.txt` and the search index.
- [ ] Both SKILL.md copies in sync.
- [ ] No package source was modified.

## Do not do

- Do not add a package capability to make a guide work. Say the capability is missing.
- Do not claim bare specifiers work without verifying.
- Do not claim fingerprinting improves a Lighthouse score.
- Do not write the micro-site **article**. **Prompt 59.**
- Do not implement `bascik add`. **Prompt 57.**
- Do not run pre-push scripts.
