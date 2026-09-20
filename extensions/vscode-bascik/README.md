# Bascik for Visual Studio Code

Build Bascik sites with faster navigation and earlier feedback. The official extension understands component boundaries, project configuration, scoped CSS and JavaScript, server-rendered output, streams, and API routes, so common mistakes surface in the editor instead of during a build or browser test.

## Why Install It?

- **Move through components instantly.** Cmd/Ctrl-click a custom element to open its source, or hover to inspect its props, slots, source path, styles, and scripts.
- **Complete component usage in context.** Suggest project component tags, inferred prop attributes, and named slots, with paired tag snippets for components that accept default content.
- **Document component contracts.** Add an optional leading `@bascik` comment to describe a component and the props and slots inferred from its markup.
- **Catch scoping leaks early.** Get focused CSS and JavaScript warnings for patterns Bascik cannot safely rewrite.
- **Protect server-rendered output.** See targeted diagnostics for unsafe interpolation contexts in server and stream scripts.
- **Validate component contracts.** Find unclosed tags, conflicting directives, invalid preserve values, broken ID references, and unsupplied prop bindings as you type.
- **Check API routes before runtime.** Catch unrecognized method exports, incompatible return annotations, missing handlers, and unguarded JSON parsing.
- **Start with zero configuration.** Standard Bascik projects work immediately, while custom paths, nested projects, and multi-root workspaces are detected automatically.

## Component IntelliSense

Type a partial opening tag to see matching project components in IntelliSense. Suggestions follow the current project's configured component roots and remain isolated across nested projects and multi-root workspaces.

Components with a default slot complete as paired opening and closing tags. Inside a discovered component's opening tag, IntelliSense suggests inferred `data-bascik-prop-*` attributes and omits props already supplied. Inside its body, start an element opening tag to receive named `data-bascik-slot` suggestions from the nearest containing component.

Inside a `<script>` tag, IntelliSense suggests the mutually exclusive execution directives: `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream`. Once one directive is present, competing directives are suppressed.

Cmd/Ctrl-click custom component tags to open their HTML definitions. Hover over a component to see the contract you need at the call site, including its description, inferred props, named and default slots, source location, and included styles or scripts. Component tag suggestions display the same contract before insertion.

### Filtering Generic Word Suggestions

VS Code by default provides word-based completions harvested from other words in the active document. Because VS Code merges those suggestions independently of language extensions, generic words from neighboring elements may appear alongside Bascik completions. To restrict HTML completions to semantic language and Bascik completions only, add the following to your VS Code settings:

```json
"[html]": {
  "editor.wordBasedSuggestions": "off"
}
```

## Optional Component Descriptions

Component markup is the source of truth for props and slots. The extension infers props from `data-bascik-prop-*`, `data-bascik-attr-*`, `data-bascik-text`, and `data-bascik-html`, and infers named or default slots from `data-bascik-slot`.

Add a leading metadata header to enrich that inferred contract:

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

The header must precede markup, styles, and scripts. It can describe only members inferred from markup, not declare new ones. Descriptions appear in hover and completion details and are rendered as literal text. Duplicate annotations and annotations for undeclared members produce warnings, including while the component has unsaved edits.

## Navigation and Editor Intelligence

Import navigation resolves `./`, `../`, and `@/` paths in build, routes, and server scripts, including script `src` attributes. Dedicated highlighting makes Bascik attributes easy to recognize alongside standard HTML.

## Diagnostics That Understand Bascik

The extension reports high-signal problems in the editor and Problems panel:

- component naming and unclosed custom elements
- conflicting build, routes, server, and stream directives
- misplaced script directives on non-script elements
- undeclared component props and misplaced slot attributes
- leading-slash imports and mixed inline or companion styles
- invalid preserve tokens, external form names, ID references, and prop bindings
- duplicate or undeclared component metadata annotations
- standalone CSS attribute selectors and bare elements in `:is()`, `:where()`, or `:has()`
- runtime ID changes, attribute DOM queries, dynamic class templates, and runtime CSS custom-property names

Server and stream scripts receive additional contract and interpolation-sink checks. JavaScript and TypeScript files under `src/api/` receive HTTP method, return type, handler, and JSON parsing checks. Built-in snippets (`bascik-api`, `bascik-get`, `bascik-post`) scaffold typed route handlers with `Request` and `context` arguments.

## Nested Projects and Custom Configuration

The extension reads `directory.components` and `scripts.importRoot` from `bascik.config.ts`, `bascik.config.js`, or `bascik.config.mjs`. It discovers configs recursively, assigns each file to its closest enclosing Bascik project, and keeps nested projects and separate workspace folders isolated.

Projects without a config use Bascik's defaults: `src/components` for components and `src` for the `@/` import root. Config, component, and HTML changes refresh automatically without restarting VS Code.

## Get Started

1. Open the Extensions view in VS Code.
2. Search for **Bascik**.
3. Install the official extension and open a Bascik project.

Read the [complete VS Code extension guide](https://bascik.dev/tools/vscode-extension) for every navigation feature, diagnostic, limitation, and local development step.

## Contributing and Local Testing

### Running in an Extension Development Host (Recommended)

1. Run `yarn ext:compile` from the repository root (or `npm run compile` in `extensions/vscode-bascik`).
2. Open the `extensions/vscode-bascik` folder in VS Code.
3. Press **F5** (or open the Run and Debug panel and choose **Run Extension**). This opens a clean Extension Development Host window running your local development build.

### Testing Inside Your Main VS Code Window

If you already have the official extension installed from the marketplace (`~/.vscode/extensions/bascik.bascik-vscode-*`) and want to test local edits directly in your primary editor session:

1. Compile the extension from the repo root:

   ```sh
   yarn ext:compile
   ```

2. Copy the compiled `dist/` output into the installed extension's folder:

   ```sh
   cp -r extensions/vscode-bascik/dist/* ~/.vscode/extensions/bascik.bascik-vscode-*/dist/
   ```

3. In VS Code, open the Command Palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux) and run `Developer: Reload Window`.

### Running Tests

From the repository root:

- `yarn ext:unit` runs fast Vitest unit tests for rules and metadata parsing.
- `yarn ext:e2e` runs the VS Code extension-host integration test suite.
