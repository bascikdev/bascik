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

### Daily Edit-and-Save Loop

Edit any file and save. Bascik re-transpiles only the affected files in milliseconds and updates your browser automatically without full page reloads:

```terminal
transpiled: pages/index.html in 0.4ms (modified component: <user-badge>)
```

Drop a new component file at `src/components/user-badge/user-badge.html` and use `<user-badge></user-badge>` in your pages immediately without writing import statements or registering tags.

### Recovering from a Broken Page

A syntax error, missing `<body>`, or other page-level transpilation failure does not terminate the dev server. Initial boot still completes, successfully compiled pages remain available, and the failed route returns an error response instead of remaining on the boot screen. Bascik logs the source path, stage, and error message.

In development, Bascik displays a **build-error overlay** in the browser immediately via SSE (`event: build-error`), detailing the file, line number, and error stack trace so you do not have to check your terminal. Fix and save the page normally; the overlay clears automatically and your page refreshes.

The live-reload connection also includes comment heartbeats every 20 seconds, ensuring connections through corporate firewalls, VPNs, and proxies do not silently time out.

### Inspecting Dev Output

Dev mode writes each transpiled HTML page to `dist/` after placing it in the in-memory page store. Open files such as `dist/index.html` to inspect the latest compiled markup while the server is running. The disk write is asynchronous, so browser requests receive the updated in-memory page without waiting for file I/O.

### Open-Page Prioritization for Instant Feedback

When you edit a shared component or a global stylesheet used across many pages, Bascik does not make your active browser tab wait for the entire site to recompile. The dev server tracks which pages currently have active live-reload browser tabs connected. It partitions the rebuild queue, transpiles the open page(s) first, stores them in memory, and emits the live-reload signal immediately. Your visible browser window updates in milliseconds while any remaining background pages finish compiling afterwards.

> **Zero-Refresh Dev Server Reconnection:** If you stop or restart the local development server while working in your code editor, you do not need to click refresh in your browser. As soon as you focus back onto your web page, Bascik's injected live reload client immediately re-establishes the SSE connection and reloads the page automatically.

