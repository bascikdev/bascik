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

New projects created with `npm create bascik@latest` include these skills already.

## Skills

| Skill | Use it for |
|---|---|
| [`bascik`](bascik/SKILL.md) | Start here: project layout, components, slots, props, the CLI, and verifying output |
| [`bascik-scoping`](bascik-scoping/SKILL.md) | Component CSS and JavaScript scoping rules and pitfalls |
| [`bascik-scripts`](bascik-scripts/SKILL.md) | Build, routes, server, and stream scripts, and API routes |
| [`bascik-config`](bascik-config/SKILL.md) | `bascik.config.ts`, exec scripts, assets, and deployment |
| [`bascik-testing`](bascik-testing/SKILL.md) | Unit and E2E tests, debugging, spec validation, Lighthouse |
| [`bascik-migrate`](bascik-migrate/SKILL.md) | Moving a site from React, Next.js, Vue, Svelte, Astro, Eleventy, Hugo, or WordPress |

## Scripts

The skills ship dependency-free Node.js scripts (Node 22.18+) that agents run from the project root:

| Script | Purpose |
|---|---|
| `bascik/scripts/verify.mjs` | `bascik --check` plus the language server linter, optionally a build |
| `bascik/scripts/preview.mjs` | Compile a snippet or page with the project's components and print readable output |
| `bascik/scripts/list-components.mjs` | Inventory components with props, slots, and descriptions |
| `bascik/scripts/new-component.mjs` | Create a component that follows the conventions |
| `bascik/scripts/search-docs.mjs` | Search the live docs |
| `bascik/scripts/read-doc.mjs` | Print a docs page as text |
| `bascik-config/scripts/audit-config.mjs` | Flag redundant or risky `bascik.config.ts` values |

## Contributing

These files are the source of truth. The docs build publishes them to `https://bascik.dev/assets/skills.tar.gz`, `https://bascik.dev/.well-known/agent-skills/` (one archive per skill plus `index.json`), and the core skill to `https://bascik.dev/assets/SKILL.md`, and `create-bascik` bundles a copy in `create/assets/skills/` (`yarn create:prepack`). Contributor-only skills for working on Bascik itself live in `.github/skills/` and are marked `metadata.internal`, so `npx skills add` does not offer them.
