# create-bascik

[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)

Interactive project initializer for [Bascik](https://bascik.dev): the command behind `npm create bascik`. Use it to start a new Bascik site with a working starter, editor settings, tests, and the agent skills. Requires Node.js 24.21 or newer. The [Getting Started guide](https://bascik.dev/getting-started) walks through the result, and [Create App internals](https://bascik.dev/internals/create-app) explains how the scaffolder works.

## Quick Start

Scaffold a new Bascik project in one command:

```sh
npm create bascik my-site -y
```

Pass a project name as an argument or run without arguments to be prompted:

```sh
npm create bascik
```

The name is a new folder under the current one, such as `my-site` or `sites/my-site`; `.`, `..`, absolute paths and spaces are refused. A folder that already has one of the starter's files, such as `package.json` or `src/pages/index.html`, is refused before anything is written. To add Bascik to an existing project, see [Manual Setup](https://bascik.dev/getting-started#manual-setup).

## What it scaffolds

`create-bascik` creates a complete, ready-to-run starter site:

```text
my-site/
├── AGENTS.md                       ← Project brief for coding assistants
├── CLAUDE.md                       ← Imports AGENTS.md for Claude Code
├── .agents/skills/                 ← Bascik agent skills for Copilot, Cursor, Codex, and others (on Y)
├── .claude/skills/                 ← The same skills for Claude Code (on Y)
├── .vscode/
│   ├── launch.json                 ← Debug launchers for dev server and tests
│   ├── extensions.json             ← Recommends official Bascik extension
│   └── settings.json               ← Stops false VS Code errors on pages with several scripts
├── src/
│   ├── components/                 ← site-meta, site-header, site-footer, feature-card, my-counter, contact-form
│   └── pages/                      ← index.html, about.html, contact.html, 404.html, css/styles.css
├── package.json                    ← dev, build, lint, test, and e2e scripts
└── .gitignore
```

The starter does not include `bascik.config.ts` because it uses Bascik's built-in defaults. Add a config only when the project needs non-default behavior.

## Agent skills

After scaffolding, `create-bascik` asks:

```text
Install the Bascik agent skills for coding assistants (Claude Code, Copilot, Cursor, Codex...)? (Y/n)
```

Yes, the default and what `-y` answers, runs the [skills CLI](https://skills.sh) to install every [Bascik skill](https://bascik.dev/agent-skills) except the opt-in `bascik-refactor`, at the release tag matching the Bascik version scaffolded. `--no-skills` skips it. When you skip it, or the install fails, for example offline, the project is still created and the command to run later is printed, pinned to the same release tag.

| Flag           | Effect                                             |
| :------------- | :------------------------------------------------- |
| `-y`, `--yes`  | Answer every question with its default             |
| `--no-skills`  | Do not install the agent skills                    |
| `--no-install` | Do not run `npm install`, nor start the dev server |
| `--no-dev`     | Do not start the dev server                        |

After scaffolding:

```sh
cd my-site
npm run dev
```

Your site will be live at `http://localhost:8080` in every template. `npm run dev` is always the Bascik dev server; the Cloudflare and Netlify templates add `npm run dev:cloudflare` (`http://127.0.0.1:8787`) and `npm run dev:netlify` (`http://127.0.0.1:8888`) to run the same site in the host's local runtime.

## Adapters

Add a deploy adapter to the starter with `--adapter <name>` (or `--adapter=<name>`). Without the flag you get the static starter; the prompts never ask where the site will be deployed, and an adapter can be added to any project later.

| Adapter      | What you get                                                                                                             |
| :----------- | :----------------------------------------------------------------------------------------------------------------------- |
| `none`       | The static starter above. The same as leaving the flag out.                                                              |
| `cloudflare` | The same starter plus the [Cloudflare adapter](https://bascik.dev/deployment/cloudflare), Wrangler, and an edge demo.    |
| `netlify`    | The same starter plus the [Netlify adapter](https://bascik.dev/deployment/netlify), a `netlify.toml`, and the edge demo. |

```sh
npm create bascik my-site -- --adapter cloudflare
```

The `--` matters: npm keeps flags placed before it for itself and does not pass them on, so `--adapter` has to follow a `--`. `-y` is the exception, since `create-bascik` also reads npm's own `yes` setting (`npm create bascik my-site -y -- --adapter cloudflare` skips every prompt).

### Templates

`--template <name>` picks the kind of site. Any template takes any adapter (`--template default --adapter netlify`).

| Template    | What you get                                                                                                                                                                                                           |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`   | A small multi-page site: home, about, contact, and a 404 page. Alias: `static`                                                                                                                                         |
| `blog`      | A blog: Markdown posts in `content/posts/`, a post list, tag pages, an Atom feed, SEO tags for every post, an about page, and a 404 page                                                                               |
| `docs`      | Documentation directly at `/`: Markdown guides, searchable sidebar navigation, an active table of contents, and previous and next links                                                                                |
| `landing`   | A product landing page: hero, features, steps, testimonials, pricing, FAQ, and a sign-up form. With an adapter, the form posts to an API route that validates it                                                       |
| `portfolio` | An editorial creator portfolio: clearly labeled fictional sample work, a featured grid, a project index, a page per Markdown entry in `content/projects/` read by `src/lib/projects.ts`, about, contact, and 404 pages |
| `corporate` | A company site: services, about, careers, news, and contact pages                                                                                                                                                      |
| `shop`      | A shop: a product catalog, product pages, a cart, and a demo checkout                                                                                                                                                  |

The blog uses your project slug as a plain brand, a responsive author sidebar, an unboxed reading column, and an accessible icon-only light/dark toggle. It retains the Bascik favicon. Global `styles.css` and `blog.css` are inlined through `assets.inlineStyles` in `bascik.config.ts`, without duplicate stylesheet links or above-the-fold entrance animations. Navigation remains visible without JavaScript.

Its racing guides are explicitly illustrative, not biographies, endorsements, or actual track reports. Before publishing, replace the John Doe placeholder and author context in `src/lib/site.ts`, update the Markdown bylines and about page, and replace or source the sample content. Article pages include author context below the prose.
For a plain slug brand, scaffold with `npm create bascik docs -- --template docs`. The folder name is used unchanged as the site name. The first sidebar entry in `src/lib/sidebar.ts` becomes `/`; the remaining guides use `/docs/<slug>`. The sample guides explain how to customize the template, rather than sending readers through a separate landing page.

The docs template includes an accessible icon-only theme control, initializes the saved theme before paint, and keeps the canonical Bascik favicon. Global `src/pages/css/styles.css` is inlined through `assets.inlineStyles` in its config, without a stylesheet link or request. Navigation has no resting underline, and content appears immediately without entrance animations; interaction motion respects reduced motion.
The portfolio uses an inset editorial masthead, a plain project-slug brand (`portfolio` for that project name), non-underlined navigation, and an accessible icon-only theme toggle with saved light/dark preference. Its global `src/pages/css/styles.css` is inlined through `assets.inlineStyles: true`; above-fold content is visible immediately without entrance animations. Bascik's shared favicons are unchanged. Replace the sample work and biography before publishing; the contact form validates locally and does not send a message.
The shop's default brand is the plain slug `shop`. Its icon-only theme button
restores a saved light/dark preference before paint. Global CSS is inlined,
and initial content has no entrance animation. Edit `catalog/books.ts` to
change each product's material, fit, specification and demo availability.
All products, ratings and stock counts are illustrative; nothing is sold or
shipped by the demo checkout. The favicon remains the canonical Bascik asset.
Product actions render at their final size before scripts load: Add to cart
starts disabled, and View cart is always a working link. The navigation keeps
a visible neutral cart-count pill, including `0` for an empty cart.

The all-products catalog is `/`; product details use `/products/<slug>`.
Sorting and filtering are native GET forms, so they work without JavaScript.
A non-streamed Bascik server script reads `data/racing.db` read-only, or the
Cloudflare D1 `DB` binding, before sending the catalog HTML. The demo seed
runs before dev/build and resets the catalog from `catalog/books.ts`.
Production therefore needs `bascik --server` or an adapter, not a static host.
Cloudflare projects need a dedicated D1 database bound as `DB`; generate its
fixture SQL with `node scripts/seed-database.ts --sql`. Never run the demo seed
against an application's database.
The Netlify variant includes the seeded, read-only SQLite fixture in its
function bundle through `functions.included_files`.

`--template cloudflare` and `--template netlify`, the spelling before `create-bascik` 1.1.0, still work and mean the same as `--adapter`. Naming two different adapters with the two flags is an error.

The Cloudflare template differs from the default in these files only:

- `package.json`: `@bascik/adapter-cloudflare` and `wrangler` as dev dependencies; `dev` stays `bascik`, and `dev:cloudflare` runs `bascik --target cloudflare` with source watching and browser live reload in the real local platform runtime; `build` runs `bascik --build --target cloudflare`; `preview` and `deploy` run Wrangler from the emitted `dist/.bascik/cloudflare/` folder.
- `src/pages/edge.html`: a page with a `data-bascik-server` script that the Worker renders on every request, linked from a fourth feature card on the home page.
- `src/api/hello.ts`: an API route served at `/api/hello`.
- `e2e/app.spec.ts`: one extra test covering the edge page.
- `.gitignore`: ignores `.wrangler/`.

After scaffolding a Cloudflare project:

```sh
npm run dev              # Bascik dev server on http://localhost:8080
npm run dev:cloudflare   # watched workerd development on http://127.0.0.1:8787
npm run build     # bascik --build --target cloudflare
npm run preview   # run the bundle locally in workerd
npm run deploy    # wrangler deploy
```

The Netlify template differs from the default in these files only:

- `package.json`: `@bascik/adapter-netlify` and `netlify-cli` as dev dependencies; `dev` stays `bascik`, and `dev:netlify` runs `bascik --target netlify` with source watching and browser live reload through the locally installed Netlify Dev; `build` runs `bascik --build --target netlify && bascik-netlify-install`; `preview` and `deploy` run the Netlify CLI through `npx`.
- `netlify.toml`: builds with `npm run build`, publishes `publish/`, and uses Netlify's `URL` as the site URL unless `BASCIK_SITE_URL` is set.
- `src/pages/edge.html` and `src/api/hello.ts`: the edge demo and API route, run in the Netlify Function.
- `e2e/app.spec.ts`: one extra test covering the edge page.
- `.gitignore`: ignores `publish/` and `.netlify/`.

After scaffolding a Netlify project:

```sh
npm run dev           # Bascik dev server on http://localhost:8080
npm run dev:netlify   # watched Netlify development on http://127.0.0.1:8888
npm run build     # bascik --build --target netlify && bascik-netlify-install
npm run preview   # netlify dev --dir publish
npm run deploy    # netlify deploy --build --prod
```

Both adapter development workflows use a local HTTP-only proxy; `--port` and `--host` override its public address. A rebuild or failed build may return 503, but the watcher stays alive and retries after the next source edit. Live reload is injected only by that proxy, never into production artifacts. `preview` remains a production-output workflow without Bascik's source watcher, and bare `bascik` remains the Node development server.

## Development & Testing

From the repository root:

```sh
yarn create:build      # compile build output
yarn create:typecheck  # TypeScript type check
yarn create:unit       # run unit tests
yarn create:coverage   # run unit tests with coverage report
```

The integration tests compile scaffolded projects with the built framework and Cloudflare adapter, so run `yarn pkg:build && yarn adapter:cf:build` first (CI does the same).
