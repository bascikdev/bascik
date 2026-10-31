---
name: bascik-vscode-extension
metadata:
  internal: true
description: Development, syntax grammars, language-server wiring, bundling, and testing for the official Bascik VS Code Extension. Use when updating extensions/vscode-bascik, changing how the extension starts the language server, adding or changing a diagnostic, completion, hover, or definition (which lives in lsp/), or testing extension features.
---

# VS Code Extension Development for Bascik (`extensions/vscode-bascik`)

The extension is a thin **language client**. It starts `@bascik/language-server` and connects it to VS Code. Every diagnostic, completion, hover, definition, reference, and quick fix comes from the server in `lsp/`, so the editor, `bascik --check`, and other editors agree. The extension holds no rules of its own, and must not grow any: a rule added here would be missing from CI.

---

## 1. Layout

```
extensions/vscode-bascik/
├── src/
│   ├── extension.ts            # activate(): starts the language client and waits for the server's initialize
│   ├── client-options.ts       # Document selector and the server bundle path (no vscode import, so it is unit-testable)
│   ├── server-bundle.test.ts   # Vitest: starts the bundled server and talks to it over the protocol
│   └── test/extension.test.ts  # VS Code integration suite (Mocha, runs in a real editor)
├── build.mjs                   # tsc (typecheck, tests into out/), then esbuild bundles dist/extension.js and dist/server.js
├── syntaxes/, snippets/        # TextMate injection grammar and API route snippets
└── package.json                # Manifest with contribution points
```

A VSIX ships no `node_modules`, so `build.mjs` bundles both files with their dependencies:

- `dist/extension.js` is `src/extension.ts` with `vscode-languageclient` bundled in. `vscode` stays external.
- `dist/server.js` is the language server from `../../lsp/src` (entry: `startLanguageServer()` in `lsp/src/start.ts`) with `vscode-languageserver` bundled in. It does not need `lsp/dist` to be built first.
- `build.mjs` deletes `dist/` and `out/` first, so a file removed from `src/` cannot ship. tsc writes to `out/` (the real-editor suite runs `out/test/`), so `dist/` holds only the two bundles and their notices, and `.vscodeignore` ships only those three from it (`src/packaging.test.ts` checks both).
- Bundling inlines third-party code, so `build.mjs` also writes `dist/THIRD-PARTY-NOTICES.txt`: the license text of every package in either bundle's esbuild metafile. A bundled package with no license file fails the build with its name.

---

## 2. Where a change belongs

| Change                                                                    | Where                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A diagnostic rule, completion, hover, definition, references, code action | `lsp/src/` (`analyzer.ts`, `server-script-rules.ts`, `api-rules.ts`, `directive-rules.ts`, `rules.ts`), with a test in `lsp/`                                                      |
| Scoping compatibility rules                                               | `docs/content/compatibility.md` is the source; `docs/scripts/generate-compatibility-rules.ts` writes `lsp/src/compatibility-rules.json` and `pkg/src/lib/compatibility-rules.json` |
| Which files the server is sent, how it is launched                        | `extensions/vscode-bascik/src/client-options.ts`, `extension.ts`                                                                                                                   |
| Project discovery, file watching, workspace folders, stale results        | `lsp/src/server.ts`, tested in `lsp/src/server.test.ts`                                                                                                                            |
| Highlighting                                                              | `syntaxes/bascik-html.tmLanguage.json`                                                                                                                                             |

Scoping rules (`css-*`, `js-*`) apply to component files only. Pages, API routes, and scripts outside the component folders are not scoped, so they are not checked.

Highlighting is a TextMate injection into `text.html`, the prefix of `text.html.derivative`, the root grammar of the `html` language (`text.html.basic` has no language, so an injection there never loads). Its rule is a begin/end that includes `text.html.basic#attribute-interior`, so the value keeps HTML string scopes. The real-editor suite reads scopes with `_workbench.captureSyntaxTokens`.

---

## 3. Server behavior the extension relies on

- **File watching.** The server registers watchers for `bascik.config.{ts,js,mjs}` and `**/*.html`, one pattern per workspace folder using a folder-relative pattern. A bare `**/*.html` pattern is matched against whatever events the editor sees and can arrive seconds late. Keep folder-relative patterns.
- **Workspace folders.** The server follows folder changes. It registers `onDidChangeWorkspaceFolders` only after `initialize`, and only when the client sends them, because the connection throws otherwise.
- **Stale results.** A check whose document changed while the project was being read is dropped; the newer check publishes.
- **Files outside every workspace folder and non-`file:` documents** get no diagnostics.
- **Folders that are not Bascik projects** get no diagnostics either: a workspace folder with no `bascik.config.*` counts as a zero-config project only when its `package.json` lists `@bascik/bascik` (`isBascikProject()` in `server.ts`, re-read when the file's size or mtime changes). Navigation, hover, and completion still work there. The real-editor `plain` folder is such a folder.
- **Markdown safety.** Component descriptions are prose. `escapeMarkdownText()` in the analyzer escapes them exactly as VS Code's `MarkdownString.appendText()` does. Do not put a description into markdown unescaped.
- **Completions** that replace the typed `<` must set `filterText` to start with `<`, or the editor hides every item.

---

## 4. Development and testing

```sh
yarn ext:compile       # regenerate compatibility rules, then build.mjs: tsc, bundle dist/extension.js and dist/server.js
yarn ext:typecheck
yarn ext:unit          # includes server-bundle.test.ts, which builds and starts the real server bundle
yarn ext:e2e           # compiles, then runs the integration suite in a real VS Code
yarn lsp:unit          # the analysis itself
```

Yarn 4 does not run npm's implicit `pre<name>`/`post<name>` scripts, so the extension's `package.json` has none: `compile` runs the rules generator itself (`src/package-scripts.test.ts` enforces this).

- Diagnostics are published by a server process after a document opens, not before the call returns. Integration tests that expect a diagnostic use `waitForDiagnostic()`; a test that expects none opens the file with `openWorkspaceDocument()`, which waits for the server.
- Definition results can be a `Location` or a `LocationLink`. Use `firstLocationPath()` or `locationUri()`.
- Scoping-rule fixtures go in `src/components/`, via `openWorkspaceDocument({ directory: 'src/components', ... })`.
- A bug that only shows in the bundle (a missing data file, a startup crash) is caught by `server-bundle.test.ts`. A bug that only shows against a real editor (late file events) is caught by `ext:e2e`. Run both when you change `lsp/src/server.ts`.

---

## 5. Packaging and release

- The Marketplace needs plain `x.y.z` versions; `.github/scripts/publish-vsce.sh` enforces it. `engines.vscode` must be at least what `vscode-languageclient` requires (`^1.91.0` today) and match `@types/vscode`.
- Publishing uses `vsce publish --no-dependencies`. That is correct only because everything is bundled; do not add a runtime `dependencies` entry that is not bundled.
- Change the package version only for a release; see `RELEASING.md`, "Extension releases".
- Ensure fixtures in `test-fixtures/sample-workspace` reflect valid component structures.
