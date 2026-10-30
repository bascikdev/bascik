# @bascik/language-server

Official Language Server Protocol (LSP) server for Bascik projects.

Provides editor-agnostic intelligence for Bascik HTML components, props, slots, mutually exclusive script directives, and scoping diagnostics across any LSP-compatible editor. Use it to wire Bascik into Neovim, Zed, Helix, a coding agent, or CI. In VS Code, install the [Bascik extension](https://bascik.dev/tools/vscode-extension) instead: it bundles this server. Requires Node.js 22.22 or newer. Every rule is documented on the [Linter](https://bascik.dev/tools/linter) page.

## Capabilities

- **Autocompletion (`textDocument/completion`)**:
  - Discovers custom component tags (e.g. `<site-nav>`, `<docs-head>`).
  - Auto-inserts self-closing tags for void components (`<docs-head />`) or slot containers (`<site-nav>$0</site-nav>`).
  - Auto-completes inferred and declared component props (`data-bascik-prop-*`).
  - Auto-completes contextual script directives (`data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`, `data-bascik-server`, `data-bascik-stream`) with mutual exclusion.
- **Hover Documentation (`textDocument/hover`)**:
  - Displays docblock summaries, prop descriptions, and slot requirements from `<!-- @bascik -->` metadata headers.
- **Jump to Definition (`textDocument/definition`)**:
  - Jump from a component tag directly to its HTML component source file.
  - Jump from build/server script imports (`@/...` or `./...`) to their target source files.
- **Find All References (`textDocument/references`)**:
  - Lists every opening tag that uses a component, across pages and components, from a component tag name or from the component's own first line, `<!-- @bascik` comment, or root tag line.
  - Skips tags in comments, attribute values, and `<script>`, `<style>`, or `<textarea>` bodies, as the compiler does. Usages that only appear in build script, Markdown, or server script output are not visible to the source index.
- **Diagnostics (`textDocument/publishDiagnostics`)**:
  - Unclosed component tag warnings.
  - Paired closing tag warnings on zero-slot components (`prefer-self-closing-component`).
  - Misplaced script directives on non-`<script>` tags.
  - Undeclared prop attributes on component tags.
  - Misplaced `data-bascik-slot` attributes.
  - Scoping compatibility checks in CSS and JavaScript.
  - In-file ignore comment support (`<!-- bascik-ignore -->`, `/* bascik-ignore */`, `// bascik-ignore`).
  - Configuration support via `bascik.ext.json`, `.bascikrc.json`, `bascik.ext.ts`, or `bascik.ext.js`.
- **Quick Fixes (`textDocument/codeAction`)**:
  - Adds the missing `data-bascik-prop-` prefix to a prop attribute (`missing-prop-prefix`).
  - Converts a paired tag on a zero-slot component to a self-closing tag (`prefer-self-closing-component`).
  - Wraps a server script template literal that returns markup in `` html`...` `` and imports `html` from `@bascik/bascik/html` (`server-script-unescaped-markup`). It imports `html as safeHtml` when the script already uses the name `html`, and is not offered when that name is taken too or a value sits where `html` would throw. This fix is editor-only, because it changes the returned value from a string to `SafeHtml`.

## Installation & CLI Usage

Run directly via `npx`:

```sh
npx @bascik/language-server --stdio
```

Or install globally:

```sh
npm install -g @bascik/language-server
bascik-language-server --stdio
```

## Project Config Discovery

The server reads `directory.components` and `scripts.importRoot` from each project's Bascik config, looking for `bascik.config.js`, then `bascik.config.mjs`, then `bascik.config.ts`, the same order the CLI uses. When a folder holds more than one, the first in that order wins, so the editor and the build read the same file.

## Editor Configurations

### Neovim (`nvim-lspconfig`)

In your Neovim configuration (`lua`):

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.bascik then
  configs.bascik = {
    default_config = {
      cmd = { 'npx', '@bascik/language-server', '--stdio' },
      filetypes = { 'html' },
      root_dir = lspconfig.util.root_pattern('bascik.config.js', 'bascik.config.mjs', 'bascik.config.ts', '.git'),
      settings = {},
    },
  }
end

lspconfig.bascik.setup{}
```

### Coding agents and other LSP clients

The server speaks the Language Server Protocol, not the Model Context Protocol (MCP). Any editor or coding agent that can run an external LSP server (Claude Code through a language server plugin, Cursor, Zed, Helix, and others) can start it with:

```sh
bascik-language-server --stdio
```

It also accepts `--node-ipc` and `--socket=<port>`, as editors pass them. Register it for HTML files in the project root.

## One-shot check

For CI or an agent that wants a single pass instead of a running server, `--check` prints the same diagnostics, one per line, for a folder or file and exits:

```sh
npx @bascik/language-server --check          # the current folder
npx @bascik/language-server --check src      # one folder or file
npx @bascik/language-server --check --fix    # also apply the fixes that have one correct answer
```

`--project <path>` names the project when the target lives outside it, such as a monorepo's shared components. The exit code is 1 when any error is found, otherwise 0. `--fix` applies the prop prefix and self-closing fixes above and rewrites those files; the `html` wrap fix is never applied there.

## Development

The diagnostics, completions, hovers, and definitions are implemented once, here in `src/`; the VS Code extension bundles this server rather than reimplementing any of it. From the repository root:

```sh
yarn lsp:build      # compile dist/
yarn lsp:typecheck  # TypeScript type check
yarn lsp:unit       # unit tests
yarn lsp:linear-time # linear-time scaling checks (CPU growth on large input; CI runs them on Linux)
yarn lsp:coverage   # unit tests with coverage, written to lsp/test-coverage.json
yarn lsp:check      # build, then run --check on the repository
```

When you change `src/server.ts` (project discovery, file watching, publishing), also run `yarn ext:unit` and `yarn ext:e2e`, which start the real server bundle.
