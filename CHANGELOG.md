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
- `create-bascik` 1.1.0: `--template docs` scaffolds a documentation site, as in `npm create bascik my-docs -- --template docs`. Each Markdown file in `content/docs/` becomes a page at `/docs/<name>` with a sidebar that marks the current page, an "On this page" list built from the page's headings, and previous and next links. To add a page, write the file and list it in `src/lib/sidebar.ts`; a page missing from the sidebar, or an entry with no file, fails the build with an error that names it. It works with `--adapter cloudflare` and `--adapter netlify`. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).
- `create-bascik` 1.1.0: `--template landing` scaffolds an editorial SaaS landing page with an interactive product preview, feature details, pricing, an FAQ built on `<details>`, and an early-access form, plus a privacy page and a 404 page. Its lists are typed data beside each component, and with `--adapter` the form posts to an API route that validates it again. Try it with `npm create bascik my-site -- --template landing`. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).
- `create-bascik` 1.1.0: `--template portfolio` scaffolds a creator portfolio, as in `npm create bascik my-portfolio -- --template portfolio`. The sample site includes a home page with featured work, a project index, a page per project, an about page, a contact form that checks its fields, and a 404 page, with a canonical URL and Open Graph tags on every page. Projects are entries in `src/lib/projects.ts`, and a [dynamic route](https://bascik.dev/scripts/dynamic-routes) turns each into a page; an entry with a missing field or a slug used twice stops the build with an error that names it. Project visuals are composed in CSS, so there are no image files. It takes any `--adapter`. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).
- `create-bascik` 1.1.0: `--template corporate` scaffolds a multi-page company site: a home page, a services index with one page per service, about, careers, news, and contact pages, placeholder privacy and terms pages, and a 404. The services, open roles, and news entries are typed data: add an entry and its card, menu link, and page follow, and an entry with a missing field or a repeated slug fails the build with its name. Try it with `npm create bascik my-company -- --template corporate`; it takes any `--adapter`.
- `create-bascik` 1.1.0: `--template shop` scaffolds a retail catalog, product pages, a cart kept in the browser, and a demo checkout (no payment is taken). Edit `catalog/books.ts` to change the illustrative products. With `--adapter`, the server prices the cart at `POST /api/cart`. Try it with `npm create bascik my-shop -- --template shop`.
- `create-bascik` 1.1.0: `--template reports` scaffolds a reporting site with summaries, inline SVG charts, comparison tables, CSV downloads, and print styles. Bascik server scripts read the seeded SQLite database on Node or Cloudflare D1 when deployed with the `DB` binding. The Netlify variant renders reports at build time. Run `npm create bascik my-reports -- --template reports` and see the generated `REPORTS.md` for setup.
- `create-bascik` 1.1.0: `--template dashboard` scaffolds an admin dashboard for a bookshop, as in `npm create bascik my-dashboard -- --template dashboard`: stat tiles, a line chart and a bar chart drawn as inline SVG at build time, an orders table that sorts, filters and pages, a page per title from a dynamic route, a settings form, and a light and dark theme, with no client framework and no chart library. The demo data in `src/lib/shop.ts` is seeded, so every build is the same. A plain `bascik --build` is a complete static site; under `bascik --server` and the Cloudflare and Netlify adapters one tile is rendered per request by a stream script. It has no authentication and its settings form saves to the browser only: add both before real data goes in. See [Scaffold a new project](https://bascik.dev/cli#scaffold-a-new-project).

### Changed

- `create-bascik`: the dashboard template uses a restrained data-product palette, clearer typographic hierarchy and content spacing, with reduced-motion-aware pressed buttons. Initial page content paints without entrance animations.
- `create-bascik`: dashboard scaffolds inline their global stylesheet through `assets.inlineStyles`, retain the canonical Bascik favicon, and use an accessible icon-only light/dark toggle. Navigation remains non-underlined at rest, settings use the plain `dashboard` name, and seeded customers and inventory use explicit demo labels rather than invented claims about real people.
- `create-bascik`: dashboard cards and navigation now use a neutral, softly layered light/dark palette with responsive surfaces and a more legible accent.

- `create-bascik`: shop opens directly on the all-products catalog at `/`, with product pages under `/products/<slug>`. A Bascik server script reads SQLite (or Cloudflare D1), and native GET filters work without JavaScript. Use `bascik --server` or a deploy adapter in production.
- `create-bascik`: the shop template uses plain `shop` branding, original product-matched illustrations and a roomier editorial storefront, without associating its fictional catalog with real people or companies.
- `create-bascik`: shop adds an accessible icon-only theme toggle with pre-paint preference restoration, keeps the canonical Bascik favicon, inlines global CSS through `assets.inlineStyles`, and removes initial entrance animations. Resting navigation is deliberately not underlined. Product pages now have viewport-sized desktop panels and clearly illustrative material, fit, specification and availability details.
- `create-bascik`: shop pages and book cards now use the shared raised light/dark surfaces, with responsive padding and theme-aware form errors.

- `create-bascik`: the portfolio template is now an art-directed creator portfolio with fictional identity, editorial, and image-making projects rather than a motorsport author portfolio.
- `create-bascik`: portfolio now uses an inset editorial masthead with numbered links, non-underlined navigation, and a persistent accessible icon-only theme toggle. Global CSS is inlined with `assets.inlineStyles`; first-paint content stays visible without entrance animation, and canonical Bascik favicons remain unchanged. Collections, case studies, and the biography are explicitly labeled as fictional samples.
- `create-bascik`: the landing template now presents a focused project-workspace product in a clean editorial layout, with a responsive CSS product preview instead of the book illustration.
- `create-bascik`: landing-page feature, pricing, and reader cards now use restrained layered surfaces and the shared light/dark palette.
- `create-bascik`: the blog template uses a responsive editorial author sidebar, a plain project-slug brand, rule-led post entries, and an unboxed reading column with article author context. An accessible icon-only light/dark toggle restores the saved theme before paint, while global styles are inlined through `assets.inlineStyles`. The Bascik favicon is unchanged; navigation has no default underline and above-the-fold content has no entrance animation. Sample racing guides are explicitly illustrative, with a John Doe placeholder instead of invented real-person biographies or endorsements.
- `create-bascik`: docs now opens directly in the introductory Markdown guide at `/`, with the existing searchable sidebar, active table of contents, and pagination. Its icon-only theme control persists both schemes, global CSS is inlined without a stylesheet request, navigation has no resting underline, and content paints without entrance animation. The shared SVG favicon is restored to canonical Bascik geometry and colors.
- `create-bascik`: the corporate template keeps its navy, stone, and copper identity with an accessible icon-only light/dark toggle, saved theme restoration before paint, a borderless Services disclosure that works with hover, keyboard, and touch, and inlined global CSS. Initial page content no longer animates or flashes, and the favicon keeps the original Bascik colors.

- `create-bascik`: the reports template uses an editorial-analytics design with a warm paper palette, typographic hierarchy, restrained chart color, and a consistent neutral treatment in light and dark modes. Its demo data uses fictional names instead of real companies and people. Chart inspection remains keyboard accessible, and charts and tables work without JavaScript in screen and print layouts.
- `create-bascik`: the default starter and adapter variants use a warm paper-and-ink design system with moss accents, quieter surfaces, clearer typography, and reduced-motion-aware button feedback.
- Public Bascik skills: testing guidance now includes optional development-only CSS diagnostics for compiled HTML, with Bascik scoping precautions and explicit limits on what selector-based checks can prove. See [Component testing](https://bascik.dev/testing/component-testing#optional-css-diagnostics-on-compiled-html).
- `create-bascik`: the docs template has a searchable header dialog, a responsive docs layout, and a table of contents that highlights the current section.

### Fixed

- `create-bascik`: default's icon-only theme toggle follows Contact at the far right of desktop navigation and in keyboard order.
- `create-bascik`: the default starter welcomes your project name, includes an accessible icon-only theme toggle that remembers both themes without flashing, inlines global CSS, and retains the canonical Bascik favicon. Navigation has deliberate resting styles, initial content stays static including view transitions, and independent counters demonstrate scoped CSS monitoring the raw numeric `data-value` to turn negative values red without JavaScript sign classification.

- `create-bascik`: the starter's mobile navigation works without JavaScript and returns focus to the menu button when dismissed with Escape.
- `create-bascik`: the docs template highlights the last section at the bottom of the page, even when its heading cannot reach the reading position. Direct links to nearby headings keep the correct highlight.
- `create-bascik`: the landing template now has an accessible icon-only light/dark toggle with a saved preference applied before paint, no initial hero or root view-transition fades, an inlined global stylesheet, consistent project-slug branding, and the canonical Bascik favicon. Its landing-specific styling and reduced-motion-aware interaction feedback are preserved.
- `create-bascik`: shop product actions no longer change the panel height after load or disturb restored scroll positions. The cart count stays visible as a neutral pill, including `0` for an empty cart.
- `create-bascik`: shop reserves navigation and cart-count space before paint, initializes theme/menu controls without network-loaded cart modules, and no longer reveals or reorders the catalog after load.
- `create-bascik`: reports use an accessible icon-only persistent theme toggle, the unchanged Bascik favicon, inline global CSS, and immediate above-fold paint. Linked month rows navigate to real report pages; chart-month controls alone pin month inspection. SQLite/D1 rendering and CSV downloads remain intact.

- `create-bascik`: the generated dashboard Playwright spec now parses correctly.
- `create-bascik`: dashboard builds without a pre-seeded database use an in-memory SQLite seed, avoiding races between parallel build workers. Run `npm run db:seed` to create the persistent demo database.
- `create-bascik`: the starter's "Skip to content" link stays hidden when you put something above `<site-header>`, such as a banner or another nav. It was hidden with a fixed offset that only worked while the header was first on the page; it is now clipped until it has keyboard focus. Existing sites: in `src/components/site-header/site-header.html`, set `.skip-link` to `top: 8px` and replace the `.skip-link:focus` rule with `.skip-link:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }`.

## [1.0.0] - 2026-11-12

Bascik launched!

Bascik is a build tool for HTML components with automatically scoped CSS and
JavaScript and no runtime. Start a site with `npm create bascik`, and see
[Getting Started](https://bascik.dev/getting-started) for the rest.

[1.0.0]: https://github.com/bascikdev/bascik/releases/tag/v1.0.0
