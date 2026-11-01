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
  - TypeScript errors in `<script type="text/typescript">` blocks, from TypeScript's own language service, with the source `ts (bascik)`. Each block is checked in the scope it runs in (a page's browser blocks share one scope, a scoped component's and every server-side block are on their own); browser blocks get the DOM and server-side blocks (`data-bascik-build`, `-build-once`, `-routes`, `-server`, `-stream`) get Node.js (its types with `@types/node`; without it, the web globals Node.js and workerd share, and Node.js's globals and modules untyped); `@/` resolves against `scripts.importRoot`, and the project's `tsconfig.json` is the base. See [TypeScript](#typescript) below.
  - Configuration support via `bascik.ext.json`, `.bascikrc.json`, `bascik.ext.ts`, or `bascik.ext.js`. The `.ts` and `.js` forms are read without running them (literal values only), and a config that cannot be read is logged to stderr with its file and line.
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

## TypeScript

TypeScript is an optional peer dependency (`typescript` 5 or 6), never bundled. The server uses, in order: a `typescript` package folder the client passes in `initializationOptions.typescript.path` (the VS Code extension passes the `bascik.typescript.path` setting), the editor's own copy in `initializationOptions.typescript.editorPath` (the VS Code extension passes VS Code's), the project's `typescript`, then one beside this package. TypeScript 7 publishes no JavaScript language service, so a TypeScript 7 install is skipped, and so is one older than TypeScript 5 (no `bundler` module resolution, so every `.ts` import would be an error). Without a usable TypeScript, TypeScript checks are off and the server logs why, once per project.

`initializationOptions`, all optional:

```json
{
  "typescript": {
    "enabled": true,
    "path": "/path/to/node_modules/typescript",
    "editorPath": "/path/to/editor/typescript",
    "releaseDelayMs": 30000
  },
  "editorHasEmbeddedTypeScript": false
}
```

`path` is used first; `editorPath`, the editor's own copy, is used when `path` is missing or cannot be used, before the project's `typescript`. When `path` cannot be used, the server shows the reason once with `window/showMessageRequest` and logs it.

Inside these blocks the server answers hover, definition, completion (members, and files in relative and `@/` import paths) and signature help from the same TypeScript, after its own answers: hover and definition only where Bascik has none. `editorHasEmbeddedTypeScript` tells the server the editor already answers about the page's own names there (VS Code's HTML support does, and cannot be turned off; the VS Code extension sends `true` only while it runs). The server then answers only what that mode cannot: symbols, members, globals and calls declared in another file (an import, a package, `@types/node`, the context `@bascik/bascik` gives a directive script), names whose type comes from one, and import paths. `.` and `/` trigger completion in these blocks. The server checks TypeScript in a worker thread after a short pause in typing, so its own diagnostics are published first. A page edit checks that page only; a change to a file the blocks may import, a `tsconfig.json`, a `package.json` or the Bascik config checks every open page. Until a page is checked again, its TypeScript errors move with their blocks, and an edited block's errors are left out rather than shown on the wrong code. Pages due a check are given to TypeScript together, so its programs are built once for all of them. Once no open page has TypeScript blocks for `releaseDelayMs` (default 30000), the worker ends and its memory is freed; the next page with blocks starts it again.

A page's browser blocks are checked as one classic script: the names its plain `<script>` elements declare, and those of the component scripts in its scope (with `scoping.scriptBlocks` off), are known as `any`; top-level names are never reported unused; a top-level `interface Window { ... }` adds to the global interface; and a block with a syntax error is reported alone and left out, as a browser skips it.

## Project Config Discovery

The server reads `directory.components` and `scripts.importRoot` from each project's Bascik config, looking for `bascik.config.js`, then `bascik.config.mjs`, then `bascik.config.ts`, the same order the CLI uses. When a folder holds more than one, the first in that order wins, so the editor and the build read the same file.

A workspace folder without a Bascik config is still a Bascik project, with the defaults `src/components` and `src`, when its root has a language server config (`bascik.ext.json`, `.bascikrc.json`, `bascik.ext.ts`, or `bascik.ext.js`) or its `package.json` lists `@bascik/bascik` or `@bascik/language-server` in any dependency field. A linter-only component library, or a global install with no `package.json` entry, opts in with a `bascik.ext.json`. Any other folder, such as a React or Vue app with its own `src/components`, gets no diagnostics; navigation, hover, and completion still work there, and the server logs why once. A new `bascik.config.*` turns the checks on right away; a new language server config or dependency turns them on at the next edit.

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
      root_dir = lspconfig.util.root_pattern('bascik.config.js', 'bascik.config.mjs', 'bascik.config.ts', 'bascik.ext.json', '.git'),
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
npx @bascik/language-server --check --typescript  # also report TypeScript errors in type="text/typescript" blocks
```

`--project <path>` names the project when the target lives outside it, such as a monorepo's shared components. The exit code is 1 when any error is found, otherwise 0. `--fix` applies the prop prefix and self-closing fixes above and rewrites those files; the `html` wrap fix is never applied there. `--typescript` is opt-in, uses the project's own `typescript`, and without a usable one prints a single `note:` line and checks the rest.

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
