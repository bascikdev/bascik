# 58: Articles infrastructure

Read `.github/prompts/00-README.md` first.

**Scope:** `docs/src/lib/nav.ts`, `docs/src/components/docs-sidebar/docs-sidebar.html`, a new
`docs/content/articles/` and `docs/src/pages/articles/`, plus
`docs/scripts/generate-llms-txt.ts` and `docs/scripts/generate-search-index.ts`.

**No package code changes.** This prompt builds the container. Prompts 59 through 62 write the
articles.

---

## What an article is, and is not

| Articles                      | Docs pages                   |
| ----------------------------- | ---------------------------- |
| Make an argument              | Describe how something works |
| Have a point of view          | Are neutral reference        |
| Are read once                 | Are returned to              |
| Can go out of date gracefully | Must be current              |

Keeping them **separate from the docs** is the point. An opinion piece in a reference section
undermines the reference; a reference page in an opinion section gets skimmed.

**Decision, do not re-litigate:** articles are a **section of the docs site**, not a separate
site, blog engine, or subdomain. They share the nav, the sidebar, the Markdown pipeline, the
search index, and `llms.txt`. Building a second content system for five pages would be absurd.

---

## Same conventions as everything else

Articles use the **identical** rendering approach as docs pages, per the repo's docs rules:

- Content lives in `docs/content/articles/*.md`.
- The HTML page is a shell with a `data-bascik-build` block calling `renderMd`.
- Fenced code blocks become `code-block` components; blockquotes become callouts.
- **No inline HTML in the Markdown.**
- **No `$...$`**, which renders literally. Prompt 01 covers this; **do not reintroduce it.**
- h1 equals sidebar label, per prompt 53.
- A `<title>` and `<meta name="description">` per shell.

**Do not invent an article-specific renderer, front matter format, or layout.** If an article
needs something `renderMd` cannot do, that is a signal the article should be written differently.

---

## Presentation decisions

Make each one deliberately and record it on the index page or in the code.

| Question                            | Guidance                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Index page or sidebar list?**     | An index page listing all articles with a one-line summary is likely better than five sidebar entries competing with reference pages. Decide, then be consistent |
| **Dates?**                          | An undated article looks abandoned. A dated one looks stale. **Prefer no dates** for evergreen pieces and make them evergreen by writing them that way           |
| **Authorship?**                     | Probably not. It is project documentation                                                                                                                        |
| **Ordering?**                       | Deliberate reading order, not alphabetical, not chronological                                                                                                    |
| **RSS?**                            | **No.** Five pages do not need a feed, and an unmaintained feed is worse than none                                                                               |
| **Reading time, tags, categories?** | **No.** Blog furniture for a five-page section                                                                                                                   |

---

## Search and `llms.txt`

Both are generated at build time. **Read `generate-search-index.ts` and `generate-llms-txt.ts`
before adding the section**, and determine how each discovers content.

- If they derive sections from `nav.ts`, articles are picked up automatically. **Prove it** by
  building and inspecting the output, not by assuming.
- If either enumerates directories, extend it.

**In `llms.txt`, articles should be distinguishable from reference documentation.** An agent
answering "how do I configure X" should weight the reference page above an essay that mentions X
in passing. If the format supports a section label, use it.

---

## TDD steps

1. Read both generator scripts and their tests. Establish how discovery works **before** changing
   anything.
2. Write a test asserting an articles page appears in the **search index**. It fails.
3. Write a test asserting it appears in **`llms.txt`**, labeled distinguishably. It fails.
4. Build the section: nav entry, sidebar or index, the directory, and **one placeholder article**
   with real content so the pipeline is exercised by something non-trivial.
5. Both tests pass.
6. Prompt 53's h1-equals-label test must cover the new page. Confirm.
7. Prompt 54's link-integrity test must cover article cross-links. Confirm.

The placeholder should be the **shortest real article**, so prompt 59 through 62 have a working
example to follow rather than an empty directory.

## Testing

**Unit:**

- The two generator tests above.
- An article page renders from its Markdown, guarding the wrong-`renderMd`-path failure, which
  produces an **empty page that builds cleanly**.
- The naming and link tests cover the section.

**E2E:** `docs/e2e/docs-components.spec.ts` exists. **Add a single navigation check**: the
articles section is reachable from the nav and an article renders its content. That is the one
thing a unit test cannot prove.

The four `pkg/e2e` configs do not apply; this is docs-site content with no package behavior.
**State that reasoning.**

**Verification:**

```sh
yarn docs:build
```

The section appears in the nav, the article renders **with content**, `docs/dist/llms.txt`
contains it and distinguishes it from reference pages, and the site search finds it by title.

## Documentation

| File                              | Change                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/articles/index.md`  | If you chose an index page: what this section is and why it is separate from the reference documentation                                                                                  |
| `.github/copilot-instructions.md` | **Record the articles conventions**: where content lives, that they use the same `renderMd` pipeline, and the presentation decisions made above. Future work will otherwise reinvent them |
| `docs/content/index.md`           | Link the section                                                                                                                                                                          |

**Not** SKILL.md. Articles are prose for humans; the skill file is operational guidance for
agents. Adding essays to it dilutes it. **Say so explicitly** rather than silently skipping.

## Acceptance criteria

- [ ] The generator tests failed first and pass now.
- [ ] The section exists in nav and the sidebar or index, with a deliberate reading order.
- [ ] One real placeholder article renders **with content**.
- [ ] Articles appear in the **search index** and in **`llms.txt`**, distinguishably labeled.
- [ ] **No article-specific renderer, front matter, or layout was invented.**
- [ ] **No RSS, tags, reading time, or dates** unless a stated reason was recorded.
- [ ] Prompt 53's naming test and prompt 54's link test cover the section.
- [ ] The docs E2E spec has a navigation check.
- [ ] The conventions are recorded in `.github/copilot-instructions.md`.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] No package source was modified.
- [ ] SKILL.md deliberately untouched, with the reason stated.

## Do not do

- Do not build a blog engine.
- Do not add front matter, RSS, tags, or reading time.
- Do not use `$...$` anywhere.
- Do not write articles 59 through 62.
- Do not modify package source.
- Do not run pre-push scripts.
