# 60: Article, building the docs search

Read `.github/prompts/00-README.md` first.

**Scope:** one new article at `docs/content/articles/docs-search.md` and its page shell.

**Depends on prompt 58.**

**No package code changes.**

---

## The subject

The docs site has **working full-text search with no search service, no index server, and no
runtime dependency**. It is built at build time by `docs/scripts/generate-search-index.ts` and
queried by client-side JavaScript.

That is a genuinely interesting thing to have built, and it is a **worked example of the
build-time-first philosophy** applied to a feature people assume requires a service.

---

## Read the implementation first

**This article documents something real. Get it right.**

Before writing anything, read:

- `docs/scripts/generate-search-index.ts` and its test.
- The client-side search code in `docs/src/`, wherever it lives.
- The search UI component.
- Prompt 02's note, if it landed, about search-related SKILL.md guidance.

**Describe what the code does.** If the article and the code disagree, the article is wrong. If
you find a bug while reading, **note it for a follow-up** rather than fixing it here.

Quote real code. Do not paraphrase an algorithm you did not read.

---

## The interesting questions to answer

These are what a reader actually wants to know, and each has a real answer in the source.

| Question                                                     | Where it is answered                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| What goes into the index, and what is deliberately left out? | The generator's content extraction                                                                                                    |
| **How large is the index, and why is that acceptable?**      | Measure it from a real build                                                                                                          |
| How is it queried without a library?                         | The client code                                                                                                                       |
| How are results ranked?                                      | The client code. If ranking is naive, **say so**; a naive answer honestly described is more useful than an invented sophisticated one |
| What breaks at scale, and where is the ceiling?              | Your judgment, stated as judgment                                                                                                     |
| Why not Algolia, Pagefind, or Lunr?                          | The tradeoff. **Be fair to them**; they solve problems this does not                                                                  |

The size question is the crux. A build-time index ships to every visitor, so **the real number
matters**. Measure it. If it is large, say so and explain why it is still the right call, or
concede where it stops being one.

---

## Keep the transferability

The reader's takeaway should be **"I could build this for my own site"**, not "look what Bascik
did".

That means: describe the approach, not the specific file layout. Show the shape of the index.
Explain the decisions and what would change under different constraints.

An article about a feature is documentation. An article about **an approach**, illustrated by a
feature, is worth reading.

---

## Structure

Suggested.

1. **The assumption.** Site search means a service, or a heavy client library.
2. **The constraint.** A zero-runtime site cannot ship a large search library, and a static site
   has no server to query.
3. **The build-time index.** What it contains and how it is produced.
4. **The client.** How queries run and how results rank.
5. **The numbers.** Real, measured.
6. **The ceiling.** Where this stops working, honestly.
7. **The alternatives.** Fair treatment of the hosted and library options.

---

## Code examples

More than prompt 59's article, because this one is technical.

**Every block extracted from the real source via `extractDemoBlock`**, not retyped. If a marker
needs adding to a script file, the repo convention supports comment markers; use them.

Retyped code will diverge from the implementation on the next change, and an article about the
implementation that no longer matches it is actively misleading.

---

## Steps

1. Read all the search code and its tests.
2. **Measure the real index size** from `yarn docs:build`.
3. Draft the outline, including the honest ceiling section.
4. Add extraction markers where needed.
5. Write it.
6. Register in nav and the index or sidebar; h1 equals label per prompt 53.

## Testing

**Unit:**

- The page renders from its Markdown.
- **Every `extractDemoBlock` marker resolves**, which for this article also means the referenced
  source regions still exist. That is the coupling that keeps it accurate.
- Prompt 53's naming test and prompt 54's link test cover the page.

**E2E:** **none new** for the article itself. **However**, check whether
`docs/e2e/docs-components.spec.ts` already exercises search. If it does not, **add a test that
performs a real search and asserts a result**, because the article is about to claim it works and
nothing currently proves it.

Note that per the repo's testing rules, identifier minification means **E2E assertions must use
`data-testid` and `page.getByTestId`**, never raw class names or IDs. The search overlay is
explicitly called out as an example of this. Follow it.

**Verification:**

```sh
yarn docs:build
```

The article renders, every code block has content, and **the quoted code matches the current
source**. Re-read the source against the article one final time.

## Documentation

| File                                   | Change                                                    |
| -------------------------------------- | --------------------------------------------------------- |
| `docs/content/articles/docs-search.md` | The article                                               |
| `docs/content/articles/index.md`       | Entry and summary                                         |
| `docs/content/search.md`               | Link the article as the deeper explanation                |
| `docs/content/internals/*.md`          | Link, if an internals page covers the docs site's tooling |

**Not** SKILL.md, per prompt 58's reasoning.

## Acceptance criteria

- [ ] The article exists, renders with content, and is registered.
- [ ] **The implementation was read**, and every claim matches the source.
- [ ] **The index size is a real measured number.**
- [ ] Ranking is described accurately, including if it is naive.
- [ ] There is an honest "where this stops working" section.
- [ ] Alternatives are treated fairly.
- [ ] The article teaches an **approach**, not a file layout.
- [ ] **Every code block is extracted from real source**, with a test that every marker resolves.
- [ ] Search is covered by a docs E2E test using `getByTestId`, added if it was missing.
- [ ] Any bug found while reading the source is **noted, not fixed here**.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] No package source was modified.

## Do not do

- Do not paraphrase code you did not read.
- Do not retype code instead of extracting it.
- Do not invent an index size.
- Do not overstate the ranking.
- Do not use raw class names or IDs in E2E assertions.
- Do not fix search bugs here.
- Do not use `$...$`.
- Do not run pre-push scripts.
