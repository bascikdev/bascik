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
  for (const width of [1440, 375]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        test(\`initial paint: \${width} / \${colorScheme} / \${reducedMotion}\`, async ({ page }) => {
          await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
          await page.emulateMedia({ colorScheme, reducedMotion });
          await page.addInitScript((scheme) => {
            const samples: string[] = [];
            Object.assign(window, { initialMotion: samples });
            const sample = () => {
              for (const element of document.querySelectorAll('*')) {
                const rect = element.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= innerHeight || rect.width === 0 || rect.height === 0) continue;
                const style = getComputedStyle(element);
                if (getComputedStyle(document.documentElement).colorScheme !== scheme) {
                  samples.push('theme flash:' + getComputedStyle(document.documentElement).colorScheme);
                }
                if (style.animationName !== 'none' || Number(style.opacity) < 1) {
                  samples.push(element.tagName + ':' + style.animationName + ':' + style.opacity);
                }
              }
              if (performance.now() < 1200) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          }, colorScheme);
          for (const route of ['/', '/privacy', '/no-such-page']) {
            await page.goto(route);
            await page.waitForTimeout(1250);
            expect(await page.evaluate(() => (window as Window & { initialMotion: string[] }).initialMotion)).toEqual([]);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
            const theme = page.getByTestId('site-header-theme-toggle');
            await expect(theme).toHaveAttribute('aria-pressed', String(colorScheme === 'dark'));
            await expect(theme).toHaveText('');
            expect((await theme.textContent())!.trim()).toBe('');
            expect(await theme.locator('svg').count()).toBeGreaterThan(0);
            if (width > 640) {
              await expect(theme).toBeVisible();
              await expect(theme).toHaveAccessibleName('Toggle dark mode');
              await expect(theme).toHaveCSS('width', '44px');
            } else {
              // At phone width the icon gives way to the menu button; the theme switch is a row in the menu.
              await expect(theme).toBeHidden();
              await expect(page.getByTestId('site-header-nav-toggle')).toHaveCSS('width', '44px');
            }
            expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme);
            expect(await page.evaluate(() => getComputedStyle(document.documentElement, '::view-transition-new(root)').animationName)).toBe('none');
          }
        });
      }
    }
  }

  test('theme is keyboard accessible, persists before paint, and leaves nav styled', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.goto('/');
    const theme = page.getByTestId('site-header-theme-toggle');
    await theme.focus();
    await page.keyboard.press('Space');
    await expect(theme).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
    await page.addInitScript(() => {
      const schemes: string[] = [];
      Object.assign(window, { savedPaintSchemes: schemes });
      const sample = () => {
        if (document.body?.getBoundingClientRect().height) {
          schemes.push(getComputedStyle(document.documentElement).colorScheme);
        }
        if (performance.now() < 1000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.reload();
    await page.waitForTimeout(1100);
    const schemes = await page.evaluate(() => (window as Window & { savedPaintSchemes: string[] }).savedPaintSchemes);
    expect(schemes.length).toBeGreaterThan(0);
    expect([...new Set(schemes)]).toEqual(['dark']);
    await expect(theme).toHaveAttribute('aria-pressed', 'true');
    const brand = (await page.getByTestId('site-header-logo').innerText()).trim();
    expect(brand).not.toBe('');
    await expect(page.getByTestId('home-hero-preview')).toContainText(brand);
    await expect(page.getByTestId('site-header-pricing')).toHaveCSS('text-decoration-line', 'none');
    await page.getByTestId('site-header-pricing').hover();
    await expect(page.getByTestId('site-header-pricing')).toHaveCSS('text-decoration-line', 'none');
    await page.getByTestId('site-footer-privacy').click();
    await expect(theme).toHaveAttribute('aria-pressed', 'true');
    await theme.click();
    await expect(theme).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
  });

  test('global CSS is inline and canonical favicon reaches production unchanged', async ({ page, request }) => {
    const styles: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/css/styles.css')) styles.push(request.url());
    });
    await page.goto('/');
    expect(styles).toEqual([]);
    expect(await page.locator('link[rel="stylesheet"]').evaluateAll(links =>
      links.some(link => (link as HTMLLinkElement).href.includes('styles.css')))).toBe(false);
    expect(await page.content()).not.toContain('href="/css/styles.css"');
    const icon = await request.get('/assets/favicon.svg');
    expect(await icon.text()).toContain('fill="#d3ff8d"');
    expect(await icon.text()).toContain('points="10,3 28,3 23,29 4,29"');
    expect(await icon.text()).not.toContain('#42664d');
  });

  test('reduced motion disables button press scaling but normal interaction keeps it', async ({ page }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion });
      await page.goto('/');
      const button = page.getByTestId('home-hero-cta');
      await button.hover();
      await page.mouse.down();
      await page.waitForTimeout(200);
      await expect(button).toHaveCSS('scale', reducedMotion === 'reduce' ? 'none' : '0.97');
      await page.mouse.up();
    }
  });

  test('root view transitions never animate page snapshots', async ({ page }) => {
    await page.goto('/');
    const names = await page.evaluate(async () => {
      const transition = document.startViewTransition(() => {});
      await transition.ready;
      const names = ['group', 'image-pair', 'old', 'new'].map(name =>
        getComputedStyle(document.documentElement, \`::view-transition-\${name}(root)\`).animationName);
      await transition.finished;
      return names;
    });
    expect(names).toEqual(['none', 'none', 'none', 'none']);
  });

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

    // At phone width the theme switch is the last row of the menu and names the theme it switches to.
    await expect(page.getByTestId('site-header-theme-toggle')).toBeHidden();
    const themeRow = page.getByTestId('site-header-mobile-theme');
    const before = await themeRow.innerText();
    await themeRow.click();
    await expect(themeRow).not.toHaveText(before);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();

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
