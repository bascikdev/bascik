---
applyTo: "docs/**"
---

# Bascik Docs Instructions

These rules apply to all work inside `/docs/`. They must be read before creating or editing docs pages.

## Content Lives in Markdown

**All docs page content must be written in `docs/content/*.md` files, not directly in the HTML page.**

The Markdown files serve three purposes simultaneously:
1. They are the canonical source for the rendered docs page (via `data-bascik-build`)
2. They feed `llms.txt` (generated automatically via `exec` in `docs/bascik.config.ts`)
3. They feed `SKILL.md` (the Copilot skill file at `docs/src/pages/assets/SKILL.md`, served at `/assets/SKILL.md`)

**When adding or updating docs content:**
- Write the prose and code examples in the appropriate `docs/content/topic.md` file
- The HTML page is a shell: edit it only for page-specific chrome (custom styles, decorative UI, score grids, etc.)
- Never duplicate prose between the MD file and the HTML file

## How Pages Render from MD

Each docs page that has a corresponding MD file uses a `<script data-bascik-build>` block inside `<main class="docs-content">`:

```html
<!-- Content rendered from docs/content/topic.md at build time.
     To update page content, edit the MD file, not this file. -->
<script data-bascik-build>
  import { renderMd } from '@/lib/md-renderer.ts';
  console.log(await renderMd('./content/topic.md'));
</script>
```

`@/` is Bascik's import-root alias (`scripts.importRoot`, default `src`), so the same import line works from a page at any depth (`docs/src/pages/topic.html` and `docs/src/pages/how-to/topic.html` alike). Do not write depth-dependent `../lib/` or `../../lib/` paths, and do not use the older `pathToFileURL(join(process.cwd(), ...))` boilerplate.

