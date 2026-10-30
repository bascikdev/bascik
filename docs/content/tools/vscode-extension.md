# VS Code Extension

The official Bascik extension brings component navigation, context-aware component, prop, and slot suggestions, rich hover details, syntax highlighting, and real-time diagnostics into VS Code. It is powered by the [`@bascik/language-server`](/tools/linter) engine, which also provides CLI linting and editor support for Neovim.

## Install the Extension

1. Open the Extensions view in VS Code and search for `bascik`, or run **Extensions: Install Extensions** from the Command Palette.
2. Install the official **Bascik** extension.

That is all the setup there is. The extension activates for HTML, CSS, JavaScript, and TypeScript files in a workspace and uses Bascik's standard project layout, so no editor settings are required. In a Bascik project it also offers, once, to turn off one VS Code check that gives false errors on Bascik pages, as [Several Scripts in One File](#several-scripts-in-one-file) explains.

## What You Get

| When you...                      | The extension...                          | Learn more                                           |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Type `<` and the start of a tag  | Suggests your project's components        | [Component tags](#complete-component-tags)           |
| Add attributes to a component    | Suggests its props and named slots        | [Props and slots](#complete-props-and-slots)         |
| Write a `<script>`               | Offers the five execution directives      | [Script directives](#complete-script-directives)     |
| Hover a component tag            | Shows its source, props, and slots        | [Hover details](#see-a-components-contract-on-hover) |
| Cmd/Ctrl-click a tag or import   | Jumps to the component or module          | [Navigation](#navigate-components-and-imports)       |
| Press `Shift+F12` on a component | Lists every page and component using it   | [Find All References](#find-all-references)          |
| Save or type a mistake           | Flags it in the editor and Problems panel | [Diagnostics](#catch-problems-as-you-type)           |

## Complete Component Tags

Type a partial opening tag and press `Ctrl+Space` if the list does not open on its own. IntelliSense lists the components from your project, and pressing `Ctrl+Space` again opens a panel with the component's documentation.

![The VS Code suggest widget listing user-card for the partial tag user-ca, with a documentation panel showing the component source file, its props, and its slots](/assets/vscode/complete-component-tags@2x.webp)

Suggestions use `directory.components` from the closest owning Bascik config, including every configured component root. Nested projects and separate workspace folders stay isolated.

> **Where suggestions appear.** Only while typing an opening tag name. They are not offered in closing tags, attributes, HTML comments, scripts, styles, or text areas.

The inserted snippet depends on the component. A component with a default slot completes as a pair and places the cursor between the tags. A component without one completes as a void element:

```html
<user-card></user-card> <docs-head />
```

## Complete Props and Slots

Inside a component's opening tag, suggestions list every prop Bascik infers from the component markup. A prop you already supplied on that tag is left out of the list.

![The suggest widget listing data-bascik-prop-status and data-bascik-prop-tone after typing data-bascik-prop inside a user-badge tag](/assets/vscode/complete-props@2x.webp)

Selecting a prop inserts `data-bascik-prop-name=""` and places the cursor inside the value.

Named slots work the same way from inside the component body. Start an element and the extension suggests `data-bascik-slot` with the slot names the nearest containing component declares:

![The suggest widget offering data-bascik-slot="actions" on a span inside a user-card](/assets/vscode/complete-slots@2x.webp)

Slot suggestions are not repeated when the element already has a `data-bascik-slot` attribute. Default slots need no attribute, so the paired component snippet represents them.

## Complete Script Directives

Inside a `<script>` tag, the extension suggests the five mutually exclusive execution directives:

![The suggest widget listing data-bascik-build, data-bascik-build-once, data-bascik-routes, data-bascik-server, and data-bascik-stream](/assets/vscode/complete-script-directives@2x.webp)

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
- a relative import, an `@/` import, or a `src` value in a `data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`, or `data-bascik-server` script

```html
<user-card data-bascik-prop-role="Lead Engineer"></user-card>

<script data-bascik-build>
  import { canonical } from "@/lib/canonical.ts";
  export default async () => await canonical();
</script>

<script data-bascik-server src="./scripts/profile.ts"></script>
```

The `@/` alias follows `scripts.importRoot` from the owning Bascik config and defaults to `src`. Relative imports resolve from the current HTML file.

> **Scope.** Import navigation applies to build, routes, and server scripts. Stream-script import navigation is not currently provided.

## Find All References

VS Code's standard Find All References works on components, so the shortcuts you already know list every page and component that uses one. There are two ways to start it:

- **From a usage.** Put the cursor on a component tag name, opening or closing, in any page or component, and press `Shift+F12`.
- **From the component itself.** In the component's own file, press `Shift+F12` on its first line, anywhere in its `<!-- @bascik` comment, or on its root element's tag line. You do not need to find a usage first.

![VS Code: Shift+F12 on the @bascik comment of product-card.html opens Peek References listing featured-row.html, gifts.html, and shop.html; selecting the usage in gifts.html previews it, and Enter opens the page at that tag](/assets/vscode/find-references@2x.webp)

`Shift+F12` opens Peek References, which previews each usage in place. Select one and press `Enter` to open it. To list them in the References panel instead, right-click and choose **Find All References**, or press `Shift+Option+F12` (`Shift+Alt+F12` on Windows and Linux). Each result is the tag name in an opening tag, and self-closing tags count. A tag inside an HTML comment, an attribute value, or a `<script>`, `<style>`, or `<textarea>` body is not a usage, because Bascik does not expand it there. Results include unsaved edits in open files, and follow files you add, change, or delete.

> **Source files only.** References come from the HTML files in your project, so a usage that only exists in the output of a build script, a Markdown file, or a server script is not listed.

Bascik-specific syntax highlighting also makes the framework's attributes easy to pick out of ordinary markup. It covers prop and attribute bindings, slots, build scripts, route scripts, server scripts, and preserve directives.

## Catch Problems as You Type

Diagnostics appear as squiggles in the editor and as entries in the Problems panel. Hover a squiggle to read the explanation:

![An editor with warnings and errors: an undeclared prop on user-card with its hover message, an unknown slot name, and a script with two conflicting directives](/assets/vscode/diagnostics@2x.webp)

The checks below cover the most common mistakes. Metadata annotation warnings use the current unsaved component text, so they appear as you edit. Hover and completion contracts refresh from disk when component files change.

| Area              | The extension reports                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Component naming  | A component filename without the hyphen a custom element name requires                                                                                                                                                                                                                                                               |
| Unclosed elements | A non-self-closing component tag with no matching closing tag                                                                                                                                                                                                                                                                        |
| Script directives | A script combining more than one of `data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` (error), including `data-bascik-build` with `data-bascik-build-once`, or a directive on an element other than `<script>` (error)                                             |
| Props             | A `data-bascik-prop-*` attribute the component does not declare or infer (warning), and a `data-bascik-attr-*` binding whose prop no project caller supplies (hint)                                                                                                                                                                  |
| Slots             | `data-bascik-slot` outside any parent component, a slot name the containing component does not have, or an empty named slot (errors)                                                                                                                                                                                                 |
| Imports           | Imports and script `src` values that begin with `/`, with guidance to use `@/` or a relative path                                                                                                                                                                                                                                    |
| Styles            | A component that combines an inline `<style>` element with a companion `.css` file (warning). Multiple inline `<style>` elements are supported and are not reported                                                                                                                                                                  |
| ID references     | `for`, `itemref`, ARIA ID references, and `href="#fragment"` values whose target ID is not declared in the component                                                                                                                                                                                                                 |
| Preserve          | A `data-bascik-preserve` value other than `id`, `name`, or `class`, and, in a project with `scoping.attributes.name: true`, a form that posts to an external URL without `data-bascik-preserve="name"`                                                                                                                               |
| Name groups       | A component that holds a whole radio group (outside a `<form>` of its own), two or more `<details>` with one `name`, or a `<map name>`, and is used more than once on a page, so the copies act as one group (warning, `shared-name-group`). See [Component Best Practices](/component-best-practices#name-form-controls-and-groups) |
| Annotations       | An `@prop` or `@slot` line documented twice, or one that does not match a member inferred from the markup (warnings)                                                                                                                                                                                                                 |

### Find Scoping Compatibility Issues Early

Bascik rewrites CSS and JavaScript at build time to keep components isolated. Some patterns cannot be rewritten reliably, and the extension warns about them before they ship:

![A hover message on the standalone attribute selector [data-state] in a CSS file, explaining that it is not scoped and suggesting an anchored selector](/assets/vscode/scoping-warnings@2x.webp)

Every warning includes a safer alternative, such as retaining an element reference, using a static scoped class, or anchoring a selector with a class. The rules match [Scoping Compatibility](/compatibility).

These checks apply to component files only: the component's `.html` file and the `.css`, `.js`, and `.ts` files beside it. Those are the only files Bascik scopes, so a page, an API route, or a script outside your component folders is not checked.

| Language                  | Patterns that are flagged                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| CSS                       | Standalone attribute selectors such as `[data-state]`, which can leak globally unless anchored by a scoped class |
| CSS                       | Bare element names inside `:is()`, `:where()`, and `:has()`, which are not converted                             |
| JavaScript and TypeScript | Runtime `.id` assignment                                                                                         |
| JavaScript and TypeScript | Attribute selectors passed to `querySelector()` or `querySelectorAll()`                                          |
| JavaScript and TypeScript | Template-literal class values assigned through `className` or `classList.replace()`                              |
| JavaScript and TypeScript | Runtime custom-property names passed to `style.setProperty('--name', value)`                                     |

### Audit Server and Stream Scripts

Server and stream script diagnostics enforce the runtime contract and flag output contexts that need special handling:

- An inline server or stream script must `export default` a handler function.
- Server and stream scripts may import `@bascik/bascik/html`, and nothing else from `@bascik/bascik`, which is build tooling.
- A markup template that interpolates a value without `html` gets `server-script-unescaped-markup` on that hole, with the quick fix **Wrap template in html\`...\`**, which adds the tag and the import. The fix is not offered when a hole calls a hand-written escaper such as `escape(q)` or holds a joined string, because wrapping would escape the value twice.
- Template substitutions in URL attributes, event handlers, unquoted attributes, inline scripts, and CSS contexts receive targeted warnings because normal HTML escaping is not sufficient there. Inside an `html` template, the ones `html` refuses are errors.
- `esc()` inside an `html` template is reported as `html-escaped-twice`, and a `.join("")` of `html` values inside one as `html-joined-string`. Both would show escaped tags as text on the page.

![VS Code: the hole in a server script's template is underlined, the hover names server-script-unescaped-markup, and the Quick Fix wraps the template in html and adds the import from @bascik/bascik/html](/assets/vscode/unescaped-markup@2x.webp)

These diagnostics identify risky sinks. They do not replace application-specific validation, escaping, or authorization. See [Security](/security) and the [Linter](/tools/linter#server-script-unescaped-markup) for complete guidance.

### Validate API Routes

JavaScript and TypeScript files under `src/api/` receive route-specific checks:

- HTTP method exports must use recognized uppercase names: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD`.
- Annotated handlers should return `Response` or `Promise<Response>`. `any` and `unknown` are also accepted when an exact type is unavailable.
- A route file with no recognized HTTP method export reports an error.
- A `request.json()` or `req.json()` call outside an apparent `try` block receives an information diagnostic, because malformed JSON can otherwise produce an unhandled error.

The extension also ships snippets for scaffolding route handlers in TypeScript and JavaScript:

| Prefix        | Inserts                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bascik-api`  | A route handler with an HTTP method picker and pre-typed `request: Request` and `context: { params: Record<string, string>; remoteIp: string }` arguments |
| `bascik-get`  | A typed `GET` handler                                                                                                                                     |
| `bascik-post` | A typed `POST` handler with JSON request body parsing                                                                                                     |

## Several Scripts in One File

A Bascik page or component often has more than one `<script>`: a build script, a server script, and a script for the browser. VS Code's built-in HTML checker joins every classic `<script>` (one without `type="module"`) in a file into one JavaScript file before it checks them. Two Bascik scripts that each `export default` then look like one file with two default exports, and VS Code underlines both with:

```text
A module cannot have multiple default exports.
```

Bascik runs each script on its own, so the page builds fine. The fix is to turn off VS Code's inline script check with the `html.validate.scripts` setting:

```json
{
  "html.validate.scripts": false
}
```

A project gets this setting in one of three ways. None of them touches your user settings or any folder that is not a Bascik project:

- **`npm create bascik`** writes it to the new project's `.vscode/settings.json`, so it works for teammates before they install the extension.
- **`bascik init`** adds it to `.vscode/settings.json` in the current folder, and keeps any settings that file already has.
- **The extension's prompt, or pasting it yourself.** When the extension starts in a workspace that holds a `bascik.config.js`, `bascik.config.mjs`, or `bascik.config.ts` and nobody has set `html.validate.scripts` in the user, workspace, or folder settings, it shows one message that explains the false error, with two buttons. **Add to workspace settings** writes the setting to `.vscode/settings.json` in each Bascik folder and keeps what that file already has. **Don't ask again** stops the message for that workspace. The message shows at most once per window. Or paste the JSON above into `.vscode/settings.json` at the project root; if the file already has settings, add the `"html.validate.scripts": false` line inside its braces.

The extension never changes the setting without your click, and it never asks when the value is already set either way. A project that wants VS Code's check can set it to `true`.

Here is what you give up. With the setting off, VS Code no longer reports JavaScript syntax errors or type and semantic errors for code inside `<script>` tags in `.html` files: no red underlines and no Problems entries for it. Completions, hover, `<style>` checks, and checks in `.js` and `.ts` files work as before. The Bascik language server still checks Bascik's own rules inside scripts, such as conflicting directives and unsafe server output, in the editor and under `bascik --check`, but it does not check general JavaScript syntax in an inline script either. Script errors are still caught when the code loads:

- **A build script or server script** with a syntax error fails at load, with the file and line. The dev server prints the error and leaves that page out (it returns 404), and `bascik --build` fails.
- **A script for the browser** with a syntax error shows the error in the browser console when the page loads.

VS Code forks such as Cursor and Windsurf read the same `.vscode` folder and settings, so all of this applies to them too.

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
  [data-state] {
    color: red;
  }
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

Component discovery follows `directory.components` in the owning project's config file, found in the same order the CLI uses: `bascik.config.js`, then `bascik.config.mjs`, then `bascik.config.ts`. When a folder holds more than one, the first in that order wins, so the editor and the build read the same file. It supports one component directory, multiple directories, absolute paths, and relative paths, including shared component directories outside the project root.

Config files, component directories, and project HTML usage are watched for changes. Creating, editing, renaming, or deleting them refreshes extension state automatically, so reopening VS Code is not required.

## How It Works

The extension does not analyze anything itself. It starts `@bascik/language-server`, which ships inside the extension, and connects it to VS Code. Every diagnostic, completion, hover, definition, and reference on this page comes from that server. The same server runs under [`bascik --check`](/cli#static-analysis-with-bascik-check) and in other editors, so a squiggle in VS Code is the same finding CI reports.

If diagnostics ever look stale or missing, open the **Bascik** output panel to see the server's log. Reloading the window restarts it.

## Command-Line Linting and Other Editors

If you need to run these diagnostics in continuous integration (CI), or you want editor support for Neovim, see the [Linter](/tools/linter) documentation.
