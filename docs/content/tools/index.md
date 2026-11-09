# Tooling Overview

Bascik ships three tools that catch mistakes before your visitors do: a command-line linter for CI, a VS Code extension for as-you-type feedback, and agent skills that teach coding agents how Bascik works.

## Choosing a Tool

- [Linter](/tools/linter): run `bascik --check` locally or in CI to find invalid component tags, undeclared props, misplaced script directives, and scoping problems.
- [VS Code Extension](/tools/vscode-extension): component navigation, completions, hover details, and live diagnostics from the same language server.
- [Agent Skills](/agent-skills): install the Bascik skills so coding agents follow the same conventions as the linter.

## Next Steps

Wire the linter into your test run with [Linting](/testing/linting), or read [Getting Started](/getting-started) to scaffold a project that already has it.
