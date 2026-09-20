# VS Code Extension

The official Bascik extension brings component navigation, context-aware component, prop, and slot suggestions, rich hover details, syntax highlighting, and real-time diagnostics into VS Code. It is powered by the [`@bascik/language-server`](/tools/linter) engine, which also provides CLI linting and multi-editor support for Neovim, Zed, and Helix.

## Install the Extension

Install **Bascik** from the VS Code Extensions view by searching for `bascik`, or run **Extensions: Install Extensions** from the Command Palette and select the official extension.

The extension activates automatically for HTML, CSS, JavaScript, and TypeScript files in a workspace. It uses Bascik's standard project layout without requiring editor settings.

## Complete Component Tags

Type a partial opening tag to see matching components from the current Bascik project:

```html
<docs-
```

IntelliSense lists discovered names such as `docs-nav`, `docs-sidebar`, and `docs-footer`. Suggestions use `directory.components` from the closest owning Bascik config, including every configured component root. Nested projects and separate workspace folders remain isolated.

Suggestions appear only while typing an opening tag name. They are not offered in closing tags, attributes, HTML comments, scripts, styles, or text areas.

When a component exposes a default slot, selecting its suggestion inserts a paired snippet and places the cursor between the tags:

```html
<user-card></user-card>
```

Components without a default slot complete as self-closing void elements:

```html
<docs-head />
```

## Complete Props and Slots in Context

Inside a discovered component's opening tag, IntelliSense suggests every prop inferred from the component markup:

```html
<user-card data-bascik-prop-role="Lead Engineer">
```

Selecting a prop inserts `data-bascik-prop-name=""` and places the cursor inside the value. A prop already supplied on that opening tag is omitted from the suggestions.

Inside the component body, start an element opening tag to see its named slots:

```html
<user-card>
  <span data-bascik-slot="name">Sarah Chen</span>
</user-card>
```

Named-slot suggestions appear only within the nearest containing Bascik component. They are not repeated when the element already has a `data-bascik-slot` attribute. Default slots need no attribute, so they are represented by the paired component snippet rather than an attribute suggestion.

## Complete Script Directives

Inside a `<script>` tag, IntelliSense suggests the four mutually exclusive Bascik execution directives:

- `data-bascik-build`
- `data-bascik-routes`
- `data-bascik-server`
- `data-bascik-stream`

Once any one of these directives is present on the tag, competing directives are omitted so conflicting execution modes are prevented before they can be saved.

## Filter Generic Editor Word Suggestions

VS Code by default offers word-based completions derived from surrounding text in the active document. Because VS Code merges these suggestions independently, generic text tokens from nearby tags may appear in the completion list. To limit HTML suggestions to semantic attributes and Bascik completions, disable word-based suggestions for HTML in `settings.json`:

```json
"[html]": {
  "editor.wordBasedSuggestions": "off"
}
```

## Suppress Diagnostics with Ignore Comments

Suppress diagnostics on a line or block using in-file comments:

- **HTML:**

  ```html
  <!-- bascik-ignore -->
  <docs-head></docs-head>

  <!-- bascik-disable -->
  ... code with warnings ...
  <!-- bascik-enable -->
  ```

- **JavaScript & TypeScript:**

  ```ts
  // bascik-ignore
  btn.id = "custom";
  ```

- **CSS:**

  ```css
  /* bascik-ignore */
  [data-state] { color: red; }
  ```

## Extension Configuration (`bascik.ext.json` / `bascik.ext.ts`)

Configure extension behavior per project without modifying application config (`bascik.config.ts`) by placing a `bascik.ext.json` or `bascik.ext.ts` file in your project root:

```json
{
  "diagnostics": {
    "enabled": true,
    "selfClosingComponents": true,
    "unclosedComponents": true,
    "disabledRules": ["css-attribute-selector"]
  }
}
```

## Describe Inferred Component Contracts

