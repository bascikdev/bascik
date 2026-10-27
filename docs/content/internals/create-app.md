# Create App

The `create/` folder is a small standalone package that scaffolds a fresh Bascik project. It is separate from the main package because it is meant to be run as a user-facing CLI, not as a workspace dependency.

## Code structure

The package has two source files with distinct responsibilities:

- `create/src/scaffold.ts`: pure data and file-writing logic. All generated file content lives here as exported string constants and functions. No I/O beyond `fs/promises`. This is what the tests cover.
- `create/src/index.ts`: the CLI entry point. Handles prompts, including the Cloudflare template question, and spawns `npm install` / `npm run dev`. Not unit-tested.
- `create/src/cli.ts`: parses `-y`, `--no-install`, `--no-dev`, `--template <name>`, and the positional project name. Because npm keeps flags written before `--` for itself, it also honors the `npm_config_yes` and `npm_config_template` variables npm sets instead.

Keeping them split means you can test every generated file without invoking the CLI or touching the filesystem.

## What the CLI generates

Running `npx create-bascik <name>` writes this structure:

```text
<name>/
  package.json
  vite.config.js
  .gitignore
  .vscode/
    launch.json
    extensions.json
  .agents/skills/        Bascik agent skills (bascik, bascik-components, ...) with scripts
  .claude/skills/        the same skills for Claude Code
  e2e/
    playwright.config.ts
    app.spec.ts
  src/
    pages/
      favicon.ico
      assets/
        favicon-32x32.png
        favicon.svg
        apple-touch-icon.png
      index.html
      about.html
      contact.html
      404.html
      css/
        styles.css
    components/
      site-meta/
        site-meta.html
        site-meta.test.ts
      site-header/
        site-header.html
        site-header.test.ts
      site-footer/
        site-footer.html
        site-footer.test.ts
      feat-card/
        feat-card.html
        feat-card.test.ts
      my-counter/
        my-counter.html
        my-counter.test.ts
```

The `feat-card` component demonstrates named slots. The `my-counter` component demonstrates scoped JS with two independent instances on the home page. Every component includes co-located unit tests, `package.json` includes `npm run lint` (`bascik --check`, which runs the `@bascik/language-server` linter and the project-wide checks), `.vscode/extensions.json` recommends the official Bascik VS Code extension, `vite.config.js` configures Vitest with V8 code coverage, and `e2e/` includes Playwright browser specs testing page navigation, counter interaction, and mobile menu toggling.

After scaffolding, the CLI offers to run `npm install` and `npm run dev`. Both prompts can be skipped with `-y`. The `cloudflare` template adds `src/pages/edge.html` (a server-script demo page), `src/api/hello.ts`, the `@bascik/adapter-cloudflare` and `wrangler` dev dependencies, and `build`, `preview`, and `deploy` scripts for Cloudflare Workers.

## Why the generated app uses npm

The scaffold runs `npm install` and `npm run dev` so users do not need Yarn or pnpm to get started. The repo itself uses Yarn workspaces for contributor work, but the generated site is designed to feel like a regular app from a standard Node CLI.

## Modifying the scaffold

All generated file content is defined as string constants in `scaffold.ts`. To change what a new project looks like, edit the relevant constant there. After any change, rebuild before testing:

```sh
cd create
npm run build
```

The `npm link` symlink points at the `create/` directory, so a fresh `dist/` is picked up immediately without relinking. `npm link` also runs `prepare`, which copies the latest agent skills from the repository's `skills/` folder into `assets/skills/` and rebuilds `dist/`, so the initial link after a fresh checkout needs no separate build step.

## Tests

The scaffold is fully unit-tested. Run the tests from the `create/` directory:

```sh
cd create
npm test
```

Tests mock `fs/promises` and verify that every expected file is written with the right content. If you add or rename a generated file, add a corresponding test case in `scaffold.test.ts`.

## Lockfiles and package managers

Contributors use Yarn at the monorepo root with `yarn.lock`.

Generated projects intentionally use npm, and each generated project gets its own `package-lock.json`.

## Testing create app locally

From the repo root, run:

```sh
yarn create:test-site
```

This builds `create-bascik` (copying the latest agent skills from `skills/`) and runs the scaffolding CLI to create a test project at `my-site/`. It skips the generated project's npm install, then builds the site using the `@bascik/bascik` package already linked from `pkg/` in the monorepo workspace. This lets CI test the current package changes before an RC is published.

The `-y` flag selects the defaults non-interactively, while `--no-install` and `--no-dev` skip npm install and dev server startup. `--template cloudflare` selects the Cloudflare Workers template; through `npm create` it must follow a `--` separator (`npm create bascik@rc my-site -- --template cloudflare`).

```text
Build complete
```

## Cleanup after local testing

To clean up after testing:

```sh
rm -rf my-site
```
