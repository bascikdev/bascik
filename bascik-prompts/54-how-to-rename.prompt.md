# 54: Rename Recipes to How-to

Read `.github/prompts/00-README.md` first.

**Scope:** `docs/src/lib/nav.ts`, `docs/src/components/docs-sidebar/docs-sidebar.html`,
`docs/src/pages/recipes/`, `docs/content/recipes/`, cross-links across the docs, and both
SKILL.md copies.

**No package code changes.**

---

## Why

"Recipes" says nothing about what the reader will find. **"How-to" is the standard term** in the
Diátaxis vocabulary that the rest of the site already follows in spirit: overviews explain,
reference pages describe, and these pages walk you through a task.

It is also more searchable. People type "how to" into a search box; nobody types "recipe".

---

## The rename is not just a directory move

| Location                                             | Change                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `docs/src/lib/nav.ts#L67`                            | The section entry; the label **and** the path prefix                                          |
| `docs/src/components/docs-sidebar/docs-sidebar.html` | The `sidebar-heading` text and every link                                                     |
| `docs/src/pages/recipes/`                            | Move to `docs/src/pages/how-to/`                                                              |
| `docs/content/recipes/`                              | Move to `docs/content/how-to/`                                                                |
| Every `data-bascik-build` block in the moved pages   | The `renderMd` path argument, which is relative and **will silently render nothing** if stale |
| Every cross-link in `docs/content/**`                | `/recipes/x` becomes `/how-to/x`                                                              |
| `docs/src/pages/assets/SKILL.md`                     | Any `/recipes/` URL                                                                           |
| `create/assets/SKILL.md`                             | Same, keep in sync                                                                            |
| `README.md` files                                    | Any docs link                                                                                 |

**Decision, do not re-litigate:** **no redirects.** Bascik is unreleased, the docs site is not
published under a stable URL contract, and adding a redirect layer for a pre-1.0 rename is
permanent complexity for zero readers. Rename cleanly.

---

## The two generated artifacts

`docs/scripts/generate-llms-txt.ts` and `docs/scripts/generate-search-index.ts` both build a
section-aware view of the docs.

**Read both before renaming.** Determine whether they derive section names from `nav.ts` or
**hardcode** them.

- If they derive from `nav.ts`, they need no change, but **prove it** by regenerating and
  diffing.
- If either hardcodes "Recipes", fix it to derive from `nav.ts`. A hardcoded copy is the same
  drift problem prompt 53 solved for headings.

The generated `llms.txt` and search index feed **agents and site search**. A stale section name
there is invisible in the browser and very visible to an LLM reading the site.

---

## The grep that finishes the job

After moving everything:

```sh
grep -ri "recipes" --include="*.ts" --include="*.html" --include="*.md" --include="*.json" .
```

Expect zero hits outside this prompt file and any historical changelog entry. Check
`extensions/vscode-bascik/` and `.github/skills/` too, since both contain prose that agents read.

A hit in `docs/dist/` is stale build output; rebuild rather than editing it.

---

## TDD steps

1. **Write a link-integrity test first**, if the docs package does not already have one. It walks
   `docs/content/**/*.md` and `docs/src/pages/**/*.html`, extracts internal links, and asserts
   each resolves to a real page. Run it **before** the rename to confirm it passes, so you know
   it works.
2. Move the two directories.
3. Update `nav.ts` and the sidebar.
4. Fix every `renderMd` path in the moved pages. **These fail silently**, so verify by building
   and reading the pages, not by assuming.
5. Re-run the link test. It should now fail on every stale cross-link. Fix them.
6. Regenerate `llms.txt` and the search index; diff for a stale section name.
7. Grep.

The link test is worth writing even though this prompt is the only immediate consumer. It will
catch the next rename too, and prompts 56, 57, and 58 all add cross-linked pages.

## Testing

**Unit:** the link-integrity test, and any existing `docs/scripts/*.test.ts` that assert on
section names.

**E2E:** `docs/e2e/docs-components.spec.ts` exists. **Check whether it navigates to any
`/recipes/` URL** and update it. Otherwise no new E2E, because a directory rename produces no new
behavior. **State that reasoning.**

**Verification:**

```sh
yarn docs:build
```

Then confirm: the sidebar heading reads How-to, every moved page renders **with its content**
rather than an empty shell, `docs/dist/llms.txt` names the section correctly, and the site search
finds a how-to page by title.

The empty-shell case is the one to watch. A wrong `renderMd` path produces a page with a nav, a
footer, and nothing in between, and it **builds without error**.

## Documentation

| File                                     | Change                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `docs/content/how-to/*.md`               | The moved files. Update any self-referential prose that says "recipe" |
| `docs/content/index.md` and any overview | Links and section name                                                |
| `docs/src/pages/assets/SKILL.md`         | URLs; sync `create/assets/SKILL.md`                                   |
| `.github/copilot-instructions.md`        | If it names the Recipes path anywhere                                 |

## Acceptance criteria

- [ ] The link-integrity test exists, passed before the rename, failed during, and passes after.
- [ ] Both directories moved; `nav.ts` and the sidebar updated.
- [ ] **Every moved page renders its content**, verified by reading the built output, not
      assumed.
- [ ] `llms.txt` and the search index name the section correctly, and neither hardcodes it.
- [ ] `grep -ri "recipes"` returns nothing outside this prompt file.
- [ ] `extensions/vscode-bascik/` and `.github/skills/` checked.
- [ ] **No redirects were added.**
- [ ] `docs/e2e/docs-components.spec.ts` checked for `/recipes/` URLs.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] Both SKILL.md copies in sync.
- [ ] No package source was modified.

## Do not do

- Do not add redirects.
- Do not rewrite the content of the moved pages. **Prompt 55 rewrites templating; prompt 56 adds
  new guides.**
- Do not edit `docs/dist/`.
- Do not run pre-push scripts.
