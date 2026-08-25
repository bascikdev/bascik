# Bascik

[![CI](https://github.com/bascikdev/bascik/actions/workflows/ci.yml/badge.svg)](https://github.com/bascikdev/bascik/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/%40bascik%2Fbascik.svg)](https://www.npmjs.com/package/@bascik/bascik)
[![License: BSAL-1.0](https://img.shields.io/badge/License-BSAL--1.0-blue.svg)](https://bascik.dev/license)
[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)
[![Unit branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.branches.pct&label=unit%20branches&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)
[![E2E lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.lines.pct&label=e2e%20lines&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)
[![E2E functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.functions.pct&label=e2e%20functions&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)
[![E2E branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.branches.pct&label=e2e%20branches&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)

Bascik is a build tool for HTML components. It is **not** a JavaScript framework — you write vanilla HTML, CSS, and JavaScript.

Bascik acts as a build-time find-and-replace: it resolves custom HTML tags to their component source, scopes CSS and JavaScript per component instance, and writes a `dist/` directory of vanilla HTML files. **Zero JavaScript is added to your pages.** Every script in the output was written by you.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Setup](#project-setup)
- [Folder Structure](#folder-structure)
- [Full Documentation](#full-documentation)
- [Configuration](#configuration)
- [Publishing](#publishing)
- [Development](#development)
- [Internals: Transpilation Pipeline](#internals-transpilation-pipeline)
- [Contributing](#contributing)

---

## Getting Started

Requires **Node.js ≥ 22.18**.

```sh
yarn add @bascik/bascik
# or
npm install @bascik/bascik
# or
pnpm add @bascik/bascik
```

---

## Project Setup

```json
{
  "scripts": {
    "dev": "bascik",
    "build": "bascik --build"
  }
}
```

`dev` — transpiles your project, starts the HTTP/2 dev server, and watches for changes.  
`build` — transpiles to `dist/` only.

---

## Folder Structure

```text
src/
  pages/       ← one .html file per route (plus CSS, images, etc.)
  components/  ← component .html (+ optional .css) files
```

Both directories can be overridden in `bascik.config.ts`.

---

## Full Documentation

Full feature documentation lives at **[bascik.dev](https://bascik.dev)**.

| Topic                   | URL                                                                          |
| ----------------------- | ---------------------------------------------------------------------------- |
| Getting started         | [bascik.dev/getting-started](https://bascik.dev/getting-started)             |
| Slots                   | [bascik.dev/slots](https://bascik.dev/slots)                                 |
| Props                   | [bascik.dev/props](https://bascik.dev/props)                                 |
| Attribute inheritance   | [bascik.dev/attribute-inheritance](https://bascik.dev/attribute-inheritance) |
| Scoped styles           | [bascik.dev/scoped-styles](https://bascik.dev/scoped-styles)                 |
| Scoped JavaScript       | [bascik.dev/scoped-javascript](https://bascik.dev/scoped-javascript)         |
| Configuration reference | [bascik.dev/configuration](https://bascik.dev/configuration)                 |
| CSS/JS compatibility    | [bascik.dev/compatibility](https://bascik.dev/compatibility)                 |

---

## Configuration

Create an optional `bascik.config.ts` in the project root:

```js
export const bascikConfig = {
  directory: {
    pages: "src/pages", // default
    components: "src/components", // default
  },
  watch: [], // re-transpile all pages when these paths change in dev

  scopeScriptBlocks: true, // wrap scripts in IIFEs, rewrite selectors
  inheritAttributes: true, // forward non-bascik attrs onto the component root
  scopeAttribute: {
    class: true, // scope class attribute values
    id: true, // scope id attribute values
    name: true, // scope name attribute values
  },

  minify: {
    html: false,
    css: true,
    js: false,
    identifiers: true, // hash class/id names to short hex strings
  },
  inlineStyles: false, // false | true | ['src/css/styles.css']
  cacheHttp: false, // HTTP cache headers on dev server responses
};

// Options applied only during `bascik --build`, merged over bascikConfig
export const buildOverrideConfig = {
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
};
```

`minify.identifiers` is an impactful production setting: it turns `bascik__site-nav__a1b2c3__navigation` into a short hash like `ba1b2c3d`.

---

## Publishing

This repo has two independently versioned packages, each released by pushing a git tag.
The [Release workflow](../.github/workflows/release.yml) builds and publishes automatically, and `dist/` is **not** committed to git.

### Tag scheme

| Package | Tag format | Example |
|---|---|---|
| `@bascik/bascik` (`pkg/`) | `v<semver>` | `v0.3.0` |
| `create-bascik` (`create/`) | `create-v<semver>` | `create-v0.2.0` |

The `if:` condition on each workflow job ensures only the relevant package is published when a tag is pushed.

### Release checklist — `@bascik/bascik`

1. **Update version** in `pkg/package.json` following [Semantic Versioning](https://semver.org/).
2. **Update `CHANGELOG.md`** — move entries from `[Unreleased]` to the new version with today's date.
3. **Run tests locally** with `yarn pkg:unit` or `yarn pkg:test:ci`.
4. **Commit and tag**:
   ```sh
   git add pkg/package.json CHANGELOG.md
   git commit -m "chore: release v0.3.0"
   git tag v0.3.0
   git push origin main --tags
   ```
5. The Release workflow picks up the `v*.*.*` tag, runs tests, builds, and publishes to npm.

### Release checklist — `create-bascik`

1. **Update version** in `create/package.json`.
2. **Update `CHANGELOG.md`** if applicable.
3. **Run tests locally** with `yarn workspace create-bascik test:ci`.
4. **Commit and tag**:
   ```sh
   git add create/package.json
   git commit -m "chore: release create-bascik v0.2.0"
   git tag create-v0.2.0
   git push origin main --tags
   ```
5. The Release workflow picks up the `create-v*.*.*` tag, runs tests, builds, and publishes to npm.

### Prerequisites

Ensure the `NPM_TOKEN` secret is set in the repository settings (Settings → Secrets and variables → Actions) before pushing a release tag.

### Manual publish (if needed)

```sh
# For @bascik/bascik
yarn pkg:build
yarn workspace @bascik/bascik npm publish --access public

# For create-bascik
yarn create:build
yarn workspace create-bascik npm publish --access public
```

---

## Development

Requires Node.js ≥ 24. Run `yarn install` from the repo root.

```sh
yarn pkg:build        # compile dist/
yarn pkg:unit         # unit tests, single run
yarn pkg:test         # unit tests in watch mode
yarn pkg:test:ci      # unit tests + coverage summary (used in CI)
yarn pkg:e2e          # E2E tests
yarn pkg:typecheck    # JSDoc/TypeScript type check
yarn pkg:coverage     # update unit & E2E coverage
yarn pkg:bench        # micro-benchmarks
```

### Tests

```sh
yarn pkg:test           # watch mode
yarn pkg:unit           # single run
yarn pkg:test:ci        # single run + coverage summary (used in CI)
yarn pkg:coverage       # full coverage report → coverage/
```

### Type checking (JSDoc + checkJs)

The source is vanilla JavaScript with JSDoc type annotations. TypeScript's compiler checks them without a build step:

```sh
yarn pkg:typecheck
```

This runs `tsc --noEmit` using `tsconfig.json` (`checkJs: true`, `strict: true`). Fix any reported errors before opening a PR.

### Benchmarks

Repeatable micro-benchmarks for the transpile pipeline (powered by vitest bench):

```sh
yarn pkg:bench
```

**Baseline numbers (Node.js 24, Apple M-series):**

| Scenario                               | ops/sec | mean latency |
| -------------------------------------- | ------- | ------------ |
| `minifyHtml` — small HTML              | ~138K   | ~7.2µs       |
| `minifyHtml` — large HTML (50×)        | ~81     | ~12.4ms      |
| `getTag` — paired                      | ~778K   | ~1.3µs       |
| `getTag` — self-closing                | ~1.07M  | ~0.9µs       |
| `prefixClassesInCss` — realistic CSS   | ~14.1K  | ~70.7µs      |
| `scopeCssCustomProperties` — 10 props  | ~69.4K  | ~14.4µs      |
| `recursivelyTranspile` — 10 components | ~7.17K  | ~140µs       |
| `recursivelyTranspile` — 50 components | ~809    | ~1.23ms      |
| `deduplicateCss` — 20 entries          | ~1.28M  | ~0.8µs       |

Run `yarn bench` after any change to the hot paths to catch regressions.

---

## Internals: Transpilation Pipeline

This section is for contributors who want to understand how Bascik processes source HTML into its final output. All code lives in `pkg/src/lib/`.

### Overview

Bascik runs in two nested phases:

```
Page Phase  (pageProcessing)
└── Component Phase  (recursivelyTranspile)  ← recursive, once per tag
    └── Scoping Pipeline  (buildScopingPipeline → applyTransforms)
```

---

### Page Phase

Triggered by `pageProcessing(pagePath)` — once per `.html` file.

```
1. Read source file → strip comments, collapse whitespace  (minifyHtml)
2. Extract <body> inner content
3. Extract <head> inner content
4. Run Component Phase on <body>  →  { transpiledBody, usedComponents }
5. Run Component Phase on <head>  →  { transpiledHead, headComponents }
6. Collect CSS from all used components, deduplicate, inject <style>  (deduplicateCss)
7. Inject live-reload SSE <script>  (dev mode only)
8. Reassemble: replace <body> and <head> contents in the original HTML
9. Store in memory for the dev server  (dev mode)
10. Write to dist/  (both modes)
```

---

### Component Phase

`recursivelyTranspile(html, componentList)` recurses until no custom tags remain:

```
Base case: no custom tag found → return { html, usedComponents }

For each custom tag found:

  ┌─ 1. SCOPING PIPELINE ─────────────────────────────────────────┐
  │   buildScopingPipeline(instanceId) returns ComponentTransform[]  │
  │   Each step: BascikComponent → BascikComponent                │
  │                                                               │
  │   a. prefixElementAttribute('id',    instanceId)              │
  │   b. prefixElementAttribute('name',  instanceId)              │
  │   c. prefixElementAttribute('class', instanceId)  ← also CSS  │
  │   d. namespaceScriptTags                          ← IIFE wrap  │
  │                                                               │
  │   Each step is skipped if disabled in bascik.config.ts.       │
  └───────────────────────────────────────────────────────────────┘

  ┌─ 2. TEMPLATE RESOLUTION ──────────────────────────────────────┐
  │   a. injectProps         — fill data-bascik-prop-* markers    │
  │   b. replaceNamedSlots   — fill data-bascik-slot="name" zones  │
  │   c. default slot        — fill data-bascik-slot (no value)  │
  │                            with inner content or fallback      │
  │   d. mergeAttributesOntoRoot — pass-through attrs to root     │
  └───────────────────────────────────────────────────────────────┘

  ┌─ 3. SUBSTITUTION ─────────────────────────────────────────────┐
  │   Replace the original usage tag with the resolved HTML.      │
  │   Recurse on the updated HTML string.                         │
  └───────────────────────────────────────────────────────────────┘
```

---

### Scoping Pipeline Detail

`prefixElementAttribute(component, 'class'|'id'|'name', instanceId)` handles both HTML and CSS:

```
For every attribute value found in the template HTML:

  HTML:  id="my-btn"      →  id="bascik__comp__a1b2c3__my-btn"
  JS:    getElementById("my-btn")  →  getElementById("bascik__comp__a1b2c3__my-btn")
         querySelector("#my-btn")  →  querySelector("#bascik__comp__a1b2c3__my-btn")

For class attribute, also scopes the companion .css file:
  .nav { }              →  .bascik__comp__a1b2c3__nav { }
  p { }                 →  .bascik__comp__a1b2c3__el__p { }  (+ class injected on <p>)
  @keyframes spin       →  @keyframes bascik__comp__a1b2c3__keyframe__spin
  --brand: #d3ff8d      →  --bascik__comp__a1b2c3__brand: #d3ff8d
  var(--brand)          →  var(--bascik__comp__a1b2c3__brand)
  [id] { }              →  (stripped — cannot be scoped without DOM wrapping)
```

When `minify.identifiers: true` (the production default), all generated names are hashed to short hex strings: `bascik__comp__a1b2c3__nav` → `bab12cd3`.

---

### Adding a New Pipeline Step

All scoping steps share the `ComponentTransform` signature — `(c: BascikComponent) => BascikComponent`. To add a new transform:

1. Write the transform function in the relevant `lib/` module.
2. Add it to `buildScopingPipeline()` in `processing.ts`, guarded by a config flag if it should be opt-in.
3. Export it and add tests.

```ts
// Example: adding a hypothetical new scoping step
const buildScopingPipeline = (instanceId: string): ComponentTransform[] =>
  ([
    BascikConfig.scopeAttribute.id    && (...),
    BascikConfig.scopeAttribute.name  && (...),
    BascikConfig.scopeAttribute.class && (...),
    BascikConfig.scopeScriptBlocks    && namespaceScriptTags,
    BascikConfig.myNewFeature         && myNewTransform,  // ← add here
  ] as (ComponentTransform | false)[]).filter(Boolean);
```

---

## Contributing

1. Fork the repo and create a branch from `main`.
2. Write tests for new functionality (TDD preferred).
3. Run `yarn pkg:unit` and `yarn pkg:typecheck` (both must pass).
4. Run `yarn pkg:bench` if touching the transpile pipeline, including numbers in the PR description.
5. Update `CHANGELOG.md` under `[Unreleased]`.
6. Open a PR against `main`.
