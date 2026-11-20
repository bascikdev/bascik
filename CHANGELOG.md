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
- `create-bascik` 1.1.0: `--template blog` scaffolds a blog, as in `npm create bascik my-blog -- --template blog`. Posts are Markdown files with front matter in `content/posts/`; the starter has a home page with the newest posts, a post list, a page per post and per tag, an Atom feed at `/feed.xml`, canonical and Open Graph tags for every post, an about page, and a 404 page. A post with a missing title, description, author or date stops the build with an error that names the file. It takes any `--adapter`. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).

### Changed

- `create-bascik`: the blog template uses a responsive editorial author sidebar, a plain project-slug brand, rule-led post entries, and an unboxed reading column with article author context. An accessible icon-only light/dark toggle restores the saved theme before paint, while global styles are inlined through `assets.inlineStyles`. The Bascik favicon is unchanged; navigation has no default underline and above-the-fold content has no entrance animation. Sample racing guides are explicitly illustrative, with a John Doe placeholder instead of invented real-person biographies or endorsements.

- `create-bascik`: the starter and adapter variants use a shared light/dark design system, with a neutral canvas, raised cards, restrained periwinkle accents, visible keyboard focus, and motion that respects reader preferences.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).

### Changed

- `create-bascik`: the default starter and adapter variants use a warm paper-and-ink design system with moss accents, quieter surfaces, clearer typography, and reduced-motion-aware button feedback.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).

### Fixed

- `create-bascik`: default's icon-only theme toggle follows Contact at the far right of desktop navigation and in keyboard order.
- `create-bascik`: the default starter welcomes your project name, includes an accessible icon-only theme toggle that remembers both themes without flashing, inlines global CSS, and retains the canonical Bascik favicon. Navigation has deliberate resting styles, initial content stays static including view transitions, and independent counters demonstrate scoped CSS monitoring the raw numeric `data-value` to turn negative values red without JavaScript sign classification.

- `create-bascik`: the starter's mobile navigation works without JavaScript and returns focus to the menu button when dismissed with Escape.
- `create-bascik`: the starter's "Skip to content" link stays hidden when you put something above `<site-header>`, such as a banner or another nav. It was hidden with a fixed offset that only worked while the header was first on the page; it is now clipped until it has keyboard focus. Existing sites: in `src/components/site-header/site-header.html`, set `.skip-link` to `top: 8px` and replace the `.skip-link:focus` rule with `.skip-link:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }`.

## [1.0.0] - 2026-11-12

Bascik launched!

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime. Start a site with `npm create bascik`, and see
[Getting Started](https://bascik.dev/getting-started) for the rest.

[1.0.0]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0
