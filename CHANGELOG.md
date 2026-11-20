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
- `create-bascik` 1.1.0: `--template landing` scaffolds an editorial SaaS landing page with an interactive product preview, feature details, pricing, an FAQ built on `<details>`, and an early-access form, plus a privacy page and a 404 page. Its lists are typed data beside each component, and with `--adapter` the form posts to an API route that validates it again. Try it with `npm create bascik my-site -- --template landing`. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).

### Changed

- `create-bascik`: the landing template now presents a focused project-workspace product in a clean editorial layout, with a responsive CSS product preview instead of the book illustration.
- `create-bascik`: landing-page feature, pricing, and reader cards now use restrained layered surfaces and the shared light/dark palette.

- `create-bascik`: the starter and adapter variants use a shared light/dark design system, with a neutral canvas, raised cards, restrained periwinkle accents, visible keyboard focus, and motion that respects reader preferences.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).

### Changed

- `create-bascik`: the default starter and adapter variants use a warm paper-and-ink design system with moss accents, quieter surfaces, clearer typography, and reduced-motion-aware button feedback.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).

### Fixed

- `create-bascik`: the landing template now has an accessible icon-only light/dark toggle with a saved preference applied before paint, no initial hero or root view-transition fades, an inlined global stylesheet, consistent project-slug branding, and the canonical Bascik favicon. Its landing-specific styling and reduced-motion-aware interaction feedback are preserved.
- `create-bascik`: the starter's "Skip to content" link stays hidden when you put something above `<site-header>`, such as a banner or another nav. It was hidden with a fixed offset that only worked while the header was first on the page; it is now clipped until it has keyboard focus. Existing sites: in `src/components/site-header/site-header.html`, set `.skip-link` to `top: 8px` and replace the `.skip-link:focus` rule with `.skip-link:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }`.

## [1.0.0] - 2026-11-12

Bascik launched!

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime. Start a site with `npm create bascik`, and see
[Getting Started](https://bascik.dev/getting-started) for the rest.

[1.0.0]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0
