# VS Code Extension

The official Bascik extension brings component navigation, context-aware component, prop, and slot suggestions, rich hover details, syntax highlighting, and real-time diagnostics into VS Code. It is powered by the [`@bascik/language-server`](/tools/linter) engine, which also provides CLI linting and multi-editor support for Neovim, Zed, and Helix.

## Install the Extension

1. Open the Extensions view in VS Code and search for `bascik`, or run **Extensions: Install Extensions** from the Command Palette.
2. Install the official **Bascik** extension.

That is all the setup there is. The extension activates for HTML, CSS, JavaScript, and TypeScript files in a workspace and uses Bascik's standard project layout, so no editor settings are required.

## What You Get

| When you... | The extension... | Learn more |
| --- | --- | --- |
| Type `<` and the start of a tag | Suggests your project's components | [Component tags](#complete-component-tags) |
| Add attributes to a component | Suggests its props and named slots | [Props and slots](#complete-props-and-slots) |
| Write a `<script>` | Offers the four execution directives | [Script directives](#complete-script-directives) |
| Hover a component tag | Shows its source, props, and slots | [Hover details](#see-a-components-contract-on-hover) |
| Cmd/Ctrl-click a tag or import | Jumps to the component or module | [Navigation](#navigate-components-and-imports) |
| Save or type a mistake | Flags it in the editor and Problems panel | [Diagnostics](#catch-problems-as-you-type) |

## Complete Component Tags

Type a partial opening tag and press `Ctrl+Space` if the list does not open on its own. IntelliSense lists the components from your project, and pressing `Ctrl+Space` again opens a panel with the component's documentation.

![The VS Code suggest widget listing user-card for the partial tag user-ca, with a documentation panel showing the component source file, its props, and its slots](/assets/vscode/complete-component-tags@2x.webp)

Suggestions use `directory.components` from the closest owning Bascik config, including every configured component root. Nested projects and separate workspace folders stay isolated.

> **Where suggestions appear.** Only while typing an opening tag name. They are not offered in closing tags, attributes, HTML comments, scripts, styles, or text areas.

The inserted snippet depends on the component. A component with a default slot completes as a pair and places the cursor between the tags. A component without one completes as a void element:

```html
<user-card></user-card>
<docs-head />
```

## Complete Props and Slots

Inside a component's opening tag, suggestions list every prop Bascik infers from the component markup. A prop you already supplied on that tag is left out of the list.

![The suggest widget listing data-bascik-prop-status and data-bascik-prop-tone after typing data-bascik-prop inside a user-badge tag](/assets/vscode/complete-props@2x.webp)

Selecting a prop inserts `data-bascik-prop-name=""` and places the cursor inside the value.

Named slots work the same way from inside the component body. Start an element and the extension suggests `data-bascik-slot` with the slot names the nearest containing component declares:

![The suggest widget offering data-bascik-slot="actions" on a span inside a user-card](/assets/vscode/complete-slots@2x.webp)

Slot suggestions are not repeated when the element already has a `data-bascik-slot` attribute. Default slots need no attribute, so the paired component snippet represents them.

## Complete Script Directives

Inside a `<script>` tag, the extension suggests the four mutually exclusive execution directives:

![The suggest widget listing data-bascik-build, data-bascik-routes, data-bascik-server, and data-bascik-stream](/assets/vscode/complete-script-directives@2x.webp)

Once one directive is on the tag, the others are removed from the list, so conflicting execution modes are prevented before they can be saved.

To skip the boilerplate, type `<bascik-` to expand a full script block for any of the four modes: `bascik-build`, `bascik-routes`, `bascik-server`, or `bascik-stream`.

## See a Component's Contract on Hover

Hover a component tag, or press `Cmd+K Cmd+I` (`Ctrl+K Ctrl+I` on Windows and Linux), to see its public contract without leaving the page you are editing:

![A hover card for the user-card tag showing its description, source path, the role prop, and the actions and default slots](/assets/vscode/hover-component@2x.webp)

The card shows the source path, the inferred props, named and default slots, and whether the component includes styles or scripts. Component tag suggestions expose the same documentation before insertion.

### Describe a Component with an `@bascik` Comment

Bascik infers the contract from component markup. Props come from `data-bascik-prop-*` declarations and from prop names referenced by `data-bascik-attr-*`, `data-bascik-text`, or `data-bascik-html`. Named and default slots come from `data-bascik-slot` declarations. To add human-readable descriptions, put an optional leading `@bascik` comment at the top of the component:

```html
<!-- @bascik
Displays a person's identity and available actions.
@prop role - The person's role or job title.
@slot actions - Controls displayed after the profile details.
@slot default - The primary profile content.
-->
<article data-bascik-attr-aria-label="role">
  <p data-bascik-text="role"></p>
  <div data-bascik-slot></div>
  <footer data-bascik-slot="actions"></footer>
</article>
```

That comment is what produced the hover card above: the description line, the `role` prop description, and the descriptions of the `actions` and default slots.

> **Markup stays authoritative.** An `@prop` or `@slot` line adds a description to a member the markup already declares. It cannot create a new prop or slot. Use `@slot default` to describe an inferred default slot. Annotation names are matched case-insensitively.

The comment must appear before component markup, `<style>`, or `<script>` elements. A byte-order mark, whitespace, and ordinary leading comments may precede it. Authored text is displayed literally rather than interpreted as Markdown or HTML.

## Navigate Components and Imports

Hold `Cmd` on macOS or `Ctrl` on Windows and Linux, then click:

- a **custom element name** to open its component HTML file
- a relative import, an `@/` import, or a `src` value in a `data-bascik-build`, `data-bascik-routes`, or `data-bascik-server` script

```html
<user-card data-bascik-prop-role="Lead Engineer"></user-card>

<script data-bascik-build>
  import { canonical } from '@/lib/canonical.ts';
  export default async () => await canonical();
</script>

<script data-bascik-server src="./scripts/profile.ts"></script>
```

The `@/` alias follows `scripts.importRoot` from the owning Bascik config and defaults to `src`. Relative imports resolve from the current HTML file.

> **Scope.** Import navigation applies to build, routes, and server scripts. Stream-script import navigation is not currently provided.

Bascik-specific syntax highlighting also makes the framework's attributes easy to pick out of ordinary markup. It covers prop and attribute bindings, slots, build scripts, route scripts, server scripts, and preserve directives.

## Catch Problems as You Type

Diagnostics appear as squiggles in the editor and as entries in the Problems panel. Hover a squiggle to read the explanation:

![An editor with warnings and errors: an undeclared prop on user-card with its hover message, an unknown slot name, and a script with two conflicting directives](/assets/vscode/diagnostics@2x.webp)

The checks below cover the most common mistakes. Metadata annotation warnings use the current unsaved component text, so they appear as you edit. Hover and completion contracts refresh from disk when component files change.

| Area | The extension reports |
| --- | --- |
| Component naming | A component filename without the hyphen a custom element name requires |
| Unclosed elements | A non-self-closing component tag with no matching closing tag |
| Script directives | A script combining more than one of `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` (error), or a directive on an element other than `<script>` (error) |
| Props | A `data-bascik-prop-*` attribute the component does not declare or infer (warning), and a `data-bascik-attr-*` binding whose prop no project caller supplies (warning) |
| Slots | `data-bascik-slot` outside any parent component, a slot name the containing component does not have, or an empty named slot (errors) |
| Imports | Imports and script `src` values that begin with `/`, with guidance to use `@/` or a relative path |
| Styles | A component that combines an inline `<style>` element with a companion `.css` file (warning). Multiple inline `<style>` elements are supported and are not reported |
| ID references | `for`, `itemref`, ARIA ID references, and `href="#fragment"` values whose target ID is not declared in the component |
| Preserve | A `data-bascik-preserve` value other than `id`, `name`, or `class`, and a form that posts to an external URL without `data-bascik-preserve="name"` |
| Annotations | An `@prop` or `@slot` line documented twice, or one that does not match a member inferred from the markup (warnings) |

### Find Scoping Compatibility Issues Early

Bascik rewrites CSS and JavaScript at build time to keep components isolated. Some patterns cannot be rewritten reliably, and the extension warns about them before they ship:

![A hover message on the standalone attribute selector [data-state] in a CSS file, explaining that it is not scoped and suggesting an anchored selector](/assets/vscode/scoping-warnings@2x.webp)

Every warning includes a safer alternative, such as retaining an element reference, using a static scoped class, or anchoring a selector with a class. The rules match [Scoping Compatibility](/compatibility).

| Language | Patterns that are flagged |
| --- | --- |
| CSS | Standalone attribute selectors such as `[data-state]`, which can leak globally unless anchored by a scoped class |
| CSS | Bare element names inside `:is()`, `:where()`, and `:has()`, which are not converted |
| JavaScript and TypeScript | Runtime `.id` assignment |
| JavaScript and TypeScript | Attribute selectors passed to `querySelector()` or `querySelectorAll()` |
| JavaScript and TypeScript | Template-literal class values assigned through `className` or `classList.replace()` |
| JavaScript and TypeScript | Runtime custom-property names passed to `style.setProperty('--name', value)` |

### Audit Server and Stream Scripts

Server and stream script diagnostics enforce the runtime contract and flag output contexts that need special handling:

- An inline server or stream script must `export default` a handler function.
- Server and stream scripts must not import `@bascik/bascik`. Project helpers should live under your import root instead.
- Template substitutions in URL attributes, event handlers, unquoted attributes, inline scripts, and CSS contexts receive targeted warnings because normal HTML escaping is not sufficient there.
- Request-derived values interpolated into text without an apparent escaping function receive an information diagnostic.

These diagnostics identify risky sinks. They do not replace application-specific validation, escaping, or authorization. See [Server Scripts](/server-scripts) for complete guidance.

### Validate API Routes

JavaScript and TypeScript files under `src/api/` receive route-specific checks:

- HTTP method exports must use recognized uppercase names: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD`.
- Annotated handlers should return `Response` or `Promise<Response>`. `any` and `unknown` are also accepted when an exact type is unavailable.
- A route file with no recognized HTTP method export reports an error.
- A `request.json()` or `req.json()` call outside an apparent `try` block receives an information diagnostic, because malformed JSON can otherwise produce an unhandled error.

The extension also ships snippets for scaffolding route handlers in TypeScript and JavaScript:

| Prefix | Inserts |
| --- | --- |
| `bascik-api` | A route handler with an HTTP method picker and pre-typed `request: Request` and `context: { params: Record<string, string>; remoteIp: string }` arguments |
| `bascik-get` | A typed `GET` handler |
| `bascik-post` | A typed `POST` handler with JSON request body parsing |

## Configure the Extension

### Suppress Diagnostics with Ignore Comments

Suppress diagnostics on a line or block using in-file comments:

- **HTML:**

  ```html
  <!-- bascik-ignore -->
  <docs-head></docs-head>

  <!-- bascik-disable -->
  ... code with warnings ...
  <!-- bascik-enable -->
  ```

- **JavaScript and TypeScript:**

  ```ts
  // bascik-ignore
  btn.id = "custom";
  ```

- **CSS:**

  ```css
  /* bascik-ignore */
  [data-state] { color: red; }
  ```

### Configure Per Project with `bascik.ext.json`

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

### Filter Generic Editor Word Suggestions

VS Code by default offers word-based completions derived from surrounding text in the active document. Because VS Code merges these suggestions independently, generic text tokens from nearby tags may appear in the completion list. To limit HTML suggestions to semantic attributes and Bascik completions, disable word-based suggestions for HTML in `settings.json`:

```json
"[html]": {
  "editor.wordBasedSuggestions": "off"
}
```

### Work Across Nested and Multi-Root Projects

The extension discovers Bascik configs recursively inside every VS Code workspace folder. Each config directory is treated as an independent project with its own component roots, import root, component usage index, navigation, hover details, and diagnostics.

When projects are nested, the closest enclosing project owns the file. Separate workspace folders remain isolated. A workspace folder with no Bascik config still receives zero-config support with `src/components` and `src` as the defaults.

Component discovery follows `directory.components` in the owning project's `bascik.config.ts`, `bascik.config.js`, or `bascik.config.mjs`. It supports one component directory, multiple directories, absolute paths, and relative paths, including shared component directories outside the project root.

Config files, component directories, and project HTML usage are watched for changes. Creating, editing, renaming, or deleting them refreshes extension state automatically, so reopening VS Code is not required.

## Command-Line Linting and Other Editors

If you need to run these diagnostics in continuous integration (CI), or you want editor support for Neovim, Zed, or Helix, see the [Linter](/tools/linter) documentation.
