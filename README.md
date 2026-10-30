# Bascik

HTML components.
Zero runtime.

Bascik is a build tool for HTML components with automatically scoped CSS and JavaScript. You write vanilla HTML, CSS, and JavaScript. Bascik scopes and assembles reusable component files into plain static HTML pages at build time, with no framework runtime, no Shadow DOM, and no virtual DOM. The code that ships is the code you wrote.

**Documentation:** [bascik.dev](https://bascik.dev)  
**Package:** [`@bascik/bascik`](https://www.npmjs.com/package/@bascik/bascik)  
**npm organization:** [@bascik](https://www.npmjs.com/org/bascik)

## Get Started

```sh
npm create bascik@rc my-site
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
<nav class="nav" data-testid="site-nav">
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

## Repository Layout

This repository holds Bascik and everything around it. Each folder is a Yarn workspace unless noted.

| Folder                      | What it is                                                                                                    | README                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pkg/`                      | `@bascik/bascik`: the compiler, CLI, dev server, and production server                                        | [pkg/README.md](pkg/README.md)                                           |
| `create/`                   | `create-bascik`: the project scaffolder behind `npm create bascik`                                            | [create/README.md](create/README.md)                                     |
| `lsp/`                      | `@bascik/language-server`: diagnostics, completion, hover, and the `--check` linter for any LSP editor        | [lsp/README.md](lsp/README.md)                                           |
| `extensions/vscode-bascik/` | The VS Code extension, a thin client of the language server                                                   | [extensions/vscode-bascik/README.md](extensions/vscode-bascik/README.md) |
| `adapters/cloudflare/`      | `@bascik/adapter-cloudflare`: builds server scripts and API routes into a Cloudflare Worker                   | [adapters/cloudflare/README.md](adapters/cloudflare/README.md)           |
| `docs/`                     | The [bascik.dev](https://bascik.dev) site, built with Bascik                                                  | [docs/README.md](docs/README.md)                                         |
| `examples/`                 | Example components and a starter site to copy into a project (not a workspace)                                | [examples/README.md](examples/README.md)                                 |
| `skills/`                   | Public agent skills for coding assistants, installed with `npx skills add bascikdev/bascik` (not a workspace) | [skills/README.md](skills/README.md)                                     |
| `skills-tests/`             | Tests and fixtures for `skills/`, kept apart because `skills/` ships to users                                 | [skills-tests/README.md](skills-tests/README.md)                         |

## Working in This Repo

Develop on **Node 24**: the full test suite needs it. The published packages support **Node 22.22** and newer, and CI checks that floor in its own job. The repo uses Yarn 4 workspaces (`yarn@4.18.0`, through Corepack), so one install at the root wires everything up:

```sh
corepack enable
yarn install
yarn pkg:build   # build the compiler first; the docs and tests use pkg/dist
yarn docs:dev    # the docs site at http://localhost:8080, a good place to try a change
```

`node_modules/@bascik/bascik` is a symlink to `pkg/`, so the docs and other workspaces use your local build with no pack or reinstall step.

Root scripts are prefixed by workspace (`pkg:`, `create:`, `lsp:`, `ext:`, `adapter:cf:`, `docs:`, `skills:`), and the `:all` scripts run every workspace:

```sh
yarn pkg:unit        # one workspace's unit tests (pkg:test watches)
yarn typecheck:all   # TypeScript in every workspace
yarn check:all       # formatting (Prettier), spelling (codespell), web standards (webhint)
yarn unit:all        # unit tests in every workspace
yarn integration:all # tests that start real processes, servers, and browsers
yarn e2e:all         # Playwright E2E: the four pkg server lanes, the docs, and the Cloudflare adapter
yarn test:all        # typecheck, checks, unit, integration, and E2E, plus a Lighthouse audit of the docs
yarn coverage:all    # regenerate every coverage file in the table below
```

[CI](.github/workflows/ci.yml) runs on every branch push, in gated stages, each starting only when the one before passes: static checks (typecheck, formatting, spelling, web standards, Jelly, Semgrep), unit tests, integration tests, then E2E. A fifth stage deploys bascik.dev and the [Cloudflare adapter demo](https://cloudflare-adapter.bascik.dev) to production from `main`, and uploads a preview of both from every other branch, listing the two URLs in the run summary and in a comment on the branch's pull request, if it has one. Pull requests from forks are tested but never deployed; [DEPLOYMENT.md](DEPLOYMENT.md) is the runbook. Packages are released by pushing a tag, as described in [RELEASING.md](RELEASING.md).

Before opening a pull request, run the checks for what you touched (at least the workspace's unit tests and `yarn typecheck:all`, plus `yarn check:format`). There is no changelog before 1.0.0, so leave `CHANGELOG.md` alone. Agent and contributor guidance lives in [`.github/copilot-instructions.md`](.github/copilot-instructions.md), which `CLAUDE.md` also loads.

## Test Coverage

| Workspace                                             | Suite                | Lines | Functions | Branches | Source                                              |
| :---------------------------------------------------- | :------------------- | ----: | --------: | -------: | :-------------------------------------------------- |
| `@bascik/bascik` (`pkg/`)                             | Unit                 | 92.8% |     91.2% |    85.4% | [JSON](pkg/test-coverage.json)                      |
| `@bascik/bascik` (`pkg/`)                             | E2E build steps      | 69.9% |     62.1% |    70.5% | [JSON](pkg/e2e-test-coverage.json)                  |
| `create-bascik` (`create/`)                           | Unit                 | 99.0% |     98.6% |    94.6% | [JSON](create/test-coverage.json)                   |
| `@bascik/language-server` (`lsp/`)                    | Unit                 | 91.9% |     94.5% |    82.2% | [JSON](lsp/test-coverage.json)                      |
| `bascik-vscode` (`extensions/vscode-bascik/`)         | Unit                 | 27.3% |     25.0% |    38.5% | [JSON](extensions/vscode-bascik/test-coverage.json) |
| `@bascik/adapter-cloudflare` (`adapters/cloudflare/`) | Unit                 | 97.8% |     96.2% |    87.1% | [JSON](adapters/cloudflare/test-coverage.json)      |
| `bascik-docs` (`docs/`)                               | Unit and integration | 62.2% |     67.2% |    67.6% | [JSON](docs/test-coverage.json)                     |
| `bascik-skills-tests` (`skills-tests/`)               | Unit                 | 50.5% |     51.8% |    49.7% | [JSON](skills-tests/test-coverage.json)             |

Measured on October 30, 2026. Unit numbers come from each workspace's Vitest unit tests; `pkg` counts its unit project only, never its integration tests. The `@bascik/bascik` E2E row is measured separately, while the CLI builds the E2E fixture site and runs the dev and production servers, so it covers entry points and worker threads that unit tests cannot reach. `skills-tests` measures the skills' scripts in `skills/`. The extension's number is low because most of its code calls the VS Code API and runs only in the `yarn ext:e2e` suite, which is not measured; the diagnostics it shows are tested in `lsp/`. The docs number includes the docs' integration tests. Run `yarn coverage:all` to regenerate the JSON files; the [Testing Internals](https://bascik.dev/internals/testing) page explains each suite and shows lines, statements, functions, and branches for all eight coverage files.

## License

[MIT](LICENSE)
