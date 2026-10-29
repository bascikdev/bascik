# Bascik Agent Skills

[Agent Skills](https://agentskills.io) that teach AI coding assistants (GitHub Copilot, Claude Code, Cursor, Codex, Gemini CLI, OpenCode, Windsurf, and others) how to build sites with [Bascik](https://bascik.dev).

## Install

With the [skills CLI](https://skills.sh):

```sh
npx skills add bascikdev/bascik
# or from the docs site's /.well-known/agent-skills/ index:
npx skills add https://bascik.dev
```

Without it, download every skill into the shared `.agents/skills/` folder (use `.claude/skills` for Claude Code, or `.github/skills` if you prefer):

```sh
mkdir -p .agents/skills && curl -fsSL https://bascik.dev/assets/skills.tar.gz | tar -xz -C .agents/skills
```

New projects created with `npm create bascik@rc` include every skill except the opt-in `bascik-refactor`. Install that one on its own when you want coding agents to refactor a live site:

```sh
npx skills add bascikdev/bascik --skill bascik-refactor
```

## Skills

| Skill                                                   | Use it for                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`bascik`](bascik/SKILL.md)                             | Start here: project layout, components, slots, props, the CLI, verifying output, examples, and building a new site                 |
| [`bascik-components`](bascik-components/SKILL.md)       | Component CSS and scripts that work with many instances, interactivity, and theming                                                |
| [`bascik-compatibility`](bascik-compatibility/SKILL.md) | Which HTML, CSS, and JavaScript features to use: Baseline support and Bascik scoping                                               |
| [`bascik-scripts`](bascik-scripts/SKILL.md)             | Build, routes, server, and stream scripts, API routes, and Markdown blogs                                                          |
| [`bascik-seo`](bascik-seo/SKILL.md)                     | Head tags, social cards, structured data, sitemap, and `llms.txt`                                                                  |
| [`bascik-config`](bascik-config/SKILL.md)               | `bascik.config.ts`, exec scripts, assets, deployment, and monorepos                                                                |
| [`bascik-testing`](bascik-testing/SKILL.md)             | Unit and E2E tests, debugging, spec validation, Lighthouse                                                                         |
| [`bascik-migrate`](bascik-migrate/SKILL.md)             | Moving a site from React, Next.js, Vue, Svelte, Astro, Eleventy, Hugo, or WordPress                                                |
| [`bascik-refactor`](bascik-refactor/SKILL.md)           | Opt-in: coding agents refactor a live site to match production at every breakpoint and score 100 in all five Lighthouse categories |

The skills hold the rules an assistant must follow and point to the docs at https://bascik.dev for everything else, so the guidance lives in one place. `bascik/scripts/read-doc.mjs` prints any docs page.

## Scripts

The skills ship dependency-free Node.js scripts (Node 22.22+) that agents run from the project root. The opt-in `bascik-refactor` scripts load Playwright and sharp from the project:

| Script                                               | Purpose                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `bascik/scripts/verify.mjs`                          | `bascik --check` plus the language server linter (including component folders outside the project), optionally a build |
| `bascik/scripts/preview.mjs`                         | Compile a snippet or page with the project's components and print readable output                                      |
| `bascik/scripts/list-components.mjs`                 | Inventory components with props, slots, and descriptions                                                               |
| `bascik/scripts/new-component.mjs`                   | Create a component that follows the conventions                                                                        |
| `bascik/scripts/search-docs.mjs`                     | Search the live docs                                                                                                   |
| `bascik/scripts/read-doc.mjs`                        | Print a docs page as text                                                                                              |
| `bascik/scripts/add-example.mjs`                     | Copy an example from https://bascik.dev/example-components into the project                                            |
| `bascik/scripts/check-links.mjs`                     | Find broken internal links and `#fragments` in `dist/`                                                                 |
| `bascik-components/scripts/check-tokens.mjs`         | Find CSS custom properties components use but nothing declares                                                         |
| `bascik-compatibility/scripts/lookup.mjs`            | Search Bascik's live compatibility matrix                                                                              |
| `bascik-compatibility/scripts/baseline.mjs`          | Baseline browser support for a web feature                                                                             |
| `bascik-scripts/scripts/new-post.mjs`                | Create a Markdown post with valid front matter                                                                         |
| `bascik-seo/scripts/audit-seo.mjs`                   | Check titles, descriptions, canonicals, social tags, and JSON-LD in `dist/`                                            |
| `bascik-config/scripts/audit-config.mjs`             | Flag redundant or risky `bascik.config.ts` values                                                                      |
| `bascik-config/scripts/check-workspace.mjs`          | Map every site in a repository and report cross-site problems                                                          |
| `bascik-refactor/scripts/breakpoint-matrix.mjs`      | Legacy breakpoints to a B - 1, B, B + 1 viewport matrix                                                                |
| `bascik-refactor/scripts/geometry-diff.mjs`          | Element box diff between production and the Bascik site                                                                |
| `bascik-refactor/scripts/compare-route.mjs`          | Pixel, geometry and interaction comparison per route (Playwright and sharp)                                            |
| `bascik-refactor/scripts/lighthouse-gate.mjs`        | Fail unless every Lighthouse report is 100 in all five categories                                                      |
| `bascik-refactor/scripts/llms-txt.mjs`               | Post exec script that writes `dist/llms.txt`                                                                           |
| `bascik-refactor/scripts/responsive-webp.mjs`        | WebP variants and a sha256 manifest (sharp)                                                                            |
| `bascik-refactor/scripts/worker-response-policy.mjs` | Cloudflare Worker wrapper with CSP hashes, robots and cache headers                                                    |
| `bascik-refactor/scripts/interaction-crawl.mjs`      | Activate every interactive element on both sides and compare what each one does                                        |
| `bascik-refactor/scripts/state-capture.mjs`          | Open every dropdown and disclosure on both sides: styles, icons and crops                                              |
| `bascik-refactor/scripts/repeated-sections.mjs`      | A section repeated across routes must be one component, styled the same                                                |
| `bascik-refactor/scripts/text-style-diff.mjs`        | Text color, weight and font at rest, `:hover` and `:focus-visible`                                                     |
| `bascik-refactor/scripts/spacing-diff.mjs`           | Vertical gaps inside each section, 2 px tolerance                                                                      |
| `bascik-refactor/scripts/alignment-diff.mjs`         | Text alignment, line count and offsets at every breakpoint                                                             |
| `bascik-refactor/scripts/overlap-diff.mjs`           | Overlapping elements within 1 px, and their pixels exactly                                                             |
| `bascik-refactor/scripts/testid-carryover.mjs`       | Production and legacy test hooks kept on the same elements                                                             |
| `bascik-refactor/scripts/testid-coverage.mjs`        | A `data-testid` on every control, form, landmark and component root                                                    |
| `bascik-refactor/scripts/presence-by-route.mjs`      | Banners, dialogs and sticky layers per route, fresh and after dismissal                                                |
| `bascik-refactor/scripts/production-defects.mjs`     | Production's own layout bugs, logged as fixes before parity runs                                                       |
| `bascik-refactor/scripts/run-checks.mjs`             | Every parity check per route in one command (Playwright and sharp)                                                     |
| `bascik-refactor/scripts/review-page.mjs`            | Side-by-side review page per route and the human sign-off gate                                                         |

The example components and the starter site live in the repository's [`examples/`](https://github.com/bascikdev/bascik/tree/main/examples) folder, not in the skills. The docs build publishes them at `https://bascik.dev/assets/examples.json`, which `add-example.mjs` downloads.

## Contributing

These files are the source of truth. The docs build publishes them to `https://bascik.dev/assets/skills.tar.gz`, `https://bascik.dev/.well-known/agent-skills/` (one archive per skill plus `index.json`), and the core skill to `https://bascik.dev/assets/SKILL.md`, and `create-bascik` bundles a copy of every skill except the opt-in `bascik-refactor` in `create/assets/skills/` (`yarn create:prepack`). Contributor-only skills for working on Bascik itself live in `.github/skills/` and are marked `metadata.internal`, so `npx skills add` does not offer them.
