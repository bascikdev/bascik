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
- The API routes page and the `bascik-scripts` agent skill no longer tell you to import a shared helper into a route file as `@/lib/db.ts`. The `@/` alias is rewritten inside `<script>` blocks only, so that import made the route answer 500 in `bascik` and `bascik --server` and stopped `bascik --build --target cloudflare` and `--target netlify`. In a file under `src/api/`, use a relative import such as `../lib/db.ts`. The server's `Failed to load API route module` error now says so when this is the cause. See [API Routes](https://bascik.dev/api-routes#file-based-routing).
- Component CSS that lists element selectors on one line now scopes every one of them when a later item takes an argument. In `h1, h2:not(.lead), li:nth-child(2) {}` only `h1` was scoped: `h2:not(.lead)` and `li:nth-child(2)` kept their bare tag names, so the rule styled matching elements on the whole page, not only in the component. A list written one selector per line (as Prettier formats it) was not affected. A class name with an escaped comma (`.cols-\[1fr\,auto\]`) is also no longer split at the comma. No change is needed in your code; rebuild, and check any page that relied on the leaked rule. See the "Comma-separated element selector list" row of the [compatibility page](https://bascik.dev/compatibility).
- `<!--` inside a component's `<style>`, `<script>`, JSON data block or `<textarea>` is no longer read as the start of an HTML comment. A CSS string such as `content: "<!--"`, a script string, or a block wrapped in `<!-- ... -->` hid everything up to the next `-->` (or the end of the file) from the compiler. Depending on where it sat, the page's stylesheet received a `BASCIK_SHIELD_0` placeholder in place of the CSS, the classes and ids after it were left unscoped while the stylesheet was scoped, the component's script lost its per-instance wrapper, or the build stopped with a "`{` is never closed" or "`<style>` is never closed" error on correct code. With `base` set, links after such a block also kept their unprefixed URLs. No change is needed in your code; rebuild. See the "Raw-text comments and nested scripts" row of the [compatibility page](https://bascik.dev/compatibility).

## [1.0.0] - 2026-11-12

Bascik launched!

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime. Start a site with `npm create bascik`, and see
[Getting Started](https://bascik.dev/getting-started) for the rest.

[1.0.0]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0
