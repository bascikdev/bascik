# Bascik VS Code Extension

Editor companion for [Bascik](https://bascik.dev) projects. Provides component tag navigation and scoping compatibility warnings.

## Features

- **Component navigation:** command-click a custom tag (e.g. `<my-card>`) to jump to the matching component file in `src/components`.
- **Script import navigation:** command-click `./`, `../`, and `@/` specifiers in `data-bascik-build`, `data-bascik-routes`, and `data-bascik-server` scripts to navigate directly to local files.
- **Scoping diagnostics:** warns on CSS selectors and JavaScript patterns that Bascik's scoping engine cannot handle safely. The warning set is generated from the [Scoping Compatibility](https://bascik.dev/compatibility) matrix and stays in sync automatically.
- **Server script diagnostics:** validates server and stream script contracts (`export default`, legacy request rewrites, output handling, import hygiene) and identifies structural HTML/JS/CSS injection sinks (`href`, `onclick`, unquoted attributes, inline `<script>`, styles, and unescaped request text). Includes quick fixes to migrate legacy request member expressions to standard WHATWG Request APIs.

## Local development

```sh
cd extensions/vscode-bascik
npm run compile   # generates compatibility-rules.json then runs tsc
npm run watch     # recompiles on save
```

Open `extensions/vscode-bascik/` as the workspace root in VS Code and press **F5** to launch an Extension Development Host with the extension loaded.

## Testing

The extension uses `@vscode/test-cli` and `@vscode/test-electron` to run integration tests inside an Extension Development Host instance.

### Running tests

From the repository root:

```sh
yarn ext:typecheck   # TypeScript type check
yarn ext:unit        # Vitest unit tests
yarn ext:e2e         # VS Code extension host integration tests
yarn ext:coverage    # Vitest unit tests with coverage report
```

Or from the extension directory:

```sh
cd extensions/vscode-bascik
npm run typecheck
npm run unit
npm test             # integration tests
```

### Test structure

- **Unit tests** (`src/test/rules.test.ts`): verify CSS and JS scoping compatibility rule matching logic.
- **Integration tests** (`src/test/extension.test.ts`): verify extension activation, component definition provider navigation, and diagnostics generation inside a real VS Code environment using the `test-fixtures/sample-workspace` fixture.
- **Test configuration** (`.vscode-test.cjs`): configures test files, workspace fixtures, and Mocha settings.

For more details on VS Code extension testing architecture, see the [VS Code Extension Testing documentation](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

## Implementation

The extension uses:

- the VS Code `DefinitionProvider` API for component tag navigation
- the `DiagnosticCollection` API for inline warnings in HTML, CSS, and JS files
- a workspace scan of `src/components` to build a component-name to file map

The `precompile` script runs `docs/scripts/generate-compatibility-rules.ts` before `tsc`, so `src/compatibility-rules.json` is always regenerated from the compatibility docs before the TypeScript compiles.

## Publishing to the VS Code Marketplace

### Prerequisites

1. Create a publisher on the [Visual Studio Marketplace publisher management page](https://marketplace.visualstudio.com/manage).
2. Generate a Personal Access Token (PAT) in Azure DevOps with the **Marketplace (Manage)** scope.
3. Install `vsce`:

   ```sh
   npm install -g @vscode/vsce
   ```

### First-time setup

Add a `publisher` field to `package.json` matching the publisher name you created:

```json
"publisher": "your-publisher-name"
```

### Package and publish

Build the extension and create a `.vsix` bundle:

```sh
cd extensions/vscode-bascik
npm run compile
vsce package
```

This produces a file like `bascik-vscode-0.1.0.vsix`. Inspect it locally before publishing:

```sh
code --install-extension bascik-vscode-0.1.0.vsix
```

When ready, publish:

```sh
vsce publish
```

`vsce` will prompt for your PAT on the first run. To skip the prompt, pass it directly:

```sh
vsce publish --pat <your-pat>
```

### Bumping the version

Update `version` in `package.json` before each release. `vsce publish` also accepts a version bump shorthand:

```sh
vsce publish patch   # 0.1.0 → 0.1.1
vsce publish minor   # 0.1.0 → 0.2.0
vsce publish major   # 0.1.0 → 1.0.0
```

This writes the new version back to `package.json` and tags the release.

### Pre-publish checklist

- [ ] `compatibility-rules.json` is current (`npm run compile` regenerates it)
- [ ] `version` in `package.json` is bumped
- [ ] `publisher` field is set in `package.json`
- [ ] `.vsix` installs and works correctly in a clean VS Code window
