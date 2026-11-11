# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries cover every Bascik package: `@bascik/bascik`, `create-bascik`,
`@bascik/adapter-cloudflare`, `@bascik/adapter-netlify`, `@bascik/language-server`,
the VS Code extension, and the public agent skills. A bullet names its package when
it is not `@bascik/bascik`.

## [Unreleased]

### Changed

- `create-bascik`: in the Cloudflare and Netlify templates `npm run dev` is the Bascik dev
  server again (`bascik`, `http://localhost:8080`), as in the default template. The
  host's local runtime moves to its own script, `npm run dev:cloudflare` or
  `npm run dev:netlify` (`bascik --target ...`, with source watching and browser live
  reload). Existing projects are not changed; to match, set `"dev": "bascik"` and add
  the `dev:<host>` script. See
  [Cloudflare](https://bascik.dev/deployment/cloudflare#develop-locally) and
  [Netlify](https://bascik.dev/deployment/netlify#develop-locally).

### Fixed

- The pinned `Server running at` link in the dev server's terminal no longer opens a
  garbled address. In VS Code's terminal, when a long log line wrapped and its first
  half scrolled away, the remaining half was read as part of the pinned row, so
  Cmd/Ctrl+click opened something like `http://localhost:8080ages/img/photo.webp`.

## [1.0.0-rc.12] - 2026-11-09

The release candidate for 1.0.0: the full pre-launch audit lands here so every
site can be tested against it before the stable release. Install it with
`npm create bascik@rc` or `@bascik/bascik@rc`. This candidate ships
`@bascik/bascik`, `create-bascik` and `@bascik/adapter-cloudflare` as
1.0.0-rc.12, `@bascik/adapter-netlify` as 1.0.0-rc.2, `@bascik/language-server`
as 1.0.0-rc.1, and the VS Code extension as 0.7.0 on the pre-release channel.

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime: you write vanilla HTML, CSS, and JavaScript in one
file per component, and `bascik --build` emits static HTML pages with the
component's styles and scripts scoped to each instance. The notes below cover
everything since the project started; 1.0.0 will carry the same notes plus
whatever the candidate period finds.

### Added

- **Components**: one `.html` file per component, used as a custom tag in pages and
  other components; [props](https://bascik.dev/props) through
  `data-bascik-prop-*`, [slots](https://bascik.dev/slots) with fallbacks and named
  slots, [attribute inheritance](https://bascik.dev/attribute-inheritance) onto the
  component root, and companion `.css` and `.ts` files.
- **Scoped styles and scripts** at build time: class, id, and element selectors are
  rewritten per component, and the scripts that query them are rewritten to match,
  covering `@layer`, `@container`, `@scope`, keyframes, custom properties, CSS
  nesting, `querySelector`, `getElementById`, `classList`, template literals, and
  more. The [compatibility page](https://bascik.dev/compatibility) lists every
  supported pattern; [`preserve`](https://bascik.dev/preserve) opts an element or a
  selector out.
- **Scripts that run at build, request, and stream time**: `data-bascik-build` for
  build-time rendering with a disk cache, `data-bascik-server` and
  `data-bascik-stream` for request-time rendering that expands components in their
  output, `data-bascik-routes` for dynamic routes, [API routes](https://bascik.dev/api-routes),
  and [`exec` scripts](https://bascik.dev/exec-scripts) with pre, parallel, and post
  phases. Scripts are TypeScript by default; Node strips the types.
- **Development server** with live reload over Server-Sent Events, an error overlay,
  incremental rebuilds that only touch dependent pages, and a worker pool for large
  sites. **Production server** over HTTP/1.1 and HTTP/2 with TLS, precompression,
  caching headers, and body limits, or a plain static `dist/` for any host.
- **Hosting adapters**: `@bascik/adapter-cloudflare` builds a Workers bundle with
  static assets, and `@bascik/adapter-netlify` builds a Functions v2 deployment;
  both keep request-time scripts and API routes working, and the
  [custom adapter API](https://bascik.dev/deployment/custom-adapters) covers other
  hosts.
- **`bascik --check`**, a linter for components, pages, config, and the built output
  (WHATWG parsing, scoping compatibility rules, API route rules, TypeScript errors
  with `--typescript`), backed by `@bascik/language-server`, which also powers the
  [VS Code extension](https://bascik.dev/tools/vscode-extension): diagnostics,
  completions, hovers, go to definition, and references across components.
- **`create-bascik`** (`npm create bascik my-site`): a starter site with components,
  unit tests on Vitest, Playwright end-to-end tests, a `lint` script, VS Code
  settings, and templates for Cloudflare and Netlify.
- **Agent skills** for coding assistants, installed by `create-bascik` and `bascik init`
  or with `npx skills add bascikdev/bascik`, plus `AGENTS.md` and `CLAUDE.md`
  project briefs and `llms.txt` on the docs site.
- **`@bascik/bascik/html`**, a dependency-free tagged template for safe HTML in
  server and build scripts, and **`@bascik/bascik/config`** with `defineConfig` for a
  typed `bascik.config.ts`.
- **Production build options**: identifier minification, HTML and CSS minification
  with a bring-your-own-minifier hook, asset fingerprinting, sitemap and robots
  generation, base paths, and a build log.

### Changed

- The minimum supported Node.js version is 24.21.0. Earlier release candidates
  supported Node 22.22; npm 10.9 (bundled with Node 22) cannot install the starter
  project's dependencies, and Node 24.21 is the first release where `node --check`
  locates a syntax error in a `.js` config, which `bascik` relies on to name the
  line. The floor is the first version proven to work end to end.
  [1.0.0-rc.12]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0-rc.12
