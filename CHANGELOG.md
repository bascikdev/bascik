# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries cover every Bascik package: `@bascik/bascik`, `create-bascik`,
`@bascik/adapter-cloudflare`, `@bascik/adapter-netlify`, `@bascik/language-server`,
the VS Code extension, and the public agent skills. A bullet names its package when
it is not `@bascik/bascik`.

## [Unreleased]

### Added

- `create-bascik` 1.1.0: `--adapter <name>` adds a deploy adapter to the starter (`cloudflare`, `netlify`, or `none`), as in `npm create bascik my-site -- --adapter cloudflare`. `--template cloudflare` and `--template netlify` still work and mean the same thing; naming two different adapters with the two flags is an error. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).
- `create-bascik` 1.1.0: `--template reports` scaffolds a reporting site. Each JSON file in `data/reports/` is one period (the demo data is four months of a bookshop's sales) and becomes a report page with a summary, charts drawn as inline SVG at build time, data tables, and notes. The site also has a list of reports, a page that compares the periods, a CSV download per report written by a post-build script, and print styles with a "Print or save as PDF" button. Run `npm create bascik my-reports -- --template reports`. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).

### Changed

- `create-bascik`: the reports template has a layered dashboard design, with raised surfaces, recessed chart areas, clean flat bars, neutral dark-mode panels, styled navigation links, flicker-free button hover states, and responsive metric cards. Lightweight chart inspection links bars to their table rows; select anywhere on a data row to pin it, with native keyboard access and working period links. Charts and tables remain readable without JavaScript, and light, dark, and print layouts remain supported.

### Changed

- `create-bascik`: the starter and adapter variants use a shared light/dark design system, with a neutral canvas, raised cards, restrained periwinkle accents, visible keyboard focus, and motion that respects reader preferences.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).

### Changed

- `create-bascik`: the default starter and adapter variants use a warm paper-and-ink design system with moss accents, quieter surfaces, clearer typography, and reduced-motion-aware button feedback.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).

### Fixed

- `create-bascik`: the starter's "Skip to content" link stays hidden when you put something above `<site-header>`, such as a banner or another nav. It was hidden with a fixed offset that only worked while the header was first on the page; it is now clipped until it has keyboard focus. Existing sites: in `src/components/site-header/site-header.html`, set `.skip-link` to `top: 8px` and replace the `.skip-link:focus` rule with `.skip-link:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }`.

## [1.0.0] - 2026-11-12

Bascik launched!

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime. Start a site with `npm create bascik`, and see
[Getting Started](https://bascik.dev/getting-started) for the rest.

[1.0.0]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0
