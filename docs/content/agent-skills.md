# Agent Skills

Install the Bascik agent skills so GitHub Copilot, Claude Code, Cursor, Codex, or any assistant that supports Agent Skills knows how to build with Bascik, and can run scripts that check its own work.

Most Bascik sites are now written with an AI assistant, so the assistant has to understand Bascik as well as you do. The Bascik skills follow the open [Agent Skills](https://agentskills.io) format. Each one covers one area, loads only when a task needs it, and ships Node.js scripts the assistant runs to compile a preview, inventory components, lint, audit config, and look up the live docs.

## Install

Run one of these from the root of your project.

### With the skills CLI

```sh
npx skills add bascikdev/bascik
```

The [skills CLI](https://skills.sh) detects the assistants you use and installs the skills where each one looks for them. Add `--skill bascik` to install only the core skill, or `--skill '*' -y` to install all of them without prompts.

You can also install from this site instead of GitHub. Every release of the docs publishes an [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615) skills index at `https://bascik.dev/.well-known/agent-skills/index.json`, and the skills CLI reads it:

```sh
npx skills add https://bascik.dev
```

### With curl

Download every skill into the shared `.agents/skills/` folder, which GitHub Copilot, Cursor, Codex, Gemini CLI, and OpenCode read:

```sh
mkdir -p .agents/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills
```

Claude Code reads `.claude/skills/` instead:

```sh
mkdir -p .claude/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .claude/skills
```

VS Code also reads `.github/skills/`, so you can extract into that folder if your repository keeps its Copilot customizations there.

On Windows, `curl.exe` and `tar` ship with Windows 10 and later. Download the archive to a file first, because older PowerShell versions do not pipe binary data:

```sh
mkdir .agents\skills -Force
curl.exe -fsSLo skills.tar.gz https://bascik.dev/assets/skills.tar.gz
tar -xzf skills.tar.gz -C .agents/skills
del skills.tar.gz
```

### New projects

Projects created with `npm create bascik@latest` include every skill in `.agents/skills/` and `.claude/skills/`, so there is nothing to install.

### Single file

The core skill is also available on its own at [https://bascik.dev/assets/SKILL.md](https://bascik.dev/assets/SKILL.md), for tools that accept one instruction file. It tells the assistant how to install the rest when the companion skills or scripts are missing.

## The Skills

| Skill | The assistant loads it when |
|---|---|
| `bascik` | Working in any Bascik project: layout, components, slots, props, the CLI, checking output, copying examples, and building a new site. Start here |
| `bascik-components` | Writing component CSS or `<script>` code, adding interactivity, setting up theming, or compiled class and ID names look wrong |
| `bascik-compatibility` | Deciding whether an HTML, CSS, or JavaScript feature is safe to use, in browsers and inside a component |
| `bascik-scripts` | Using build, routes, server, or stream scripts, API routes, Markdown, or a blog |
| `bascik-seo` | Writing titles, descriptions, canonical URLs, social cards, JSON-LD, or `llms.txt` |
| `bascik-config` | Creating or editing `bascik.config.ts`, adding exec scripts, deploying, or setting up a monorepo |
| `bascik-testing` | Writing unit or E2E tests, debugging, validating `dist/`, or tuning Lighthouse scores |
| `bascik-migrate` | Moving a site from React, Next.js, Vue, Svelte, Astro, Eleventy, Hugo, or WordPress |

The skills hold only what an assistant must not get wrong: target per-instance elements with `id` and `getElementById`, keep props to text and use slots for markup, do not create a config file without a reason, and never write generated files into `src/`. For everything else they point to the page on this site that explains it, and `read-doc.mjs` prints that page, so the skills and the docs never disagree.

## Scripts the Assistant Runs

The skills include dependency-free Node.js scripts (Node 22.18 or newer). The assistant runs them from the project root, and they use the project's own installed Bascik.

| Script | What it does |
|---|---|
| `bascik/scripts/verify.mjs` | Runs `bascik --check` and the [linter](/tools/linter) (including component folders outside the project, such as a monorepo's shared components), and with `--build` a production build, then reports each step |
| `bascik/scripts/preview.mjs` | Compiles a snippet or an existing page with your components and config in a scratch directory, and prints readable output |
| `bascik/scripts/list-components.mjs` | Lists every component with its props, slots, companion files, and `@bascik` description |
| `bascik/scripts/new-component.mjs` | Creates a component folder that follows the naming and ordering rules |
| `bascik/scripts/search-docs.mjs` | Searches this documentation site |
| `bascik/scripts/read-doc.mjs` | Prints a docs page as text, such as `/scoped-javascript` |
| `bascik/scripts/add-example.mjs` | Copies an [example](/example-components) into the right folders of your project, and refuses to overwrite your files |
| `bascik/scripts/check-links.mjs` | Finds broken internal links, missing assets, and dead `#fragment` targets in `dist/`, honoring `base` |
| `bascik-components/scripts/check-tokens.mjs` | Reports CSS custom properties that components read but no global stylesheet declares |
| `bascik-compatibility/scripts/lookup.mjs` | Searches the [compatibility matrix](/compatibility) for a pattern, such as `container` or `setAttribute` |
| `bascik-compatibility/scripts/baseline.mjs` | Reports a web feature's Baseline status and browser versions from the [Web Platform Status](https://webstatus.dev) API |
| `bascik-scripts/scripts/new-post.mjs` | Creates a Markdown post with front matter the starter site's blog helper accepts |
| `bascik-seo/scripts/audit-seo.mjs` | Checks every built page for a title, description, canonical URL, social tags, one `<h1>`, image `alt`, and valid JSON-LD |
| `bascik-config/scripts/audit-config.mjs` | Flags config values that restate defaults, `siteUrl` in config, missing exec scripts, and watched output paths |
| `bascik-config/scripts/check-workspace.mjs` | Lists every site in a repository with its shared folders and reports duplicate tags, broken `@/` imports in shared components, unwatched helpers, and mismatched Bascik versions |

For example, after writing a component the assistant can confirm that two instances get separate IDs:

```sh
node .agents/skills/bascik/scripts/preview.mjs '<like-button data-bascik-prop-label="Like" />' --count 2 --body
```

Only `new-component.mjs`, `add-example.mjs`, and `new-post.mjs` write to your project. `preview.mjs` builds into a temporary folder under `node_modules/.cache/bascik/` and deletes it afterward, so your `dist/` is never touched. The docs scripts read the public search index at `https://bascik.dev/assets/search-index.json`.

## Example Components

The [Example Components](/example-components) section of this site has tested components, and the Bascik repository has a complete [starter site](https://github.com/bascikdev/bascik/tree/main/examples/starter-site). The skills tell the assistant to start from them, and `add-example.mjs` downloads them from this site, so the files the assistant copies are the ones these pages show:

```sh
node .agents/skills/bascik/scripts/add-example.mjs --list
node .agents/skills/bascik/scripts/add-example.mjs tab-group
```

## Keeping the Skills Updated

With the skills CLI, update everything it installed:

```sh
npx skills update
```

With curl, run the same install command again; it overwrites the files in place.

You can also ask your assistant to do this. Add an instruction like the following to your repository's agent instructions (such as `AGENTS.md`, `.github/copilot-instructions.md`, or `CLAUDE.md`):

> Before working on Bascik code, make sure the Bascik agent skills are installed and current. Run `npx skills update` if they were installed with the skills CLI. Otherwise run `mkdir -p .agents/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills`.

> **Source.** The skills live in the [`skills/` folder](https://github.com/bascikdev/bascik/tree/main/skills) of the Bascik repository and are published with each docs release. Tests keep the skills' defaults, scripts, and links in step with the compiler.
