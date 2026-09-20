# Linter & Editor Support

Bascik provides official linter and editor tooling to catch invalid markup, unclosed components, undeclared props, misplaced script directives, and CSS/JS scoping errors as you type or in CI.

Editor support and CLI diagnostics are powered by `@bascik/language-server`.

## Features at a Glance

- **Component Autocompletion**: Auto-completes custom tags (`<my-counter />`, `<site-nav>`), automatically inserting self-closing tags for void components or slot blocks for components with slots.
- **Prop & Slot Completion**: Suggests declared and inferred props (`data-bascik-prop-*`) with descriptions and validates named slots (`data-bascik-slot`).
- **Script Directive Completion**: Contextually completes `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` on `<script>` tags, enforcing mutual exclusion so you cannot accidentally combine conflicting script runtimes.
- **Hover Documentation**: Hovering over any custom component renders its `<!-- @bascik -->` docblock, author description, declared props, and available slot names.
- **Jump to Definition**: Jump directly from a custom tag to its HTML source file, or from a script import specifier (`@/...`, `./...`) to the target file.
- **Linter Diagnostics**: Instant feedback for unclosed components, paired closing tags on zero-slot components, and unscoped runtime DOM or CSS manipulations.

---

## CLI Linter

Every project scaffolded with `npm create bascik` includes a `lint` script in `package.json`:

```sh
npm run lint
```

You can also run the checker directly on any directory or file with `npx`:

```sh
npx @bascik/language-server --check
```

Check a specific path or page:

```sh
npx @bascik/language-server --check src/pages
```

### CI / Pre-commit Integration

The CLI checker exits with code `0` when clean (or only warnings) and code `1` when errors are detected, making it drop-in ready for GitHub Actions or pre-commit git hooks:

```yaml
- name: Lint Bascik components and scripts
  run: npx @bascik/language-server --check
```

---

## Editor Setup

### VS Code

Install the official **Bascik** extension from the VS Code Marketplace:

1. Press `Ctrl+P` (or `Cmd+P` on macOS).
2. Type:
   ```text
   ext install bascik.bascik-vscode
   ```
3. Press Enter.

New projects scaffolded with `create-bascik` include `.vscode/extensions.json`, prompting VS Code to recommend installing the extension upon opening the folder.

### Neovim (`nvim-lspconfig`)

Because Bascik implements the standard Language Server Protocol (LSP), you can use it in Neovim with `nvim-lspconfig`:

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

Add the following to your `languages.toml`:

```toml
[language-server.bascik]
command = "npx"
args = ["@bascik/language-server", "--stdio"]

[[language]]
name = "html"
language-servers = ["vscode-html-language-server", "bascik"]
```

### Zed

Add the language server binary to your Zed settings:

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

---

## Suppressing Warnings

### In-File Comments

To suppress a warning for a specific line:

```html
<!-- bascik-ignore -->
<inherit-demo-card></inherit-demo-card>
```

In CSS or JavaScript:

```css
/* bascik-ignore */
[data-state] { color: red; }
```

```js
// bascik-ignore
element.id = 'dynamic-id';
```

You can also disable checks across an entire block:

```html
<!-- bascik-disable -->
...
<!-- bascik-enable -->
```

### Configuration File (`bascik.ext.json`)

To configure diagnostics project-wide, create a `bascik.ext.json` or `bascik.ext.ts` in your project root:

```json
{
  "diagnostics": {
    "selfClosingComponents": false,
    "disabledRules": [
      "component-metadata-duplicate-annotation"
    ]
  }
}
```

---

## Architecture Note (LSP)

Under the hood, `@bascik/language-server` is an implementation of Microsoft's **Language Server Protocol (LSP)**. This means the exact same analysis engine powers the command-line linter, the VS Code extension, and editor plugins for Neovim, Zed, and Helix.
