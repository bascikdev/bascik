# Agent Skill

Download the Bascik skill file and attach it to GitHub Copilot, Cursor, Claude, or any AI assistant that supports instruction files, so it understands Bascik's component model, scoping rules, and conventions out of the box.

The Bascik skill file (`SKILL.md`) teaches any AI assistant, GitHub Copilot, Cursor, Claude, or others that support instruction files, the full details of how Bascik works: its component model, scoping system, config options, CLI, and conventions.

Add it once, and your AI assistant can accurately answer questions about Bascik, generate correct components, and help debug scoping issues without needing to look anything up.

## Download and Install

Run the following from the root of your repo in your terminal. This will create the `skills/bascik` directory and download and install the Bascik `SKILL.md` file.

### Add the Skill to VSCode

```sh
mkdir -p .github/skills/bascik && curl -L -o .github/skills/bascik/SKILL.md https://bascik.dev/assets/SKILL.md

```

### Add the Skill to Cursor

```sh
mkdir -p .cursor/skills/bascik && curl -L -o .cursor/skills/bascik/SKILL.md https://bascik.dev/assets/SKILL.md
```

### Add the Skill to Claude

```sh
mkdir -p .claude/skills/bascik && curl -L -o .claude/skills/bascik/SKILL.md https://bascik.dev/assets/SKILL.md
```

### Download Only

Download the Bascik [SKILL.md](https://bascik.dev/assets/SKILL.md) directly.

## Keeping the Skill Updated

An easy way to keep the skill file current is to simply instruct your AI assistant or agent to update itself from time to time.

Since the skill file is hosted at a stable static URL (`https://bascik.dev/assets/SKILL.md`), you can add a brief instruction to your agent's system prompt or workspace instructions (such as a `.prompt.md`, `.instructions.md`, or your assistant's rules) telling it to keep the file updated.

### Recommended Prompt for Your Agent

Add an instruction like the following to your agent configuration files:

> When working in this repository, check if the Bascik skill file (`SKILL.md`) is present and up to date. If you need to update it, run the following download command to fetch the latest version of the guidelines:
> 
> ```sh
> curl -L -o .github/skills/bascik/SKILL.md https://bascik.dev/assets/SKILL.md
> ```

This ensures your AI assistant always operates with the most up-to-date syntax, conventions, and compatibility guidelines with zero manual effort required from you.

## What's inside

The skill covers:

- Component authoring, slots, and props
- Scoped CSS and scoped JavaScript rules and constraints
- Build scripts (`data-bascik-build`)
- Configuration options (`bascik.config.ts`)
- CLI commands and workflow
- The scoping compatibility table
- Folder structure and naming conventions

> **Keeping it current.** `SKILL.md` is regenerated from the same Markdown source files that power this docs site. When the docs update, so does the skill file.
