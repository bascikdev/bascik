# create-bascik

[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)

Interactive project initializer for [Bascik](https://bascik.dev).

## Quick Start

Scaffold a new Bascik project in one command:

```sh
npm create bascik@rc my-site -y
```

Pass a project name as an argument or run without arguments to be prompted:

```sh
npm create bascik@rc
```

## What it scaffolds

`create-bascik` creates a complete, ready-to-run starter site:

```text
my-site/
├── .agents/skills/                 ← Bascik agent skills for Copilot, Cursor, Codex, and others
├── .claude/skills/                 ← The same skills for Claude Code
├── .vscode/
│   ├── launch.json                 ← Debug launchers for dev server and tests
│   └── extensions.json             ← Recommends official Bascik extension
├── src/
│   ├── components/                 ← site-meta, site-header, site-footer, feat-card, my-counter
│   └── pages/                      ← index.html, about.html, contact.html, 404.html, css/styles.css
├── package.json                    ← dev, build, lint, test, and e2e scripts
└── .gitignore
```

The starter does not include `bascik.config.ts` because it uses Bascik's built-in defaults. Add a config only when the project needs non-default behavior.

After scaffolding:

```sh
cd my-site
npm run dev
```

Your site will be live at `http://localhost:8080`.

## Templates

Pick a starter with `--template <name>` (or `--template=<name>`). Without the flag, the interactive prompts ask whether the site deploys to Cloudflare Workers; with `-y` and no flag, you get the default.

| Template     | What you get                                                                                                          |
| :----------- | :-------------------------------------------------------------------------------------------------------------------- |
| `default`    | The static starter above. `static` is accepted as an alias.                                                           |
| `cloudflare` | The same starter plus the [Cloudflare adapter](https://bascik.dev/deployment/cloudflare), Wrangler, and an edge demo. |

```sh
npm create bascik@rc my-site -- --template cloudflare
```

The `--` matters: npm keeps flags placed before it for itself and does not pass them on, so `--template` has to follow a `--`. `-y` is the exception, since `create-bascik` also reads npm's own `yes` setting (`npm create bascik@rc my-site -y -- --template cloudflare` skips every prompt).

The Cloudflare template differs from the default in these files only:

- `package.json`: `@bascik/adapter-cloudflare` and `wrangler` as dev dependencies; `build` runs `bascik --build --target cloudflare`; new `preview` and `deploy` scripts run Wrangler from the emitted `dist/.bascik/cloudflare/` folder. `dev` is still the Bascik dev server.
- `src/pages/edge.html`: a page with a `data-bascik-server` script that the Worker renders on every request, linked from a fourth feature card on the home page.
- `src/api/hello.ts`: an API route served at `/api/hello`.
- `e2e/app.spec.ts`: one extra test covering the edge page.
- `.gitignore`: ignores `.wrangler/`.

After scaffolding a Cloudflare project:

```sh
npm run build     # bascik --build --target cloudflare
npm run preview   # run the bundle locally in workerd
npm run deploy    # wrangler deploy
```

## Development & Testing

From the repository root:

```sh
yarn create:build      # compile build output
yarn create:typecheck  # TypeScript type check
yarn create:unit       # run unit tests
yarn create:coverage   # run unit tests with coverage report
```
