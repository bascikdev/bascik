# Overview

Everything you need to work on the Bascik package itself, architecture, the transpilation pipeline, the scoping system, the dev server, and how to run the test suite.

## Repository Layout

The monorepo is split into four top-level folders:

```text
bascik/
  pkg/          ← the @bascik/bascik npm package
    src/
      index.ts        ← CLI entry point
      transpile.ts    ← dev/build startup (called by index.ts)
      lib/            ← all library modules
  create/       ← standalone generator used by `npm create bascik@latest`
  docs/         ← this documentation site (a Bascik project itself)
  extensions/   ← editor tooling, including the VS Code extension
```

The `pkg/` directory is a self-contained TypeScript project with its own `package.json`, `tsconfig.json`, and `vite.config.js` (used by Vitest).

## Quick Start for Contributors

You need Node.js v22.18 or later and Yarn 4. Clone the repo and install dependencies from the root, Yarn workspaces wires everything up in one step:

```sh
git clone https://github.com/bascikdev/bascik.git
cd bascik
corepack enable
yarn install
```

Run the test suite across all packages:

```sh
yarn test:all
```

Or run package-specific unit tests:

```sh
yarn pkg:unit
```

Build the package (compiles TypeScript to `pkg/dist/`):

```sh
yarn pkg:build
```

To work on the docs site with a live-reload dev server:

```sh
yarn pkg:build   # build pkg first
yarn docs:dev     # http://localhost:8080
```

After any `pkg/src/` change, rebuild the package and the docs server will pick it up automatically.

## Internals Sub-pages

- [Architecture](/internals/architecture), module map, responsibilities, and how the files relate to one another.
- [Create App](/internals/create-app), how the standalone scaffolding CLI is structured and why the generated app uses npm.
- [Transpilation Pipeline](/internals/transpilation-pipeline), the two-phase page and component pipeline that turns source HTML into deployable output.
- [Scoping System](/internals/scoping-system), how IDs, class names, CSS, and JavaScript references are namespaced per component instance.
- [Server Architecture](/internals/server), the HTTP/1.1 and HTTP/2 servers, dev vs prod modes, request script execution, memory store, and live reload.
- [Time Boundaries](/internals/time-boundaries), why time is a framework architecture boundary, where FrameworkClock is owned, and how timeout behavior is enforced and tested.
- [Diagnostics](/internals/diagnostics), static project validation (`bascik --check`), tag scanning, and stack trace remapping.
- [Minification](/internals/minification), zero-dependency HTML, CSS, and JS minification, Base62 identifier hashing, and BYO minifiers.
- [Testing Internals](/internals/testing), running tests, coverage, writing new tests, and the benchmarking suite.
