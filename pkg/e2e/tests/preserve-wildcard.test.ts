/**
 * E2E tests for wildcard patterns in scoping.preserve.
 *
 * Verifies that every tag matching a configured wildcard family (vendor-*)
 * keeps its id, name, and class attributes, contents, and descendants
 * literal, while elements outside the family scope normally.
 */
import { test, expect } from '@playwright/test';

test.describe('preserve-wildcard-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/preserve-wildcard-test');
  });

  test('elements outside the preserved family are scoped normally', async ({ page }) => {
    const outer = page.getByTestId('outer');

    await expect(outer).toHaveClass(/bascik__preserve-wildcard__text/);
    await expect(outer).toHaveAttribute('id', /bascik__preserve-wildcard__.*__outer/);
    await expect(outer).toHaveAttribute('name', /bascik__preserve-wildcard__.*__outer/);
  });

  test('the wildcard-matched tag itself has literal attributes', async ({ page }) => {
    const widget = page.getByTestId('widget');

    await expect(widget).toHaveAttribute('class', 'widget');
    await expect(widget).toHaveAttribute('id', 'widget-root');
    await expect(widget).toHaveAttribute('name', 'widget-root');
  });

  test('descendants of the wildcard-matched tag are shielded from scoping', async ({ page }) => {
    const label = page.getByTestId('label');

    await expect(label).toHaveAttribute('class', 'label');
    await expect(label).toHaveAttribute('id', 'label');
    await expect(label).toHaveAttribute('name', 'label');
  });
});
