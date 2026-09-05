# Create App

The `create/` folder is a small standalone package that scaffolds a fresh Bascik project. It is separate from the main package because it is meant to be run as a user-facing CLI, not as a workspace dependency.

## Code structure

The package has two source files with distinct responsibilities:

- `create/src/scaffold.ts`: pure data and file-writing logic. All generated file content lives here as exported string constants and functions. No I/O beyond `fs/promises`. This is what the tests cover.
- `create/src/index.ts`: the CLI entry point. Handles prompts, the `-y` flag, and spawns `npm install` / `npm run dev`. Not unit-tested.

Keeping them split means you can test every generated file without invoking the CLI or touching the filesystem.

## What the CLI generates

Running `npx create-bascik <name>` writes this structure:

```text
<name>/
  package.json
  bascik.config.ts
  vite.config.js
  .gitignore
  .vscode/
    launch.json
  .github/skills/bascik/SKILL.md
  .claude/skills/bascik/SKILL.md
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

The `feat-card` component demonstrates named slots. The `my-counter` component demonstrates scoped JS with two independent instances on the home page. Every component includes co-located unit tests, `vite.config.js` configures Vitest with V8 code coverage, and `e2e/` includes Playwright browser specs testing page navigation, counter interaction, and mobile menu toggling.

After scaffolding, the CLI offers to run `npm install` and `npm run dev`. Both prompts can be skipped with `-y`.

## Why the generated app uses npm

The scaffold runs `npm install` and `npm run dev` so users do not need Yarn or pnpm to get started. The repo itself uses Yarn workspaces for contributor work, but the generated site is designed to feel like a regular app from a standard Node CLI.

## Modifying the scaffold

All generated file content is defined as string constants in `scaffold.ts`. To change what a new project looks like, edit the relevant constant there. After any change, rebuild before testing:

```sh
cd create
npm run build
```

The `npm link` symlink points at the `create/` directory, so a fresh `dist/` is picked up immediately without relinking. `npm link` also runs `prepare`, which copies the latest SKILL.md from docs and rebuilds `dist/`, so the initial link after a fresh checkout needs no separate build step.

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

This builds `create-bascik` (copying the latest `SKILL.md` from `docs/`), runs the scaffolding CLI to create a test project at `my-site/`, installs its dependencies, and boots the development server.

The `-y` flag skips prompts for automatic setup. Within the monorepo workspace, Yarn links `@bascik/bascik` directly from `pkg/`, allowing end-to-end testing of the scaffolded templates and dev server without publishing to npm first.

```text
Server running at http://localhost:8080
```

## Cleanup after local testing

To clean up after testing:

```sh
rm -rf my-site
```
