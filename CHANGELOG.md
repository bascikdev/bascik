# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries cover every Bascik package: `@bascik/bascik`, `create-bascik`,
`@bascik/adapter-cloudflare`, `@bascik/adapter-netlify`, `@bascik/language-server`,
the VS Code extension, and the public agent skills. A bullet names its package when
it is not `@bascik/bascik`.

## [Unreleased]

### Fixed

- The built-in JavaScript minifier no longer puts a `;` before a `{` that sits on its own line after a function, method, class, static block, or `catch` header. A production build turned `function f(a)\n{` into `function f(a);{`, which does not parse, so the script failed in the browser while the same code worked in development. This also broke TypeScript functions with a return type written across several lines. No change is needed in your code; rebuild. See the "Semicolon-free scripts" row of the [compatibility page](https://bascik.dev/compatibility).
- `bascik` no longer hangs at full CPU when it crashes after whatever was reading its output has gone away (a closed terminal, a killed CI step, `bascik --build 2>&1 | head`). The failed write to stderr was reported to stderr again, forever, and the process never exited. It now exits with code 1 as any other crash does. See [Crash net](https://bascik.dev/internals/server#crash-net-stream-error-handling).
- `--config <path>` now applies to every page when `pipeline.workers` is on. Page workers ignored the flag and compiled with the defaults, or with a `bascik.config.*` in the project root, while the rest of the build used the named file: pages came out with the wrong `minify`, `base`, and `scoping` settings, and with a non-default `directory.pages` they were written to the wrong paths in `dist/`. Projects that rely on a discovered `bascik.config.*` were not affected. See [CLI reference](https://bascik.dev/cli#cli-reference).

## [1.0.0] - 2026-11-12

Bascik launched!

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime. Start a site with `npm create bascik`, and see
[Getting Started](https://bascik.dev/getting-started) for the rest.

[1.0.0]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0
