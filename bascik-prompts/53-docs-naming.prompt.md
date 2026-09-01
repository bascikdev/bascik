# 53: Docs naming convention

Read `.github/prompts/00-README.md` first.

**Scope:** `docs/content/**/*.md`, `docs/src/pages/**/*.html`,
`docs/src/components/docs-sidebar/docs-sidebar.html`, `docs/src/lib/nav.ts`, plus a new test.

**No package code changes.**

---

## The convention

**Decision, do not re-litigate:** **a page's h1 must equal its sidebar label exactly.**

Section context comes from the rendered **section label** above the h1, which already exists via
`renderSectionLabel` in `docs/src/lib/render-nav.ts`. Repeating the section name in the h1 is
redundant, and doing it inconsistently is worse than either extreme.

---

## Known mismatches

Compiled by inspection. **This list is almost certainly incomplete. Audit every page.**

| Sidebar label                    | Current h1                                   |
| -------------------------------- | -------------------------------------------- |
| Internals Overview               | Internals Guide                              |
| Overview (Testing section)       | Testing & Debugging Overview                 |
| Overview (Switch section)        | Switch to Bascik                             |
| From Astro                       | Switch from Astro                            |
| From Eleventy                    | Switch from Eleventy                         |
| From Hugo                        | Switch from Hugo                             |
| From Next.js                     | Switch from Next.js                          |
| From React                       | Switch from React                            |
| From Svelte                      | Switch from Svelte                           |
| From Vue                         | Switch from Vue                              |
| Markdown                         | Markdown Recipes                             |
| Server Scripts (Recipes section) | Server Script Recipes                        |
| Templating                       | Templating Recipes                           |
| CLI / Command Line               | Command Line Interface (CLI)                 |
| Build Scripts                    | Build-time Scripts                           |
| Scoping Compatibility            | Bascik Web Standards & Scoping Compatibility |
| Developer Experience             | Developer Experience Guide                   |
| Debugging                        | Debugging & VS Code Integration              |

---

## Which side wins

For each mismatch, decide which name is right. **Usually the h1 carries the better name and the
sidebar should adopt it**, but not always.

Rules of thumb:

- **Do not repeat the section name in the h1.** The section label renders above it. So "From
  Astro" is correct and "Switch from Astro" is not.
- **An overview page is named the same on both sides.** Prefer "Overview" everywhere, since the
  section label supplies the context. That resolves the Internals, Testing, and Switch cases
  consistently.
- **Do not use "Guide" as a suffix** unless the sidebar says it too. "Internals Guide" versus
  "Internals Overview" is exactly the kind of drift this convention prevents.
- **A sidebar label must fit a sidebar.** "Bascik Web Standards & Scoping Compatibility" is too
  long, so shorten the **h1** in that case rather than lengthening the label.
- Prefer the expanded form where it genuinely helps discovery. "Command Line Interface (CLI)" is
  more searchable than "CLI", so consider adopting it on **both** sides.

Whatever you choose, **apply it uniformly**. An inconsistent convention is no convention.

---

## The regression guard

**This is the real deliverable.** Without it the drift returns within a month.

Add a unit test in `docs/` that:

1. Parses `docs/src/components/docs-sidebar/docs-sidebar.html` for every link text and target.
2. Reads the h1 from the corresponding `docs/content/*.md`.
3. **Fails, naming both**, on any mismatch.

Write it **first**. It must fail listing every mismatch, and **that failure list is your work
queue**. If it lists fewer than the table above, your parsing is wrong. If it lists more, the
table was incomplete and you found the rest.

Handle nested paths, since `docs/content/internals/*.md` and `docs/content/testing/*.md` both
exist.

---

## Titles and descriptions

Every page has a `<title>` and `<meta name="description">` **hardcoded in its HTML file**. They
are **not** generated from the Markdown.

When you change an h1, **check whether the title should change too.** The convention is the h1
plus a ` - Bascik Docs` suffix for non-homepage pages.

**Consider extending the same test** to assert the `<title>` derives from the h1. If that is
cheap, do it; it closes the same drift on a second axis.

---

## Coordination with other prompts

Several prompts add pages and were told to match this convention from the start:

| Prompt | Page                                           |
| ------ | ---------------------------------------------- |
| 19     | `docs/content/preserve.md`                     |
| 48     | `docs/content/api-routes.md`                   |
| 56     | Four new how-to guides                         |
| 57     | `docs/content/how-to/publishing-components.md` |
| 58     | The Articles section                           |

**If any of those landed before this prompt, verify them.** If they land after, this test catches
them.

---

## TDD steps

1. **Write the regression test first.** It must fail with the complete mismatch list.
2. Work down the list. For each page: update the h1 or the sidebar label per the rules, then the
   `<title>` and `<meta name="description">`.
3. Re-run after each page so a partial fix is visible.
4. If you extended the test to titles, watch that half fail and fix it too.
5. Green.

## Testing

**Unit:** the regression test. It is the only test this prompt needs, and it is the one that
matters.

**E2E:** **none.** Page titles and headings are rendered content, and no E2E config asserts on
docs prose. **State that reasoning.**

**Verification:**

```sh
yarn docs:build
```

Then read the built site: every renamed page renders, the sidebar reads sensibly, the section
labels are correct, and **no internal link 404s**. A renamed page whose slug changed would break
links; this prompt should **not** change any slug, only display text. Confirm that.

## Documentation

This prompt **is** documentation work. Two additions beyond the renames:

| File                              | Change                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/copilot-instructions.md` | **Add the convention to the docs rules.** It already covers content-in-Markdown and title-description alignment; this belongs alongside them so future work follows it without being told |
| `docs/content/internals/*.md`     | If any page documents the docs site's own structure, note the convention and the test                                                                                                     |

## Acceptance criteria

- [ ] The regression test existed **before** any rename and failed with the complete list.
- [ ] **Every page's h1 equals its sidebar label.**
- [ ] The audit covered every page, not only the eighteen listed.
- [ ] Every changed page's `<title>` and `<meta name="description">` were reviewed.
- [ ] The convention was applied **uniformly**; no page follows a different rule.
- [ ] **No page slug changed**, so no internal link broke.
- [ ] Pages added by prompts 19, 48, 56, 57, and 58 already comply, or were fixed.
- [ ] The convention is recorded in `.github/copilot-instructions.md`.
- [ ] `yarn check:spelling` passes.
- [ ] `yarn docs:build` succeeds and every page renders.
- [ ] No package source was modified.

## Do not do

- Do not change any page slug or URL.
- Do not rename the Recipes section. **Prompt 54.**
- Do not rewrite page content. Headings and titles only.
- Do not add new pages.
- Do not run pre-push scripts.
