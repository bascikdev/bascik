/**
 * e2e tests for a parent component styling a child component's root element
 * through a class on the child's usage tag.
 *
 * <attr-parent> contains two <attr-child> usages and one plain anchor:
 *   - class="nav-link": defined in attr-parent.css, so the parent scopes it
 *     (`bascik__attr-parent__nav-link`) before the child expands.
 *   - class="utility-global": not defined in attr-parent.css, so it passes
 *     through unscoped and a page-level stylesheet can style it.
 *   - a plain <a>: matched by the parent's `nav a` rule.
 *
 * Isolation guarantee: the parent's `nav a` rule must not reach the anchor
 * that <attr-child> renders as its root.
 *
 * The parent class and the child's own class are never given the same property
 * here: both have equal specificity, so which one wins would depend on
 * stylesheet order, which Bascik does not guarantee.
 *
 * The fixture is built with `minify.identifiers: false` so scoped names are
 * readable. These are compiler tests, so they assert the exact scoped output.
 */
import { test, expect } from '@playwright/test';

test.describe('attr-inherit-parent-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/attr-inherit-parent-test');
  });

  test('a class written in the parent template is scoped by the parent and merged onto the child root', async ({ page }) => {
    const child = page.getByTestId('attr-child-styled');
    await expect(child).toHaveAttribute('class', 'bascik__attr-child__link bascik__attr-parent__nav-link');
  });

  test('the parent class styles the child root, and the child keeps its own styles', async ({ page }) => {
    const child = page.getByTestId('attr-child-styled');
    await expect(child).toHaveCSS('font-weight', '700');
    await expect(child).toHaveCSS('color', 'rgb(0, 0, 255)');
  });

  test('a class not defined in the parent stylesheet passes through unscoped', async ({ page }) => {
    const child = page.getByTestId('attr-child-global');
    await expect(child).toHaveAttribute('class', 'bascik__attr-child__link utility-global');
    await expect(child).toHaveCSS('outline-color', 'rgb(255, 0, 0)');
    await expect(child).toHaveCSS('color', 'rgb(0, 0, 255)');
  });

  test("the parent's element selector styles its own anchor", async ({ page }) => {
    await expect(page.getByTestId('attr-parent-own-anchor')).toHaveCSS('background-color', 'rgb(255, 255, 0)');
  });

  test("the parent's element selector does not reach the child's root anchor", async ({ page }) => {
    for (const id of ['attr-child-styled', 'attr-child-global']) {
      await expect(page.getByTestId(id)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
  });
});
