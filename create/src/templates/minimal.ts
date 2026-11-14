/**
 * @module templates/minimal
 *
 * The `minimal` template: an almost empty site to start from nothing. One page,
 * one stylesheet, a 404 page, and the head component every page shares. It has
 * no header, footer or demo components, and it adds nothing for an adapter:
 * the `/api/hello` route `scaffold` writes is the only request-time code.
 */

import {
  SITE_META_HTML,
  SITE_META_TEST,
  type StarterTemplate,
  type TemplateContext,
  type TemplateFile,
} from "../scaffold.js";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * The site name as HTML text. The CLI only lets through names that need no
 * escaping, but `scaffold` can be called with any name, and a `<` or `&` in it
 * must not become markup in the pages.
 */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);

/** The one global stylesheet: readable defaults in light and dark, and nothing to delete. */
export const MINIMAL_STYLES_CSS = `*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  line-height: 1.6;
}

main {
  max-width: 40rem;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}

h1 {
  margin-top: 0;
  line-height: 1.2;
}
`;

/** A whole page: the shared head component, a title, and one `<main>`. */
const page = (
  title: string,
  testId: string,
  body: string,
): string => `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
    <title>${title}</title>
  </head>
  <body>
    <main id="main" data-testid="${testId}">
${body}
    </main>
  </body>
</html>
`;

/** The home page: the site's name and where to start editing. */
export const minimalIndexPage = (siteName: string): string => {
  const name = escapeHtml(siteName);
  return page(
    name,
    "home-main",
    `      <h1>${name}</h1>
      <p>Edit <code>src/pages/index.html</code> to get started.</p>`,
  );
};

/** The page Bascik serves, with status 404, for a URL no page answers. */
export const minimalNotFoundPage = (siteName: string): string =>
  page(
    `Page not found - ${escapeHtml(siteName)}`,
    "404-main",
    `      <h1>Page not found</h1>
      <p>
        Nothing lives at this address.
        <a href="/" data-testid="404-home-link">Go to the home page</a>
      </p>`,
  );

/** Two browser tests: the home page renders, and an unknown URL gets the 404 page. */
export const MINIMAL_E2E_APP_SPEC = `import { test, expect } from '@playwright/test';

test.describe('Site E2E Tests', () => {
  test('home page renders its heading', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('home-main').getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('unknown URL shows the 404 page', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId('404-main')).toContainText('Page not found');

    await page.getByTestId('404-home-link').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('home-main')).toBeVisible();
  });
});
`;

const minimalDirectories = (): string[] => [
  "src/pages/css",
  "src/components/site-meta",
];

const minimalFiles = ({ siteName }: TemplateContext): TemplateFile[] => [
  ["e2e/app.spec.ts", MINIMAL_E2E_APP_SPEC],
  ["src/pages/css/styles.css", MINIMAL_STYLES_CSS],
  ["src/pages/index.html", minimalIndexPage(siteName)],
  ["src/pages/404.html", minimalNotFoundPage(siteName)],
  // The head every page shares, with its unit test so `npm test` has one to run.
  ["src/components/site-meta/site-meta.html", SITE_META_HTML],
  ["src/components/site-meta/site-meta.test.ts", SITE_META_TEST],
];

/** `--template minimal`: start from nothing. The same files with or without an adapter. */
export const MINIMAL_TEMPLATE: StarterTemplate = {
  name: "minimal",
  summary: "An almost empty site: one page, one stylesheet, and a 404 page",
  directories: minimalDirectories,
  files: minimalFiles,
};
