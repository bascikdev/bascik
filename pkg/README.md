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

Requires **Node.js ≥ 22.22**.

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
`build`: transpiles to `dist/` only.

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
| Dynamic routes          | [bascik.dev/dynamic-routes](https://bascik.dev/dynamic-routes)               |
| Slots                   | [bascik.dev/slots](https://bascik.dev/slots)                                 |
| Props                   | [bascik.dev/props](https://bascik.dev/props)                                 |
| Attribute inheritance   | [bascik.dev/attribute-inheritance](https://bascik.dev/attribute-inheritance) |
| Scoped styles           | [bascik.dev/scoped-styles](https://bascik.dev/scoped-styles)                 |
| Scoped JavaScript       | [bascik.dev/scoped-javascript](https://bascik.dev/scoped-javascript)         |
| Configuration reference | [bascik.dev/configuration](https://bascik.dev/configuration)                 |
| CSS/JS compatibility    | [bascik.dev/compatibility](https://bascik.dev/compatibility)                 |

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

This repo has four independently versioned npm packages (plus the VS Code extension), each released by pushing a git tag.
The [Release workflow](../.github/workflows/release.yml) builds and publishes automatically, and `dist/` is **not** committed to git.
The tag must equal the prefix plus the package's `package.json` version. Prerelease versions such as `1.0.0-rc.1` publish under the `rc` dist-tag.

### Tag scheme

| Package                                               | Tag format                     | Example                     |
| ----------------------------------------------------- | ------------------------------ | --------------------------- |
| `@bascik/bascik` (`pkg/`)                             | `v<semver>`                    | `v0.3.0`                    |
| `create-bascik` (`create/`)                           | `create-v<semver>`             | `create-v0.2.0`             |
| `@bascik/adapter-cloudflare` (`adapters/cloudflare/`) | `adapter-cloudflare-v<semver>` | `adapter-cloudflare-v1.0.0` |
| `@bascik/language-server` (`lsp/`)                    | `lsp-v<semver>`                | `lsp-v0.1.0`                |

The `if:` condition on each workflow job ensures only the relevant package is published when a tag is pushed.

[RELEASING.md](../RELEASING.md) has the publish order across packages and the release candidate walkthrough. Bascik does not keep a changelog before 1.0.0: a release bumps the version in `package.json` and pushes the tag, and `CHANGELOG.md` starts with the 1.0.0 release.

### Release checklist: `@bascik/bascik`

1. **Update version** in `pkg/package.json` following [Semantic Versioning](https://semver.org/).
2. **Run tests locally** with `yarn pkg:unit` or `yarn pkg:test:ci`.
3. **Commit and tag**:
   ```sh
   git add pkg/package.json
   git commit -m "chore: release v0.3.0"
   git tag v0.3.0
   git push origin main --tags
   ```
4. The Release workflow picks up the `v*.*.*` tag, runs tests, builds, and publishes to npm.

### Release checklist: `create-bascik`

1. **Update version** in `create/package.json`.
2. **Run tests locally** with `yarn workspace create-bascik test:ci`.
3. **Commit and tag**:
   ```sh
   git add create/package.json
   git commit -m "chore: release create-bascik v0.2.0"
   git tag create-v0.2.0
   git push origin main --tags
   ```
4. The Release workflow picks up the `create-v*.*.*` tag, runs tests, builds, and publishes to npm.

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

Requires Node.js ≥ 24. The published package supports Node.js 22.22 and newer, but the full test suite needs Node 24: two test helpers depend on the V8 `%StringIsFlat` intrinsic (V8 13.6) and on Node 24's TLS cleanup callback ordering, and those tests skip on Node 22. Run `yarn install` from the repo root.

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
5. Leave `CHANGELOG.md` alone: the project keeps no changelog before 1.0.0. Versions are bumped at release time, as described in [RELEASING.md](../RELEASING.md).
6. Open a PR against `main`.
