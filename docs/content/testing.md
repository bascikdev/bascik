# Testing

Bascik supports automated testing across every layer of an application, including component markup contracts, compiled build outputs, server scripts, and browser component logic.

Node 22.18.0+ natively executes TypeScript files without a separate compilation step. Test runners and build scripts import `.ts` modules directly.

## Testing Architecture

Testing a Bascik application is structured into three main tiers:

1. **Component Contract and Build Output Testing**: Validates rendered HTML markup, CSS rules, prop substitution, slot replacement, and accessibility attributes in compiled pages or component templates.
2. **TypeScript Logic Testing**: Validates pure, exported functions from server scripts (`<script data-bascik-server>`) and browser component logic modules.
3. **End-to-End Browser Testing**: Validates full browser workflows, user interactions, form submissions, and routing in real browser engines using Playwright.

### Pre-Configured Testing with `create-bascik`

If your project was scaffolded using the `npm create bascik` (or `yarn create bascik`) template, the entire testing stack is already pre-configured with Vitest, Playwright, and V8 code coverage. You do not need to install additional packages or manually write config files.

You can run your tests immediately using the following commands:

```sh
# Run all unit and component contract tests
npm test

# Run unit tests with a coverage summary and HTML reports
npm run test:coverage

# Run end-to-end browser tests
npm run e2e
```

> **Debugging with VS Code.** Scaffolded projects also include pre-configured `.vscode/launch.json` debug profiles to step through unit tests, server scripts, and browser component logic. See [Debugging with VS Code and Node.js](#debugging-with-vs-code-and-nodejs).

If you are adding testing manually to an existing or custom project structure, refer to the [Manual Test Runner Setup](#manual-test-runner-setup) section at the bottom of this page.

## Testing Compiled Build Output

Testing compiled pages in `dist/` validates the entire Bascik compilation pipeline for your site, including component expansion, prop substitution, slot filling, and minification.

### Example build output test

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Compiled index page', () => {
  const distPath = join(process.cwd(), 'dist/index.html');

  it('expands component tags and substitutes props cleanly', async () => {
    const html = await readFile(distPath, 'utf8');

    // Verify component tags expanded completely
    expect(html).not.toContain('<site-header');
    expect(html).not.toContain('<feat-card');

    // Verify prop substitution succeeded without leaving raw prop markers
    expect(html).not.toContain('data-bascik-prop-brand');

    // Verify slot content was injected into component output
    expect(html).toContain('Zero runtime');

    // Verify no unhandled slot attributes remain
    expect(html).not.toContain('data-bascik-slot');
  });
});
```

## Component Template Contract Testing

When testing individual `.html` component templates before transpilation, test the component's structural contracts, accessibility standards, and script discipline.

### Template Directory Structure

```text
src/components/component-demo/
  component-demo.html         ← component HTML and CSS
  component-demo.test.ts      ← component contract unit tests
```

### Example component contract test

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('component-demo component contract', () => {
  const path = join(process.cwd(), 'src/components/component-demo/component-demo.html');

  it('uses CSS :has() for tab state and ships zero client-side JavaScript', async () => {
    const html = await readFile(path, 'utf8');

    // Verify accessibility and structural contracts
    expect(html).toContain('type="radio"');
    expect(html).toContain('value="preview"');
    expect(html).toContain(':has(');

    // Verify no runtime client script tag is included
    const clientScriptRegex = /<script(?![^>]*data-bascik-build)[^>]*>[\s\S]*?<\/script>/gi;
    expect(clientScriptRegex.test(html)).toBe(false);
  });
});
```

## Server Script Testing

Server scripts (`<script data-bascik-server>`) execute in Node.js on every request. Non-trivial request logic should be extracted into standalone TypeScript modules for isolated unit testing.

### Component file layout

```text
src/components/my-widget/
  my-widget.html          ← component HTML template
  widget-logic.ts         ← pure functions (TypeScript), exported
  widget-logic.test.ts    ← unit tests (TypeScript)
```

### Server script usage

```html
<script data-bascik-server>
  import { myPureFunction } from './widget-logic.js';
  // Execute myPureFunction within the request handler
</script>
```

> **ESM Import Convention.** Standard ES module resolution under Node 24+ allows importing local TypeScript files using either runtime `.js` specifiers or `.ts` specifiers during testing.

### Unit test implementation

```ts
import { describe, it, expect } from 'vitest';
import { myPureFunction } from './widget-logic.ts';

describe('myPureFunction', () => {
  it('returns the expected value', () => {
    expect(myPureFunction('input')).toBe('expected output');
  });
});
```

## Browser Component Script Testing

Browser component scripts run in an IIFE scope and cannot be directly imported as standard ES modules. Testing browser script logic requires separating pure functions from DOM event wiring.

