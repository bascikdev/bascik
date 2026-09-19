# VS Code Extension

The official Bascik extension brings component navigation, rich hover details, syntax highlighting, and real-time diagnostics into VS Code. It catches component contract, scoping, server rendering, streaming, and API route problems while you edit, before they reach a build or browser.

## Install the Extension

Install **Bascik** from the VS Code Extensions view by searching for `bascik`, or run **Extensions: Install Extensions** from the Command Palette and select the official extension.

The extension activates automatically for HTML, CSS, JavaScript, and TypeScript files in a workspace. It uses Bascik's standard project layout without requiring editor settings.

## Navigate Components and Inspect Their Contracts

Hold Cmd on macOS or Ctrl on Windows and Linux, then click a custom element name to open its component HTML file:

```html
<user-card data-bascik-prop-role="Lead Engineer">
  <span data-bascik-slot="name">Sarah Chen</span>
</user-card>
```

Hover over the same tag to see its source path, declared props, named slots, and whether the component includes styles or scripts. This gives you the component's public contract without leaving the page you are editing.

Component discovery follows `directory.components` in the owning project's `bascik.config.ts`, `bascik.config.js`, or `bascik.config.mjs`. It supports one component directory, multiple directories, absolute paths, and relative paths, including shared component directories outside the project root.

## Navigate Script Imports

Cmd/Ctrl-click relative imports, the `@/` alias, and `src` values in `data-bascik-build`, `data-bascik-routes`, and `data-bascik-server` scripts:

```html
<script data-bascik-build>
  import { canonical } from '@/lib/canonical.ts';
  console.log(await canonical());
</script>

<script data-bascik-server src="./scripts/profile.ts"></script>
```

The `@/` alias follows `scripts.importRoot` from the owning Bascik config and defaults to `src`. Relative imports resolve from the current HTML file.

> **Scope.** Import navigation applies to build, routes, and server scripts. Stream-script import navigation is not currently provided.

## Recognize Bascik Markup at a Glance

Dedicated HTML syntax highlighting makes Bascik attributes easier to distinguish from standard markup. It covers prop and attribute bindings, slots, build scripts, route scripts, server scripts, and preserve directives.

## Catch Component and Template Problems

The extension publishes actionable diagnostics in the editor and Problems panel:

- **Component naming:** Warns when an HTML component filename does not contain the hyphen required for a custom element name.
- **Unclosed custom elements:** Warns when a non-self-closing component tag has no matching closing tag.
- **Conflicting script directives:** Reports an error when a script combines more than one of `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream`.
- **Leading-slash specifiers:** Reports imports and script `src` values that begin with `/`, with guidance to use `@/` or a relative path instead.
- **Companion style conflicts:** Warns when a component combines an inline `<style>` element with a companion `.css` file.
- **Unscoped ID references:** Identifies `for`, `itemref`, ARIA ID references, and `href="#fragment"` values whose target ID is not declared in the component.
- **Invalid preserve tokens:** Warns when `data-bascik-preserve` contains a value other than `id`, `name`, or `class`.
- **External form names:** Warns when a form posts to an external URL without `data-bascik-preserve="name"`.
- **Unsupplied prop bindings:** Warns when a component uses `data-bascik-attr-*` with a prop that no project caller supplies.

Multiple inline `<style>` elements are supported and are not reported as an editor problem.

## Audit Server and Stream Scripts

Server and stream script diagnostics enforce the runtime contract and flag output contexts that need special handling:

- An inline server or stream script must `export default` a handler function.
- Server and stream scripts must not import `@bascik/bascik`; project helpers should live under your import root instead.
- Template substitutions in URL attributes, event handlers, unquoted attributes, inline scripts, and CSS contexts receive targeted warnings because normal HTML escaping is not sufficient there.
- Request-derived values interpolated into text without an apparent escaping function receive an information diagnostic.

These diagnostics identify risky sinks, but they do not replace application-specific validation, escaping, or authorization. See [Server Scripts](/server-scripts) for complete guidance.

## Validate API Routes While You Type

JavaScript and TypeScript files under `src/api/` receive route-specific checks:

- HTTP method exports must use recognized uppercase names: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD`.
- Annotated handlers should return `Response` or `Promise<Response>`; `any` and `unknown` are also accepted when an exact type is unavailable.
- A route file with no recognized HTTP method export reports an error.
- A `request.json()` or `req.json()` call outside an apparent `try` block receives an information diagnostic because malformed JSON can otherwise produce an unhandled error.

## Find Scoping Compatibility Issues Early

The extension warns about CSS and JavaScript patterns that Bascik cannot reliably rewrite at build time.

CSS checks cover:

- standalone attribute selectors such as `[data-state]`, which can leak globally unless anchored by a scoped class
- bare element names inside `:is()`, `:where()`, and `:has()`, which are not converted

JavaScript and TypeScript checks cover:

- runtime `.id` assignment
- attribute selectors passed to `querySelector()` or `querySelectorAll()`
- template-literal class values assigned through `className` or `classList.replace()`
- runtime custom-property names passed to `style.setProperty('--name', value)`

Each warning includes a safer alternative, such as retaining an element reference, using a static scoped class, or anchoring a selector with a class. The checks follow the rules documented in [Scoping Compatibility](/compatibility).

## Work Across Nested and Multi-Root Projects

The extension discovers Bascik configs recursively inside every VS Code workspace folder. Each config directory is treated as an independent project with its own component roots, import root, component usage index, navigation, hover details, and diagnostics.

When projects are nested, the closest enclosing project owns the file. Separate workspace folders remain isolated. A workspace folder with no Bascik config still receives zero-config support with `src/components` and `src` as the defaults.

Config files, component directories, and project HTML usage are watched for changes. Creating, editing, renaming, or deleting them refreshes extension state automatically, so reopening VS Code is not required.

## Develop the Extension Locally

From the Bascik repository root, compile the extension with `yarn ext:compile`. Open `extensions/vscode-bascik` in VS Code and press F5 to launch an Extension Development Host.

The extension requires VS Code 1.90 or newer. Repository contributors can run its focused tests through the extension scripts in the root `package.json`.