Bascik infers the public contract directly from component markup. Props come from `data-bascik-prop-*` declarations and prop names referenced by `data-bascik-attr-*`, `data-bascik-text`, or `data-bascik-html`. Named and default slots come from `data-bascik-slot` declarations. Inline or companion styles and inline scripts are also detected.

Add an optional leading `@bascik` comment to describe the component and its inferred members:

```html
<!-- @bascik
Displays a person's identity and available actions.
@prop role - The person's role or job title.
@slot actions - Controls displayed after the profile details.
@slot default - The primary profile content.
-->
<article data-bascik-attr-aria-label="role">
  <div data-bascik-slot></div>
  <footer data-bascik-slot="actions"></footer>
</article>
```

The comment must appear before component markup, `<style>`, or `<script>` elements. A byte-order mark, whitespace, and ordinary leading comments may precede it.

Markup remains authoritative. An `@prop` or `@slot` line adds a description to a member that the markup already declares, but it cannot create a new prop or slot. Use `@slot default` to describe an inferred default slot. Annotation names are matched case-insensitively.

Descriptions appear in component hover details, component completion documentation, prop suggestions, and named-slot suggestions. Authored text is displayed literally rather than interpreted as Markdown or HTML.

## Navigate Components and Inspect Their Contracts

Hold Cmd on macOS or Ctrl on Windows and Linux, then click a custom element name to open its component HTML file:

```html
<user-card data-bascik-prop-role="Lead Engineer">
  <span data-bascik-slot="name">Sarah Chen</span>
</user-card>
```

Hover over the same tag to see its source path, inferred props, named and default slots, optional descriptions, and whether the component includes styles or scripts. Component tag suggestions expose the same documentation before insertion. This gives you the component's public contract without leaving the page you are editing.

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
- **Misplaced script directives:** Reports an error when `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, or `data-bascik-stream` is placed on an element other than `<script>`.
- **Undeclared component props:** Warns when a `data-bascik-prop-*` attribute is placed on a custom component tag that does not declare or infer that prop.
- **Misplaced or undeclared slots:** Reports errors when `data-bascik-slot` is placed on an element outside any parent component, when an assigned slot name does not exist on the containing component, or when a named slot attribute is empty.
- **Leading-slash specifiers:** Reports imports and script `src` values that begin with `/`, with guidance to use `@/` or a relative path instead.
- **Companion style conflicts:** Warns when a component combines an inline `<style>` element with a companion `.css` file.
- **Unscoped ID references:** Identifies `for`, `itemref`, ARIA ID references, and `href="#fragment"` values whose target ID is not declared in the component.
- **Invalid preserve tokens:** Warns when `data-bascik-preserve` contains a value other than `id`, `name`, or `class`.
- **External form names:** Warns when a form posts to an external URL without `data-bascik-preserve="name"`.
- **Unsupplied prop bindings:** Warns when a component uses `data-bascik-attr-*` with a prop that no project caller supplies.
- **Duplicate metadata annotations:** Warns when a leading `@bascik` header documents the same prop or slot more than once. The first annotation supplies the description.
- **Undeclared metadata annotations:** Warns when an `@prop` or `@slot` annotation does not match a member inferred from the component markup.

Multiple inline `<style>` elements are supported and are not reported as an editor problem.

---

## Command-Line Linting & Other Editors

If you need to run these diagnostics in continuous integration (CI) or want editor support for Neovim, Zed, or Helix, see the [Linter & Editor Support](/tools/linter) documentation.

Metadata annotation warnings use the current unsaved component text, so mistakes appear as you edit without waiting for the file to be saved. Hover and completion contracts refresh from disk when component files change.

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

### API Route Snippets

The extension provides built-in snippets for scaffolding route handlers in TypeScript and JavaScript:

- `bascik-api`: Scaffold an API route handler with an HTTP method picker and pre-typed `request: Request` and `context: { params: Record<string, string>; remoteIp: string }` arguments.
- `bascik-get`: Quick snippet for a typed `GET` handler.
- `bascik-post`: Quick snippet for a typed `POST` handler with JSON request body parsing.

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
