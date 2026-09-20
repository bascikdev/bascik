# create-bascik

[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fcreate%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/create/test-coverage.json)

Interactive project initializer for [Bascik](https://bascik.dev).

## Quick Start

Scaffold a new Bascik project in one command:

```sh
npm create bascik@latest my-site -y
```

Pass a project name as an argument or run without arguments to be prompted:

```sh
npm create bascik@latest
```

## What it scaffolds

`create-bascik` creates a complete, ready-to-run starter site:

```text
my-site/
├── .github/skills/bascik/SKILL.md  ← AI Copilot skill file
├── .claude/skills/bascik/SKILL.md  ← Claude skill file
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

## Development & Testing

From the repository root:

```sh
yarn create:build      # compile build output
yarn create:typecheck  # TypeScript type check
yarn create:unit       # run unit tests
yarn create:coverage   # run unit tests with coverage report
```
