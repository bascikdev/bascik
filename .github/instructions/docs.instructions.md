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
3. They are the reference the public agent skills in the repo-root `skills/` folder are written from. The docs build publishes those skills as `/assets/skills.tar.gz` and the core skill as `/assets/SKILL.md` (see "Updating the Agent Skills" below)

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
  import { renderMd } from "@/lib/md-renderer.ts";
  export default async () => await renderMd("./content/topic.md");
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
            import { renderSectionLabel } from "@/lib/render-nav.ts";
            export default async () => renderSectionLabel("/topic");
          </script>
          <!-- h1, page-intro p, and all content come from MD -->
          <script data-bascik-build>
            …
          </script>

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

## Images in `/assets/demos/` and `/assets/vscode/`

Both folders are served with `Cache-Control: public, max-age=31536000, immutable` on Cloudflare Pages (rule written by `docs/scripts/generate-pages-headers.ts`). That is only safe because every reference gets a `?v=<content hash>` from the image helper in `docs/src/lib/md-renderer.ts`. Always reference these images through a Markdown image (`![alt](/assets/demos/x@2x.webp)`) or `demoImage()` in a `data-bascik-build` script. Never write a raw `<img src>`, `<link href>`, or CSS `url()` into them: `docs/src/lib/versioned-image-references.test.ts` fails if you do. When re-recording a demo, keep the same file name; the hash changes on its own.

## Visuals

Three kinds of visual, each with one home. Do not mix them up, and do not add a fourth.

- **Recordings** of a real tool (editor, browser, terminal) are WebP or animated WebP in `/assets/demos/` and `/assets/vscode/`, produced by `docs/scripts/capture-demos.ts` and shown as Markdown images. Only use an image when the thing shown has to be a picture of a real program.
- **Diagrams** (a flow, a file tree, or a "you write / Bascik emits" comparison) are Bascik components: `diagram-figure`, `diagram-steps` with `diagram-step`, and `diagram-row` with `diagram-panel`. They are real HTML, so the text is selectable, searchable, and themable.
- **Live examples** that must run in the page are a `<component-demo>`.

### Diagrams

Markdown cannot hold a component, so a diagram goes in the page shell, at the end of the section it illustrates. Split that page's `renderMdRange` call at the heading that follows the section, put the diagram between the two ranges, and pass `{ stripDemoBlocks: true }` to any range that contains the diagram's code blocks.

Code shown in a panel is written once, as a demo block in `docs/src/diagrams/<page>.md` (the file named after the page), and read back with `extractDemoBlock('./src/diagrams/<page>.md', '<diagram-id>-<panel>')`. It lives there and not in `docs/content/` on purpose: a diagram restates prose and code the page already has, so its blocks must not feed the page's search entries or its Markdown. This is the one exception to "code in slots comes from `docs/content/`": that rule exists so `llms.txt` and the search index see the code, and a diagram adds nothing they do not already have. Name each block `<diagram-id>-<panel>`:

<!-- prettier-ignore -->
````markdown
<!-- demo:scoped-styles-global-classes-in -->
```html
<a class="skip-link dnav-logo">
```
````

Flow diagrams need no code blocks. Their text lives in props:

```html
<diagram-figure data-bascik-prop-title="One build, three phases">
  <diagram-steps>
    <diagram-step
      data-bascik-prop-title="'pre' scripts"
      data-bascik-prop-detail="Awaited before any page or component is transpiled."
    />
  </diagram-steps>
</diagram-figure>
```

For a comparison, use a `diagram-row` per pair of panels. Add `data-bascik-prop-direction="stack"` to stack them (use this for code with long lines), and `data-bascik-prop-arrow="↓"` on the second panel to draw the arrow. Side by side is the default and suits file trees. A diagram restates prose and code that already exist, so it must never carry information the text does not.

## Markdown File Conventions

