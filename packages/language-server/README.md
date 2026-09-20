# @bascik/language-server

Official Language Server Protocol (LSP) server for Bascik projects.

Provides editor-agnostic intelligence for Bascik HTML components, props, slots, mutually exclusive script directives, and scoping diagnostics across any LSP-compatible editor.

## Capabilities

- **Autocompletion (`textDocument/completion`)**:
  - Discovers custom component tags (e.g. `<site-nav>`, `<docs-head>`).
  - Auto-inserts self-closing tags for void components (`<docs-head />`) or slot containers (`<site-nav>$0</site-nav>`).
  - Auto-completes inferred and declared component props (`data-bascik-prop-*`).
  - Auto-completes contextual script directives (`data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, `data-bascik-stream`) with mutual exclusion.
- **Hover Documentation (`textDocument/hover`)**:
  - Displays docblock summaries, prop descriptions, and slot requirements from `<!-- @bascik -->` metadata headers.
- **Jump to Definition (`textDocument/definition`)**:
  - Jump from a component tag directly to its HTML component source file.
  - Jump from build/server script imports (`@/...` or `./...`) to their target source files.
- **Diagnostics (`textDocument/diagnostic`)**:
  - Unclosed component tag warnings.
  - Paired closing tag warnings on zero-slot components (`prefer-self-closing-component`).
  - Misplaced script directives on non-`<script>` tags.
  - Undeclared prop attributes on component tags.
  - Misplaced `data-bascik-slot` attributes.
  - Scoping compatibility checks in CSS and JavaScript.
  - In-file ignore comment support (`<!-- bascik-ignore -->`, `/* bascik-ignore */`, `// bascik-ignore`).
  - Configuration support via `bascik.ext.json` or `bascik.ext.ts`.

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
      root_dir = lspconfig.util.root_pattern('bascik.config.ts', 'bascik.config.js', '.git'),
      settings = {},
    },
  }
end

lspconfig.bascik.setup{}
```

### Helix

In your `languages.toml`:

```toml
[language-server.bascik]
command = "npx"
args = ["@bascik/language-server", "--stdio"]

[[language]]
name = "html"
language-servers = ["vscode-html-language-server", "bascik"]
```

### Zed

In your Zed settings:

```json
{
  "lsp": {
    "bascik": {
      "binary": {
        "path": "npx",
        "arguments": ["@bascik/language-server", "--stdio"]
      }
    }
  }
}
```

### Claude Code / AI Agents

Claude Code, Cursor, and AI agents supporting the Model Context Protocol (MCP) or standard language server communication can launch `bascik-language-server --stdio` as an external language server process to query component contracts, props, and diagnostics programmatically.
