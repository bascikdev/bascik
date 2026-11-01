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
│   ├── test/extension.test.ts  # VS Code integration suite (Mocha, runs in a real editor)
│   └── test-no-html/           # The same, in an editor with the built-in HTML language features disabled
├── build.mjs                   # tsc (typecheck, tests into out/), then esbuild bundles dist/extension.js and dist/server.js
├── syntaxes/, snippets/        # TextMate injection grammar and API route snippets
└── package.json                # Manifest with contribution points
```

A VSIX ships no `node_modules`, so `build.mjs` bundles both files with their dependencies:

- `dist/extension.js` is `src/extension.ts` with `vscode-languageclient` bundled in. `vscode` stays external.
- `dist/server.js` is the language server from `../../lsp/src` (entry: `startLanguageServer()` in `lsp/src/start.ts`) with `vscode-languageserver` bundled in. It does not need `lsp/dist` to be built first. It is also the TypeScript worker's file: started as a worker thread, `typescript-worker.ts` runs and the server does not start.
- **TypeScript is never bundled.** It is an optional peer of the language server. The extension passes the machine-scoped `bascik.typescript.path` setting as `typescript.path` and VS Code's own copy (`<appRoot>/extensions/node_modules/typescript`) as `typescript.editorPath` in `initializationOptions`, with `editorHasEmbeddedTypeScript: true`, so a mistyped setting falls back to VS Code's copy and the server shows a warning. `build.mjs` marks `typescript` external and `src/packaging.test.ts` fails if any TypeScript file reaches the bundle.
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
| TypeScript errors in `type="text/typescript"` blocks                      | `lsp/src/typescript-*.ts` (blocks and offsets, finding TypeScript, the LanguageService engine, the worker); the server merges its diagnostics with Bascik's per document           |
| Hover, definition, completion, signature help in those blocks             | `lsp/src/typescript-features.ts` (answers, and what counts as cross-file), `typescript-lsp.ts` (LSP shapes); `server.ts` asks after Bascik's own answer                            |
| Highlighting                                                              | `syntaxes/bascik-html.tmLanguage.json` (attributes), `syntaxes/bascik-typescript-script.tmLanguage.json` (TypeScript in `type="text/typescript"` scripts)                          |

Scoping rules (`css-*`, `js-*`) apply to component files only. Pages, API routes, and scripts outside the component folders are not scoped, so they are not checked.

Highlighting is a TextMate injection into `text.html`, the prefix of `text.html.derivative`, the root grammar of the `html` language (`text.html.basic` has no language, so an injection there never loads). Its rule is a begin/end that includes `text.html.basic#attribute-interior`, so the value keeps HTML string scopes. The real-editor suite reads scopes with `_workbench.captureSyntaxTokens`.

The TypeScript script injection embeds VS Code's own `source.ts` and maps it to the `typescript` language with `embeddedLanguages`. VS Code loads an injection for every dot prefix of the root scope but merges its `embeddedLanguages` only when `injectTo` names the root scope exactly, so that grammar injects into `text.html.derivative`. `src/grammar.test.ts` tokenizes documents with `vscode-textmate` and the `tm-grammars` copies of VS Code's grammars; an unnamed begin/end rule that an injection can match again at the same position loops, which is why the rule sets a `contentName` its selector excludes.

---

## 3. Server behavior the extension relies on

