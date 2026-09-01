import { expect, test } from '@playwright/test';

test('binds distinct props to non-root attributes and strips directives', async ({ page }) => {
  await page.goto('/attribute-binding-test');

  const firstCard = page.getByTestId('binding-card-one');
  const secondCard = page.getByTestId('binding-card-two');
  const firstLink = firstCard.getByTestId('binding-link');
  const secondLink = secondCard.getByTestId('binding-link');
  const firstImage = firstCard.getByTestId('binding-image');
  const secondImage = secondCard.getByTestId('binding-image');

  await expect(firstLink).toHaveAttribute('href', '/attribute-binding-test#first');
  await expect(secondLink).toHaveAttribute('href', '/attribute-binding-test#second');
  await expect(firstImage).toHaveAttribute('src', '/assets/binding-first.svg');
  await expect(secondImage).toHaveAttribute('src', '/assets/binding-second.svg');
  await expect(firstImage).toHaveAttribute('alt', 'First image');
  await expect(secondImage).toHaveAttribute('alt', 'Second image');
  expect(await firstImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await secondImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

  for (const element of [firstLink, secondLink, firstImage, secondImage]) {
    expect(
      await element.evaluate((node) =>
        node.getAttributeNames().every((name) => !name.startsWith('data-bascik-attr-')),
      ),
    ).toBe(true);
  }

  await firstLink.click();
  await expect(page).toHaveURL(/#first$/);
  await page.goto('/attribute-binding-test');
  await page.getByTestId('binding-card-two').getByTestId('binding-link').click();
  await expect(page).toHaveURL(/#second$/);
});