import { expect, test } from '@playwright/test';

test('production server receives preserved form field names', async ({ page }) => {
  await page.goto('/preserve-test');
  const submittedRequest = page.waitForRequest((request) =>
    request.method() === 'POST' && request.url().endsWith('/preserve-test'),
  );
  await page.getByTestId('submit-preserved-form').click();
  const request = await submittedRequest;
  expect(request.postData()).toBe('email=person%40example.com');
});