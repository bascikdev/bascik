# 61: Article, the scoping engine

Read `.github/prompts/00-README.md` first.

**Scope:** one new article at `docs/content/articles/scoping-engine.md` and its page shell.

**Depends on prompt 58.** Also depends on a large amount of prompts 13 through 24 having landed,
since the article describes behavior those prompts change. **Write it against the code as it
exists when you write it**, not against this description.

**No package code changes.**

---

## The subject

Bascik scopes CSS and JavaScript **at build time**, with no shadow DOM, no runtime, and no
custom element registration. A component's styles do not leak out and are not leaked into, and
the mechanism is entirely visible in the output.

Most readers' mental model of component scoping is Shadow DOM or a CSS-in-JS runtime. This
article replaces that model.

---

## Read the implementation first

Before writing, read the scoping source in `pkg/src/lib/`: the CSS scoping path, the JavaScript
scoping path, class and ID rewriting, and the transpile loop.

Also read `docs/content/compatibility.md`, which is the maintained table of what the engine
handles. **It is the ground truth for capability claims.** If the article claims something the
table does not, one of them is wrong; find out which and **note it**.

**There is a repo-wide rule** that scoping capability changes require updating
`compatibility.md`. This article must not become a second, unmaintained copy of that table. Link
to it rather than restating it.

---

## The interesting parts

| Topic                                                            | What makes it worth writing about                                                                                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Why not Shadow DOM**                                           | Real tradeoffs: style inheritance, form participation, third-party tooling, and the runtime cost. Be fair; Shadow DOM is a reasonable choice for other goals                                   |
| **The specificity problem**                                      | Scoping must isolate without making every selector unbeatable. How the engine keeps authored specificity meaningful                                                                            |
| **CSS nesting, keyframes, container queries, custom properties** | Each needs different handling. These are the details that make the engine non-trivial                                                                                                          |
| **`deduplicateCss`**                                             | Per-type versus per-instance is **the** defining architectural decision, and prompt 21 resolved a real tension in it. Explain the tradeoff                                                     |
| **JavaScript scoping**                                           | Why `getElementById` on a scoped ID is the default pattern, and why `querySelector('.cls')` **finds only the first instance** under shared scoping. This is the most common real-world mistake |
| **What it cannot do**                                            | `innerHTML` class scanning limitations, and anything else `compatibility.md` marks unsupported                                                                                                 |
| **Determinism**                                                  | Prompt 24 made instance IDs deterministic, so the same input produces byte-identical output. Explain why that matters for caching and diffs                                                    |

---

## Lead with the mistake

The `querySelector` versus `getElementById` distinction is the single most valuable thing on this
page.

It is subtle, it is not what people expect coming from other tools, and it produces a bug that
**works perfectly on a page with one instance** and breaks on a page with two.

Do not bury it. Give it its own section with a worked example showing both the wrong and right
version and the actual output of each.

---

## Structure

Suggested.

1. **The expectation.** Scoping means Shadow DOM or a runtime.
2. **The alternative.** Rewrite at build time; ship plain HTML and CSS.
3. **How CSS scoping works**, including the hard cases.
4. **How JavaScript scoping works**, including the `querySelector` trap.
5. **`deduplicateCss`** and the per-type decision.
6. **Determinism** and why it is worth having.
7. **The limits**, linking `compatibility.md`.

---

## Code examples

**Input and output pairs are the whole value here.** Show authored source and the actual emitted
result.

**Every block extracted via `extractDemoBlock` from real fixtures.** The docs site already uses
the `component-demo` pattern with `source-html` and `output-css` style markers for exactly this;
reuse the mechanism.

**Hand-written output examples will be wrong**, because the exact emitted form depends on
minification settings, the scoping hash format, and several of prompts 13 through 24. Extract
them, or the article will be misleading within a week.

---

## Steps

1. Read the scoping source and `compatibility.md`.
2. Identify existing fixtures that demonstrate each point. Write new ones only where none exist.
3. Verify each input-output pair by **building it and reading the real output**.
4. Draft the outline with the `querySelector` section prominent.
5. Write it.
6. Register in nav and the index or sidebar; h1 equals label per prompt 53.

## Testing

**Unit:**

- The page renders from its Markdown.
- **Every marker resolves**, including the output-side markers, which is what keeps the emitted
  examples true.
- Prompt 53's naming test and prompt 54's link test cover the page.

**E2E:** **none new.** Every behavior described is already covered by the package's scoping tests
across the four configs; this article documents them rather than adding behavior. **State that
reasoning**, and **name the existing tests** that cover the `querySelector` and multi-instance
claims so a reader of the pull request can verify the article is grounded.

If you find a claim **no test covers**, that is a gap. **Note it** rather than filing it under
this prompt.

**Verification:**

```sh
yarn docs:build
```

Every output example matches what the build actually emits. **Check at least two by hand against
`docs/dist/`.**

## Documentation

| File                                                       | Change                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `docs/content/articles/scoping-engine.md`                  | The article                                                                                      |
| `docs/content/articles/index.md`                           | Entry and summary                                                                                |
| `docs/content/scoped-styles.md` and `scoped-javascript.md` | Link the article as the deeper explanation                                                       |
| `docs/content/compatibility.md`                            | Link the article for the reasoning behind the table. **Do not restate the table in the article** |
| `docs/content/internals/*.md`                              | Link from the relevant internals page                                                            |

**Not** SKILL.md, per prompt 58's reasoning. The `querySelector` guidance **already belongs
there** and should already be present from earlier prompts. **Verify it is**, and if it is not,
that is a real gap worth fixing.

## Acceptance criteria

- [ ] The article exists, renders with content, and is registered.
- [ ] **The scoping source was read**, and every claim matches the code as it currently stands.
- [ ] The `querySelector` versus `getElementById` trap has a prominent section with a worked
      wrong-and-right example.
- [ ] Shadow DOM is treated **fairly**, as a different set of tradeoffs.
- [ ] `deduplicateCss` per-type versus per-instance is explained.
- [ ] Determinism and why it matters is covered.
- [ ] Limits link `compatibility.md` rather than **duplicating** it.
- [ ] Any disagreement between the article and `compatibility.md` was investigated and **noted**.
- [ ] **Every code block, input and output, is extracted from real fixtures**, with at least two
      output examples verified by hand against `docs/dist/`.
- [ ] The existing tests covering the article's key claims are **named in the pull request**.
- [ ] Any uncovered claim is noted as a gap.
- [ ] SKILL.md's `querySelector` guidance verified present.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] No package source was modified.

## Do not do

- Do not hand-write emitted output.
- Do not duplicate the compatibility table.
- Do not describe behavior from an earlier prompt's description instead of from the code.
- Do not fix scoping bugs found while reading. Note them.
- Do not use `$...$`.
- Do not run pre-push scripts.
