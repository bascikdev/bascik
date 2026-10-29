---
name: bascik-migrate
description: Migrate an existing website to Bascik. Use when converting a React, Next.js, Vue, Svelte, SvelteKit, Astro, Eleventy, Hugo, WordPress, or plain HTML site into Bascik pages and components; mapping props, slots, state, routing, layouts, data fetching, content collections, and template loops to Bascik equivalents; or handling existing sitemap.xml and robots.txt files during a migration.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Migrating to Bascik

Requires the `bascik` skill for component rules and the `bascik-scripts` skill for build-time data.

To have coding agents refactor a live site to production parity at every breakpoint and 100 in all five Lighthouse categories, install the opt-in `bascik-refactor` skill (`npx skills add bascikdev/bascik --skill bascik-refactor`) and read `node <skills-dir>/bascik/scripts/read-doc.mjs /how-to/agent-migration`.

## Procedure

1. **Inventory.** List every URL, shared layout region (`<head>` tags, header, footer, nav), repeated widget, data source, and client behavior. Run `node <skills-dir>/bascik/scripts/list-components.mjs` if Bascik components already exist.
2. **Read the framework guide.** `node <skills-dir>/bascik/scripts/read-doc.mjs /switch/from-<framework>` (`react`, `next`, `vue`, `svelte`, `astro`, `eleventy`, `hugo`, `wordpress`). Read it before writing any code; it maps each framework feature to its Bascik equivalent.
3. **Pages first.** One `.html` per URL in `src/pages/`, each with its own `<html>`, `<head>`, and `<body>`. Parameterized URLs become dynamic route templates.
4. **Extract components.** Shared head becomes `<site-head />`; header, footer, and nav become components; repeated widgets become components with props and slots. Use `scripts/new-component.mjs` for the folder layout.
5. **Move styles.** Delete framework scoped-style mechanisms and put the CSS in each component's companion `.css`. Class names stay the same; Bascik scopes them. Global styles go to `src/pages/css/styles.css`.
6. **Move behavior.** Replace state and effects with a plain `<script>` per component, targeting elements by `id`. Prefer HTML and CSS solutions where they exist.
7. **Move data.** Framework data loaders become `data-bascik-build` scripts that call helpers in `src/lib/`. Escape every interpolated value.
8. **Verify.** `node <skills-dir>/bascik/scripts/verify.mjs --build`, then compare old and new pages URL by URL.

## Cross-framework mapping