The `renderMd` helper (`docs/src/lib/md-renderer.ts`) applies these transformations:
- Fenced code blocks (` ``` `) → `<code-block data-bascik-prop-lang="…">` component
- Blockquotes (`>`) → `<div class="callout">`

## HTML Page Shell Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <!-- title, styles.css, any page-specific <style> -->
</head>
<body>
  <docs-nav></docs-nav>
  <div class="container">
    <div class="docs-layout">
      <docs-sidebar></docs-sidebar>
      <main class="docs-content">
        <script data-bascik-build>
          import { renderSectionLabel } from '@/lib/render-nav.ts';
          console.log(renderSectionLabel('/topic'));
        </script>
        <!-- h1, page-intro p, and all content come from MD -->
        <script data-bascik-build>…</script>

        <!-- Any page-specific summary UI (technique grids, etc.) -->

        <div class="callout">
          <p><strong>Next:</strong> …</p>
        </div>
      </main>
    </div>
  </div>
  <docs-footer></docs-footer>
</body>
</html>
```

## Markdown File Conventions

- First lines: `# Page Title` (h1), then a plain intro paragraph (styled as page-intro via CSS)
- Prose: plain Markdown paragraphs
- Section headings: `##` (h2), sub-sections: `###` (h3)
- Code examples: fenced code blocks with a language tag (` ```html `, ` ```css `, ` ```js `, etc.)
- Callout/tip boxes: Markdown blockquote (`> **Label.** body text`)
- No inline HTML in MD files: keep MD pure Markdown

## Updating SKILL.md and create/assets/SKILL.md

**Do not run `#pre-push.prompt.md` or pre-push scripts automatically.** The user handles running pre-push steps.

Note: `llms.txt` and search index are generated automatically when running `yarn docs:build` (or during dev server via `exec` in `docs/bascik.config.ts`). **Lifecycle/generation scripts executed by `exec` must write their generated output files directly to the output directory (`dist/`), never to the source directories (`src/`), to avoid polluting the source tree with build-time artifacts.**

If manually updating or propagating `SKILL.md` when specifically requested:

```sh
yarn create:prepack
```

These files must stay in sync. A content change that lands in `docs/content/*.md` but not `SKILL.md` (or vice versa) means Copilot is working from stale guidance, which is how bugs like "use `querySelector` for per-instance elements" go undetected.

### Skill Authoring & Best Practices (agentskills.io)

When updating `SKILL.md`, follow the official Agent Skills best practices (https://agentskills.io/skill-creation/best-practices):

- **Illustrative vs. Literal Code Examples:** Frame code blocks and configuration options (such as `exec` script arrays, BYOMinifier custom transformers, or page-aware canonical helpers) with explicit commentary indicating they are illustrative examples. AI agents must understand what capabilities exist without copying example script paths or filenames literally.
- **Add What the Agent Lacks, Omit What It Knows:** Focus on Bascik-specific mechanics, transforms, scoping rules, and gotchas. Omit generic explanations of HTML, CSS, JavaScript, or standard web concepts.
- **Provide Defaults, Not Menus:** Always highlight the primary default pattern first (e.g. `getElementById` for per-instance DOM selection, or `deduplicateCss: true` in `bascik.config.ts`), and list alternative options concisely as escape hatches.
- **Calibrate Control:** Be prescriptive where operations are fragile or critical (e.g. using `getElementById` for per-instance script isolation, writing `exec` outputs to `dist/`, placing `<style>` above and `<script>` below HTML), and explain the rationale when providing procedural steps.
- **Gotchas and Constraints:** Keep non-obvious traps upfront and explicit (e.g. `querySelector('.cls')` targeting only the first instance under shared scoping, `innerHTML` class scanning limitations, or `data-bascik-build` and `data-bascik-server` being mutually exclusive).
- **Writing Style:** Keep entries concise, structured, and free of em-dashes. Use standard American English.

## Sidebar

Add new pages to `docs/src/components/docs-sidebar/docs-sidebar.html`. Group under the appropriate `<p class="sidebar-heading">` section.

## Code in HTML Slots (component-demo pattern)

Interactive demos use `<component-demo>` with named slots. **Code examples inside those slots must come from MD files**, not written inline as `&lt;`/`&gt;` entities in the HTML page.

### Why MD-first

MD files feed `llms.txt` and `SKILL.md`. If code examples only exist in HTML slots, LLMs never see them. Write example code in the relevant `docs/content/topic.md` file first; the HTML slot reads from there.

### How to add a demo code block to an MD file

Place an HTML comment marker immediately before the fenced code block:

```markdown
<!-- demo:source-html -->
` ` `html
<div class="fcard">
  <p class="fcard-label" data-bascik-prop-label></p>
</div>
` ` `
```

Marker IDs are arbitrary strings (e.g. `source-html`, `output-css`, `code`, `output`).

### How to use it in an HTML slot

Use `extractDemoBlock` from `src/lib/md-renderer.ts` inside a `data-bascik-build` script. Bascik trims slot content at build time, so normal indentation around the `<script>` tag is fine: no collapsed one-liner is needed.

```html
<div data-bascik-slot="source-html">
  <code-block data-bascik-prop-lang="html">
    <script data-bascik-build>
      import { extractDemoBlock } from '@/lib/md-renderer.ts';
      console.log(await extractDemoBlock('./content/03-scoped-css.md', 'source-html'));
    </script>
  </code-block>
</div>
```

## Fix Bugs in the Package, Not the Docs

This repo is the **bascik package itself** (`pkg/`). When a rendering or build issue (e.g. minification stripping newlines, whitespace collapsing, HTML output mangled) would otherwise require a workaround in the docs content or build scripts, **fix it in `pkg/src/` instead**. Do not paper over bascik bugs with hacks in the docs layer.

## Keeping SEO Meta in Sync with Content

Each docs page has a `<title>` and `<meta name="description">` hardcoded in its HTML file. These are **not** generated from the Markdown; they are maintained manually.

**When editing a `docs/content/*.md` file**, check whether the h1 or intro paragraph changed in a way that should be reflected in the corresponding HTML page's `<title>` or `<meta name="description">`. If so, update both together.

The mapping is straightforward: `docs/content/topic.md` corresponds to `docs/src/pages/topic.html`. The `<title>` should reflect the page's h1 (with ` - Bascik Docs` suffix for non-homepage pages), and the description should be a concise search-optimised summary drawn from the intro paragraph.

## Page Naming Convention (h1 equals sidebar label)

**A docs page's h1 must equal its sidebar (nav) label exactly**, with one explicit exception: `/compatibility` (label "Compatibility", h1 "Web Standards & Scoping Compatibility") because the full title is too long for a sidebar link.

Rules:

- Do not repeat the section name in the h1. The section label renders above it via `renderSectionLabel`.
- Overview pages are named "Overview" everywhere; the section label supplies the context.
- Do not use "Guide" as a suffix unless the sidebar says it too.
- A sidebar label must fit a sidebar; shorten the label, not the h1, when the full title is long.
- The `<title>` is the h1 plus ` - Bascik Docs` for non-homepage pages.

This is enforced by `docs/src/lib/nav-label-h1.test.ts`, which parses `nav.ts` labels, reads h1s from `docs/content/*.md`, and asserts equality (plus the title convention). **When adding or renaming a docs page**, keep the h1, nav label, and `<title>` in sync so that test stays green.

## Docs Writing Guide

Favor the term vanilla HTML/JavaScript/CSS over plain HTML/JavaScript/CSS.
