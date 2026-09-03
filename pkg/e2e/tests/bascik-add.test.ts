/**
 * E2E tests for `bascik add` static build rendering.
 *
 * NOTE: Skipped for the two production server configs (HTTP/1.1 and HTTP/2)
 * because `bascik add` is a build-time authoring command with no runtime behavior;
 * serving a copied component is identical to serving any other component.
 *
 * Exercises:
 *   Static build config: verifies a component added via the copy-in mechanism
 *   (present in the components directory and referenced from a page before static build)
 *   builds and renders correctly through the static pipeline.
 */

import { test, expect } from '@playwright/test';

test.describe('bascik add static build', () => {
  test('renders copy-in added component through static build pipeline', async ({ page }) => {
    await page.goto('/bascik-add-test');

    const root = page.getByTestId('added-component-root');
    await expect(root).toBeVisible();

    const title = page.getByTestId('added-component-title');
    await expect(title).toHaveText('Added Copy-In Component');

    const slot = page.getByTestId('added-component-slot');
    await expect(slot).toHaveText('Rendered through static build pipeline');
  });
});
