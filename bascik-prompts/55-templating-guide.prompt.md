# 55: Templating how-to rewrite

Read `.github/prompts/00-README.md` first.

**Scope:** `docs/content/how-to/templating.md` and its page shell.

**Depends on prompt 54**, which moved the file. If that has not landed, the file is still at
`docs/content/recipes/templating.md`; **do the rewrite there and let prompt 54 move it.**

**No package code changes.** This is a content rewrite.

---

## What the page does today

It presents five approaches in this order: template literals, a tiny helper, EJS, Nunjucks, and
Handlebars.

Two problems:

1. **It opens with the weakest option.** Template literals are what you already know; that is not
   a recipe.
2. **It never recommends anything.** Five options and no guidance is a menu, and the repo's own
   skill-authoring rules say to **provide defaults, not menus**.

---

## The new shape

### Lead with the recommendation

**Decision, do not re-litigate:** **Handlebars is the recommended templating library.** It is
small, has no runtime dependency in the output, and its logic-less design fits a build-time
system where the template is evaluated once and the result is static HTML.

Say that in the first paragraph. Then show it working.

### Then the dependency-free option

A **roughly fifteen-line** `${path.to.value}` substitution helper. Someone adding one interpolated
value to one page should not install anything.

Requirements for the helper:

- Resolves dotted paths against a plain object.
- **Escapes HTML by default.** A helper that interpolates unescaped user data into HTML is an
  injection bug, and a docs page that ships one teaches the bug. Show the escape function; do not
  hand-wave it.
- Documents what it does on a missing key, and makes that behavior deliberate rather than
  accidental.
- Is genuinely short. If it grows past about twenty lines, **that is the signal to reach for
  Handlebars**, and saying so is the most useful sentence on the page.

### Then the alternatives, briefly

EJS and Nunjucks stay, compressed, framed as "if you already know it or already have it".

### Keep the framing

The existing "why Bascik stays out of the template layer" explanation is good and should survive
the rewrite. Build scripts are plain Node, so any templating library works with no integration
layer. That is the actual point of the page.

---

## The fetch-once pattern

**This is the most valuable addition.** It is the pattern anyone building a data-driven page
needs, and it is nowhere in the docs.

Fetch or read the data **once at page level** in a single `data-bascik-build` script, then apply
it everywhere on the page. Not once per component instance.

### The cache warning is mandatory

Prompt 31 documented that **build script cache invalidation cannot see network fetches.** The
cache keys on script content and declared inputs, so a script whose output depends on a remote
API will be **served from cache with stale data** across builds.

State this as a **callout**, not a footnote. Give the escape: exclude that script from caching, or
disable the cache, and show exactly how using the config option prompt 31 added.

Someone who follows the fetch pattern without knowing this ships a stale site and has no idea
why.

---

## The JSON payload example

A `<script type="application/json">` block emitted at build time and read by client JavaScript.

Frame it **honestly**: this is the one approach on the page that **requires client-side
JavaScript**, which is a real cost on a zero-runtime site. It is worth it when the data drives
interaction, not when it drives initial render.

**The gotcha to state explicitly:** the script's `id` is **scoped at build time**, so client code
must use `getElementById` with the **scoped** name. This is the same rule as everywhere else in
Bascik, and it is the thing people get wrong. Prompt 20 formalized ID reference rewriting; make
sure the example matches what that prompt implemented rather than what the page says today.

---

## Examples must come from real fixtures

**Every code block on this page must be extracted from a working fixture via `extractDemoBlock`**,
per the repo's docs conventions.

A templating page full of hand-written examples that nobody runs will rot on the next transpiler
change. Put the fixtures where the E2E or unit suite already exercises them so a break is caught.

If a fixture does not exist for an example, **write the fixture**. That is part of this prompt,
not a reason to hand-write the block.

---

## Steps

1. Read the current page in full. Keep what is good; the framing paragraph is good.
2. Build the fixtures: Handlebars, the tiny helper, the fetch-once pattern, and the JSON payload.
3. Verify each fixture actually builds and produces the output the page will claim.
4. Rewrite the Markdown, extracting every block from those fixtures.
5. Add the cache callout as a blockquote, per the repo's Markdown conventions.
6. Update the page shell's `<title>` and `<meta name="description">` if the h1 changed, and honor
   prompt 53's h1-equals-sidebar-label rule.

## Testing

**Unit:** if the fixtures live under a package with a test suite, assert each builds and produces
the expected output. **A fixture nobody runs is a hand-written example with extra steps.**

Also assert `extractDemoBlock` finds every marker the page references. A typo'd marker renders an
**empty code block** and builds cleanly.

**E2E:** **none.** No package behavior changed and no page interaction was added. **State that
reasoning.**

**Verification:**

```sh
yarn docs:build
```

Read the built page. Every code block has content. The Handlebars example is first. The cache
warning is a visible callout, not buried prose. The JSON example's `getElementById` call matches
the scoped ID the build actually produces, checked in the built output rather than assumed.

## Documentation

| File                                | Change                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/how-to/templating.md` | The rewrite                                                                                                                                                      |
| `docs/content/build-scripts.md`     | Cross-link the fetch-once pattern and **repeat the cache caveat**. Someone reading about build scripts should not have to find the templating page to learn it   |
| `docs/content/configuration.md`     | Ensure the cache-exclusion option from prompt 31 is documented well enough to be used from this page                                                             |
| `docs/content/faq.md`               | "Which templating library should I use with Bascik?" answering Handlebars, and "Why is my build script returning stale data?" answering the cache                |
| `docs/src/pages/assets/SKILL.md`    | The fetch-once pattern **and the cache exclusion gotcha**. This is exactly the kind of non-obvious trap the skill file exists for. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] **Handlebars leads and is explicitly recommended**, with a stated reason.
- [ ] The dependency-free helper is about fifteen lines, **escapes HTML**, and says when to
      graduate to Handlebars.
- [ ] EJS and Nunjucks remain, compressed.
- [ ] The "why Bascik stays out of the template layer" framing survives.
- [ ] The fetch-once pattern is documented **with the cache-exclusion warning as a callout** and a
      concrete escape.
- [ ] The JSON payload example is framed honestly as requiring client JavaScript, and its
      `getElementById` uses the **scoped** ID, verified against real build output.
- [ ] **Every code block is extracted from a real fixture** via `extractDemoBlock`.
- [ ] A test asserts every referenced marker resolves.
- [ ] The h1 follows prompt 53's convention; title and description reviewed.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] Both SKILL.md copies in sync.
- [ ] No package source was modified.

## Do not do

- Do not hand-write code blocks.
- Do not recommend a templating library Bascik integrates with. It integrates with none, and that
  is the point.
- Do not ship an interpolation helper without HTML escaping.
- Do not bury the cache warning.
- Do not add the other new how-to guides. **Prompt 56.**
- Do not run pre-push scripts.
