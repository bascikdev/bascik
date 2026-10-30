# Developer Experience

This hands-on guide walks through your daily workflow in Bascik: running the local environment, leveraging editor tools, debugging, running tests, and inspecting production builds.

## Local Development Flow

Start the local development server from your project root:

```sh
npm run dev
# or directly: npx bascik
```

### What You See in the Terminal

When you launch the dev server, Bascik transpiles pages and components, starts the HTTP server, and opens a live Server-Sent Events (SSE) connection:

```terminal
transpiled: pages/index.html in 0.5ms
transpiled: pages/about.html in 0.3ms

✓ 2 pages transpiled in 18ms
Server running at http://localhost:8080
```

In an interactive terminal, the `Server running at` line is pinned to the top row the moment the server is up, so the address never scrolls away as logs arrive. Piped output and CI print it as an ordinary line instead. In VS Code's terminal, starting the server also clears the terminal's scrollback, as `clear` does, because its sticky scroll feature would otherwise draw an earlier command over the address. Start with `bascik --no-pin`, or set `BASCIK_PIN_SERVER_URL=0` in your shell profile, to turn pinning off and keep your scrollback. Pinning is a terminal setting, so it is a flag and an environment variable rather than a config key.

To see less, run `bascik --quiet` (or `-q`). It hides the per-page, copy, request, and script lines, so a running dev server prints the summary and `Server running at` at boot, then stays silent while you edit until a warning or an error. See [Logging](/configuration#logging) for exactly what each level hides.

This is a real run on a new project. After the server starts, one page is saved and only that page is rebuilt:

![A terminal running bascik on a new project. The line Server running at localhost:8080 stays pinned to the top row while four pages transpile in under a quarter of a second below it. After one file is saved, only that page is rebuilt, in a few milliseconds](/assets/demos/dev-terminal@2x.webp)

### Daily Edit-and-Save Loop

Edit any file and save. Bascik re-transpiles only the affected files in milliseconds and updates your browser automatically without full page reloads:

```terminal
transpiled: pages/index.html in 0.4ms (modified component: <user-badge>)
```

![An editor above a browser. A heading edited in the editor and saved changes in the browser. A border color edited in a component and saved changes on every card](/assets/demos/live-reload-stacked@2x.webp)

Drop a new component file at `src/components/user-badge/user-badge.html` and use `<user-badge></user-badge>` in your pages immediately without writing import statements or registering tags.

### Recovering from a Broken Page

A syntax error, missing `<body>`, or other page-level transpilation failure does not terminate the dev server. Initial boot still completes, successfully compiled pages remain available, and the failed route returns an error response instead of remaining on the boot screen. Bascik logs the source path, stage, and error message.

In development, Bascik displays a **build-error overlay** in the browser immediately via SSE (`event: build-error`), detailing the file, line number, and error stack trace so you do not have to check your terminal. Fix and save the page normally; the overlay clears automatically and your page refreshes.

![An editor above a browser. A typo in a build script, String changed to Strin, is saved and the browser shows a Bascik Build Error overlay naming the file and the ReferenceError. Restoring the letter and saving dismisses the overlay](/assets/demos/error-overlay@2x.webp)

The live-reload connection also includes comment heartbeats every 20 seconds, ensuring connections through corporate firewalls, VPNs, and proxies do not silently time out.

### Inspecting Dev Output

Dev mode writes each transpiled HTML page to `dist/` after placing it in the in-memory page store. Open files such as `dist/index.html` to inspect the latest compiled markup while the server is running. The disk write is asynchronous, so browser requests receive the updated in-memory page without waiting for file I/O.

### Open-Page Prioritization for Instant Feedback

When you edit a shared component or a global stylesheet used across many pages, Bascik does not make your active browser tab wait for the entire site to recompile. The dev server tracks which pages currently have active live-reload browser tabs connected. It partitions the rebuild queue, transpiles the open page(s) first, stores them in memory, and emits the live-reload signal immediately. Your visible browser window updates in milliseconds while any remaining background pages finish compiling afterwards.

The same order applies when the dev server starts: open pages first, then the home page, then everything else. A tab that connects after compilation has begun, for example one reconnecting after a restart, still moves its page ahead of the pages that have not started. See [Compile Order](/development-server#compile-order).

> **Zero-Refresh Dev Server Reconnection:** If you stop or restart the local development server while working in your code editor, you do not need to click refresh in your browser. As soon as you focus back onto your web page, Bascik's injected live reload client immediately re-establishes the SSE connection and reloads the page automatically.

> **Deep Dive:** Read [CLI Dev Server](/cli#starting-the-dev-server) for server options, or explore [Server Architecture Internals](/internals/server) for live reload mechanics.

## VS Code Editor Ergonomics

Install the official Bascik extension to get component, prop, and slot IntelliSense, component navigation, syntax highlighting, rich hover details, and real-time warnings directly in VS Code:

```sh
# Search for "bascik" in VS Code Extensions (Cmd+Shift+X or Ctrl+Shift+X)
```

### Context-Aware Component IntelliSense

Start an opening tag to see matching project components in IntelliSense. For example, typing `<user-` suggests discovered components such as `user-card` and `user-badge`. A component with a default slot completes as paired opening and closing tags with the cursor placed between them.

![The VS Code suggest widget listing user-card for the partial tag user-ca, with a documentation panel showing the component source file, its props, and its slots](/assets/vscode/complete-component-tags@2x.webp)

Inside a component opening tag, IntelliSense suggests props inferred from that component's markup and omits props already supplied. Inside its body, element attributes receive named-slot suggestions from the nearest containing component:

```html
<user-card data-bascik-prop-role="Lead Engineer">
  <span data-bascik-slot="name">Sarah Chen</span>
</user-card>
```

![The suggest widget listing data-bascik-prop-status and data-bascik-prop-tone after typing data-bascik-prop inside a user-badge tag](/assets/vscode/complete-props@2x.webp)

Component authors can add a leading `@bascik` comment to describe the component and its inferred props and slots. Those descriptions appear in tag, prop, and slot suggestions and in hover details. Markup remains the source of truth, and editor warnings identify duplicate annotations or names that the component does not declare.

Suggestions follow the closest owning Bascik config, including custom component roots, nested projects, and multi-root workspaces.

### Component Navigation and Hover Details

Hover over any custom component tag in your page HTML, hold `Cmd` (macOS) or `Ctrl` (Windows/Linux), and click to jump straight to the component definition file:

```html
<!-- Hold Cmd/Ctrl and click <user-card> to open src/components/user-card/user-card.html -->
<user-card data-bascik-prop-role="Lead Engineer">
  <span data-bascik-slot="name">Sarah Chen</span>
</user-card>
```

Hover without clicking to inspect the component description, source path, inferred props, named and default slots, member descriptions, and included styles or scripts.

![A hover card for the user-card tag showing its description, source path, the role prop, and the actions and default slots](/assets/vscode/hover-component@2x.webp)

The same gesture works for relative imports, the `@/` import-root alias, and `src="..."` attributes inside build and server scripts:

```html
<!-- Hold Cmd/Ctrl and click the path to open src/lib/canonical.ts -->
<script data-bascik-build>
  import { canonical } from "@/lib/canonical.ts";
  export default async () => await canonical();
</script>

<script data-bascik-server src="./scripts/greet.ts"></script>
```

A `.ts` `src=`, or an inline block marked `type="text/typescript"`, is TypeScript: Bascik strips its types before it runs and errors name the source's lines (see [Build Scripts](/build-scripts#typescript)). Alias imports resolve against `scripts.importRoot` (default `src`). The extension reads that key from the closest owning Bascik config, so nested projects keep their navigation and diagnostics isolated.

### Structural & Scoping Warnings in the Problems Panel

The extension catches invalid tags or unsafe scoping patterns in real time as you type:

![An editor with warnings and errors: an undeclared prop on user-card with its hover message, an unknown slot name, and a script with two conflicting directives](/assets/vscode/diagnostics@2x.webp)

Unsafe CSS is flagged the same way:

```css
/* Flagged in VS Code Problems panel: [id] selectors cannot be scoped safely */
[id] {
  color: red;
}
```

> **Deep Dive:** See setup details and the complete capability guide in [VS Code Extension](/tools/vscode-extension).

## Component Authoring Pleasantries

Authoring UI in Bascik keeps your file structure clean and eliminates framework boilerplate.

### Co-located Component Directory

Everything related to a UI component lives together in a dedicated folder:

```text
src/components/user-card/
  user-card.html      ← HTML markup, scoped <style>, and client <script>
  user-card.test.ts    ← Co-located Vitest unit test
```

### Clean Component Authoring (`src/components/user-card/user-card.html`)

Write standard HTML, plain CSS, and standard JavaScript in one file:

```html
<article class="card">
  <h3 class="name"><slot name="name">Guest User</slot></h3>
  <p class="role" data-bascik-prop-role></p>
</article>

<style>
  .card {
    padding: 16px;
    border: 1px solid #3a3d40;
    border-radius: 8px;
  }
  .name {
    margin: 0 0 8px 0;
    font-size: 1.1rem;
  }
  .role {
    margin: 0;
    color: #a0a0a0;
    font-size: 0.875rem;
  }
</style>
```

### Zero-Import Page Usage (`src/pages/index.html`)

Use custom tags anywhere in your pages without `import` statements or component registration steps:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Team Directory</title>
  </head>
  <body>
    <!-- Bascik auto-discovers <user-card> from src/components/user-card/user-card.html -->
    <user-card data-bascik-prop-role="Lead Engineer">
      <span data-bascik-slot="name">Sarah Chen</span>
    </user-card>
  </body>
</html>
```

> **Deep Dive:** Read [Components](/components) for folder conventions, [Props](/props) for data passing, [Slots](/slots) for content insertion, and [Scoped Styles](/scoped-styles) for CSS scoping.

## Debugging Workflow

Because Bascik resolves components ahead of time, the HTML and CSS that run in the browser match your source files directly.

### Source vs DevTools Inspection

Compare source template code with what appears when inspecting elements in browser DevTools:

**Your Source Code (`src/pages/index.html`):**

```html
<user-card data-bascik-prop-role="Lead Engineer">
  <span data-bascik-slot="name">Sarah Chen</span>
</user-card>
```

**Inspected Element in Browser DevTools (`Cmd+Option+I`):**

```html
<article class="bascik__user-card__card">
  <h3 class="bascik__user-card__name">
    <span>Sarah Chen</span>
  </h3>
  <p class="bascik__user-card__role">Lead Engineer</p>
</article>
```

Notice the clean output: no synthetic wrapper `<div>` elements, no framework runtime attributes, and clear class prefixes (`.bascik__user-card__card`) that tell you exactly which component file owns each style rule.

### Client Script Breakpoints

Open the DevTools **Sources** tab to set breakpoints in component scripts. Because Bascik outputs standard JavaScript, browser breakpoints pause directly on your actual source line numbers without virtual DOM stack traces:

```html
<!-- Inside src/components/counter/counter.html -->
<script>
  document.getElementById("counter-btn").addEventListener("click", (e) => {
    // Set a breakpoint directly on this line in browser DevTools
    const count = parseInt(e.target.dataset.count || "0", 10) + 1;
    e.target.dataset.count = String(count);
  });
</script>
```

### Stack Remapping and Click-to-Line Diagnostics

When a build-time script or server script throws an exception, Bascik filters out internal Node.js runtime noise and remaps stack trace lines back to your original source HTML template and line offsets.

Because the terminal prints clean `filename:line:column` references, you can hold `Cmd` (macOS) or `Ctrl` (Windows/Linux) and click directly on the error line in your terminal output to jump straight to the exact line in your source template:

```terminal
[bascik] build script error in "src/pages/cli.html" at (line 6, column 3):
Error [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist' imported from src/pages/cli.html:6:4
```

### VS Code Debugging (`F5`)

To debug `bascik.config.ts` or custom build scripts, press `F5` in VS Code. Node's native TypeScript support (22.22 or newer) allows VS Code to attach directly to `.ts` files:

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Bascik Build",
      "program": "${workspaceFolder}/node_modules/.bin/bascik",
      "args": ["--build"]
    }
  ]
}
```

## Source Maps and Location Attribution

Bascik eliminates the overhead and synchronization issues of traditional multi-megabyte `.map` files by combining zero-overhead `//# sourceURL` directives, 1:1 line offset preservation, and build-time stack trace remapping.

### Zero-Overhead Browser Source Mapping (`//# sourceURL`)

During component compilation, Bascik automatically appends a `//# sourceURL` comment to every client `<script>` block and pads the script with blank lines, one for each line above it in the component file. For a component whose `<script>` tag is on line 3:

```html
<!-- Compiled output injected into page HTML -->
<script>
  (function () {
    document
      .getElementById("bascik__counter__a1b2__btn")
      .addEventListener("click", () => {
        console.log("Button clicked");
      });
  })();
  //# sourceURL=src/components/counter/counter.html
</script>
```

When inspecting your application in Chrome DevTools, Firefox Developer Tools, Safari Web Inspector, or Microsoft Edge DevTools:

- **Virtual File Tree:** Component scripts appear under their actual project paths (such as `src/components/counter/counter.html`) in the **Sources** or **Debugger** tab. Each instance on a page is its own file: the second is `counter.html?instance=2`.
- **Accurate Breakpoints:** Clicking a line number in DevTools pauses that instance directly on the original source line. A `debugger;` statement pauses every instance.

Line numbers match while JavaScript is not minified, which is the default for the dev server. `bascik --build` minifies JavaScript by default.

- **Console Log and Error Mapping:** Messages from `console.log()` and uncaught runtime errors reference the component file and line number rather than a compiled monolithic page.

### Build and Server Script Stack Trace Remapping

Node.js runs each `<script data-bascik-build>`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` block as a module of its own. When one throws:

1. **Source Lines and Columns:** The stack names the file the script was written in and the failing line and column in that file (for example, `src/pages/dashboard.html:34:11`), including in a component, whose markup and `<style>` blocks above the script are moved out before it runs.
2. **Syntax Errors:** In a build or routes script, a syntax error shows the file, the failing line, and a caret under the token. In a server or stream script, Node reports no line for a syntax error, so Bascik names the file and the line the script starts on.
3. **Printed Once:** Each error is printed once, with only your own frames: Node.js internals, Bascik's script runner, and Bascik's request handling are removed. A build or routes error's header names the file and the script tag's line and column; a server or stream error's header names the request path.
4. **Clickable Terminal Links:** The `file:line:column` locations can be `Cmd + Click`ed (macOS) or `Ctrl + Click`ed (Windows/Linux) in VS Code to jump straight to the failing line.

### TypeScript and Custom Minifier Source Maps

- **Native TypeScript Support:** Node 24 and Node 22.22+ strip TypeScript types without an intermediate compilation step, preserving source line numbers in imported `.ts` modules.
- **External Source Maps (`sourceMap: true`):** Set `"sourceMap": true` in `tsconfig.json` so external tools, debuggers, and language servers generate and resolve `.map` files across external libraries and helper scripts.
- **BYOMinifier Integration:** When using custom minifiers via `minify.js` or `minify.css` in `bascik.config.ts` (such as Terser, esbuild, or LightningCSS), you can configure inline or external source maps according to your production requirements.

> **Deep Dive:** Read [Debugging with VS Code and Node.js](/testing/debugging) for step-debugging launch configurations, [CLI Transpilation and Build Errors](/cli#transpilation-and-build-errors) to learn how Bascik reports syntax issues, or explore [Architecture](/internals/architecture) to see how transpilation works under the hood.

## Testing Your Workflow

Every scaffolded Bascik project includes co-located unit tests, Playwright end-to-end tests, and static checks.

### Co-located Unit Testing (`src/components/user-card/user-card.test.ts`)

Test component template contracts right next to the component HTML file:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("user-card contract", () => {
  const filePath = join(
    process.cwd(),
    "src/components/user-card/user-card.html",
  );

  it("defines slot and prop placeholders correctly", async () => {
    const html = await readFile(filePath, "utf8");
    expect(html).toContain('<slot name="name">');
    expect(html).toContain("data-bascik-prop-role");
  });
});
```

Run unit tests during development:

```sh
npm run test:watch
```

### End-to-End Testing (`e2e/app.spec.ts`)

Test user interactions in real browsers using Playwright:

```ts
import { test, expect } from "@playwright/test";

test("renders user card with expanded slot content", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".bascik__user-card__card")).toBeVisible();
  await expect(page.locator(".bascik__user-card__role")).toHaveText(
    "Lead Engineer",
  );
});
```

Run Playwright browser tests:

```sh
npm run e2e
```

### Static Analysis

Validate custom tag references and page structure across your workspace before opening a pull request:

```sh
npx bascik --check
```

Output:

```terminal
✓ Checked 4 pages and 12 components in 14ms (0 errors, 0 warnings)
```

Scaffolded projects also include `npm run lint`, which is `bascik --check`. It runs the same `@bascik/language-server` checks as the editor extension, plus the project-wide checks, from the terminal. Each finding names the file, line, column, and rule:

![A terminal running npm run lint. It reports two warnings, an undeclared prop on site-header and an unclosed feat-card tag, and two errors, a data-bascik-build attribute on a div and a script with two conflicting directives. It ends with 2 errors, 2 warnings](/assets/demos/lint@2x.webp)

> **Deep Dive:** Read [Component Template Contract Testing](/testing/component-testing) and [End-to-End Browser Testing](/testing/e2e-testing) for complete testing guidelines.

## Production Build & Inspection

Preview and inspect static production assets before deploying.

### Running the Production Build

```sh
npm run build
# or: npx bascik --build
```

Terminal Output:

```terminal
transpiled: pages/index.html -> dist/index.html
transpiled: pages/about.html -> dist/about.html
extracted: dist/css/styles.css (minified)

✓ Build completed in 34ms
```

### Inspecting Output Files (`dist/index.html`)

Open `dist/index.html` to see the compiled result. Custom component tags are fully expanded, and component CSS is extracted into minified stylesheets:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Team Directory</title>
    <link rel="stylesheet" href="/css/styles.css" />
  </head>
  <body>
    <article class="bascik__user-card__card">
      <h3 class="bascik__user-card__name"><span>Sarah Chen</span></h3>
      <p class="bascik__user-card__role">Lead Engineer</p>
    </article>
  </body>
</html>
```

### Local Production Preview

Serve the compiled `dist/` directory locally over HTTP:

```sh
npx bascik --server
```

Terminal Output:

```terminal
Serving dist/ at http://localhost:8080
```

> **Deep Dive:** Read [Deployment Overview](/deployment) for deployment targets and [Production Server](/production-server) for server options.