- First lines: `# Page Title` (h1), then a plain intro paragraph (styled as page-intro via CSS)
- Prose: plain Markdown paragraphs
- Section headings: `##` (h2), sub-sections: `###` (h3)
- Code examples: fenced code blocks with a language tag (` ```html `, ` ```css `, ` ```js `, etc.)
- Callout/tip boxes: Markdown blockquote (`> **Label.** body text`)
- No inline HTML in MD files: keep MD pure Markdown

## Updating the Agent Skills (`skills/`)

**Do not run `#pre-push.prompt.md` or pre-push scripts automatically.** The user handles running pre-push steps.

Note: `llms.txt` and search index are generated automatically when running `yarn docs:build` (or during dev server via `exec` in `docs/bascik.config.ts`). **Lifecycle/generation scripts executed by `exec` must write their generated output files directly to the output directory (`dist/`), never to the source directories (`src/`), to avoid polluting the source tree with build-time artifacts.**

The public skills live in the repo-root `skills/` folder, one directory per skill (`bascik`, `bascik-components`, `bascik-compatibility`, `bascik-scripts`, `bascik-seo`, `bascik-config`, `bascik-testing`, `bascik-migrate`, and the opt-in `bascik-refactor`). That folder is the source of truth for every distribution channel:

- `npx skills add bascikdev/bascik` reads it straight from GitHub.
- `docs/scripts/publish-agent-skill.ts` (an `exec` producer) writes `/assets/skills.tar.gz`, the RFC 8615 discovery index `/.well-known/agent-skills/index.json` with one `<name>.tar.gz` per skill (so `npx skills add https://bascik.dev` works), and copies `skills/bascik/SKILL.md` to `/assets/SKILL.md`.
- `create-bascik` bundles a copy of every skill except the opt-in `bascik-refactor` in `create/assets/skills/`, which the scaffold copies into `.agents/skills/` and `.claude/skills/`. Refresh it with `yarn create:prepack` (the `prepare` and `prepack` scripts remove `bascik-refactor` after copying); `create/src/skill-sync.test.ts` fails when the copy drifts or an opt-in skill is bundled. Readers install `bascik-refactor` with `npx skills add bascikdev/bascik --skill bascik-refactor`.

**The docs are the reference; the skills are a router.** A skill holds only the must-follow rules an assistant gets wrong without them, short decision tables, and "How do I..." tables that point to docs pages (`read-doc.mjs /path`). Explanations, option lists, and code examples belong in `docs/content/`, never in a skill. There are no `references/` folders, except in `bascik-refactor`: its `references/` hold the prompt templates and the production-parity contract that the `/how-to/agent-migration` page hands to coding agents. When a docs change alters a rule, default, API, or pitfall that a skill states, update that rule in the same task. When a skill needs guidance the docs do not have, add it to the docs and link to it.

Structure rules:

- Each `SKILL.md` stays short (well under 500 lines) with prescriptive rules up front. `name` must match the directory name.
- Every docs path a skill names (`read-doc.mjs /path`, a backticked `/path` in a "Read" column, or `https://bascik.dev/path`), including `#fragments`, must exist; `docs/scripts/skill-links.test.ts` fails otherwise. Every example a skill names must exist in `examples/`.
- Scripts are dependency-free Node.js (22.18+) `.mjs` files that run from the user's project root. The exception is `bascik-refactor`, whose scripts load Playwright and sharp from the reader's own project through `scripts/lib/project-deps.mjs` and fail with an install command when either is missing. Shared helpers live in `skills/bascik/scripts/lib/`; other skills refer to `<skills-dir>/bascik/scripts/...` rather than copying them. A script that belongs to another skill stays self-contained (no imports from `bascik/scripts/lib/`), because that skill can be installed on its own.

## Examples (`examples/`)

The repo-root `examples/` folder is the only copy of every example: `examples/components/<name>/<name>.html` (standalone components) and `examples/starter-site/` (a complete project). They are examples to copy and adapt, not a component library: no package, no stable API.

- The docs register `../examples/components` as a second component root, so the components render live. Each has a page at `/example-components/<name>` whose Markdown is `docs/content/example-components/<name>.md`; the page reads the component file and the `<!-- demo:usage -->` block at build time through `renderExample()` in `docs/src/lib/examples.ts`. `<!-- example:file <path> -->` and `<!-- example:tree <folder> -->` markers in that Markdown show other example files. Never paste example code into Markdown.
- The docs section is "Example Components" and has one page per component. The starter site has no docs page (its README on GitHub explains it) because showing it means deploying it separately. Its files are still published in `/assets/examples.json` for `add-example.mjs`.
- `docs/e2e/examples.spec.ts` serves a temporary copy of the starter site with `bascik --server`, adds the test page `docs/e2e/fixtures/example-components.html` (two of every component, with `data-testid` wrappers), and tests each pair there, then the site-level behavior.
- `docs/scripts/publish-examples.ts` publishes `/assets/examples.json` (built by `docs/scripts/examples-bundle.ts`), which `skills/bascik/scripts/add-example.mjs` downloads. `docs/scripts/examples.integration.test.ts` builds the starter site and copies examples into fresh projects with `add-example.mjs`, then runs `bascik --check`, the linter, and the skill audit scripts.
- A new component example needs: its folder with an `@bascik` description, a docs page (shell, Markdown, nav entry), and a pair on `docs/e2e/fixtures/example-components.html` with an E2E test (`docs/scripts/examples-bundle.test.ts` checks all three). Pass props as `data-bascik-prop-<name>="..."`; a plain attribute is forwarded to the root, not a prop.
- Example components use no `@/` imports: the docs site and other projects resolve `@/` against their own import root.
- `skills/bascik-config/scripts/audit-config.mjs` hard-codes config defaults. `pkg/src/lib/agent-skill-config-defaults.test.ts` fails when they drift from `pkg/src/lib/config.ts`; update the table when a default changes.
- After changing a script, run it against a real project (for example `pkg/e2e/` or `docs/`) before finishing.
- Contributor-only skills in `.github/skills/` must carry `metadata: internal: true` so `npx skills add` does not offer them. Check with `npx skills add . --list` from the repo root.
- `docs/scripts/skill-bundle.test.ts` checks frontmatter (an unquoted value must not contain `: ` or ` #`, or `npx skills add` skips the skill), line counts, and relative links; the docs hygiene tests scan `skills/**/*.md` for outdated script patterns.

### Skill Authoring & Best Practices (agentskills.io)

When updating a skill, follow the official Agent Skills best practices (https://agentskills.io/skill-creation/best-practices):

- **Illustrative vs. Literal Code Examples:** Frame code blocks and configuration options (such as `exec` script arrays, BYOMinifier custom transformers, or canonical helpers that read page context) with explicit commentary indicating they are illustrative examples. AI agents must understand what capabilities exist without copying example script paths or filenames literally.
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

MD files feed `llms.txt`, the search index, and the agent skills' docs lookup scripts. If code examples only exist in HTML slots, LLMs never see them. Write example code in the relevant `docs/content/topic.md` file first; the HTML slot reads from there.

### How to add a demo code block to an MD file

Place an HTML comment marker immediately before the fenced code block:

<!-- prettier-ignore -->
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
      import { extractDemoBlock } from "@/lib/md-renderer.ts";
      export default async () =>
        await extractDemoBlock("./content/03-scoped-css.md", "source-html");
    </script>
  </code-block>
</div>
```

## Fix Bugs in the Package, Not the Docs

This repo is the **bascik package itself** (`pkg/`). When a rendering or build issue (e.g. minification stripping newlines, whitespace collapsing, HTML output mangled) would otherwise require a workaround in the docs content or build scripts, **fix it in `pkg/src/` instead**. Do not paper over bascik bugs with hacks in the docs layer.

## Keeping SEO Meta in Sync with Content

Each docs page has a `<title>` and `<meta name="description">` hardcoded in its HTML file. These are **not** generated from the Markdown; they are maintained manually.

**When editing a `docs/content/*.md` file**, check whether the h1 or intro paragraph changed in a way that should be reflected in the corresponding HTML page's `<title>` or `<meta name="description">`. If so, update both together.

The mapping is straightforward: `docs/content/topic.md` corresponds to `docs/src/pages/topic.html`. The `<title>` is written for search results, not derived from the h1: lead with the search phrase a developer would type (for example "Scoped CSS for HTML Components, No Shadow DOM - Bascik"), keep it 15-65 characters, name Bascik, and keep it unique. Pages without a strong search phrase keep the `{h1} - Bascik Docs` form. The `og:title` and `TechArticle` headline follow the `<title>` automatically, while the breadcrumb label uses the short sidebar label. The description should be a concise search-optimised summary drawn from the intro paragraph.

## Page Naming Convention (h1 equals sidebar label)

**A docs page's h1 must equal its sidebar (nav) label exactly**, with one explicit exception: `/compatibility` (label "Compatibility", h1 "Web Standards & Scoping Compatibility") because the full title is too long for a sidebar link.

Rules:

- Do not repeat the section name in the h1. The section label renders above it via `renderSectionLabel`.
- Overview pages are named "Overview" everywhere; the section label supplies the context.
- Do not use "Guide" as a suffix unless the sidebar says it too.
- A sidebar label must fit a sidebar; shorten the label, not the h1, when the full title is long.
- The `<title>` is independent of the h1 (see "Keeping SEO Meta in Sync with Content"); it only has to be unique, name Bascik, and fit 15-65 characters.

This is enforced by `docs/src/lib/nav-label-h1.test.ts`, which parses `nav.ts` labels, reads h1s from `docs/content/*.md`, and asserts equality, plus the title rules above. **When adding or renaming a docs page**, keep the h1 and nav label in sync and give the page a unique `<title>` so that test stays green.

## Docs Writing Guide

Favor the term vanilla HTML/JavaScript/CSS over plain HTML/JavaScript/CSS.
