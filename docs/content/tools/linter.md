# Linter

Bascik provides official linter and editor tooling to catch invalid markup, unclosed components, undeclared props, misplaced script directives, and CSS/JS scoping errors as you type or in CI.

Editor support and CLI diagnostics are powered by `@bascik/language-server`.

## Linter, or `bascik --check`?

Both, and they do different jobs. Each rule lives in exactly one of them.

| | Linter (`@bascik/language-server`) | [`bascik --check`](/cli#static-analysis-with-bascik-check) |
| --- | --- | --- |
| Answers | Questions about **one file**: is this attribute a typo, can this CSS be scoped, does this API route export a handler | Questions about the **whole project**: duplicate routes, unused components, config errors, unmatched tags |
| Runs | In your editor as you type, and from the command line | From the command line and CI |
| Needs | Nothing but the file (and the project's config, to find components) | The whole project |

`bascik --check` also runs the linter. When `@bascik/language-server` is installed, `bascik --check` hands it your pages, components, and API routes and lists what it finds, so one command covers both halves and an editor squiggle always matches what CI reports. The full list of which rule lives where is in [Diagnostics](/internals/diagnostics#where-each-rule-lives).

Use the linter on its own, without `bascik`, when you want per-file checks and nothing else: a shared component library with no site of its own, a pre-commit hook that must stay fast, or an editor other than VS Code.

## Features at a Glance

- **Component Autocompletion**: Auto-completes custom tags (`<my-counter />`, `<site-nav>`), automatically inserting self-closing tags for void components or slot blocks for components with slots.
- **Prop & Slot Completion**: Suggests declared and inferred props (`data-bascik-prop-*`) with descriptions and validates named slots (`data-bascik-slot`).
- **Script Directive Completion**: Contextually completes `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` on `<script>` tags, enforcing mutual exclusion so you cannot accidentally combine conflicting script runtimes.
- **Hover Documentation**: Hovering over any custom component renders its `<!-- @bascik -->` docblock, author description, declared props, and available slot names.
- **Jump to Definition**: Jump directly from a custom tag to its HTML source file, or from a script import specifier (`@/...`, `./...`) to the target file.
- **Linter Diagnostics**: Instant feedback for unclosed components, paired closing tags on zero-slot components, and unscoped runtime DOM or CSS manipulations.

---

## CLI Linter

Every project scaffolded with `npm create bascik` includes a `lint` script in `package.json`. It runs [`bascik --check`](/cli#static-analysis-with-bascik-check), which hands your files to the linter and adds the project-wide checks:

```sh
npm run lint
```

Each finding gives the file, line and column, a rule name, and a suggested fix. This is a real run against a project with four problems planted in it:

![A terminal running npm run lint. It reports two warnings, an undeclared prop on site-header and an unclosed feat-card tag, and two errors, a data-bascik-build attribute on a div and a script with two conflicting directives. It ends with 2 errors, 2 warnings](/assets/demos/lint@2x.webp)

To run only the linter, without the project-wide checks, call the language server directly on any directory or file with `npx`:

```sh
npx @bascik/language-server --check
```

Check a specific path or page:

```sh
npx @bascik/language-server --check src/pages
```

The checker reads `bascik.config.ts` to know which folders hold components. A component folder outside the project, such as a monorepo's shared components, is not under the directory you check, so check it separately. Run from the site, the checker uses the site's config for any folder listed in its `directory.components`; `--project` names the project explicitly from anywhere:

```sh
cd sites/marketing
npx @bascik/language-server --check ../../shared/components
npx @bascik/language-server --check ../../shared/components --project .
```

### Auto-fixing with `--fix`

Add `--fix` to apply the fixes that have exactly one correct answer, write them to disk, and report what remains:

```sh
npx @bascik/language-server --check --fix
```

Two rules are fixable:

- `missing-prop-prefix`: `<my-card title="Hello">` becomes `<my-card data-bascik-prop-title="Hello">` when `title` is a declared prop of `my-card`.
- `prefer-self-closing-component`: `<zero-slot-comp></zero-slot-comp>` becomes `<zero-slot-comp />` when the component has no slots.

In VS Code, the same two fixes appear as Quick Fixes (`Cmd+.` or `Ctrl+.`) on the warning. `bascik --check --fix` applies exactly the same fixes, by calling this tool, so either command works in a pre-commit hook.

### CI / Pre-commit Integration

The CLI checker exits with code `0` when clean (or only warnings) and code `1` when errors are detected, making it drop-in ready for GitHub Actions or pre-commit git hooks. Hints are shown in the editor and by this command, and never fail anything:

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

Both `bascik-ignore` and `bascik-disable` accept a comma-separated list of rule ids, with or without spaces after the commas, to silence only those rules:

```js
/* bascik-disable js-attribute-selector, js-document-class-query */
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
