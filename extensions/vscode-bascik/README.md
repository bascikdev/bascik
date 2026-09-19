# Bascik VS Code Extension

Editor support for [Bascik](https://bascik.dev) projects.

## Features

- **Component navigation:** Command-click a custom element in an HTML document to open its component file. The extension reads `directory.components` from the owning workspace folder's `bascik.config.ts` and supports multiple relative or absolute component roots.
- **Script import navigation:** Command-click `./`, `../`, and `@/` specifiers in `data-bascik-build`, `data-bascik-routes`, and `data-bascik-server` scripts. The `@/` alias uses the owning workspace folder's `scripts.importRoot` setting.
- **Multi-root isolation:** Component maps, import roots, HTML usage discovery, diagnostics, and file watchers are isolated per workspace folder.
- **Automatic refresh:** Project state refreshes when a Bascik config, component HTML file, or project HTML file changes. Open HTML buffers temporarily override their disk contents for usage analysis.
- **Scoping diagnostics:** Warns about CSS selectors and JavaScript patterns that Bascik's scoping engine cannot handle safely. The warning set is generated from the [Scoping Compatibility](https://bascik.dev/compatibility) matrix.
- **Server script diagnostics:** Validates server stream script contracts and identifies structural HTML, JavaScript, and CSS injection sinks.

Component definition navigation is intentionally limited to HTML documents. JavaScript, TypeScript, and CSS text that resembles a custom element does not resolve as a component definition.

## Local development

From the repository root:

```sh
yarn ext:compile
```

Open `extensions/vscode-bascik/` as the workspace root in VS Code and press **F5** to launch an Extension Development Host.

## Testing

The extension uses Vitest for unit tests and `@vscode/test-cli` with `@vscode/test-electron` for integration tests inside a real Extension Development Host.

```sh
yarn ext:typecheck   # TypeScript type check
yarn ext:unit        # Vitest unit tests
yarn ext:e2e         # VS Code extension-host integration tests
yarn ext:coverage    # Unit tests with coverage
```

The integration suite opens `test-fixtures/multi-root.code-workspace`. Its `primary` and `secondary` projects verify conflicting component-name isolation, distinct component and import roots, cache invalidation, and workspace-folder lifecycle behavior.

## Implementation

The extension uses stable VS Code APIs:

- `DefinitionProvider` for component tags and script imports
- `DiagnosticCollection` for inline warnings
- `workspace.getWorkspaceFolder(document.uri)` for project ownership
- `FileSystemWatcher` for project-scoped cache invalidation

The compile script regenerates `src/compatibility-rules.json` from the compatibility documentation before running TypeScript.

## Packaging

Build and package the extension from its directory:

```sh
cd extensions/vscode-bascik
yarn compile
yarn dlx @vscode/vsce package
```

This produces `bascik-vscode-0.1.0.vsix`. Install a local package with:

```sh
code --install-extension bascik-vscode-0.1.0.vsix --force
```
