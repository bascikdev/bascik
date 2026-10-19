# Bascik

HTML components.
Zero runtime.

Bascik is a build tool for HTML components with automatically scoped CSS and JavaScript. You write vanilla HTML, CSS, and JavaScript. Bascik scopes and assembles reusable component files into plain static HTML pages at build time, with no framework runtime, no Shadow DOM, and no virtual DOM. The code that ships is the code you wrote.

**Documentation:** [bascik.dev](https://bascik.dev)  
**Package:** [`@bascik/bascik`](https://www.npmjs.com/package/@bascik/bascik)

## Get Started

```sh
npm create bascik@latest my-site
```

The CLI scaffolds a starter site and starts the dev server with live reload. See the [Getting Started guide](https://bascik.dev/getting-started) for manual setup in an existing project.

Building with an AI assistant? Install the [Bascik agent skills](https://bascik.dev/agent-skills) so GitHub Copilot, Claude Code, Cursor, or Codex knows the component and scoping rules:

```sh
npx skills add bascikdev/bascik
```

## What It Looks Like

A component is an HTML file named after its tag. Its `<style>` and `<script>` are scoped to it at build time, so class names and DOM queries never collide with other components.

```html
<!-- src/components/site-nav.html -->
<style>
  .nav {
    display: flex;
    gap: 1rem;
  }
</style>
<nav class="nav">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

Use the tag in any page or component. There is no import, export, or registration step.

```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Home</title>
  </head>
  <body>
    <site-nav />
  </body>
</html>
```

## Learn More

- [Components](https://bascik.dev/components) and [Slots](https://bascik.dev/slots)
- [Scoped CSS without Shadow DOM](https://bascik.dev/scoped-styles) and [Scoped JavaScript](https://bascik.dev/scoped-javascript)
- [Build Scripts](https://bascik.dev/build-scripts), [Dynamic Routes](https://bascik.dev/dynamic-routes), and [Deployment](https://bascik.dev/deployment)
- [Bascik vs React, Vue, Svelte, and Astro](https://bascik.dev/vs-frameworks)

---

### Test Coverage

| Package / Suite                       | Lines                                                                                                                                                                                                                                                                                                                                                         | Functions                                                                                                                                                                                                                                                                                                                                                                 | Branches                                                                                                                                                                                                                                                                                                                                                               |
| :------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@bascik/bascik` Unit**             | [![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)                                                 | [![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)                                                 | [![Unit branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Ftest-coverage.json&query=%24.total.branches.pct&label=unit%20branches&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/pkg/test-coverage.json)                                                        |
| **`@bascik/bascik` E2E**              | [![E2E lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.lines.pct&label=e2e%20lines&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)                                                | [![E2E functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.functions.pct&label=e2e%20functions&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)                                                | [![E2E branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fpkg%2Fe2e-test-coverage.json&query=%24.total.branches.pct&label=e2e%20branches&suffix=%25&color=orange)](https://github.com/bascikdev/bascik/blob/main/pkg/e2e-test-coverage.json)                                                |
| **`create-bascik` Unit**              | [![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)                                           | [![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)                                           | [![Unit branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.branches.pct&label=unit%20branches&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)                                           |
| **`bascik-vscode` Extension**         | [![Extension lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fextensions%2Fvscode-bascik%2Ftest-coverage.json&query=%24.total.lines.pct&label=ext%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/extensions/vscode-bascik/test-coverage.json) | [![Extension functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fextensions%2Fvscode-bascik%2Ftest-coverage.json&query=%24.total.functions.pct&label=ext%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/extensions/vscode-bascik/test-coverage.json) | [![Extension branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fextensions%2Fvscode-bascik%2Ftest-coverage.json&query=%24.total.branches.pct&label=ext%20branches&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/extensions/vscode-bascik/test-coverage.json) |
| **`@bascik/adapter-cloudflare` Unit** | [![Adapter lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.lines.pct&label=adapter%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)         | [![Adapter functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.functions.pct&label=adapter%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)         | [![Adapter branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.branches.pct&label=adapter%20branches&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)                |
| **`@bascik/language-server` Unit**    | [![LSP lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Flsp%2Ftest-coverage.json&query=%24.total.lines.pct&label=lsp%20lines&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/lsp/test-coverage.json)                                                          | [![LSP functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Flsp%2Ftest-coverage.json&query=%24.total.functions.pct&label=lsp%20functions&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/lsp/test-coverage.json)                                                          | [![LSP branches](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Flsp%2Ftest-coverage.json&query=%24.total.branches.pct&label=lsp%20branches&suffix=%25&color=blue)](https://github.com/bascikdev/bascik/blob/main/lsp/test-coverage.json)                                                          |

---

## Repo Structure

| Directory                   | Purpose                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pkg/`                      | The `@bascik/bascik` npm package — source, tests, benchmarks — see [pkg/README.md](pkg/README.md)                                          |
| `create/`                   | The `create-bascik` scaffolding CLI — `npm create bascik@latest` — see [create/README.md](create/README.md)                                |
| `extensions/vscode-bascik/` | The VS Code extension — see [extensions/vscode-bascik/README.md](extensions/vscode-bascik/README.md)                                       |
| `lsp/`                      | The `@bascik/language-server` LSP server — editor-agnostic intelligence for any LSP-compatible editor — see [lsp/README.md](lsp/README.md) |
| `docs/`                     | Documentation site at [bascik.dev](https://bascik.dev) — built with Bascik itself                                                          |
| `skills/`                   | Public agent skills for AI assistants, installed with `npx skills add bascikdev/bascik`. See [skills/README.md](skills/README.md)          |

---

## Development Setup

Requires **Node.js ≥ 22.18** and **Yarn ≥ 4** (pinned to `yarn@4.6.0` in `package.json`). The repo uses Yarn workspaces, one install at the root wires everything up.

```sh
corepack enable
yarn install
```

`node_modules/@bascik/bascik` is symlinked directly to `pkg/`, so changes to `pkg/src/` are immediately available to the docs site after a rebuild — no pack or reinstall step.

### Working on the package

```sh
yarn pkg:build      # build the package (start here)
yarn pkg:typecheck  # TypeScript type check
yarn pkg:unit       # unit tests (single run)
yarn pkg:test       # unit tests in watch mode
yarn pkg:e2e        # run e2e tests
yarn docs:dev       # start docs dev server
```

### Workspace-wide test commands

```sh
yarn typecheck:all  # typecheck all packages (pkg, create, docs, extension)
yarn check:all      # spelling (codespell) and web standards (webhint)
yarn unit:all       # unit tests across all packages
yarn e2e:all        # E2E tests across all packages
yarn coverage:all   # update coverage across all packages
yarn test:all       # run typechecks, checks, unit tests, E2E tests, and Lighthouse CLI audits
```

After any `pkg/src/` change, rebuild the package and the docs server will pick it up automatically (it watches for changes).

### Updating Dynamic Documentation Assets

Before committing changes that edited source code, tests, or documentation, run this custom prompt:

```sh
/pre-push
```

This runs a comprehensive pre-push checklist covering code review, documentation updates, spelling/web standards, test execution, coverage updates, and skill file synchronization.
