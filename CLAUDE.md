# Bascik: Claude Code Instructions

The repository's agent instructions are shared with Copilot and live in one file:

@.github/copilot-instructions.md

## What Claude Code Does Differently

- **Docs rules:** `.github/instructions/docs.instructions.md` applies to `docs/`, `skills/`, and docs images and diagrams. Copilot applies it through `applyTo`; Claude Code loads it from `docs/CLAUDE.md` when working in `docs/`. Read it before editing `skills/` too.
- **Contributor skills** live in `.github/skills/`; `.claude/skills` links to them, so they load as project skills.
- **Copilot-only sections:** skip "VS Code Sandbox and Command Permissions" and the `@Agent` model lists in `.github/agents/`; they configure Copilot.
- **Running the docs while testing:** `yarn docs:dev` writes into `docs/dist`. See `docs/README.md` for running the docs e2e suite alongside it.