- **File watching.** The server registers watchers for `bascik.config.{ts,js,mjs}`, `**/*.html` and `**/*.{ts,mts,js,mjs}` (a closed module's imports decide which files get the markup rules), one pattern per workspace folder using a folder-relative pattern. A bare `**/*.html` pattern is matched against whatever events the editor sees and can arrive seconds late. Keep folder-relative patterns.
- **Workspace folders.** The server follows folder changes. It registers `onDidChangeWorkspaceFolders` only after `initialize`, and only when the client sends them, because the connection throws otherwise.
- **Stale results.** A check whose document changed while the project was being read is dropped; the newer check publishes.
- **Files outside every workspace folder and non-`file:` documents** get no diagnostics.
- **Folders that are not Bascik projects** get no diagnostics either: a workspace folder with no `bascik.config.*` counts as a project only when its root has one of `EXTENSION_CONFIG_FILES` (`bascik.ext.json` and the rest) or its `package.json` lists `@bascik/bascik` or `@bascik/language-server` (`isBascikProject()` in `server.ts`, re-read when the file's size or mtime changes). The linter-only setup in `docs/content/tools/linter.md` relies on the last two. Navigation, hover, and completion still work there. The real-editor `plain` folder is such a folder.
- **Markdown safety.** Component descriptions are prose. `escapeMarkdownText()` in the analyzer escapes them exactly as VS Code's `MarkdownString.appendText()` does. Do not put a description into markdown unescaped.
- **Completions** that replace the typed `<` must set `filterText` to start with `<`, or the editor hides every item.
- **TypeScript language features.** VS Code's HTML server has its own TypeScript mode for quoted `type="text/typescript"` blocks (in-file names and the DOM, no imports, no errors) that cannot be turned off. The extension sends `editorHasEmbeddedTypeScript: true` while `vscode.html-language-features` runs, and the server then answers only what that mode cannot: a symbol, member, global or call declared in another file (an import, a package, `@types/node`, `@bascik/bascik`'s script types), a name whose type comes from one, import paths, a module's exports inside an import's braces, and every member and signature reached through a receiver the editor's mode types as `any` (`frothers.map(` on an imported array; `lsp/src/typescript-editor-mode.ts` mirrors that mode to decide). That mode embeds a block only when its `type` value, as written, matches `/["']text\/typescript["']/` and the attribute name is lowercase `type`; Bascik also compiles `type="text/TypeScript"` and `type=text/typescript`, and answers everything in those blocks. Without a lowercase `type` attribute (`TYPE="text/typescript"`) VS Code embeds the block as JavaScript, read with the page's plain scripts by its JavaScript mode, which the mirror also reproduces (`TypeScriptBlock.editorLanguage`, `editorScriptLanguage`). Without the flag (other editors, or the HTML extension disabled) it answers everything. Hover and definition are asked only when Bascik's analyzer has no answer; completions merge, and `.` and `/` ask TypeScript alone. A client block that does not parse yet is answered from a separate virtual file of all the page's client blocks.
- **TypeScript diagnostics** are published with Bascik's in one list per document (a publish replaces the list). Bascik's go out first; TypeScript's follow from the worker after `TYPESCRIPT_DELAY_MS`, and every edit makes the project's pending TypeScript requests stale through a shared-memory epoch. With TypeScript checks on, the server also watches `**/*.{ts,mts,cts,js,mjs,cjs}` and `**/{tsconfig,package}.json`.

---

## 4. Development and testing

```sh
yarn ext:compile       # regenerate compatibility rules, then build.mjs: tsc, bundle dist/extension.js and dist/server.js
yarn ext:typecheck
yarn ext:unit          # includes server-bundle.test.ts, which builds and starts the real server bundle
yarn ext:e2e           # compiles, then runs the real-editor configurations in .vscode-test.cjs (out/test,
                       # out/test-typescript-off with TypeScript checks off, out/test-typescript-settings for
                       # the bascik.typescript settings, and out/test-no-html with the built-in HTML language
                       # features disabled)
yarn lsp:unit          # the analysis itself
```

Yarn 4 does not run npm's implicit `pre<name>`/`post<name>` scripts, so the extension's `package.json` has none: `compile` runs the rules generator itself (`src/package-scripts.test.ts` enforces this).

- Diagnostics are published by a server process after a document opens, not before the call returns. Integration tests that expect a diagnostic use `waitForDiagnostic()`; a test that expects none opens the file with `openWorkspaceDocument()`, which waits for the server.
- Definition results can be a `Location` or a `LocationLink`. Use `firstLocationPath()` or `locationUri()`.
- Scoping-rule fixtures go in `src/components/`, via `openWorkspaceDocument({ directory: 'src/components', ... })`.
- The `typescript-settings` configuration sets `bascik.typescript.path` to a wrapper package that marks when the server loads it, then to a TypeScript 7 shaped package and a missing folder (both fall back to VS Code's copy), and changes two settings close together (the extension's `RestartQueue` runs one restart at a time, so the second change is applied, not lost). The `no-html-features` configuration also checks that TypeScript errors are published at their exact ranges with VS Code's HTML support disabled.
- A long worktree path can overflow macOS's socket path limit. Run the same configurations through a temporary wrapper config that adds `--user-data-dir=/tmp/<short>` to each one's `launchArgs` (`@vscode/test-electron` then skips its own), and delete it afterwards.
- `.vscode-test.cjs` runs the VS Code version `@vscode/test-cli` downloads (the current one). The minimum, VS Code 1.91, cannot run it: its Electron's Node 20 cannot `require()` mocha 12, which is ESM only (the root `resolutions` pin mocha 12), so `@vscode/test-cli` fails with `ERR_REQUIRE_ESM`. Check 1.91 by hand with a runner that loads mocha 10.
- `out/test/typescript-features.test.js` opens `src/features/typescript-features.html`, which imports `@/lib/frother-settings.ts` and `../lib/frother-speed.ts`: hover, definition, member and import path completion and signature help reach those files, and counts check that nothing is listed twice and that the page's own names and a plain script are answered once, by VS Code. Count completion labels without kind `Text` (VS Code's word-based suggestions). The `typescript-off` lane checks that none of those cross-file answers exist without Bascik, and `no-html-features` that Bascik hovers the page's own names there.
- The TypeScript checks have their own real-editor configuration, `typescript-off`, the control run: the same fixture page with `bascik.typescript.enabled` off shows no TypeScript error, so `out/test/typescript.test.js` checks what the feature adds. `server-bundle-typescript.test.ts` runs the bundle's worker with TypeScript 6 (the `typescript-6` dev alias; the repo itself builds with TypeScript 7, which has no language service).
- A bug that only shows in the bundle (a missing data file, a startup crash) is caught by `server-bundle.test.ts`. A bug that only shows against a real editor (late file events) is caught by `ext:e2e`. Run both when you change `lsp/src/server.ts`.
- CI runs both: `ext:unit` in the stage 2 job `unit-extension`, and `ext:e2e` in the stage 4 job `e2e-extension` (`xvfb-run -a yarn ext:e2e` on Ubuntu, with the VS Code download cached weekly). Both deploy jobs wait on `e2e-extension`. Run `ext:e2e` locally anyway when you change `lsp/src/server.ts`, so a real-editor failure shows before you push.

---

## 5. Packaging and release

- The Marketplace needs plain `x.y.z` versions; `.github/scripts/publish-vsce.sh` enforces it. `engines.vscode` must be at least what `vscode-languageclient` requires (`^1.91.0` today) and match `@types/vscode`.
- Publishing uses `vsce publish --no-dependencies`. That is correct only because everything is bundled; do not add a runtime `dependencies` entry that is not bundled.
- Change the package version only for a release; see `RELEASING.md`, "Extension releases".
- Ensure fixtures in `test-fixtures/sample-workspace` reflect valid component structures.
