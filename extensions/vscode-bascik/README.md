# Bascik for Visual Studio Code

Build Bascik sites with faster navigation and earlier feedback. The official extension understands component boundaries, project configuration, scoped CSS and JavaScript, server-rendered output, streams, and API routes, so common mistakes surface in the editor instead of during a build or browser test.

## Why Install It?

- **Move through components instantly.** Cmd/Ctrl-click a custom element to open its source, or hover to inspect its props, slots, source path, styles, and scripts.
- **Catch scoping leaks early.** Get focused CSS and JavaScript warnings for patterns Bascik cannot safely rewrite.
- **Protect server-rendered output.** See targeted diagnostics for unsafe interpolation contexts in server and stream scripts.
- **Validate component contracts.** Find unclosed tags, conflicting directives, invalid preserve values, broken ID references, and unsupplied prop bindings as you type.
- **Check API routes before runtime.** Catch unrecognized method exports, incompatible return annotations, missing handlers, and unguarded JSON parsing.
- **Start with zero configuration.** Standard Bascik projects work immediately, while custom paths, nested projects, and multi-root workspaces are detected automatically.

## Navigation and Editor Intelligence

Cmd/Ctrl-click custom component tags to open their HTML definitions. Hover over a component to see the contract you need at the call site, including declared props, named slots, source location, and included styles or scripts.

Import navigation resolves `./`, `../`, and `@/` paths in build, routes, and server scripts, including script `src` attributes. Dedicated highlighting makes Bascik attributes easy to recognize alongside standard HTML.

## Diagnostics That Understand Bascik

The extension reports high-signal problems in the editor and Problems panel:

- component naming and unclosed custom elements
- conflicting build, routes, server, and stream directives
- leading-slash imports and mixed inline or companion styles
- invalid preserve tokens, external form names, ID references, and prop bindings
- standalone CSS attribute selectors and bare elements in `:is()`, `:where()`, or `:has()`
- runtime ID changes, attribute DOM queries, dynamic class templates, and runtime CSS custom-property names

Server and stream scripts receive additional contract and interpolation-sink checks. JavaScript and TypeScript files under `src/api/` receive HTTP method, return type, handler, and JSON parsing checks.

## Nested Projects and Custom Configuration

The extension reads `directory.components` and `scripts.importRoot` from `bascik.config.ts`, `bascik.config.js`, or `bascik.config.mjs`. It discovers configs recursively, assigns each file to its closest enclosing Bascik project, and keeps nested projects and separate workspace folders isolated.

Projects without a config use Bascik's defaults: `src/components` for components and `src` for the `@/` import root. Config, component, and HTML changes refresh automatically without restarting VS Code.

## Get Started

1. Open the Extensions view in VS Code.
2. Search for **Bascik**.
3. Install the official extension and open a Bascik project.

Read the [complete VS Code extension guide](https://bascik.dev/tools/vscode-extension) for every navigation feature, diagnostic, limitation, and local development step.

## Contributing

From the Bascik repository root, use `yarn ext:compile` to compile the extension, `yarn ext:unit` for Vitest unit tests, and `yarn ext:e2e` for extension-host integration tests. Open `extensions/vscode-bascik` in VS Code and press F5 to launch an Extension Development Host.