### Browser Script Directory Structure

```text
src/components/my-widget/
  my-widget.html         ← HTML template and build script
  widget-logic.ts        ← pure functions (TypeScript), exported
  widget-logic-dom.js    ← DOM event listeners and wiring
  widget-logic.test.ts   ← unit tests (TypeScript)
```

### Build script integration

A build script (`<script data-bascik-build>`) in the component template combines the logic and DOM modules into a single IIFE block at build time:

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { join } from 'node:path';
  const base = join(process.cwd(), 'src/components/my-widget');
  const logic = await readFile(join(base, 'widget-logic.ts'), 'utf8');
  const dom   = await readFile(join(base, 'widget-logic-dom.js'), 'utf8');
  const fns = logic
    .replace(/:\s*(?:string|number|boolean|any)/g, '')
    .replace(/^export function /gm, 'function ')
    .replace(/^export const /gm, 'var ');
  console.log('<script>\n(function () {\n' + fns.trim() + '\n\n' + dom.trim() + '\n})();\n</scr' + 'ipt>');
</script>
```

Bascik executes the build script during compilation and replaces the tag with the resulting `<script>` IIFE output.

> **Single Source of Truth.** The `widget-logic.ts` file remains the single source of truth for both unit tests and production browser output.

## End-to-End Browser Testing (Playwright)

End-to-end (E2E) testing with Playwright is the primary way to verify that Bascik components functionally work in real browser engines (Chromium, Firefox, WebKit).

Because Bascik compiles vanilla HTML, CSS, and JavaScript with zero framework runtime overhead, E2E tests validate real-world behavior that unit tests cannot catch:

- **Browser DOM Event Handling**: Clicking buttons, opening modals, toggling details panels, and keypress shortcuts (such as `Cmd+K` or `Escape`).
- **CSS Engine Evaluation**: Real layout rendering, `:has()` pseudo-class state selection, CSS variable scoping, and responsive media queries.
- **Client State Mechanics**: Independent component instances holding isolated state (such as multiple counters or tabs on one page).
- **Navigation and Server Routes**: Real page transitions, hash anchor navigation, and 404 fallback routing.

### Installation

```sh
npm install -D @playwright/test
```

### Configuration (`e2e/playwright.config.ts`)

Configure Playwright to build and serve the compiled Bascik site automatically on a test port before running specs:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    command: 'npx bascik --build && npx bascik --serve',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
  },
});
```

### Robust Locators and Identifier Minification

In production builds (`bascik --build`), Bascik compiles and minifies element IDs and class names (enabled by `minify.identifiers: true`) to optimize bundle sizes. Consequently, relying on raw CSS selectors like `page.locator('.my-class')` or `page.locator('#my-id')` will fail in production because those identifiers are hashed and compressed.

To make your end-to-end tests resilient across both development and production environments, use standard `data-testid` attributes (e.g. `data-testid="search-input"`) on interactive elements and retrieve them using Playwright's native `page.getByTestId(...)` locator.

### Spec implementation (`e2e/docs-components.spec.ts`)

```ts
import { test, expect } from '@playwright/test';

test.describe('Docs Component Functional E2E Tests', () => {
  test('comp-toggle expands and collapses detail panel', async ({ page }) => {
    await page.goto('/scoped-javascript');

    const toggleBtn = page.getByRole('button', { name: /Read more|Show less/ }).first();
    const detailPanel = page.getByTestId('toggle-detail').first();

    await expect(detailPanel).toBeHidden();
    await expect(toggleBtn).toHaveText('Read more');

    // Click toggle button to expand
    await toggleBtn.click();
    await expect(detailPanel).toBeVisible();
    await expect(toggleBtn).toHaveText('Show less');
  });

  test('docs-search opens modal, filters results on input, and closes on Escape', async ({ page }) => {
    await page.goto('/');

    const searchBtn = page.getByRole('button', { name: 'Search docs' }).first();
    const modal = page.getByTestId('search-overlay').first();
    const input = page.getByPlaceholder('Search docs…');

    await searchBtn.click();
    await expect(modal).toBeVisible();

    await input.fill('scoped styles');
    await expect(page.locator('.search-results li').first()).toContainText('Scoped Styles');

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  });
});
```

## Web Standards and HTML Linting (Webhint)

Automated web standards checks and HTML linting catch accessibility flaws, invalid markup, and browser compatibility issues in component templates before building.

