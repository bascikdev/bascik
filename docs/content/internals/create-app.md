# Create App

The `create/` folder is a small standalone package that scaffolds a fresh Bascik project. It is separate from the main package because it is meant to be run as a user-facing CLI, not as a workspace dependency.

## Code structure

The package's source files have distinct responsibilities:

- `create/src/scaffold.ts`: pure data and file-writing logic. All generated file content lives here as exported string constants and functions. No I/O beyond `fs/promises`. This is what the tests cover.
- `create/src/agent-setup.ts`: the coding-assistant setup shared with `bascik init`: the `AGENTS.md` brief and the `CLAUDE.md` that imports it (merged into existing files), the agent skills install through the skills CLI, and the prompt helper that keeps a run without a terminal from hanging.
- `create/src/index.ts`: the CLI entry point. Handles prompts, including the Cloudflare template and agent skills questions, and spawns the skills CLI, `npm install` and `npm run dev`. `create-cli.integration.test.ts` runs it end to end.
- `create/src/cli.ts`: parses `-y`, `--no-install`, `--no-dev`, `--no-skills`, `--template <name>`, and the positional project name, and refuses an unknown flag with the closest known one. Because npm keeps flags written before `--` for itself, it also honors the `npm_config_yes`, `npm_config_template`, `npm_config_skills` and `npm_config_install` variables npm sets instead (npm sets a `--no-*` flag's variable to the empty string). npm takes `--no-dev` as its own `dev` setting and sets nothing, so that flag only works after `--`.

Keeping them split means you can test every generated file without invoking the CLI or touching the filesystem.

`validateProjectName` refuses `.`, `..`, an absolute path, spaces and empty or hidden path segments, so the project is always a new folder under the current one; its last segment names the site, and lowercased, the package. Before writing anything, `scaffold` checks the target: a file where the project folder goes, or a folder that already has one of the starter's own files (or a file where one of its folders goes), throws a `ScaffoldTargetError` naming them, which the CLI prints in one line and exits 1. AGENTS.md, CLAUDE.md and `.vscode/` are not in the way, since those are merged. Any other filesystem error is printed as `Error: could not create <name>: <reason>`.

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
    settings.json
  AGENTS.md              project brief for coding assistants
  CLAUDE.md              @AGENTS.md, so Claude Code reads the brief
  .agents/skills/        Bascik agent skills, installed by the skills CLI on Y
  .claude/skills/        the same skills for Claude Code
  skills-lock.json       written by the skills CLI
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
      contact-form/
        contact-form.html
        contact-form.test.ts
```

The `feat-card` component demonstrates named slots. The `my-counter` component demonstrates scoped JS with two independent instances on the home page, and `contact-form` a contact form. Component scripts are written in TypeScript (`<script type="text/typescript">`). Every component includes co-located unit tests, `package.json` includes `npm run lint` (`bascik --check`, which runs the `@bascik/language-server` linter and the project-wide checks), `.vscode/extensions.json` recommends the official Bascik VS Code extension, `.vscode/settings.json` sets `"html.validate.scripts": false` so VS Code does not join a page's separate `<script>` blocks into one file and report false errors, `vite.config.js` configures Vitest with V8 code coverage, and `e2e/` includes Playwright browser specs testing page navigation, counter interaction, and mobile menu toggling.

After scaffolding, the CLI asks whether to install the agent skills, then offers to run `npm install` and `npm run dev`. All three default to yes, `-y` answers yes to each, and `--no-skills`, `--no-install` and `--no-dev` skip one.

## Agent skills

The skills are not bundled in the package. On yes, the CLI runs the pinned skills CLI in the new project:

```sh
npx --prefer-offline -y skills@1.7.4 add bascikdev/bascik#v<version> -a universal -a claude-code --copy -y --skill bascik bascik-compatibility ...
```

`<version>` is the `@bascik/bascik` version the scaffold depends on (`BASCIK_VERSION` in `scaffold.ts`), so the skills match the framework. When that tag is missing, such as before a release is tagged, it retries from the default branch. It does not retry when npx itself failed to reach the npm registry, and it runs npx with `npm_config_fetch_retries=0` and a 20-second fetch timeout (unless you set your own), so an offline first run, with the skills CLI not yet in npm's cache, fails in about a second instead of minutes. When the install fails, or the reader answers no, it prints the command to run later, pinned to the same tag, and carries on. `--copy` writes real folders instead of symlinks, which Windows needs. The skills CLI has no option to leave a skill out and ignores names it does not know, so `PROJECT_SKILLS` in `agent-setup.ts` lists every skill except the opt-in `bascik-refactor`, and a test fails when it no longer matches the repository's `skills/` folder.

`BASCIK_SKILLS_SOURCE` replaces the GitHub source, for example with a local checkout (`BASCIK_SKILLS_SOURCE=$PWD/.. node dist/index.js my-site -y`), and is used as given with no tag. The integration tests use it to install this branch's skills without GitHub.

`agent-setup.ts` has an identical copy at `pkg/src/lib/agent-setup.ts` for `bascik init`; a unit test fails when the two differ. The `cloudflare` template adds `src/pages/edge.html` (a server-script demo page), `src/api/hello.ts`, the `@bascik/adapter-cloudflare` and `wrangler` dev dependencies, and `build`, `preview`, and `deploy` scripts for Cloudflare Workers.

## Why the generated app uses npm

The scaffold runs `npm install` and `npm run dev` so users do not need Yarn or pnpm to get started. The repo itself uses Yarn workspaces for contributor work, but the generated site is designed to feel like a regular app from a standard Node CLI.

## Modifying the scaffold

All generated file content is defined as string constants in `scaffold.ts`. To change what a new project looks like, edit the relevant constant there. The `.vscode/settings.json` and `.vscode/extensions.json` content lives in `vscode-settings.ts` instead, which has an identical copy at `pkg/src/lib/vscode-settings.ts` for `bascik init`; a unit test fails when the two differ. Both commands merge into `.vscode` files a folder already has: they add the missing setting or recommendation, keep comments and other entries, keep a value the user already set, and leave a file that is not valid JSON alone with a printed note saying what to add. An existing `launch.json` is never replaced. After any change, rebuild before testing:

```sh
cd create
npm run build
```

The `npm link` symlink points at the `create/` directory, so a fresh `dist/` is picked up immediately without relinking. `npm link` also runs `prepare`, which builds `dist/`, so the initial link after a fresh checkout needs no separate build step.

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

This builds `create-bascik` and runs the scaffolding CLI to create a test project at `my-site/`. It skips the generated project's npm install, then builds the site using the `@bascik/bascik` package already linked from `pkg/` in the monorepo workspace. This lets CI test the current package changes before an RC is published.

The `-y` flag selects the defaults non-interactively, while `--no-skills`, `--no-install` and `--no-dev` skip the agent skills, npm install and dev server startup. `--template cloudflare` selects the Cloudflare Workers template; through `npm create` it must follow a `--` separator (`npm create bascik@rc my-site -- --template cloudflare`).

```text
Build complete
```

## Cleanup after local testing

To clean up after testing:

```sh
rm -rf my-site
```