> **Deep Dive:** Read [CLI Dev Server](/cli#starting-the-dev-server) for server options, or explore [Server Architecture Internals](/internals/server) for live reload mechanics.

## VS Code Editor Ergonomics

Install the official Bascik extension to get code navigation, autocompletion, and real-time warnings directly in VS Code:

```sh
# Search for "bascik" in VS Code Extensions (Cmd+Shift+X or Ctrl+Shift+X)
```

### Cmd/Ctrl + Click Code Navigation

Hover over any custom component tag in your page HTML, hold `Cmd` (macOS) or `Ctrl` (Windows/Linux), and click to jump straight to the component definition file:

```html
<!-- Hold Cmd/Ctrl and click <user-card> to open src/components/user-card/user-card.html -->
<user-card data-bascik-prop-role="Lead Engineer">
  <span slot="name">Sarah Chen</span>
</user-card>
```

The same gesture works for relative imports, `@/` and `/` import-root aliases, and `src="..."` attributes inside build and server scripts:

```html
<!-- Hold Cmd/Ctrl and click the path to open src/lib/canonical.ts -->
<script data-bascik-build>
  import { canonical } from '@/lib/canonical.ts';
  console.log(await canonical());
</script>

<script data-bascik-server src="./scripts/greet.ts"></script>
```

Alias imports resolve against `scripts.importRoot` (default `src`). The extension reads that key from `bascik.config.ts` with a best-effort text match, so it follows a custom import root without executing your config.

### Structural & Scoping Warnings in the Problems Panel

The extension catches invalid tags or unsafe scoping patterns in real time as you type:

```css
/* Flagged in VS Code Problems panel: [id] selectors cannot be scoped safely */
[id] {
  color: red;
}
```

> **Deep Dive:** See setup details and feature guides in [Code Navigation](/tools/vscode-extension#1-code-navigation) and [Structural Warnings](/tools/vscode-extension#2-markup-and-script-structural-warnings).

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
  .card { padding: 16px; border: 1px solid #3a3d40; border-radius: 8px; }
  .name { margin: 0 0 8px 0; font-size: 1.1rem; }
  .role { margin: 0; color: #a0a0a0; font-size: 0.875rem; }
</style>
```

### Zero-Import Page Usage (`src/pages/index.html`)

Use custom tags anywhere in your pages without `import` statements or component registration steps:

```html
<!DOCTYPE html>
<html lang="en">
<head><title>Team Directory</title></head>
<body>
  <!-- Bascik auto-discovers <user-card> from src/components/user-card/user-card.html -->
  <user-card data-bascik-prop-role="Lead Engineer">
    <span slot="name">Sarah Chen</span>
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
  <span slot="name">Sarah Chen</span>
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
  document.querySelector('.counter-btn').addEventListener('click', (e) => {
    // Set a breakpoint directly on this line in browser DevTools
    const count = parseInt(e.target.dataset.count || '0', 10) + 1;
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

To debug `bascik.config.ts` or custom build scripts, press `F5` in VS Code. Node 24 native TypeScript support allows VS Code to attach directly to `.ts` files:

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

During component compilation, Bascik automatically appends a `//# sourceURL` comment to every client `<script>` block and inserts newline padding to preserve exact line offsets:

```html
<!-- Compiled output injected into page HTML -->
<script>
(function() {


  document.getElementById("bascik__counter__a1b2__btn").addEventListener("click", () => {
    console.log("Button clicked");
  });
})();
//# sourceURL=src/components/counter/counter.html
</script>
```

When inspecting your application in Chrome DevTools, Firefox Developer Tools, Safari Web Inspector, or Microsoft Edge DevTools:

- **Virtual File Tree:** Component scripts appear under their actual project paths (such as `src/components/counter/counter.html`) in the **Sources** or **Debugger** tab.
- **Accurate Breakpoints:** Clicking a line number in DevTools or adding a `debugger;` statement pauses execution directly on the original source line.
- **Console Log and Error Mapping:** Messages from `console.log()` and uncaught runtime errors reference the component file and line number rather than a compiled monolithic page.

### Build and Server Script Stack Trace Remapping

Node.js executes `<script data-bascik-build>` and `<script data-bascik-server>` blocks in ephemeral temporary modules. When a script throws an unhandled exception or encounters an error:

1. **Stack Trace Interception:** Bascik's `cleanStackTrace` engine intercepts the raw error emitted by Node.js.
2. **File and Line Remapping:** Temporary file paths and line offsets are converted back to the original source HTML file and line position (for example, `src/pages/dashboard.html:34`).
3. **Noise Reduction:** Internal Node.js runtime frames (`node:internal/*`, `node:diagnostics_channel`, and execution wrappers) are filtered out.
4. **Clickable Terminal Links:** Terminal error messages display standard `file:line:column` coordinates that you can `Cmd + Click` (macOS) or `Ctrl + Click` (Windows/Linux) in VS Code to jump straight to the failing line.

### TypeScript and Custom Minifier Source Maps

- **Native TypeScript Support:** Node 24 and Node 22.18+ strip TypeScript types without an intermediate compilation step, preserving source line numbers in imported `.ts` modules.
- **External Source Maps (`sourceMap: true`):** Set `"sourceMap": true` in `tsconfig.json` so external tools, debuggers, and language servers generate and resolve `.map` files across external libraries and helper scripts.
- **BYOMinifier Integration:** When using custom minifiers via `minify.js` or `minify.css` in `bascik.config.ts` (such as Terser, esbuild, or LightningCSS), you can configure inline or external source maps according to your production requirements.

> **Deep Dive:** Read [Debugging with VS Code and Node.js](/testing/debugging) for step-debugging launch configurations, [CLI Transpilation and Build Errors](/cli#transpilation-and-build-errors) to learn how Bascik reports syntax issues, or explore [Architecture](/internals/architecture) to see how transpilation works under the hood.

## Testing Your Workflow

Every scaffolded Bascik project includes co-located unit tests, Playwright end-to-end tests, and static checks.

### Co-located Unit Testing (`src/components/user-card/user-card.test.ts`)

Test component template contracts right next to the component HTML file:

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('user-card contract', () => {
  const filePath = join(process.cwd(), 'src/components/user-card/user-card.html');

  it('defines slot and prop placeholders correctly', async () => {
    const html = await readFile(filePath, 'utf8');
    expect(html).toContain('<slot name="name">');
    expect(html).toContain('data-bascik-prop-role');
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
import { test, expect } from '@playwright/test';

test('renders user card with expanded slot content', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.bascik__user-card__card')).toBeVisible();
  await expect(page.locator('.bascik__user-card__role')).toHaveText('Lead Engineer');
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
  <link rel="stylesheet" href="/css/styles.css">
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

> **Deep Dive:** Read [Deploying](/deploying) for deployment targets and [Production Server](/server) for server options.
