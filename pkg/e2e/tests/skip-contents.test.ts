/**
 * e2e tests for skipTranspilingElementContents shielding.
 *
 * Verifies that elements inside specific tags (like <code>) are not scoped
 * by the bascik compiler (their classes and IDs remain verbatim), while
 * attributes ON the skip tag itself (like class="...") ARE scoped.
 */
import { test, expect } from '@playwright/test';

test.describe('skip-contents-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/skip-contents-test');
  });

  test('outer elements are scoped normally', async ({ page }) => {
    const outer = page.getByTestId('outer');
    
    // Should have the scoped class from the component
    await expect(outer).toHaveClass(/bascik__skip-contents__text/);
    
    // The id="outer" should be scoped to prevent global collision
    await expect(outer).toHaveAttribute('id', /bascik__skip-contents__.*__outer/);
    
    // The script should have added the scoped 'active' class
    await expect(outer).toHaveClass(/bascik__skip-contents__active/);
  });

  test('the skip tag itself has scoped attributes', async ({ page }) => {
    const codeBlock = page.getByTestId('code-block');
    
    // Its own class should be scoped
    await expect(codeBlock).toHaveClass(/bascik__skip-contents__code-block/);
    // Its own id should be scoped
    await expect(codeBlock).toHaveAttribute('id', /bascik__skip-contents__.*__code-root/);
    // The unquoted/quoted data-x="a>b" should survive intact
    await expect(codeBlock).toHaveAttribute('data-x', 'a>b');
  });

  test('elements inside the skip tag are completely shielded from scoping', async ({ page }) => {
    const inner = page.getByTestId('inner');
    
    // The inner element should have literally "text" as class, not scoped
    await expect(inner).toHaveAttribute('class', 'text');
    
    // The inner element should have literally "inner" as ID, not converted to class
    await expect(inner).toHaveAttribute('id', 'inner');
    
    // The span inside should have literally "highlight" as class
    const highlight = inner.locator('.highlight');
    await expect(highlight).toHaveCount(1);
    await expect(highlight).toHaveAttribute('class', 'highlight');
  });
});
