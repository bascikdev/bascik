# Testing & Debugging Overview

Bascik supports automated testing and debugging across every layer of your application, from component markup contracts and compiled build outputs to server scripts, browser component logic, and end-to-end user workflows.

Because Node 24 and Node 22.18+ natively execute TypeScript files by erasing type annotations, test runners and build scripts import `.ts` modules directly without intermediate build steps or bundle delays.

## Testing Architecture & Tiers

Testing a Bascik application is structured into four core tiers:

| Tier | Primary Tool | Key Responsibility | Execution Speed |
| --- | --- | --- | --- |
| **[Unit Testing](/testing/unit-testing)** | Vitest | Validates pure functions, calculations, scoring, and data transformations. | Sub-second (~10ms) |
| **[Component Testing](/testing/component-testing)** | Vitest | Validates `.html` component contracts, slot filling, prop substitution, and `dist/` build output. | Sub-second (~100ms) |
| **[Server Scripts](/testing/server-scripts)** | Vitest | Validates request-time `<script data-bascik-server>` logic and exported backend modules. | Sub-second (~20ms) |
| **[End-to-End Testing](/testing/e2e-testing)** | Playwright | Validates full browser interactions, DOM event handling, CSS `:has()` rules, and multi-page routing. | Seconds |

## Quick Start with `create-bascik`

Projects created with `npm create bascik@latest` include a pre-configured testing environment powered by Vitest, Playwright, V8 code coverage, and VS Code debug launchers.

Execute test suites directly from your project root:

```sh
# Run unit and component contract tests
npm test

# Run unit tests with V8 code coverage summaries and HTML reports
npm run test:coverage

# Run Playwright end-to-end browser tests
npm run e2e
```

## Additional Testing & Tooling Guides

- **[Debugging & VS Code](/testing/debugging)**: Set up step-debugging launch configurations in VS Code for dev servers, unit tests, server scripts, and browser components.
- **[Source Maps](/testing/source-maps)**: Learn how Bascik provides 1:1 line number preservation, `//# sourceURL` directives, and build-time stack trace remapping without heavy `.map` files.
- **[Web Standards & Linting](/testing/web-standards-linting)**: Configure `.hintrc` and Webhint for accessibility auditing, HTML validity, and browser compatibility checks.
