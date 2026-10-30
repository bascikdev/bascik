---
name: bascik-testing
description: Test, debug, and validate Bascik sites. Use when writing Vitest unit tests or Playwright E2E tests for a Bascik project, choosing locators that survive production identifier minification, debugging component scripts, build scripts, or server scripts in VS Code or browser DevTools, validating compiled dist/ HTML against the WHATWG spec, running bascik --check and the language server linter in CI, or reaching Lighthouse 100 scores.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Testing and Debugging Bascik Sites

Requires the `bascik` skill for project basics and its `scripts/verify.mjs` for the check and lint loop.

## Verification ladder

Run cheapest first and stop at the first failure:

1. `npx bascik --check`: project checks (config, routes, references) plus, when `@bascik/language-server` is installed, the per-file checks (scoping patterns, unclosed tags). `node <skills-dir>/bascik/scripts/verify.mjs` runs it and also covers component folders outside the project.
2. `npx vitest run` for unit tests of pure logic.
3. `BASCIK_SITE_URL=https://example.com npx bascik --build`, then inspect `dist/` or run `verify.mjs --build`.
4. `npx playwright test` against the built site or the dev server.

CI gate: `bascik --check && vitest run && bascik --build && playwright test`. `bascik --check` already runs the per-file checks, so there is no separate linter step. Add `bascik-language-server --check <dir>` only for a component folder outside the project.

## Unit tests: extract pure logic

Component scripts are IIFEs and cannot be imported. Test logic, not DOM wiring:

1. Move pure functions (parsing, scoring, formatting, validation) into a sibling `.ts` file, for example `src/components/docs-search/search-logic.ts`.
2. Load it from the component with `<script src="search-logic.ts"></script>`. Bascik strips its types and scopes it; no build step or `minify.js` hook is needed.
3. Import the `.ts` file directly in `search-logic.test.ts`. No browser is needed.

```ts
// vite.config.ts
import { defineConfig } from "vite";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

Server, stream, and API logic: put it in `src/lib/*.ts`, unit test the functions, and cover the HTTP layer with requests against the dev server or `bascik --server`. A function or handler that returns `html` from `@bascik/bascik/html` returns an object, not a string: assert on `String(output)` (`expect(String(output)).toContain("Seattle")`), and type a helper's return as `SafeHtml`, not `string`.

## E2E tests: locators that survive production

`bascik --build` hashes scoped class names and IDs (`minify.identifiers`). Selectors such as `.my-card` or `#btn` that work in dev fail in production.

- Find a component, or a part of one, with `getByTestId(...)`. Every component root has `data-testid="<component-name>"` and each interactive part has `data-testid="<component-name>-<part>"` (rule 16 of the `bascik` skill); add any that are missing to the template, and run `verify.mjs`, whose advisory lists the gaps. Bascik never scopes or hashes `data-testid`.
- Use `getByRole(...)`, `getByLabel(...)`, or `getByText(...)` first when the test is about what a person reads or hears: a button's accessible name, a field's label, a heading.
- Instances share their test ids. Pick one with `.filter({ hasText: "..." })`, or give it its own with `data-testid` on the usage tag in the test page, which replaces the root's.
- Never use scoped names (`.bascik__my-card__title`), positional `.nth(N)` chains, or `locator('..')` traversal to reach an element.
- Put two instances of a component on a test page and assert they act independently; that catches the class-selector pitfall.
- Test against the production build (`bascik --build` served statically, or `bascik --server`), not only the dev server: script placement and identifiers differ.

```ts
import { test, expect } from "@playwright/test";

test("each like button toggles independently", async ({ page }) => {
  await page.goto("/");
  const buttons = page.getByTestId("like-button");
  await buttons.first().click();
  await expect(buttons.first()).toHaveAttribute("aria-pressed", "true");
  await expect(buttons.last()).toHaveAttribute("aria-pressed", "false");
});
```

## Validate compiled HTML

Install `parse5` as a dev dependency and `bascik --check` will report WHATWG parse errors in `dist/` HTML. For a test that fails the suite instead, walk `dist/**/*.html` and collect `parse5` `onParseError` results; see `read-doc.mjs /testing/component-testing`.

## Debug

- **Component scripts:** in DevTools Sources, open `src/components/<name>/<name>.html` (Cmd+P / Ctrl+P). Lines match the source in dev. Later instances are `<name>.html?instance=2`. Use `debugger;` to stop in every instance.
- **Build, routes, server, and stream scripts:** errors point at the file and line where the script was written. Set breakpoints in VS Code and launch the dev server under the debugger.
- **Wrong output:** run `node <skills-dir>/bascik/scripts/preview.mjs --page src/pages/x.html` to read the unminified compiled page.
- **Stale build script output:** a script that reads the network or a directory is cached; add it to `scripts.cache.exclude` or delete `node_modules/.cache/bascik/script-cache`.

VS Code launch configurations and step-by-step flows: `read-doc.mjs /testing/debugging` and `/testing/source-maps`.

## Lighthouse

Bascik output starts near 100 because it adds no runtime. The remaining points come from ordinary HTML practice: explicit image `width` and `height`, `loading="lazy"` below the fold only, preload of the hero image and critical fonts, `defer` scripts, a unique `<title>`, description, and canonical per page, landmarks, labeled controls, and `lang` on `<html>`. Checklists: `read-doc.mjs /lighthouse/performance`, `/lighthouse/accessibility`, `/lighthouse/best-practices`, `/lighthouse/seo`, and `/lighthouse/agentic-browsing`. To fail a build unless every page scores 100 in all five categories, run `bascik-refactor/scripts/lighthouse-gate.mjs` from the opt-in `bascik-refactor` skill (`npx skills add bascikdev/bascik --skill bascik-refactor`) over the Lighthouse JSON reports.

## Look it up

| How do I...                          | Read                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Unit test helpers and handlers       | `/testing/unit-testing`                                                      |
| Test components in a browser         | `/testing/component-testing`, `/testing/e2e-testing`                         |
| Test build, server, and exec scripts | `/testing/build-scripts`, `/testing/server-scripts`, `/testing/exec-scripts` |
| Lint in CI                           | `/testing/linting`, `/tools/linter`                                          |
| Fix a known problem                  | `/testing/troubleshooting`                                                   |

`node <skills-dir>/bascik/scripts/read-doc.mjs <path>` prints any of these.
