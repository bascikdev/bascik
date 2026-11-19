/**
 * @module templates/landing/e2e
 *
 * The landing template's Playwright spec.
 */

/** The tests a project with an adapter adds: its `/api/waitlist` route answers under `bascik --server`. */
export const E2E_API_TESTS = `
  test('waitlist API checks the address again on the server', async ({ request }) => {
    const refused = await request.post('/api/waitlist', { data: { email: 'reader@example' } });
    expect(refused.status()).toBe(422);
    expect(await refused.json()).toEqual({ errors: ['Enter an email address like reader@example.com.'] });

    const accepted = await request.post('/api/waitlist', { data: { email: 'reader@example.com' } });
    expect(accepted.status()).toBe(201);
  });

  test('sign-up form shows what the server refuses', async ({ page }) => {
    await page.goto('/');
    // The browser accepts an address with no dot in its domain; the server does not.
    await page.getByTestId('waitlist-signup-email').fill('reader@example');
    await page.getByTestId('waitlist-signup-submit').click();
    await expect(page.getByTestId('waitlist-signup-error')).toHaveText('Enter an email address like reader@example.com.');
    await expect(page.getByTestId('waitlist-signup-status')).toBeHidden();
  });
`;

/** `e2e/app.spec.ts`, with room for the tests only some projects need. */
export const e2eAppSpec = (extraTests = ""): string =>
  `import { test, expect } from '@playwright/test';

test.describe('Landing page E2E tests', () => {
  test('home page has one h1, a section heading for every section, and head tags for sharing', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    for (const id of ['feature-list', 'how-it-works', 'reader-quotes', 'pricing-plans', 'faq-list', 'waitlist-signup']) {
      await expect(page.getByTestId(id).getByRole('heading', { level: 2 })).toHaveCount(1);
    }
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /^https?:\\/\\/[^/]+\\/$/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', await page.title());
    // No component tag reaches the browser.
    expect(await page.content()).not.toMatch(/<(site-head|section-head|feature-list|faq-list)[\\s>/]/);
  });

  test('hero call to action goes to the sign-up form', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-hero-cta').click();
    await expect(page).toHaveURL('/#signup');
    await expect(page.getByTestId('waitlist-signup-form')).toBeInViewport();
  });

  test('the product preview is visible and readable on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const preview = page.getByTestId('home-hero-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Project overview');
    await expect(preview).toContainText('Next up');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('header links land on their sections', async ({ page }) => {
    await page.goto('/');
    const sections = {
      features: 'feature-list',
      'how-it-works': 'how-it-works',
      pricing: 'pricing-plans',
      faq: 'faq-list',
      signup: 'waitlist-signup',
    };
    for (const [id, section] of Object.entries(sections)) {
      await page.getByTestId(\`site-header-\${id}\`).click();
      await expect(page).toHaveURL(\`/#\${id}\`);
      await expect(page.getByTestId(section)).toHaveAttribute('id', id);
      await expect(page.getByTestId(section).getByRole('heading', { level: 2 })).toBeInViewport();
    }
  });

  test('header links reach the home page sections from another page', async ({ page }) => {
    await page.goto('/privacy');
    await page.getByTestId('site-header-pricing').click();
    await expect(page).toHaveURL('/#pricing');
    await expect(page.getByTestId('pricing-plans').getByRole('heading', { level: 2 })).toBeInViewport();
  });

  test('each plan links to the sign-up form and one plan is featured', async ({ page }) => {
    await page.goto('/');
    const plans = page.getByTestId('pricing-plans-plan');
    await expect(plans).toHaveCount(3);
    await expect(plans.filter({ hasText: 'Most popular' })).toHaveCount(1);
    await plans.filter({ hasText: 'Choose Studio' }).getByTestId('pricing-plans-choose').click();
    await expect(page).toHaveURL('/#signup');
  });

  test('a question opens and closes, and leaves the others closed', async ({ page }) => {
    await page.goto('/');
    const item = page.getByTestId('faq-list-item').filter({ hasText: 'Can clients see the project too?' });
    const other = page.getByTestId('faq-list-item').filter({ hasText: 'Do I need to change how my studio works?' });
    const answer = item.getByTestId('faq-list-answer');

    await expect(answer).toBeHidden();
    await item.getByTestId('faq-list-question').click();
    await expect(answer).toBeVisible();
    await expect(other.getByTestId('faq-list-answer')).toBeHidden();

    await item.getByTestId('faq-list-question').click();
    await expect(answer).toBeHidden();
  });

  test('a question opens from the keyboard', async ({ page }) => {
    await page.goto('/');
    const item = page.getByTestId('faq-list-item').filter({ hasText: 'Can clients see the project too?' });
    await item.getByTestId('faq-list-question').focus();
    await page.keyboard.press('Enter');
    await expect(item.getByTestId('faq-list-answer')).toBeVisible();
  });

  test('sign-up form refuses an empty address and says why', async ({ page }) => {
    await page.goto('/');
    const email = page.getByTestId('waitlist-signup-email');
    const error = page.getByTestId('waitlist-signup-error');

    await expect(error).toBeHidden();
    await page.getByTestId('waitlist-signup-submit').click();
    await expect(error).toHaveText('Enter your email address.');
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toBeFocused();
    await expect(page.getByTestId('waitlist-signup-status')).toBeHidden();
  });

  test('sign-up form refuses an address that is not an email address, then clears the message once it is fixed', async ({ page }) => {
    await page.goto('/');
    const email = page.getByTestId('waitlist-signup-email');
    const error = page.getByTestId('waitlist-signup-error');

    await email.fill('not-an-email');
    await page.getByTestId('waitlist-signup-submit').click();
    await expect(error).toHaveText('Enter an email address like reader@example.com.');
    await expect(page.getByTestId('waitlist-signup-status')).toBeHidden();

    await email.fill('reader@example.com');
    await expect(error).toBeHidden();
    await expect(email).toHaveAttribute('aria-invalid', 'false');
  });

  test('sign-up form accepts a valid address without leaving the page', async ({ page }) => {
    await page.goto('/');
    const email = page.getByTestId('waitlist-signup-email');
    await email.fill('reader@example.com');
    await page.getByTestId('waitlist-signup-name').fill('Marta');
    await page.getByTestId('waitlist-signup-submit').click();

    await expect(page.getByTestId('waitlist-signup-status')).toContainText('You are on the list.');
    await expect(page.getByTestId('waitlist-signup-error')).toBeHidden();
    await expect(email).toHaveValue('');
    await expect(page).toHaveURL('/');
  });
${extraTests}
  test('mobile navigation toggle expands and collapses the menu', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const toggle = page.getByTestId('site-header-nav-toggle');
    const menu = page.getByTestId('site-header-nav-menu');

    // Assert what the reader sees, not a class name: the build hashes class names.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();

    // Following a link to a section closes the menu on the way.
    await page.getByTestId('site-header-faq').click();
    await expect(page).toHaveURL('/#faq');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
  });

  test('page fits a phone screen with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('skip link is the first stop and moves to the main content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('site-header-skip-link');
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/#main');
  });

  test('privacy page is reachable from the footer and has its own title', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('site-footer-privacy').click();
    await expect(page).toHaveURL('/privacy');
    await expect(page).toHaveTitle(/^Privacy - /);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  });

  test('unknown address gets the 404 page, with a way home', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await page.getByTestId('not-found-home').click();
    await expect(page).toHaveURL('/');
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('page is readable: every section, the questions, and the form are there', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('pricing-plans-plan')).toHaveCount(3);
    await expect(page.getByTestId('faq-list-item')).toHaveCount(5);
    await expect(page.getByTestId('waitlist-signup-email')).toBeVisible();
  });

  test('phone menu stays open, because nothing can open it', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.getByTestId('site-header-nav-toggle')).toBeHidden();
    await expect(page.getByTestId('site-header-pricing')).toBeVisible();
  });
});
`;