| Concept                                                                           | Bascik                                                                                                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Component file (`.jsx`, `.vue`, `.svelte`, `.astro`)                              | `src/components/<name>/<name>.html` with a hyphenated name (`Card.vue` becomes `info-card`)                                                  |
| Scoped styles (`<style scoped>`, CSS Modules, Svelte styles)                      | Companion `<name>.css`, scoped automatically                                                                                                 |
| `children`, `<slot />`, `{@render children()}`                                    | `data-bascik-slot` (no value), fallback inside                                                                                               |
| Named slots, render props, snippets                                               | `<div data-bascik-slot="x">` in the template and as the wrapper at the usage site                                                            |
| Props (`defineProps`, `$props()`, `props.x`)                                      | `data-bascik-prop-x`, text only                                                                                                              |
| Prop bound to an attribute                                                        | `data-bascik-attr-<attribute>="propName"`                                                                                                    |
| Object, array, or function props                                                  | Not possible: print one component per item from a build script, or embed JSON in `<script type="application/json">` (escape `<` as `\u003c`) |
| `useState`, `ref`, `$state`                                                       | Variables in the component `<script>`, applied to the DOM by a function                                                                      |
| Callback props, `$emit`, `v-model`                                                | `dispatchEvent(new CustomEvent('x', { bubbles: true, detail }))`, parent listens on its root                                                 |
| `v-if`, `{#if}`, conditional JSX                                                  | Build time: a build script prints one branch. Runtime: toggle `hidden`                                                                       |
| `.map()`, `v-for`, `{#each}`                                                      | Build-time loop in a build script, or clone a `<template>` at runtime                                                                        |
| File-system routing                                                               | One `.html` per URL in `src/pages/`                                                                                                          |
| `[slug]`, `getStaticPaths`, `generateStaticParams`, pagination                    | `src/pages/blog/[slug].html` (or `[slug]/index.html` for trailing slashes) with `<script data-bascik-routes>`                                |
| `getStaticProps`, `onMounted` fetch, front matter                                 | `<script data-bascik-build>` for shared data; `fetch()` in a component script for per-visitor data                                           |
| Layouts                                                                           | Pages keep `<html>`/`<head>`/`<body>`; layout pieces become components                                                                       |
| Template includes with variables, filters, loops (Nunjucks, Liquid, Go templates) | TypeScript helpers in `src/lib/` returning escaped HTML. Only static includes become components                                              |
| Content collections (`getCollection`, Eleventy collections)                       | A `src/lib/posts.ts` helper: `fs` read, `gray-matter`, `zod`, sort by parsed date                                                            |
| API routes (`app/api/x/route.ts`)                                                 | `src/api/x.ts` exporting `GET`/`POST`; `context.params` is a plain object; needs `bascik --server`                                           |
| `next/link`, `next/image`, `next/font`                                            | `<a>`, `<img>` with `width`/`height`, self-hosted `@font-face` plus `<link rel="preload">`                                                   |
| RSS/Atom feeds                                                                    | A `pipeline.exec` script with `phase: 'post'` writing to `BASCIK_OUT_DIR`                                                                    |
| Image optimization, syntax highlighting                                           | Not built in; add your own build step                                                                                                        |

## Gotchas that apply everywhere

- **Escape every interpolated value** in build scripts; JSX and Vue templates did it for you.
- **Component tag names need a hyphen.**
- **Named-slot wrappers are removed**, so wrap headings and links in a `<div data-bascik-slot="x">`.
- **Elements created with `document.createElement` get no element-selector styles.** Clone a `<template>` in the component instead.
- **Production moves component scripts to the end of the document.** Look up elements inside handlers or after `DOMContentLoaded`; keep pre-paint scripts (theme) in `<head>`.
- **Re-sync form state on `pageshow`** after Back/Forward or reload.
- **`bascik --check` reports components printed only by build scripts as unused.** That is expected.
- **Add `"html.validate.scripts": false` to `.vscode/settings.json`** (or run `bascik init`, which merges it in). Otherwise VS Code joins a page's `<script>` blocks into one file and reports false errors such as "A module cannot have multiple default exports".
- **Do not generate page files into `src/pages/`.** Use dynamic routes.
- **Exclude data-reading build scripts from the cache** (`scripts.cache.exclude`) and watch `content/` (`pipeline.watchPaths`).
- **Tailwind:** run it as a `pre` exec script with `scoping.attributes.class: false`; see `read-doc.mjs /libraries`.
- **Start from the examples** for layout, SEO tags, a blog, and interactive widgets: `add-example.mjs --list` in the `bascik` skill.

## Existing `sitemap.xml` and `robots.txt`

1. Read both files.
2. If they contain nothing Bascik would not generate (no hand-curated URLs, live `Disallow` rules, external sitemap index pointer, or bot-specific directives), delete them. Bascik generates fresh ones at build time. Do not copy them into `src/pages/` and do not disable `generate.sitemap` or `generate.robots`.
3. If they contain custom directives, keep the authored file in `src/pages/`, set the matching `generate` flag to `false`, and add a config comment explaining why.
4. Exclude redirect-only pages from the generated sitemap with `<meta name="bascik-sitemap" content="exclude">`.

Copying old files while disabling generation looks correct but freezes the sitemap at the old URL list forever.

For Astro, Eleventy, and Hugo, read the live guide with `read-doc.mjs /switch/from-astro` (or `from-eleventy`, `from-hugo`).
