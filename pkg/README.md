# Bascik

[![CI](https://github.com/bascikdev/bascik/actions/workflows/ci.yml/badge.svg)](https://github.com/bascikdev/bascik/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/%40bascik%2Fbascik.svg)](https://www.npmjs.com/package/@bascik/bascik)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://bascik.dev/license)
[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)
[![Unit branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.branches.pct&label=unit%20branches&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)
[![E2E lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.lines.pct&label=e2e%20lines&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)
[![E2E functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.functions.pct&label=e2e%20functions&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)
[![E2E branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.branches.pct&label=e2e%20branches&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)

Bascik is a build tool for HTML components. It is **not** a JavaScript framework; you write vanilla HTML, CSS, and JavaScript.

Bascik acts as a build-time find-and-replace: it resolves custom HTML tags to their component source, scopes CSS and JavaScript per component instance, and writes a `dist/` directory of vanilla HTML files. **Zero JavaScript is added to your pages.** Every script in the output was written by you.

This is the package you install in a Bascik project: the compiler, the `bascik` CLI, the dev server, and the production server. The guides are at **[bascik.dev](https://bascik.dev)**; the [repository README](https://github.com/bascikdev/bascik#readme) covers the other packages and how to work on the code.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Setup](#project-setup)
- [Folder Structure](#folder-structure)
- [Full Documentation](#full-documentation)
- [Configuration](#configuration)
- [Publishing](#publishing)
- [Development](#development)
- [Internals](#internals)
- [Contributing](#contributing)

---

## Getting Started

Requires **Node.js ≥ 24.21**. To start a new site with a starter project, run `npm create bascik my-site` (see [Getting Started](https://bascik.dev/getting-started)). To add Bascik to an existing project:

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

`dev`: transpiles your project, starts the dev server, and watches for changes.  
`build`: transpiles to `dist/` only. It also writes `sitemap.xml` and `robots.txt`, so it exits with an error until the site's URL is set: add `BASCIK_SITE_URL=https://example.com` to a `.env` file, set it in the environment, or pass `--site-url`. To skip both files, set `generate.sitemap: false` and `generate.robots: false` in `bascik.config.ts`.

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

| Topic                   | URL                                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| Getting started         | [bascik.dev/getting-started](https://bascik.dev/getting-started)               |
| Dynamic routes          | [bascik.dev/scripts/dynamic-routes](https://bascik.dev/scripts/dynamic-routes) |
| Slots                   | [bascik.dev/slots](https://bascik.dev/slots)                                   |
| Props                   | [bascik.dev/props](https://bascik.dev/props)                                   |
| Attribute inheritance   | [bascik.dev/attribute-inheritance](https://bascik.dev/attribute-inheritance)   |
| Scoped styles           | [bascik.dev/scoped-styles](https://bascik.dev/scoped-styles)                   |
| Scoped JavaScript       | [bascik.dev/scoped-javascript](https://bascik.dev/scoped-javascript)           |
| Configuration reference | [bascik.dev/configuration](https://bascik.dev/configuration)                   |
| CSS/JS compatibility    | [bascik.dev/compatibility](https://bascik.dev/compatibility)                   |

---

## Configuration

Create an optional `bascik.config.ts` in the project root, only when the project needs a non-default setting. The values below are the defaults:

```ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  directory: {
    pages: "src/pages",
    components: "src/components",
  },
  pipeline: {
    watchPaths: [], // extra paths that rebuild pages when they change in dev
  },
  scoping: {
    scriptBlocks: true, // wrap component scripts in IIFEs, rewrite selectors
    inheritAttributes: true, // forward non-bascik attrs onto the component root
    attributes: {
      class: true, // scope class attribute values
      id: true, // scope id attribute values
      name: false, // name ships as written; true scopes it per instance
    },
  },
});

// Options applied only during `bascik --build`, merged over the default export.
// --build and --server already turn on all four minifiers.
export const build = defineConfig({
  minify: {
    identifiers: false, // keep readable scoped names in production
  },
});
```

`minify.identifiers` is an impactful production setting: it turns `bascik__site-nav__a1b2c3__navigation` into a short hash like `ba1b2c3d`.

---

## Publishing

This repository has five independently versioned npm packages (plus the VS Code extension), each released by pushing a git tag. The [Release workflow](https://github.com/bascikdev/bascik/blob/main/.github/workflows/release.yml) builds and publishes, and `dist/` is **not** committed to git. The tag must equal the prefix plus the package's `package.json` version; prerelease versions such as `1.0.0-rc.10` publish under the `rc` dist-tag.

| Package                                               | Tag format                     |
| ----------------------------------------------------- | ------------------------------ |
| `@bascik/bascik` (`pkg/`)                             | `v<semver>`                    |
| `create-bascik` (`create/`)                           | `create-v<semver>`             |
| `@bascik/adapter-cloudflare` (`adapters/cloudflare/`) | `adapter-cloudflare-v<semver>` |
| `@bascik/adapter-netlify` (`adapters/netlify/`)       | `adapter-netlify-v<semver>`    |
| `@bascik/language-server` (`lsp/`)                    | `lsp-v<semver>`                |

[RELEASING.md](https://github.com/bascikdev/bascik/blob/main/RELEASING.md) has the release checklist, the publish order across packages, the one-time setup, and the release candidate walkthrough. `CHANGELOG.md` at the repository root records every user-visible change under `[Unreleased]`; a release moves that section under the new version and pushes the tag.

---

## Development

Develop on Node.js 26, the current LTS (`.nvmrc` pins it); Node 24 works too. The published package supports Node.js 24.21 and newer. The full test suite runs on both lines: two test helpers depend on the V8 `%StringIsFlat` intrinsic (V8 13.6) and on a verified TLS cleanup callback ordering (Node 24 and 26), and those tests skip on other versions. Run `yarn install` from the repo root.

```sh
yarn pkg:build        # compile dist/
yarn pkg:unit         # unit tests, single run
yarn pkg:test         # unit tests in watch mode
yarn pkg:test:ci      # unit tests + coverage summary (used in CI)
yarn pkg:e2e          # E2E tests (static lane)
yarn pkg:e2e:all      # all four E2E lanes in parallel, each in its own dist-<lane> dir
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

### Type checking

The source is TypeScript. TypeScript's compiler checks it without emitting files:

```sh
yarn pkg:typecheck
```

This runs `tsc --noEmit` using `tsconfig.json` (`strict: true`) and `e2e/tsconfig.json`. Fix any reported errors before opening a PR.

### Benchmarks

Repeatable micro-benchmarks for the transpile pipeline and the HTML helpers (powered by vitest bench):

```sh
yarn pkg:bench
```

Numbers depend on the machine, so compare a run before and after your change on the same machine rather than against fixed figures. [bascik.dev/internals/benchmarking](https://bascik.dev/internals/benchmarking) covers the benchmarks, paired compiler comparisons, and profiling.

Run `yarn pkg:bench` after any change to the hot paths to catch regressions.

---

## Internals

How Bascik turns source HTML into its output (the page and component phases, scoping, build scripts, and the server) is documented at [bascik.dev/internals](https://bascik.dev/internals). Start with [Transpilation Pipeline](https://bascik.dev/internals/transpilation-pipeline). The code lives in `pkg/src/lib/`.

---

## Contributing

1. Fork the repo and create a branch from `main`.
2. Write tests for new functionality (TDD preferred).
3. Run `yarn pkg:unit` and `yarn pkg:typecheck` (both must pass).
4. Run `yarn pkg:bench` if touching the transpile pipeline, including numbers in the PR description.
5. Add a bullet under `[Unreleased]` in `CHANGELOG.md` for every user-visible change. Versions are bumped at release time, as described in [RELEASING.md](https://github.com/bascikdev/bascik/blob/main/RELEASING.md).
6. Open a PR against `main`.
