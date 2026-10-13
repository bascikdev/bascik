---
name: bascik
description: Build websites with Bascik, the zero-runtime HTML component build tool. Use whenever a project depends on @bascik/bascik, has a bascik.config.ts, or keeps components in src/components/*.html, or when the user mentions Bascik. Covers pages, components, slots, props, attribute inheritance, the bascik CLI (dev, --build, --server, --check, add), project layout, and verifying compiled dist/ output. Start here; companion skills cover scoping, scripts, config, testing, and migration.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Bascik

Bascik is a build tool for HTML components. It expands custom tags such as `<site-nav />` into the matching component file, scopes the component's CSS, IDs, classes, and scripts, and writes plain HTML pages to `dist/`. It adds zero JavaScript: every script in the output is one you wrote.

It is not a framework. There is no virtual DOM, reactive state, client router, template language, Shadow DOM, or runtime. Write vanilla HTML, CSS, and JavaScript, and let Bascik do the isolation at build time.

Code in this skill is illustrative. Adapt tag names, paths, and values to the project instead of copying example names literally.

## Recognize a Bascik project

- `package.json` depends on `@bascik/bascik`, or the root has `bascik.config.ts` / `bascik.config.js`, or there are `.html` files under `src/components/`.
- Node.js 22.18 or newer (24 LTS recommended). Node runs `.ts` helpers natively, so no TypeScript build step exists.
- Standard scripts: `npm run dev` (`bascik`), `npm run build` (`bascik --build`), `npm run lint` (`bascik-language-server --check`).

## Project layout

```text
src/
  components/            component templates; the file name is the tag name
    site-nav/
      site-nav.html      <site-nav>
      site-nav.css       optional companion stylesheet, scoped to site-nav
      site-nav.ts        optional companion script, loaded with <script src="site-nav.ts">
  pages/                 one .html file per URL, plus public assets
    index.html           /
    about.html           /about
    blog/post.html       /blog/post
    404.html             served for unknown routes
    css/styles.css       copied to dist/css/styles.css (global, unscoped)
  lib/                   shared Node helpers for build and server scripts (import with @/lib/...)
  api/                   optional API route handlers (bascik --server only)
dist/                    compiled output, never edited by hand, never committed
```

## Write a component

Default pattern: `<style>` above the markup, markup in the middle, `<script>` below. Give every element a script must control an `id` and find it with `getElementById`.

```html
<!-- src/components/like-button/like-button.html -->
<style>
  .like { padding: 0.5rem 1rem; border-radius: 6px; }
  .like.active { background: #d3ff8d; }
</style>
<button class="like" id="btn" type="button">
  <span data-bascik-prop-label>Like</span>
</button>
<script>
  const btn = document.getElementById('btn');
  btn.addEventListener('click', () => btn.classList.toggle('active'));
</script>
```

```html
<!-- src/pages/index.html -->
<like-button data-bascik-prop-label="Like this post" />
<like-button data-bascik-prop-label="Like this comment" />
```

Bascik rewrites `.like` to `.bascik__like-button__like`, gives each instance its own `id` (`bascik__like-button__<instance>__btn`), rewrites the `getElementById` string and the `classList` class to match, and wraps the script in an IIFE. Both buttons work independently. To see the exact output, run [`scripts/preview.mjs`](scripts/preview.mjs).

New components are picked up by the running dev server automatically; no restart is needed.

## Rules (must follow)

1. **Hyphenated, lowercase file names.** `feature-card.html` becomes `<feature-card>`. Never name a component after a native element (`header.html`, `dialog.html`): it replaces every such element on the page. Names must be unique across every component root.
2. **Per-instance targeting uses `id`.** Use `getElementById` (or `getElementsByName`) for elements a script controls. `querySelector('.cls')` returns the first instance on the page, so the other instances look broken.
3. **Order:** `<style>` above the markup, `<script>` below it.
4. **Props carry text only.** `data-bascik-prop-*` values are HTML-escaped strings. Pass markup or nested components through slots (`data-bascik-slot`).
5. **Self-close** components that take no slot content: `<site-head />`, `<site-footer />`.
6. **HTML and CSS first.** Reach for JavaScript only when HTML and CSS cannot do the job cleanly (`<details>`, `<dialog>`, `:has()`, `popover` cover a lot).
7. **Runtime state in `data-` attributes.** Toggle `data-state="open"` and style `.panel[data-state="open"]`; anchor attribute selectors on a scoped class.
8. **Zero config.** Do not create `bascik.config.ts` unless a requirement differs from a default, and never put `siteUrl` in it. See the `bascik-config` skill.
9. **Never write generated files into `src/`.** Generated output goes to `dist/` (`BASCIK_OUT_DIR`) from an existing `pipeline.exec` script.
10. **Client scripts are not bundled.** Bare imports such as `import x from 'pkg'` fail in the browser. They work only in Node-side scripts (`data-bascik-build`, `data-bascik-server`).
11. **Extract shared layout.** Repeated `<head>` tags, headers, and footers become components (`<site-head />`, `<site-header />`, `<site-footer />`). Pages keep their own `<html>`, `<head>`, and `<body>`.
12. **Script directives are exclusive.** One `<script>` tag takes at most one of `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, `data-bascik-stream`.

## Slots, props, and attributes

| Need | Component template | Usage site |
|---|---|---|
| Default slot (rich HTML) | `<div data-bascik-slot>fallback</div>` | `<my-card><h2>Title</h2></my-card>` |
| Named slot | `<div data-bascik-slot="header"></div>` | `<div data-bascik-slot="header"><h1>Hi</h1></div>` inside the tag |
| Text prop | `<p data-bascik-prop-title></p>` | `<my-card data-bascik-prop-title="Hello" />` |
| Prop into an attribute | `<img data-bascik-attr-src="image" data-bascik-attr-alt="alt">` | `<my-card data-bascik-prop-image="/a.png" data-bascik-prop-alt="A" />` |
| Forward attributes | (nothing) | `<my-card class="wide" aria-label="Promo" />` lands on the first root element |

The slot element itself is replaced by the content, so named-slot wrappers disappear: wrap headings and links in a `<div data-bascik-slot="x">` rather than putting the attribute on the `<h1>` or `<a>`. Full details: [references/components.md](references/components.md).

## Script tags at a glance

| Tag | Runs | Use for |
|---|---|---|
| `<script>` | Browser | Component and page behavior (scoped, IIFE-wrapped) |
| `<script data-bascik-build>` | Node, at build time | Markup from files, Markdown, APIs; output replaces the tag |
| `<script data-bascik-routes>` | Node, at build time | Expanding `[slug].html` templates into many pages |
| `<script data-bascik-server>` | Node, per request | Personalized markup (needs `bascik --server` or a serverless target) |
| `<script data-bascik-stream>` | Node, per request, streamed | Slow per-request blocks that should not delay the page shell |
| `<script data-bascik-dev>` | Browser, dev only | Debug helpers removed from production builds |

Node-side scripts export a default function that returns an HTML string. Details are in the `bascik-scripts` skill.

## CLI

```sh
bascik                      # dev server at http://localhost:8080 with live reload and watch
bascik --build              # production build to dist/ (HTML, CSS, JS, and identifier minification on)
bascik --build --only "blog/**"   # rebuild matching pages without cleaning dist/
bascik --server             # serve a built dist/ (needed for server/stream scripts and API routes)
bascik --check              # validate pages, components, config, and API routes without building
bascik add <package>        # copy components from an installed npm package into src/components/
bascik init                 # add Bascik to an existing project
npx @bascik/language-server --check   # lint scoping patterns, unclosed tags, and directives
```

New project: `npm create bascik@latest my-site -y`. Production builds need a site URL for `sitemap.xml` and `robots.txt`: `BASCIK_SITE_URL=https://example.com bascik --build` (or `--site-url`, or `.env`). Full CLI, dev workflow, and error messages: [references/cli.md](references/cli.md).

## Verify every change

Do not stop at "the file looks right". Run these from the project root:

1. `node <skill-dir>/scripts/verify.mjs` runs `bascik --check` and the language server linter and summarizes both. Add `--build` to also run a production build.
2. `node <skill-dir>/scripts/preview.mjs '<my-card data-bascik-prop-title="Hi" />' --count 2` compiles a snippet with the project's real components and config and prints the unminified output, so you can confirm scoped names, slot placement, and script rewrites.
3. Read the relevant file in `dist/` after a build. A hyphenated tag still present in `dist/` means no component matched it.

`<skill-dir>` is the directory containing this file, for example `.agents/skills/bascik`.

## Bundled scripts

All scripts are dependency-free Node.js (22.18+) and run from the project root. Each prints `--help`.

| Script | Purpose |
|---|---|
| [`scripts/verify.mjs`](scripts/verify.mjs) | `bascik --check` plus `@bascik/language-server --check`, with an optional `--build` |
| [`scripts/preview.mjs`](scripts/preview.mjs) | Compile a snippet, file, or existing page in a temporary build and print the result |
| [`scripts/list-components.mjs`](scripts/list-components.mjs) | Inventory components with their props, slots, companion files, and `@bascik` descriptions |
| [`scripts/new-component.mjs`](scripts/new-component.mjs) | Create a component folder that follows the naming and ordering rules |
| [`scripts/search-docs.mjs`](scripts/search-docs.mjs) | Search the live docs at bascik.dev for a topic |
| [`scripts/read-doc.mjs`](scripts/read-doc.mjs) | Print the current text of a docs page, such as `/scoped-javascript` |

Run `list-components.mjs` before creating a component so you reuse what exists instead of duplicating it.

## Look up current documentation

This skill covers the common path. For anything else, query the live docs instead of guessing:

```sh
node <skill-dir>/scripts/search-docs.mjs "dynamic routes trailing slash"
node <skill-dir>/scripts/read-doc.mjs /dynamic-routes
```

The full page index is also at https://bascik.dev/llms.txt.

## Companion skills

| Skill | Load it when |
|---|---|
| `bascik-scoping` | Writing component CSS or `<script>` code, or compiled class and ID names look wrong |
| `bascik-scripts` | Using `data-bascik-build`, `-routes`, `-server`, `-stream`, Markdown, or API routes |
| `bascik-config` | Creating or editing `bascik.config.ts`, deploying, or running `bascik --server` |
| `bascik-testing` | Writing tests, debugging, validating output, or tuning Lighthouse scores |
| `bascik-migrate` | Moving a site from React, Next.js, Vue, Svelte, Astro, Eleventy, Hugo, or WordPress |

If the companions or this skill's `references/` and `scripts/` folders are missing, the skill was installed as a single file. Reinstall the full set:

```sh
npx skills add bascikdev/bascik
# or, without npx skills:
mkdir -p .agents/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills
```

## References

- [references/components.md](references/components.md): component format, companion files, `@bascik` metadata, slots, props, attribute inheritance, head components, external custom elements
- [references/cli.md](references/cli.md): every CLI command and flag, dev server behavior, error output, `bascik --check`, inspecting `dist/`
- [references/libraries.md](references/libraries.md): CDN libraries, npm packages in the browser, petite-vue, Alpine.js, Tailwind CSS, HTMX
- [references/faq.md](references/faq.md): common questions and edge cases
