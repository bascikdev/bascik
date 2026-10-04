# Create App

The `create/` folder is a small standalone package that scaffolds a fresh Bascik project. It is separate from the main package because it is meant to be run as a user-facing CLI, not as a workspace dependency.

## Code structure

The default starter has two source files with distinct responsibilities:

- `create/src/scaffold.ts`: pure data and file-writing logic. All generated file content lives here as exported string constants and functions. No I/O beyond `fs/promises`. This is what the tests cover.
- `create/src/index.ts`: the CLI entry point. It wires the real terminal, child processes, and signal handlers into `run()` in `create/src/run.ts`, which holds the prompts, the `-y` and `--example` flags, and the `npm install` / `npm run dev` steps.

Keeping them split means you can test every generated file and every CLI flow without a terminal. The example download code is described in [Examples](#examples-example).

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

The `feat-card` component demonstrates named slots. The `my-counter` component demonstrates scoped JS with two independent instances on the home page. Every component includes co-located unit tests, `package.json` includes `npm run lint` backed by `@bascik/language-server`, `.vscode/extensions.json` recommends the official Bascik VS Code extension, `vite.config.js` configures Vitest with V8 code coverage, and `e2e/` includes Playwright browser specs testing page navigation, counter interaction, and mobile menu toggling.

After scaffolding, the CLI offers to run `npm install` and `npm run dev`. Both prompts can be skipped with `-y`. If `npm install` fails, the CLI prints the exit code and stops; it never reports success after a failed install.

## Examples (`--example`)

Besides the built-in starter, `create-bascik` can copy an example from GitHub. The code is split so each part can be tested on its own:

- `create/src/cli.ts` parses arguments. A flag's value is consumed with the flag, so an example name or link is never taken for the project name, and unknown flags are errors.
- `create/src/catalog.ts` decides where an example comes from. An official id resolves to the whole of the branch `examples/<id>` in `bascikdev/bascik`, never to `main`. A link must be `https://github.com/...`; anything else, including other hosts, credentials, query strings, and `..` segments, is rejected before any network request.
- `create/src/example.ts` downloads `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` and reads it with the `tar` package's parser. It does not use tar's extractor. Every entry path is checked, only files under the chosen folder are written (with `wx`, so nothing is overwritten or followed through a link), symbolic and hard links are refused, and file modes are reduced to `644` or `755`. Download size, expanded size, per-file size, entry count, and total time are bounded. Everything is written to a hidden `.create-bascik-*` staging folder beside the destination, validated (`package.json` present, optional `template.json` and Node version), and only then renamed into place. On any failure the staging folder is removed and the destination is untouched.
- `create/src/run.ts` is the CLI flow with every side effect passed in, so tests use a fake terminal. `create/src/index.ts` supplies the real one and removes the staging folder on `SIGINT` and `SIGTERM`.

`--yes` does not install a third-party example, because installing runs its scripts. Official examples follow the default starter's behavior.

Tests run the real download code against a local HTTP server built from hand-assembled tar files (`archive-fixtures.ts`), so `../` paths, absolute paths, and links can be tested. Set `CREATE_BASCIK_ARCHIVE_BASE=http://127.0.0.1:<port>` to point the CLI at such a server. Normal tests never use the live network.

### Adding an official example

1. Add a standalone npm project under `templates/<id>/` with its own `package.json` and lockfile. Do not add it to the Yarn workspaces.
2. Add `template.json` with `license`, `requires.node` (like `">=24.0.0"`), `requires.bascik`, and any `requirements` the user should see.
3. Add `{ id, description }` to `OFFICIAL_EXAMPLES` in `create/src/catalog.ts`.
4. Make sure nothing in the folder points outside it (no `../` imports, symlinks, or workspace links).

Official examples are read from `examples/<id>` branches, not from `main`. `.github/scripts/sync-examples.sh` creates them: for each `templates/<id>` folder at a release tag it adds a commit whose tree is exactly that folder, on top of the branch's current tip (it never force-pushes, and skips a branch whose tree already matches). The `sync-examples` job in `release.yml` runs it after `@bascik/bascik` is published for a `v*` tag, so an example never reaches users before the Bascik version it needs. Prereleases such as `1.0.0-rc.3` publish too.

Because each example is its own branch, `--example blog` downloads about 270 KB, not the whole repository. A CLI release is only needed to list a new example in the picker and in the error message; the example itself is live after the next `@bascik/bascik` release. To publish by hand, or to preview what a release would push, run `DRY_RUN=1 .github/scripts/sync-examples.sh <tag>`.

Deleting a folder from `templates/` does not delete its branch. Delete it on GitHub, and remove its id from `OFFICIAL_EXAMPLES`.

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
