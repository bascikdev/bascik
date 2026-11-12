# Agent Skills

Install the Bascik agent skills so GitHub Copilot, Claude Code, Cursor, Codex, or any assistant that supports Agent Skills knows how to build with Bascik, and can run scripts that check its own work.

The skills follow the open [Agent Skills](https://agentskills.io) format. Each covers one area and loads when a task needs it. Start with the CLI install below, then choose the skills that fit your project.

## Install

Run this from the root of your project:

```sh
npx skills add bascikdev/bascik
```

The [skills CLI](https://skills.sh) detects the assistants you use and installs the skills where each one looks for them. Choose skills interactively, or use a command from the table below to install one. To install all skills without prompts, run `npx skills add bascikdev/bascik --skill '*' -y`.

To install a skill from the docs site instead, use `npx skills add https://bascik.dev --skill <skill-name>`. For example, install the opt-in `bascik-refactor` skill with `npx skills add https://bascik.dev --skill bascik-refactor`.

## The Skills

| Skill                  | Use it for                                                                                                               | Install command                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `bascik`               | **Start here.** Project layout, components, slots, props, the CLI, checking output, and copying examples                 | `npx skills add bascikdev/bascik --skill bascik`               |
| `bascik-components`    | Component CSS and TypeScript, interactivity, theming, and scoped names                                                   | `npx skills add bascikdev/bascik --skill bascik-components`    |
| `bascik-images`        | Responsive WebP, native image markup, stable galleries, and selected variants before first paint                         | `npx skills add bascikdev/bascik --skill bascik-images`        |
| `bascik-compatibility` | Checking HTML, CSS, and JavaScript support in browsers and Bascik's scoping engine                                       | `npx skills add bascikdev/bascik --skill bascik-compatibility` |
| `bascik-scripts`       | Build, routes, server, and stream scripts, API routes, Markdown, and blogs                                               | `npx skills add bascikdev/bascik --skill bascik-scripts`       |
| `bascik-seo`           | Titles, descriptions, canonical URLs, social cards, JSON-LD, and `llms.txt`                                              | `npx skills add bascikdev/bascik --skill bascik-seo`           |
| `bascik-config`        | Configuration, exec scripts, deployment, and monorepos                                                                   | `npx skills add bascikdev/bascik --skill bascik-config`        |
| `bascik-testing`       | Unit and E2E tests, debugging, validating output, and Lighthouse                                                         | `npx skills add bascikdev/bascik --skill bascik-testing`       |
| `bascik-migrate`       | Moving from React, Next.js, Vue, Svelte, Astro, Eleventy, Hugo, or WordPress                                             | `npx skills add bascikdev/bascik --skill bascik-migrate`       |
| `bascik-refactor`      | **Opt-in.** Refactoring a live site with production parity at every breakpoint and 100 in all five Lighthouse categories | `npx skills add bascikdev/bascik --skill bascik-refactor`      |

New projects created with `npm create bascik` or `bascik init` offer to install the general-purpose skills automatically. Add `bascik-refactor` separately when you need the workflow in [Migrating with Coding Agents](/how-to/agent-migration).

The skills hold only what an assistant must not get wrong: target per-instance elements with `id` and `getElementById`, keep props to text and use slots for markup, do not create a config file without a reason, and never write generated files into `src/`. For everything else they point to the page on this site that explains it, and `read-doc.mjs` prints that page, so the skills and the docs never disagree.

## Scripts the Assistant Runs

The skills include Node.js scripts (Node 24.21 or newer). The assistant runs them from the project root, and they use the project's own installed Bascik. Most need no extra dependencies. The `bascik-images` WebP helper loads Sharp from your project; [Optimizing Images](/how-to/optimizing-images) shows how agents generate files locally, wire up native HTML and CSS, and prevent first-paint flashes. The `bascik-refactor` scripts also load Playwright and sharp from your project, so install them as dev dependencies when you use those scripts. [Migrating with Coding Agents](/how-to/agent-migration) shows the scripts in order.

| Script                                               | What it does                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bascik/scripts/verify.mjs`                          | Runs `bascik --check` and the [linter](/tools/linter) (including component folders outside the project, such as a monorepo's shared components), and with `--build` a production build, then reports each step                                                                  |
| `bascik/scripts/audit-components.mjs`                | Reports oversized pages and components, inline sections and repeated blocks that should be components, prop drilling, JavaScript where TypeScript is expected, hand-written HTML escapers and strippers (use `html` instead), and semantic HTML problems, each with `file:line` |
| `bascik/scripts/preview.mjs`                         | Compiles a snippet or an existing page with your components and config in a scratch directory, and prints readable output                                                                                                                                                       |
| `bascik/scripts/list-components.mjs`                 | Lists every component with its props, slots, companion files, and `@bascik` description                                                                                                                                                                                         |
| `bascik/scripts/new-component.mjs`                   | Creates a component folder that follows the naming and ordering rules                                                                                                                                                                                                           |
| `bascik/scripts/search-docs.mjs`                     | Searches this documentation site                                                                                                                                                                                                                                                |
| `bascik/scripts/read-doc.mjs`                        | Prints a docs page as text, such as `/scoped-javascript`                                                                                                                                                                                                                        |
| `bascik/scripts/add-example.mjs`                     | Copies an [example](/example-components) into the right folders of your project, and refuses to overwrite your files                                                                                                                                                            |
| `bascik/scripts/check-links.mjs`                     | Finds broken internal links, missing assets, and dead `#fragment` targets in `dist/`, honoring `base`                                                                                                                                                                           |
| `bascik-components/scripts/check-tokens.mjs`         | Reports CSS custom properties that components read but no global stylesheet declares                                                                                                                                                                                            |
| `bascik-compatibility/scripts/lookup.mjs`            | Searches the [compatibility matrix](/compatibility) for a pattern, such as `container` or `setAttribute`                                                                                                                                                                        |
| `bascik-compatibility/scripts/baseline.mjs`          | Reports a web feature's Baseline status and browser versions from the [Web Platform Status](https://webstatus.dev) API                                                                                                                                                          |
| `bascik-scripts/scripts/new-post.mjs`                | Creates a Markdown post with front matter the starter site's blog helper accepts                                                                                                                                                                                                |
| `bascik-seo/scripts/audit-seo.mjs`                   | Checks every built page for a title, description, canonical URL, social tags, one `<h1>`, image `alt`, and valid JSON-LD                                                                                                                                                        |
| `bascik-config/scripts/audit-config.mjs`             | Flags config values that restate defaults, `siteUrl` in config, missing exec scripts, and watched output paths                                                                                                                                                                  |
| `bascik-config/scripts/check-workspace.mjs`          | Lists every site in a repository with its shared folders and reports duplicate tags, broken `@/` imports in shared components, unwatched helpers, and mismatched Bascik versions                                                                                                |
| `bascik-refactor/scripts/breakpoint-matrix.mjs`      | Finds the legacy site's breakpoints in CSS, Sass and scripts and writes the B - 1, B, B + 1 viewport matrix                                                                                                                                                                     |
| `bascik-refactor/scripts/capture-baselines.mjs`      | Records production alone before any page exists: a full-page screenshot, element geometry and every open state per route and matrix case, by id `<route>@<case>`                                                                                                                |
| `bascik-refactor/scripts/geometry-diff.mjs`          | Compares the boxes of headings, paragraphs, buttons and links between production and Bascik at every matrix width                                                                                                                                                               |
| `bascik-refactor/scripts/compare-route.mjs`          | Compares a route with production in pixels, geometry and interactions, and writes a JSON report with screenshots                                                                                                                                                                |
| `bascik-refactor/scripts/lighthouse-gate.mjs`        | Fails unless every Lighthouse report scores 100 in all five categories for the requested form factor                                                                                                                                                                            |
| `bascik-refactor/scripts/llms-txt.mjs`               | Writes `dist/llms.txt` from the built pages as a post exec script                                                                                                                                                                                                               |
| `bascik-images/scripts/responsive-webp.mjs`          | Writes WebP variants up to each image's width and a manifest for native `srcset`; the agent edits the HTML                                                                                                                                                                      |
| `bascik-refactor/scripts/worker-response-policy.mjs` | Wraps the Cloudflare Worker to send a hash-based CSP, robots and cache headers                                                                                                                                                                                                  |
| `bascik-refactor/scripts/interaction-crawl.mjs`      | Activates every interactive element on a production route, replays it on Bascik, and reports missing or different effects such as a scroll that no longer happens                                                                                                               |
| `bascik-refactor/scripts/state-capture.mjs`          | Opens every dropdown and disclosure on both sides and compares the open state's styles, icons and a pixel crop                                                                                                                                                                  |
| `bascik-refactor/scripts/repeated-sections.mjs`      | Finds sections repeated across routes and requires one component for them, with the same computed styles on every route                                                                                                                                                         |
| `bascik-refactor/scripts/text-style-diff.mjs`        | Compares text color, weight, font and decoration at rest, under `:hover` and under `:focus-visible`                                                                                                                                                                             |
| `bascik-refactor/scripts/spacing-diff.mjs`           | Compares the vertical gaps inside each section within 2 px, so one wrong margin is not hidden by drift                                                                                                                                                                          |
| `bascik-refactor/scripts/alignment-diff.mjs`         | Compares text alignment, line count and offsets at every matrix width and names the width that differs                                                                                                                                                                          |
| `bascik-refactor/scripts/overlap-diff.mjs`           | Requires overlapping elements, such as an icon on a dot, to sit within 1 px of production and match it pixel for pixel                                                                                                                                                          |
| `bascik-refactor/scripts/testid-carryover.mjs`       | Requires every test hook from production and the legacy source on the same element of the Bascik site                                                                                                                                                                           |
| `bascik-refactor/scripts/testid-coverage.mjs`        | Reports controls, forms, landmarks and component roots without a `data-testid`, with the file to edit                                                                                                                                                                           |
| `bascik-refactor/scripts/presence-by-route.mjs`      | Compares banners, dialogs and sticky layers per route in a fresh browser and after dismissal                                                                                                                                                                                    |
| `bascik-refactor/scripts/production-defects.mjs`     | Finds squished images, misaligned icons, overflow and sideways scroll on production and logs them as fixes                                                                                                                                                                      |
| `bascik-refactor/scripts/run-checks.mjs`             | Runs every parity check per route and matrix case in one command and writes the report the review page reads                                                                                                                                                                    |
| `bascik-refactor/scripts/review-page.mjs`            | Writes a side-by-side review page per route and verifies the human sign-off in `docs/migration/review/`                                                                                                                                                                         |

For example, after writing a component the assistant can confirm that two instances get separate IDs:

```sh
node .agents/skills/bascik/scripts/preview.mjs '<like-button data-bascik-prop-label="Like" />' --count 2 --body
```

`new-component.mjs`, `add-example.mjs`, and `new-post.mjs` write to your project. The image skill's `responsive-webp.mjs` writes images into `--out` and its manifest into `--manifest` (by default, `--out/manifest.json`). The `bascik-refactor` scripts that produce files also write: `breakpoint-matrix.mjs --out`, `geometry-diff.mjs --out`, `compare-route.mjs`, `run-checks.mjs` and the parity checks it runs (reports and screenshots under `artifacts/`), `review-page.mjs` (pages under `artifacts/review/`, and a sign-off in `docs/migration/review/` with `--sign`), `production-defects.mjs` (rows appended to `docs/migration/decisions.md`), `capture-baselines.mjs` (baselines under `artifacts/baselines/`), `interaction-crawl.mjs --discover` (a draft at `docs/migration/interactions.draft.json`), and `llms-txt.mjs` (`dist/llms.txt` only). The other scripts only read. `preview.mjs` builds into a temporary folder under `node_modules/.cache/bascik/` and deletes it afterward, so your `dist/` is never touched. The docs scripts read the public search index at `https://bascik.dev/assets/search-index.json`.

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

`npx skills update` keeps the version a skill was installed from. Skills that a new project installed at a release tag stay at that tag, so after upgrading `@bascik/bascik` run the install again with the new version, as the project's `AGENTS.md` shows:

```sh
npx skills add bascikdev/bascik#v<version> -a universal -a claude-code --copy -y --skill bascik bascik-compatibility bascik-components bascik-config bascik-images bascik-migrate bascik-scripts bascik-seo bascik-testing
```

With curl, run the same install command again; it overwrites the files in place.

You can also ask your assistant to do this. Add an instruction like the following to your repository's agent instructions (such as `AGENTS.md`, `.github/copilot-instructions.md`, or `CLAUDE.md`):

> Before working on Bascik code, make sure the Bascik agent skills are installed and current. Run `npx skills update` if they were installed with the skills CLI. Otherwise run `mkdir -p .agents/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills`.

> **Source.** The skills live in the [`skills/` folder](https://github.com/bascikdev/bascik/tree/main/skills) of the Bascik repository and are published with each docs release. Tests keep the skills' defaults, scripts, and links in step with the compiler.

## Other Install Methods

### From this site

To use the skills CLI without GitHub:

```sh
npx skills add https://bascik.dev
```

Add `--skill <name>` to select a skill, just as with the GitHub commands above. Each docs release publishes an [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615) discovery index at `https://bascik.dev/.well-known/agent-skills/index.json`, which the CLI reads.

### With curl

Download every skill into the shared `.agents/skills/` folder, which GitHub Copilot, Cursor, Codex, Gemini CLI, and OpenCode read:

```sh
mkdir -p .agents/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills
```

Claude Code reads `.claude/skills/` instead:

```sh
mkdir -p .claude/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .claude/skills
```

VS Code also reads `.github/skills/`, so you can extract into that folder if your repository keeps its Copilot customizations there. The archive includes the opt-in `bascik-refactor` skill.

On Windows, `curl.exe` and `tar` ship with Windows 10 and later. Download the archive to a file first, because older PowerShell versions do not pipe binary data:

```sh
mkdir .agents\skills -Force
curl.exe -fsSLo skills.tar.gz https://bascik.dev/assets/skills.tar.gz
tar -xzf skills.tar.gz -C .agents/skills
del skills.tar.gz
```

### New projects

After setting up the files, `npm create bascik` and `bascik init` ask:

```text
Install the Bascik agent skills for coding assistants (Claude Code, Copilot, Cursor, Codex...)? (Y/n)
```

Press Enter, or pass `-y`, and they run the skills CLI for you. They install every skill except the opt-in `bascik-refactor` into `.agents/skills/` and `.claude/skills/` and record them in `skills-lock.json`. The skills come from the release tag that matches the Bascik version being set up, such as `bascikdev/bascik#v1.0.0`, and from the default branch when that tag cannot be found.

Answer `n`, or pass `--no-skills`, to skip it. When you skip it, or the install fails, for example offline, the project is still created and the command to run later is printed, pinned to the same release tag:

```sh
npx skills add bascikdev/bascik#v1.0.0 -a universal -a claude-code --copy -y --skill bascik bascik-compatibility bascik-components bascik-config bascik-images bascik-migrate bascik-scripts bascik-seo bascik-testing
```

If that tag is not found, run the same command without `#v1.0.0` to install from the default branch.

### Project Brief

New projects also get an `AGENTS.md` at the root, a short brief that GitHub Copilot, Cursor, Codex, and other assistants read before they start: the commands to run (`npm run dev`, `npm run build` and the site URL it needs, `npx bascik --check`, and a preview), the house rules (pages that read like a list of component tags without splitting too far, TypeScript for new code including browser scripts, `html` from `@bascik/bascik/html` for visitor data, semantic HTML, `data-testid` on component roots and controls, and `bascik --check` before calling work done), and where the skills live. It links to these docs instead of repeating them.

Claude Code reads `CLAUDE.md` and skips `AGENTS.md` when both exist, so new projects also get a `CLAUDE.md` whose first line imports the brief:

```md
@AGENTS.md
```

Both commands add to files you already have instead of replacing them: an existing `AGENTS.md` gets a `## Bascik` section appended, and an existing `CLAUDE.md` gets the `@AGENTS.md` line. When `bascik init` finds `dev` or `build` scripts that run another tool, it keeps them and the brief names `npx bascik` and `npx bascik --build` instead. Running them again changes nothing. Add notes only Claude Code needs below the import line in `CLAUDE.md`.

### Single file

The core skill is also available on its own at [https://bascik.dev/assets/SKILL.md](https://bascik.dev/assets/SKILL.md), for tools that accept one instruction file. It tells the assistant how to install the rest when the companion skills or scripts are missing.