If you use the **[Webhint VS Code Extension](https://marketplace.visualstudio.com/items?itemName=webhint.vscode-webhint)** (`webhint.vscode-webhint`) or the `hint` CLI (`npx hint`), add a `.hintrc` configuration file to your project root. Because Bascik components are standalone HTML template partials that expand into full page shells at build time, individual component files do not contain top-level `<meta name="viewport">` or `<link rel="apple-touch-icon">` tags.

### Recommended `.hintrc` configuration

```json
{
  "extends": [
    "development"
  ],
  "hints": {
    "apple-touch-icons": "off",
    "compat-api/css": [
      "default",
      {
        "ignore": [
          "scrollbar-width"
        ]
      }
    ],
    "meta-viewport": "off"
  }
}
```

### Configuration rationale

- **`apple-touch-icons: off`**: Component templates are partials rendered inside full page shells. Apple touch icons belong on the top-level HTML document head, not in individual component markup.
- **`meta-viewport: off`**: Viewport metadata tags are declared once in the page layout head, so checking for them inside component `.html` files produces false positives.
- **`compat-api/css`**: Ignores specific modern CSS property compatibility checks (like `scrollbar-width`) where progressive enhancement and fallback behavior are intentional.

## Testing Boundaries and Guidance

Choosing between unit tests and E2E browser tests depends on what you need to verify:

| Testing Tier | Tool | Focus & Purpose | Execution Speed |
| --- | --- | --- | --- |
| **E2E Browser Tests** | Playwright | **Primary test for functionality.** Validates DOM events, user clicks, visual state transitions, CSS `:has()` rules, and multi-page workflows in real browser engines. | Seconds (runs against built server) |
| **Lighthouse CLI Audits** | Lighthouse / LHCI | **Automated quality gate.** Audits performance, accessibility, best practices, and SEO scores locally across routes. | Seconds (runs against built server) |
| **Component Contract Unit Tests** | Vitest | **Fast structural guardrails.** Validates HTML markup contracts, ARIA accessibility attributes, slot/prop placeholders, and ensures zero runtime JavaScript is shipped when CSS handles state transitions. | Sub-second (~100ms) |
| **Pure Logic Unit Tests** | Vitest | **Fast business logic checks.** Validates scoring, tokenization, search indexing, data transformations, and server script helper functions. | Sub-second (~10ms) |

### When to Use Each

- **Use Playwright E2E tests** when you need to verify that clicking a button opens a modal, toggling a panel changes text, incrementing a counter updates the screen, or navigating links loads the correct page.
- **Use Lighthouse CLI audits** (`yarn docs:lighthouse`) to catch accessibility, performance, best practices, and SEO regressions locally before pushing changes.
- **Use Vitest unit tests** for instant local feedback when refactoring HTML templates, preventing accidental removal of accessibility attributes (`aria-expanded`, `aria-label`), ensuring pure CSS components stay script-free, or testing pure JavaScript/TypeScript calculation functions.

## Debugging with VS Code and Node.js

Bascik works smoothly with debuggers because it operates directly on vanilla HTML, CSS, and JavaScript without complex runtime abstractions or heavy bundle transformations.

### Source Location Preservation

Debugging server-side scripts, build-time scripts, and browser component code in Bascik requires no special source map plugins or transpilation step:

- **Server and Build Scripts**: Bascik automatically appends `//# sourceURL=${relPath}` comments to temporary script modules created during compilation (`<script data-bascik-build>` and `<script data-bascik-server>`). Stack traces and debugger breakpoints point directly back to your original source file paths.
- **Client Component Scripts**: Bascik preserves newline padding when scoping component `<script>` tags. Line numbers reported in console errors or hit during step-debugging match the exact line numbers in your component `.html` source files.
- **Native TypeScript Debugging**: Because Node 22.18.0+ natively executes TypeScript files by stripping type annotations, setting breakpoints in `.ts` modules pauses execution immediately with full access to local scope variables and call stacks.

### Pre-Configured VS Code Launch Configurations

Projects created using `npm create bascik@latest` include a pre-configured `.vscode/launch.json` file focused on testing and debugging your application. You can start debugging immediately by pressing `F5` or selecting a profile from VS Code's **Run and Debug** panel:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Dev Server",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["bascik"],
      "console": "integratedTerminal",
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug Unit Tests",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["vitest", "run"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Launch Chrome",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:8080",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
```

### Debugging Server Scripts and Build Steps

To debug server scripts (`<script data-bascik-server>`), build-time scripts (`<script data-bascik-build>`), or custom server logic modules:

1. Open your component `.html` file or imported `.ts` logic file in VS Code.
2. Click to the left of any line number inside your script block or function to set a breakpoint.
3. Select **Debug Dev Server** in the Run and Debug panel and press `F5`.
4. Open your browser and navigate to the page triggering the request.
5. Node.js pauses execution on your breakpoint inside VS Code. You can inspect variables, evaluate expressions in the Debug Console, step through functions, and view call stacks.

### Debugging Unit Tests in VS Code

To step through unit test logic or component contract assertions in VS Code:

1. Open your test file (such as `my-counter.test.ts`) and set a breakpoint inside an `it()` or `describe()` block.
2. Select **Debug Unit Tests** from the Run and Debug panel and press `F5`.
3. Vitest runs the test suite under the Node.js debugger and pauses at your breakpoint before assertions complete.

### Debugging Client Component Scripts in the Browser

To debug interactive client component scripts in Google Chrome or Microsoft Edge directly from VS Code:

1. Start the dev server using **Debug Dev Server** or `npm run dev`.
2. Select **Launch Chrome** from the Run and Debug panel and press `F5`.
3. VS Code launches a new Chrome window attached to the debugger.
4. Set breakpoints directly in your component `.html` files in VS Code, or open Chrome DevTools (`F12`), press `Cmd + P` (or `Ctrl + P`), and open virtual source files like `src/components/my-counter.html`.

## High-Value Component Testing vs Contrived Tests

When writing component tests, focus on verifying actual component behavior, accessibility contracts, and compiled outputs rather than writing low-value assertions.

### What to Avoid: Trivial Source Matching

Reading a raw component `.html` template file with `readFile` simply to assert that a string like `class="my-card"` exists in the source text is a low-value test. It only verifies that static text exists in a file on disk. It does not verify that Bascik compiles the component, that props or slots resolve properly, or that embedded scripts behave correctly.

### What to Test Instead

High-value component tests verify specific failure modes and structural contracts:

- **Compiled Output Validation**: Inspect the compiled `dist/` pages after building to verify that custom component tags expanded completely, props substituted correctly, slots received their content, and no raw `data-bascik-prop-*` or `data-bascik-slot` attributes remain in the final HTML.
- **Accessibility and Markup Contracts**: Assert that interactive controls have explicit `type="button"` attributes, mandatory `aria-expanded` or `aria-label` attributes, and proper semantic HTML tags.
- **Instance Safety and Scope Isolation**: Ensure component scripts use instance-safe DOM lookup patterns (such as `getElementById` or scoped queries) and do not leak variables into the global scope.
- **Script Efficiency**: Verify that pure CSS components (such as radio-based tabs or `:has()` toggles) do not ship unnecessary runtime client `<script>` tags.

## Reference Implementations

The Bascik documentation site (`docs/`) includes both E2E browser tests and unit tests to ensure all components functionally work and stay tested:

- **E2E Browser Tests (`docs/e2e/docs-components.spec.ts`)**: Runs Playwright against a live built Bascik server (`npx bascik --build && npx bascik --serve`) to test real browser behavior for `docs-search`, `component-demo`, `comp-toggle`, `demo-counter`, and `comp-alert`.
- **Pure Logic Unit Tests (`docs/src/components/docs-search/search-logic.test.ts`)**: Tests the search engine logic (`search-logic.ts`) in Vitest across tokenization, scoring tiers, snippet extraction, and result formatting.

To execute the test suites:

```sh
# Run unit tests (Vitest)
yarn workspace bascik-docs test

# Run E2E browser tests (Playwright)
yarn workspace bascik-docs e2e
```

## Manual Test Runner Setup

If you are not using a template scaffolded by `npm create bascik`, you can manually set up Vitest, Playwright, and V8 coverage.

### 1. Install Dependencies

Install Vitest, V8 coverage, and Playwright:

```sh
npm install -D vitest @vitest/coverage-v8 @playwright/test
```

### 2. Configure Vitest (`vite.config.js`)

Create a `vite.config.js` file in your project root to specify test directory filters and code coverage reports:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

### 3. Configure Playwright (`e2e/playwright.config.ts`)

Create `e2e/playwright.config.ts` to build and serve the compiled Bascik site automatically on a test port before running your E2E specs:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    command: 'npx bascik --build && npx bascik --serve',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
  },
});
```

### 4. Add Package Scripts (`package.json`)

Add the test commands to the `scripts` block inside your `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "e2e": "playwright test --config e2e/playwright.config.ts"
}
```

### 5. Code Coverage Reporting

With `@vitest/coverage-v8` installed and configured in `vite.config.js`, running `npm run test:coverage` analyzes all TypeScript source files across components, server logic, and utilities.

- **Terminal output**: Displays an inline summary of statement, branch, function, and line coverage percentages.
- **HTML reports**: Generated in `coverage/index.html` for interactive per-file drill-downs in any web browser.
- **JSON artifacts**: Saved in `coverage/coverage-final.json` for integration into CI/CD quality gates.

Ensure that the `coverage/` output directory is added to your `.gitignore` file.
