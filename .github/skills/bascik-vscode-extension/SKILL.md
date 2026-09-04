---
name: bascik-vscode-extension
description: Development, syntax grammars, language diagnostics, and testing for the official Bascik VS Code Extension. Use when updating extensions/vscode-bascik, modifying rules.ts, adding compatibility diagnostics, or testing extension features.
---

# VS Code Extension Development for Bascik (`extensions/vscode-bascik`)

The `extensions/vscode-bascik` package provides editor support for Bascik, including component tag recognition, prop/slot intellisense, diagnostic warnings for unsupported scoping patterns, and syntax highlighting.

---

## 1. Extension Architecture

```
extensions/vscode-bascik/
├── src/
│   ├── extension.ts              # Extension activation, provider registration, & diagnostics wiring
│   ├── rules.ts                  # Diagnostic rules engine for scoping compatibility checks
│   ├── server-script-rules.ts    # Pure analyzer for server and stream script contract & injection sinks
│   ├── compatibility-rules.json  # Declarative rule definitions matching compatibility.md
│   └── test/
│       ├── extension.test.ts          # VS Code integration test suite
│       ├── rules.test.ts              # Fast unit tests for diagnostic rules
│       └── server-script-rules.test.ts # Fast unit tests for server script rules
└── package.json                  # Manifest with contribution points
```

---

## 2. Compatibility Diagnostic Engine (`rules.ts`)

The diagnostic engine checks `.html`, `.css`, and `.js` files against known Bascik scoping constraints:

* **Unsupported Pattern Warnings:** Warns when developers use unsupported selectors or un-scopable dynamic JavaScript DOM queries.
* **Component Path Resolution:** Resolves custom tags (e.g. `<my-card>`) to their source HTML files in `src/components/` and provides Go-to-Definition and hover documentation.
* **Rule Definitions:** All rules must align strictly with the canonical table in `docs/content/compatibility.md`.

---

## 3. Server Script Diagnostics (`server-script-rules.ts`)

The server-script diagnostic analyzer provides fast, pure-logic diagnostics for `<script data-bascik-server>` and `<script data-bascik-stream>` blocks:

* **Offset Convention:** All diagnostics report `start` and `end` offsets relative to the script body string so the caller in `extension.ts` can compute exact document positions via `document.positionAt(scriptBodyOffset + offset)`.
* **Contract Rules (Error):** Requires default exported handler `(request, context, { signal })` and rejects imports from `@bascik/bascik`.
* **Structural Sink Rules (Warning):** Flags dangerous template literal interpolation sinks (`server-script-sink-url-attribute`, `server-script-sink-event-handler`, `server-script-sink-unquoted-attribute`, `server-script-sink-inline-script`, `server-script-sink-style`). Structural sinks fire regardless of whether the expression is wrapped in a helper function like `escape(...)` because HTML entity escaping cannot make these contexts safe.
* **Text Sink Rule (Info):** `server-script-sink-text-unescaped` flags raw request-derived values in HTML body text when they are not wrapped in an escaping function call. It remains silent when wrapped (e.g. `escape(request.headers.get('x'))`) or when the value does not reference request/context data.

---

## 4. Development & Type Checking

To compile and typecheck the extension:

```sh
# Typecheck extension workspace
npx --prefix extensions/vscode-bascik tsc -p extensions/vscode-bascik/tsconfig.json --noEmit

# Run unit tests for rules
yarn --cwd extensions/vscode-bascik test
```

---

## 4. Extension Packaging & Pre-Release

* Do not mutate package version manually without updating changelogs.
* Ensure all test fixtures in `test-fixtures/sample-workspace` reflect valid component structures.
