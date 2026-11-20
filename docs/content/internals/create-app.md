# Create App

The `create/` folder is a small standalone package that scaffolds a fresh Bascik project. It is separate from the main package because it is meant to be run as a user-facing CLI, not as a workspace dependency.

## Code structure

The package's source files have distinct responsibilities:

- `create/src/scaffold.ts`: pure data and file-writing logic. The files every project gets (package.json, the Vite and Playwright configs, `.gitignore`, the favicons, the adapter pieces) and the default template's content live here as exported string constants and functions, with the `StarterTemplate` interface a template implements. No I/O beyond `fs/promises`. This is what the tests cover.
- `create/src/templates.ts`: the list of templates `--template` accepts, the default first, and its aliases. `create/src/templates/<name>.ts` holds each template after the default. See [Adding a template](#adding-a-template).
- `create/src/agent-setup.ts`: the coding-assistant setup shared with `bascik init`: the `AGENTS.md` brief and the `CLAUDE.md` that imports it (merged into existing files), the agent skills install through the skills CLI, and the prompt helper that keeps a run without a terminal from hanging.
- `create/src/index.ts`: the CLI entry point. Handles the prompts (the project name and the agent skills question; the starter comes only from `--adapter` and `--template`, and is the default static one without them), and spawns the skills CLI, `npm install` and `npm run dev`. `create-cli.integration.test.ts` runs it end to end.
- `create/src/cli.ts`: parses `-y`, `--no-install`, `--no-dev`, `--no-skills`, `--adapter <name>`, `--template <name>`, and the positional project name, and refuses an unknown flag with the closest known one. `--adapter cloudflare` and the older `--template cloudflare` resolve to the same starter; the two flags naming different adapters is an error. Because npm keeps flags written before `--` for itself, it also honors the `npm_config_yes`, `npm_config_adapter`, `npm_config_template`, `npm_config_skills` and `npm_config_install` variables npm sets instead (npm sets a `--no-*` flag's variable to the empty string). npm takes `--no-dev` as its own `dev` setting and sets nothing, so that flag only works after `--`.

Keeping them split means you can test every generated file without invoking the CLI or touching the filesystem.

`validateProjectName` refuses `.`, `..`, an absolute path, spaces and empty or hidden path segments, so the project is always a new folder under the current one; its last segment names the site, and lowercased, the package. Before writing anything, `scaffold` checks the target: a file where the project folder goes, or a folder that already has one of the starter's own files (or a file where one of its folders goes), throws a `ScaffoldTargetError` naming them, which the CLI prints in one line and exits 1. AGENTS.md, CLAUDE.md and `.vscode/` are not in the way, since those are merged. Unrelated files such as an existing `.hintrc` are left untouched. Any other filesystem error is printed as `Error: could not create <name>: <reason>`.

## What the CLI generates

Running `npx create-bascik <name>` writes this structure:

```text
<name>/
  package.json
  vite.config.ts
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
      feature-card/
        feature-card.html
        feature-card.test.ts
      my-counter/
        my-counter.html
        my-counter.test.ts
      contact-form/
        contact-form.html
        contact-form.test.ts
```

The `feature-card` component demonstrates named slots and semantic selectors, with only a short `.body` class where a class is useful. The `my-counter` component demonstrates scoped JS with two independent instances on the home page, and `contact-form` a contact form. Component scripts are written in TypeScript (`<script type="text/typescript">`). Every component includes co-located unit tests, `package.json` includes `npm run lint` (`bascik --check`, which runs the `@bascik/language-server` linter and the project-wide checks), `.vscode/extensions.json` recommends the official Bascik VS Code extension, and `.vscode/settings.json` sets `"html.validate.scripts": false` so VS Code does not join a page's separate `<script>` blocks into one file and report false errors. `vite.config.ts` configures Vitest with V8 code coverage, and `e2e/` includes Playwright browser specs testing page navigation, counter interaction, and mobile menu toggling. Third-party linters such as Webhint are opt-in: setup creates no config or dependency for them. The [linting guide](/testing/linting#editor-linters-read-source) has copyable settings.

After scaffolding, the CLI asks whether to install the agent skills, then offers to run `npm install` and `npm run dev`. All three default to yes, `-y` answers yes to each, and `--no-skills`, `--no-install` and `--no-dev` skip one. The dev server question is skipped when the install is, and `npm run dev` runs only when `npm install` exits 0; otherwise the CLI prints the next steps, `npm install` included.

## Agent skills

The skills are not bundled in the package. On yes, the CLI runs the pinned skills CLI in the new project:

```sh
npx --prefer-offline -y skills@1.7.4 add bascikdev/bascik#v<version> -a universal -a claude-code --copy -y --skill bascik bascik-compatibility ...
```

`<version>` is the `@bascik/bascik` version the scaffold depends on (`BASCIK_VERSION` in `scaffold.ts`), so the skills match the framework. When that tag is missing, such as before a release is tagged, it retries from the default branch. It does not retry when npx itself failed to reach the npm registry, and it runs npx with `npm_config_fetch_retries=0` and a 20-second fetch timeout (unless you set your own), so an offline first run, with the skills CLI not yet in npm's cache, fails in about a second instead of minutes. When the install fails, or the reader answers no, it prints the command to run later, pinned to the same tag, and carries on. `--copy` writes real folders instead of symlinks, which Windows needs. The skills CLI has no option to leave a skill out and ignores names it does not know, so `PROJECT_SKILLS` in `agent-setup.ts` lists every skill except the opt-in `bascik-refactor`, and a test fails when it no longer matches the repository's `skills/` folder.

`BASCIK_SKILLS_SOURCE` replaces the GitHub source, for example with a local checkout (`BASCIK_SKILLS_SOURCE=$PWD/.. node dist/index.js my-site -y`), and is used as given with no tag. The integration tests use it to install this branch's skills without GitHub.

`agent-setup.ts` has an identical copy at `pkg/src/lib/agent-setup.ts` for `bascik init`; a unit test fails when the two differ. The `cloudflare` template adds `src/pages/edge.html` (a server-script demo page), `src/api/hello.ts`, the `@bascik/adapter-cloudflare` and `wrangler` dev dependencies, and `build`, `preview`, and `deploy` scripts for Cloudflare Workers. The `netlify` template adds the same `src/pages/edge.html` and `src/api/hello.ts`, the `@bascik/adapter-netlify` and `netlify-cli` dev dependencies, a `netlify.toml` (build command and the `publish` folder, with Netlify's `URL` used as the site URL), a `.gitignore` that also excludes `publish/` and `.netlify/`, and `build`, `preview`, and `deploy` scripts that build with `bascik --build --target netlify`, run `bascik-netlify-install`, and call the Netlify CLI through `npx`.

## Why the generated app uses npm

The scaffold runs `npm install` and `npm run dev` so users do not need Yarn or pnpm to get started. The repo itself uses Yarn workspaces for contributor work, but the generated site is designed to feel like a regular app from a standard Node CLI.

## Modifying the scaffold

All generated file content is defined as string constants in `scaffold.ts`. To change what a new project looks like, edit the relevant constant there. The `.vscode/settings.json` and `.vscode/extensions.json` content lives in `vscode-settings.ts` instead, which has an identical copy at `pkg/src/lib/vscode-settings.ts` for `bascik init`; a unit test fails when the two differ. Both commands merge into `.vscode` files a folder already has: they add the missing setting or recommendation, keep comments and other entries, keep a value the user already set, and leave a file that is not valid JSON alone with a printed note saying what to add. An existing `launch.json` is never replaced. Third-party linter configs are never created or modified. Keep optional examples in the linting guide, not in the scaffold. After any change, rebuild before testing:

```sh
cd create
npm run build
```

The `npm link` symlink points at the `create/` directory, so a fresh `dist/` is picked up immediately without relinking. `npm link` also runs `prepare`, which builds `dist/`, so the initial link after a fresh checkout needs no separate build step.

## Adding a template

A template is a kind of site (`--template <name>`); an adapter is where it deploys (`--adapter <name>`). The two are independent, so every template must work with every adapter and with none.

1. Write `create/src/templates/<name>.ts`, exporting one `StarterTemplate` (the interface is in `scaffold.ts`): `name`, a one-line `summary` for `--help`, `directories(context)` and `files(context)`. The context carries the site's display name and the adapter, if any.
2. Add it to `TEMPLATES` in `create/src/templates.ts`, on its own line. The CLI's choices and help text read that list.
3. Put the template's own tests in `create/src/templates/<name>.test.ts`.
4. Add a row to the template tables in `docs/content/cli.md` and `create/README.md`, and a `CHANGELOG.md` bullet.

What a template owns and what it is given:

- **Owns:** everything it writes under `src/` and `e2e/app.spec.ts`. It must write `src/pages/index.html` and `src/pages/404.html`.
- **Given:** `package.json`, `vite.config.ts`, `.gitignore`, `netlify.toml` (Netlify), `e2e/playwright.config.ts`, the favicons under `src/pages/`, `AGENTS.md`, `CLAUDE.md`, the `.vscode` files and, with an adapter, the `/api/hello` route in `src/api/hello.ts`. A template that writes one of these fails `scaffold`.
- **With an adapter:** `context.adapter` is set. A template may add a page that runs per request, as the default template's `/edge` page does, or change nothing.
- **Read-only fixtures:** `netlifyIncludedFiles` lists exact fixture paths for Netlify's `functions.included_files`. The shop includes its seeded `data/racing.db`; other templates add no inclusion rule. Server-backed templates run on `bascik --server` without an adapter, not a plain static host. Cloudflare uses a dedicated D1 `DB` binding rather than the local SQLite file.
- **Packages:** a site that imports a package beyond `@bascik/bascik` lists it in the template's `dependencies`. It must be installed in this repo's root `node_modules`, where the integration test links it from.
- **Reuse:** the default template's pieces are exported from `scaffold.ts` (`SITE_META_HTML`, `HOST_RUNTIME`, and so on). Import what fits; do not copy it.
- **Site name:** put `context.siteName` through `escapeHtml` from `scaffold.ts` before writing it into a page.

Templates follow the same house rules as the docs examples: TypeScript, component-first pages, semantic HTML, a `data-testid` on every component root and interactive part, a skip link first in the header, one `<main id="main">` per page, and books and authors as demo data.

Two tests hold every registered template to the common rules, with no code per template: `template registry` in `scaffold.test.ts` (paths, declared folders, shared files left alone) and the template-by-adapter matrix in `scaffold.integration.test.ts`, which scaffolds each combination, builds it with the real CLI, runs `bascik --check`, and runs the public skill's semantic HTML and `data-testid` audits.

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

The `-y` flag selects the defaults non-interactively, while `--no-skills`, `--no-install` and `--no-dev` skip the agent skills, npm install and dev server startup. `--adapter cloudflare` selects the Cloudflare Workers starter and `--adapter netlify` the Netlify starter (`--template cloudflare` and `--template netlify` are the older spelling and still work); through `npm create` it must follow a `--` separator (`npm create bascik my-site -- --adapter cloudflare`).

```text
Build complete
```

## Cleanup after local testing

To clean up after testing:

```sh
rm -rf my-site
```
