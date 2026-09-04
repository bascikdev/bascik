# VS Code Extension

The Bascik VS Code extension is a lightweight editor companion for the scoping system. It helps you catch the patterns that are easy to write but unsafe to scope, as well as markup structures that might lead to layout or execution surprises.

The extension is generated from the compatibility rules in [Scoping Compatibility](/compatibility), so the warning set stays aligned with the documented support matrix instead of drifting over time.

## What it does

### 1. Code Navigation
- **Go to Definition:** Command-click (or Ctrl-click) any custom component tag (e.g. `<my-component>`) to instantly jump to its definition HTML file in your project.
- **Go to Definition for Script Imports:** Command-click (or Ctrl-click) a `./` or `../` specifier in a static import, bare import, `export ... from`, dynamic `import()`, or quoted or unquoted `src` attribute inside a `<script data-bascik-build>`, `<script data-bascik-routes>`, or `<script data-bascik-server>` tag to jump straight to an existing file on disk. Bare package specifiers, missing targets, import-like text outside JavaScript code, and imports in plain client `<script>` tags are not resolved.

### 2. Markup and Script Structural Warnings
- **Unclosed Component Tags (Warning):** If a custom component tag is not self-closing and lacks a corresponding closing tag (for example, `<my-card>` without `</my-card>`), the extension flags it. This helps you prevent unintentional self-closing layout collapse.
- **Conflicting Script Attributes (Error):** Putting both `data-bascik-build` and `data-bascik-server` attributes on the same `<script>` tag is invalid because a script can only execute during the build or at request time, not both. The extension marks this as a high-visibility red error.
- **Multiple `<style>` Blocks (Warning):** Warns if a component contains multiple inline `<style>` tags. While Bascik combines them at build time, separating style blocks in a single component file is discouraged for clean maintainability.
- **Style Coexistence Conflicts (Warning):** Flags if a component has both a companion `.css` file and an inline `<style>` tag, encouraging consistent stylesheet structure within your project.

### 3. CSS Scoping Compatibility Warnings
- **Global Selector Warnings:** Flags CSS selectors that Bascik's scoping engine cannot isolate. For example, using `[id]` selectors is flagged because they cannot be scoped without DOM wrapping and would apply globally.

### 4. JavaScript Scoping Compatibility Warnings
- **Risky Selector Rewriting Patterns:** Warns on patterns that cannot be reliably rewritten at build time, such as runtime assignments to `el.id` or `el.name`. It directs you to stable alternatives, like querying the scoped element once and operating on its reference directly.

The extension does **not** warn on class names that only appear in JavaScript and never in a `class="…"` HTML attribute. Those classes are automatically discovered and scoped by the build pipeline. A `classList.toggle('active')` call is fully supported even if `active` never appears in the component template.

## Install locally

From the repo root:

```sh
yarn install
yarn workspace bascik-vscode compile
```

Then open the `extensions/vscode-bascik/` folder in VS Code and press F5. A `.vscode/launch.json` is already configured there, so VS Code will open an Extension Development Host window with the extension enabled.

## Test it locally

In the Extension Development Host window, open a Bascik project or the sample project in `my-site/` and try a few real checks:

1. Open an HTML file with a custom component tag such as `<my-card>`.
2. Place the cursor on that tag and use Command+Click (or Ctrl+Click) to jump to the matching component file.
3. Add a known unsupported pattern to a component `.css` file, inline `<style>` block, or `<script>` tag.
4. Check the Problems panel for a warning.

Example unsupported patterns:

```css
[id] {
  color: red;
}
```

```js
const panel = document.getElementById("panel");
panel.id = "other";
```

These warnings come from the same rules tracked in [Scoping Compatibility](/compatibility), and they are regenerated into the extension automatically before compile.

## Why this is useful

Bascik is intentionally simple, but its scoping engine has a few sharp edges. The extension helps catch those issues before the build ever runs, which prevents silent breakage and makes the supported patterns easier to follow.

## Current feature scope

The first pass focuses on high-confidence, high-signal warnings:

- component tag to component file navigation
- unsupported CSS selector warnings
- unsupported or risky JavaScript selector patterns
- links to the compatibility docs for the exact supported rules

This is intentionally narrower than a full linter. The goal is not to replace a CSS or JS checker. The goal is to catch the patterns that Bascik's scoping pass cannot safely handle.

## Example warnings

### CSS

```css
[id] {
  color: red;
}
```

This warns because `[id]` selectors are not scoped by Bascik and would apply globally.

### JavaScript

```js
const panel = document.getElementById("panel");
panel.id = "other";
```

This warns because runtime property assignment to `id` is not rewritten by the build pipeline. Prefer querying the scoped element once and operating on its reference instead.

Class-only operations are not flagged, even when the class only appears in JavaScript:

```js
// No warning: JS-only class names are automatically discovered and scoped
el.classList.toggle('active');
el.classList.replace('loading', 'ready');
```

## Recommended pattern

When the script needs to act on a specific instance, prefer:

```js
const panel = document.getElementById("panel");
panel.style.display = "none";
```

This is stable because the ID is rewritten with a per-instance hash, and the script operates on the actual element reference rather than a string that the compiler cannot rewrite safely.

## Source of truth

The extension follows the compatibility rules documented in [Scoping Compatibility](/compatibility).
