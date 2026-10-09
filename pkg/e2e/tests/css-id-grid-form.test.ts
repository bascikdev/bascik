import { expect, test } from '@playwright/test';

test.describe('CSS #id selector scoping & grid layout', () => {
  test('applies grid display, column layout, and gap via scoped class on #report-form', async ({ page }) => {
    await page.goto('/css-id-grid-form-test');

    const form = page.getByTestId('report-form');
    await expect(form).toBeVisible();

    // Verify computed styles directly in the browser
    const computed = await form.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        display: s.display,
        rowGap: s.rowGap,
        columnGap: s.columnGap,
        gridTemplateColumns: s.gridTemplateColumns,
      };
    });

    expect(computed.display).toBe('grid');
    expect(computed.rowGap).toBe('16px');
    expect(computed.columnGap).toBe('20px');

    // Both labels exist and are laid out inside the grid
    const labelEmployee = page.getByTestId('label-employee');
    const labelHours = page.getByTestId('label-hours');
    await expect(labelEmployee).toBeVisible();
    await expect(labelHours).toBeVisible();
  });
});
