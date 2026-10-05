/**
 * e2e tests for forwarding a default slot into a nested component.
 *
 * <slot-forward-outer> places a valueless `data-bascik-slot` marker between the usage tags of
 * <slot-forward-inner>. Content given to the outer component must land in the inner component's
 * slot, with the marker's own text as the fallback when the outer tag is empty. Before the fix
 * the marker stayed in the output and the given content was dropped without a warning.
 *
 * Runs against static output, the dev server, and the HTTP/2 production server. Production
 * output hashes class names, so elements are found by data-testid.
 */
import { test, expect } from '@playwright/test';

test.describe('default slot forwarded into a nested component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/slot-forward-test');
  });

  test('content given to the outer component appears inside the inner component', async ({ page }) => {
    const inner = page.getByTestId('given').getByTestId('forward-inner');
    await expect(inner.getByTestId('given-content')).toHaveText('given to the outer component');
    await expect(inner).not.toContainText('inner fallback');
    await expect(inner).not.toContainText('forwarded fallback');
  });

  test('a second instance keeps its own content', async ({ page }) => {
    const inner = page.getByTestId('given-again').getByTestId('forward-inner');
    await expect(inner.getByTestId('given-again-content')).toHaveText('a second, different instance');
    await expect(page.getByTestId('given').getByTestId('given-again-content')).toHaveCount(0);
  });

  test('an empty outer tag shows the marker\'s fallback text', async ({ page }) => {
    const inner = page.getByTestId('empty').getByTestId('forward-inner');
    await expect(inner).toHaveText('forwarded fallback');
  });

  test('the inner component keeps its own scoped style around the forwarded content', async ({ page }) => {
    const inner = page.getByTestId('given').getByTestId('forward-inner');
    await expect(inner).toHaveCSS('background-color', 'rgb(0, 128, 0)');
    await expect(inner).toHaveCSS('padding-top', '4px');
  });

  test('no slot marker reaches the page', async ({ page }) => {
    expect(await page.locator('[data-bascik-slot]').count()).toBe(0);
    expect(await page.content()).not.toContain('data-bascik-slot');
  });
});
