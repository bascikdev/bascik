/**
 * The tests the corporate template gives the generated project: a Vitest file beside every component and every
 * `src/lib/` module, and the Playwright spec in `e2e/app.spec.ts`.
 */

import type { TemplateFile } from "../../scaffold.js";

export const TEST_FILES: TemplateFile[] = [
  [
    "e2e/app.spec.ts",
    `import { test, expect, type Page } from '@playwright/test';

// Tests find elements by data-testid or by role: the build hashes class names and ids.

/** The parsed JSON-LD blocks of the page. */
const structuredData = async (page: Page): Promise<Record<string, unknown>[]> =>
  (await page.locator('script[type="application/ld+json"]').allTextContents()).map((text) => JSON.parse(text));

test.describe('Company site E2E Tests', () => {
  test('home page shows the hero, services, figures, clients and testimonials', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Publishing services for independent authors/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId('home-hero')).toBeVisible();

    await expect(page.getByTestId('service-list').getByRole('listitem')).toHaveCount(4);
    await expect(page.getByTestId('key-figures').getByRole('term')).toHaveCount(4);
    await expect(page.getByTestId('client-logos').getByRole('img')).toHaveCount(6);
    await expect(page.getByTestId('client-logos').getByRole('img', { name: 'Ninth Lantern' })).toBeVisible();
    await expect(page.getByTestId('testimonial-list').locator('blockquote')).toHaveCount(3);

    const [organization] = await structuredData(page);
    expect(organization['@type']).toBe('Organization');
    expect(organization.url).toMatch(/^https?:\\/\\//);

    await page.getByTestId('call-to-action-contact').click();
    await expect(page).toHaveURL('/contact');
  });

  test('every page has one main landmark, one h1, and a canonical URL that is absolute', async ({ page }) => {
    for (const path of ['/', '/services/', '/services/distribution', '/about', '/careers', '/news', '/contact', '/privacy', '/terms']) {
      await page.goto(path);
      await expect(page.locator('main#main'), path).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveCount(1);
      await expect(page.locator('link[rel="canonical"]'), path).toHaveAttribute('href', /^https?:\\/\\/[^/]+\\//);
    }
  });

  test('skip link is the first Tab stop and moves to the main content', async ({ page }) => {
    await page.goto('/about');
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('site-header-skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/about#main');
  });

  test('services menu opens and closes with the mouse', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('site-header-submenu-toggle');
    const submenu = page.getByTestId('site-header-submenu');

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(submenu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(submenu).toBeVisible();
    await expect(submenu.getByRole('link')).toHaveCount(4);

    // A click anywhere else closes it.
    await page.getByRole('heading', { level: 1 }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(submenu).toBeHidden();

    await toggle.click();
    await submenu.getByRole('link', { name: 'Distribution' }).click();
    await expect(page).toHaveURL('/services/distribution');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Distribution');
  });

  test('services menu works with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('site-header-submenu-toggle');
    const submenu = page.getByTestId('site-header-submenu');
    const links = submenu.getByRole('link');

    // Open with Enter, then move through the links with the arrow keys.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(submenu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(links.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(links.last()).toBeFocused();

    // Escape closes the menu and returns focus to its button.
    await page.keyboard.press('Escape');
    await expect(submenu).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Arrow Down on the button opens the menu on its first link; tabbing out of the menu closes it.
    await page.keyboard.press('ArrowDown');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Tab');
    await expect(submenu).toBeHidden();
    await expect(page.getByTestId('site-header-nav').getByRole('link', { name: 'About' })).toBeFocused();

    // Enter on a link in the menu follows it.
    await toggle.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/services/manuscript-editing');
  });

  test('without JavaScript the navigation is plain links, at desktop and phone width', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    const nav = page.getByTestId('site-header-nav');
    await expect(page.getByTestId('site-header-submenu-toggle')).toBeHidden();
    await expect(nav.getByRole('link', { name: 'Services' })).toBeVisible();

    // Tabbing into the group shows the service links.
    await nav.getByRole('link', { name: 'Services' }).focus();
    await expect(page.getByTestId('site-header-submenu')).toBeVisible();

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByTestId('site-header-nav-toggle')).toBeHidden();
    await expect(page.getByTestId('site-header-nav-menu')).toBeVisible();
    await nav.getByRole('link', { name: 'Royalty accounting' }).click();
    await expect(page).toHaveURL('/services/royalty-accounting');
    await context.close();
  });

  test('service page has its breadcrumb, in the page and in its structured data', async ({ page }) => {
    await page.goto('/services/manuscript-editing');
    await expect(page).toHaveTitle(/^Manuscript editing - /);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Manuscript editing');
    await expect(page.getByTestId('service-detail').getByRole('heading', { level: 2 })).toHaveCount(3);

    const crumbs = page.getByTestId('bread-crumbs');
    await expect(crumbs.getByRole('listitem')).toHaveText(['Home', 'Services', 'Manuscript editing']);
    await expect(crumbs.getByRole('listitem').last()).toHaveAttribute('aria-current', 'page');
    await expect(crumbs.getByRole('link')).toHaveCount(2);

    const [breadcrumbs] = await structuredData(page);
    expect(breadcrumbs['@type']).toBe('BreadcrumbList');
    const items = breadcrumbs.itemListElement as { name: string; item: string }[];
    expect(items.map((item) => item.name)).toEqual(['Home', 'Services', 'Manuscript editing']);
    for (const item of items) expect(item.item).toMatch(/^https?:\\/\\//);

    // The header marks the section the page is in.
    await expect(page.getByTestId('site-header-nav').getByRole('link', { name: 'Services', exact: true })).toHaveAttribute('aria-current', 'true');

    await crumbs.getByRole('link', { name: 'Services' }).click();
    await expect(page).toHaveURL('/services/');
    await expect(page.getByTestId('service-list').getByRole('listitem')).toHaveCount(4);
  });

  test('contact form says what is wrong beside each field and accepts a complete message', async ({ page }) => {
    await page.goto('/contact');
    const submit = page.getByTestId('contact-form-submit');
    const status = page.getByTestId('contact-form-status');

    // Empty: every field reports, and focus goes to the first one.
    await submit.click();
    await expect(page.getByTestId('contact-form-name-error')).toHaveText('Enter your name.');
    await expect(page.getByTestId('contact-form-email-error')).toHaveText('Enter your email address.');
    await expect(page.getByTestId('contact-form-topic-error')).toHaveText('Choose a topic.');
    await expect(page.getByTestId('contact-form-message-error')).toHaveText('Enter a message.');
    await expect(page.getByTestId('contact-form-name')).toBeFocused();
    await expect(page.getByTestId('contact-form-name')).toHaveAttribute('aria-invalid', 'true');
    await expect(status).toBeHidden();

    // An error clears as soon as its field is fixed.
    await page.getByTestId('contact-form-name').fill('Imogen Vale');
    await expect(page.getByTestId('contact-form-name-error')).toBeHidden();
    await expect(page.getByTestId('contact-form-name')).not.toHaveAttribute('aria-invalid');

    // A malformed address and a message that is too short each get their own message.
    await page.getByTestId('contact-form-email').fill('imogen@');
    await page.getByTestId('contact-form-topic').selectOption('project');
    await page.getByTestId('contact-form-message').fill('Hello');
    await submit.click();
    await expect(page.getByTestId('contact-form-email-error')).toHaveText('Enter an email address like name@example.com.');
    await expect(page.getByTestId('contact-form-message-error')).toContainText('Write at least 20 characters');
    await expect(page.getByTestId('contact-form-topic-error')).toBeHidden();
    await expect(page.getByTestId('contact-form-email')).toBeFocused();
    await expect(status).toBeHidden();

    await page.getByTestId('contact-form-email').fill('imogen@example.com');
    await page.getByTestId('contact-form-message').fill('I have a finished novel of 90,000 words and need an editor.');
    await submit.click();
    await expect(status).toBeVisible();
    await expect(status).toContainText('Thanks');
    await expect(page.getByTestId('contact-form-email-error')).toBeHidden();
    await expect(page.getByTestId('contact-form-name')).toHaveValue('');
    await expect(page).toHaveURL('/contact');
  });

  test('contact page shows the office in an address element', async ({ page }) => {
    await page.goto('/contact');
    const office = page.getByTestId('office-details');
    await expect(office.locator('address')).toHaveCount(1);
    await expect(office.getByTestId('office-details-email')).toHaveAttribute('href', /^mailto:/);
    await expect(office.getByTestId('office-details-phone')).toHaveAttribute('href', /^tel:\\+/);
  });

  test('mobile navigation toggle expands and collapses the menu and its services', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const toggle = page.getByTestId('site-header-nav-toggle');
    const menu = page.getByTestId('site-header-nav-menu');
    const submenu = page.getByTestId('site-header-submenu');

    // Assert what the reader sees, not a class name: the build hashes classes.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(submenu).toBeHidden();

    await page.getByTestId('site-header-submenu-toggle').click();
    await expect(submenu).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();

    // Nothing is wider than the phone's screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('legal pages are marked as placeholders', async ({ page }) => {
    for (const path of ['/privacy', '/terms']) {
      await page.goto(path);
      await expect(page.getByTestId('legal-text-notice'), path).toContainText('Placeholder.');
    }
  });

  test('unknown URL gets the 404 page with a way back', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle(/Page not found/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await page.getByTestId('not-found-home').click();
    await expect(page).toHaveURL('/');
  });
});
`,
  ],
  [
    "src/lib/collection.test.ts",
    `import { describe, it, expect } from 'vitest';
import { checked } from './collection.ts';

interface Book {
  slug: string;
  title: string;
  authors: string[];
}

const books: Book[] = [
  { slug: 'hollow-quay', title: 'Nine Winters at Hollow Quay', authors: ['Imogen Vale'] },
  { slug: 'ferry-2', title: 'A Ferry Called Tuesday', authors: ['Tomas Okafor'] },
];
const check = (entries: unknown[]): Book[] => checked<Book>('books', 'src/lib/books.ts', entries as Book[], ['title', 'authors']);

describe('checked', () => {
  it('returns a copy of a list in which every entry is complete', () => {
    const result = check(books);
    expect(result).toEqual(books);
    expect(result).not.toBe(books);
    expect(check([])).toEqual([]);
  });

  it('names the list, the entry and the field when a field is missing, empty or blank', () => {
    const { title: _title, ...untitled } = books[1];
    expect(() => check([books[0], untitled])).toThrow('books[1] ("ferry-2"): "title" is missing or empty. Fill it in src/lib/books.ts.');
    expect(() => check([{ ...books[0], title: '   ' }])).toThrow('books[0] ("hollow-quay"): "title" is missing or empty');
    expect(() => check([{ ...books[0], authors: [] }])).toThrow('"authors" is missing or empty');
    expect(() => check([{ ...books[0], title: null }])).toThrow('"title" is missing or empty');
  });

  it('names the entry by its position when the slug itself is missing', () => {
    expect(() => check([books[0], { title: 'Untitled', authors: ['A'] }])).toThrow('books[1]: "slug" is missing or empty');
    expect(() => check([null])).toThrow('books[0]: "slug" is missing or empty');
  });

  it('names both entries when a slug is used twice', () => {
    expect(() => check([books[0], books[1], { ...books[1], title: 'Another' }])).toThrow(
      'books[2]: the slug "ferry-2" is already used by books[1]. Give each entry its own slug in src/lib/books.ts.',
    );
  });

  it('refuses a slug that would not make a clean URL', () => {
    for (const slug of ['Hollow Quay', 'hollow_quay', 'hollow--quay', '-hollow', 'hollow/', '../etc', 'hollow?x=1', 'café']) {
      expect(() => check([{ ...books[0], slug }]), slug).toThrow('the slug must be lowercase letters, digits and single hyphens');
    }
    expect(() => check([{ ...books[0], slug: 42 }])).toThrow('the slug must be lowercase');
  });
});
`,
  ],
  [
    "src/lib/navigation.test.ts",
    `import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES } from './services.ts';
import { FOOTER_GROUPS, PRIMARY_NAV, allLinks, currentState, normalizePath, trail } from './navigation.ts';

const pagesDir = join(process.cwd(), 'src/pages');

/**
 * Whether a site path has a page: a file in src/pages (about.html or about/index.html), or a service, whose
 * pages src/pages/services/[slug].html makes from the data.
 */
function pageExists(href: string): boolean {
  const path = normalizePath(href);
  if (path === '/') return existsSync(join(pagesDir, 'index.html'));
  if (SERVICES.some((service) => path === \`/services/\${service.slug}\`)) {
    return existsSync(join(pagesDir, 'services/[slug].html'));
  }
  return existsSync(join(pagesDir, \`\${path}.html\`)) || existsSync(join(pagesDir, path, 'index.html'));
}

describe('navigation', () => {
  it('points every header and footer link at a page that exists', () => {
    const missing = allLinks()
      .filter((link) => !pageExists(link.href))
      .map((link) => \`\${link.label} -> \${link.href}\`);
    expect(missing).toEqual([]);
  });

  it('catches a link to a page that does not exist, a misspelled one and an unknown service', () => {
    expect(pageExists('/pricing')).toBe(false);
    expect(pageExists('/abuot')).toBe(false);
    expect(pageExists('/services/ghostwriting')).toBe(false);
    expect(pageExists('/about/')).toBe(true);
  });

  it('uses site paths only, so no link leaves the site or depends on the domain', () => {
    for (const link of allLinks()) expect(link.href, link.label).toMatch(/^\\/(?!\\/)/);
  });

  it('lists every service in the header menu and in the footer', () => {
    const menu = PRIMARY_NAV.find((item) => item.children)?.children ?? [];
    const footer = FOOTER_GROUPS.find((group) => group.heading === 'Services')?.links ?? [];
    for (const service of SERVICES) {
      expect(menu.map((link) => link.href)).toContain(\`/services/\${service.slug}\`);
      expect(footer.map((link) => link.href)).toContain(\`/services/\${service.slug}\`);
    }
  });

  it('lists each page once, however many places link to it', () => {
    const paths = allLinks().map((link) => normalizePath(link.href));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('treats a trailing slash as the same page', () => {
    expect(normalizePath('/services/')).toBe('/services');
    expect(normalizePath('/services///')).toBe('/services');
    expect(normalizePath('/')).toBe('/');
  });

  it('marks the page itself, the section above it, and nothing else', () => {
    expect(currentState('/about', '/about')).toBe('page');
    expect(currentState('/services/', '/services')).toBe('page');
    expect(currentState('/services/', '/services/distribution')).toBe('true');
    expect(currentState('/', '/about')).toBeUndefined();
    // A path that only starts with the same letters is another page.
    expect(currentState('/news', '/newsletter')).toBeUndefined();
  });

  it('builds a trail for every linked page, and the home page alone for "/"', () => {
    expect(trail('/')).toEqual([{ label: 'Home', href: '/' }]);
    for (const link of allLinks()) {
      const crumbs = trail(link.href);
      expect(crumbs.at(-1)?.label, link.href).toBe(link.label);
      expect(crumbs[0]).toEqual({ label: 'Home', href: '/' });
    }
  });

  it('throws with the path when a page is in no list', () => {
    expect(() => trail('/services/ghostwriting')).toThrow('No navigation entry for "/services/ghostwriting"');
    expect(() => trail('/pricing')).toThrow('src/lib/navigation.ts');
  });
});
`,
  ],
  [
    "src/lib/seo.test.ts",
    `import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { absoluteUrl, breadcrumbList, jsonLd, organization, pageHead } from './seo.ts';
import { SITE } from './site.ts';

const VARIABLES = ['BASCIK_SITE_URL', 'BASCIK_PAGE_PATH', 'BASCIK_BASE'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of VARIABLES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of VARIABLES) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The parsed JSON-LD blocks in a head. */
const schemas = (head: string): Record<string, unknown>[] =>
  [...head.matchAll(/<script type="application\\/ld\\+json">([\\s\\S]*?)<\\/script>/g)].map((match) => JSON.parse(match[1]));

describe('pageHead', () => {
  it('writes the title with the site name, the description, and an absolute canonical URL', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com/';
    process.env.BASCIK_PAGE_PATH = '/about';
    const head = String(pageHead({ title: 'About', description: 'Who we are.' }));
    expect(head).toContain(\`<title>About - \${SITE.name}</title>\`);
    expect(head).toContain('<meta name="description" content="Who we are." />');
    expect(head).toContain('<link rel="canonical" href="https://example.com/about" />');
    expect(head).toContain('<meta property="og:url" content="https://example.com/about" />');
    expect(head).toContain('<meta property="og:title"');
    expect(head).not.toContain('noindex');
  });

  it('leaves out the canonical URL when the site URL is not known, as in dev', () => {
    process.env.BASCIK_PAGE_PATH = '/about';
    const head = String(pageHead({ title: 'About', description: 'Who we are.' }));
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain('og:url');
  });

  it('adds a BreadcrumbList with absolute URLs to an inner page and none to the home page', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    process.env.BASCIK_PAGE_PATH = '/services/distribution';
    const [list] = schemas(String(pageHead({ title: 'Distribution', description: 'x' })));
    expect(list['@type']).toBe('BreadcrumbList');
    expect(list.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
      { '@type': 'ListItem', position: 2, name: 'Services', item: 'https://example.com/services/' },
      { '@type': 'ListItem', position: 3, name: 'Distribution', item: 'https://example.com/services/distribution' },
    ]);
    process.env.BASCIK_PAGE_PATH = '/';
    expect(schemas(String(pageHead({ title: 'Home', description: 'x' })))).toEqual([]);
  });

  it('marks a noindex page and gives it no canonical URL or breadcrumb, even when its path is in no navigation list', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    process.env.BASCIK_PAGE_PATH = '/404';
    const head = String(pageHead({ title: 'Page not found', description: 'x', noindex: true }));
    expect(head).toContain('<meta name="robots" content="noindex" />');
    expect(head).not.toContain('rel="canonical"');
    expect(schemas(head)).toEqual([]);
  });

  it('throws for an indexed page that is in no navigation list, naming the path', () => {
    process.env.BASCIK_PAGE_PATH = '/pricing';
    expect(() => pageHead({ title: 'Pricing', description: 'x' })).toThrow('No navigation entry for "/pricing"');
  });

  it('escapes a title and description with markup in them', () => {
    const head = String(pageHead({ title: '</title><script>alert(1)</script>', description: '"><img src=x>' }));
    expect(head).not.toContain('<script>alert');
    expect(head).not.toContain('<img');
    expect(head).toContain('content="&quot;&gt;&lt;img src=x&gt;"');
  });
});

describe('structured data', () => {
  it('describes the organization with what the footer shows, and its URL once the site URL is known', () => {
    expect(organization()).toEqual({
      '@type': 'Organization',
      name: SITE.name,
      description: SITE.description,
      email: SITE.email,
      telephone: SITE.phone.display,
    });
    process.env.BASCIK_SITE_URL = 'https://example.com';
    expect(organization().url).toBe('https://example.com/');
  });

  it('writes JSON a value cannot break out of', () => {
    const block = String(jsonLd({ '@type': 'Organization', name: '</script><script>alert(1)</script>' }));
    expect(block.match(/<\\/script>/g)).toHaveLength(1);
    expect(schemas(block)[0].name).toBe('</script><script>alert(1)</script>');
  });

  it('has no breadcrumb for the home page', () => {
    expect(breadcrumbList('/')).toBeUndefined();
  });

  it('adds the deployment base to URLs', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    process.env.BASCIK_BASE = '/books/';
    expect(absoluteUrl('/about')).toBe('https://example.com/books/about');
    expect(absoluteUrl('about')).toBe('https://example.com/books/about');
  });
});
`,
  ],
  [
    "src/lib/services.test.ts",
    `import { describe, it, expect } from 'vitest';
import { checked } from './collection.ts';
import { SERVICES, servicePath, type Service } from './services.ts';

describe('services', () => {
  it('gives every service its own slug, which is its URL', () => {
    const slugs = SERVICES.map((service) => service.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(servicePath(SERVICES[0])).toBe(\`/services/\${SERVICES[0].slug}\`);
  });

  it('keeps each summary within what a search result shows, since it is the page description', () => {
    for (const service of SERVICES) {
      expect(service.summary.length, service.slug).toBeGreaterThanOrEqual(50);
      expect(service.summary.length, service.slug).toBeLessThanOrEqual(160);
    }
  });

  it('gives every service something to list and at least one step', () => {
    for (const service of SERVICES) {
      expect(service.includes.length, service.slug).toBeGreaterThan(0);
      for (const step of service.steps) {
        expect(step.title, service.slug).not.toBe('');
        expect(step.text, service.slug).not.toBe('');
      }
    }
  });

  // What the build does with a mistake in the list: the same check runs when a page imports this module.
  const fields = ['name', 'summary', 'description', 'includes', 'steps', 'turnaround'] as const;
  const check = (entries: unknown[]): Service[] => checked<Service>('services', 'src/lib/services.ts', entries as Service[], fields);

  it('fails with the service and the field when one is left out', () => {
    const { summary: _summary, ...incomplete } = SERVICES[1];
    expect(() => check([SERVICES[0], incomplete])).toThrow(
      \`services[1] ("\${SERVICES[1].slug}"): "summary" is missing or empty. Fill it in src/lib/services.ts.\`,
    );
  });

  it('fails with the slug when two services share one', () => {
    const copy = { ...SERVICES[2], slug: SERVICES[0].slug };
    expect(() => check([...SERVICES.slice(0, 2), copy])).toThrow(
      \`services[2]: the slug "\${SERVICES[0].slug}" is already used by services[0].\`,
    );
  });
});
`,
  ],
  [
    "src/components/bread-crumbs/bread-crumbs.test.ts",
    `import { describe, it, expect } from 'vitest';
import { SERVICES } from '../../lib/services.ts';
import { breadcrumb, breadcrumbItems } from './crumbs.ts';

describe('bread-crumbs component', () => {
  it('links every page above a service page and marks the service as the current page', () => {
    const [service] = SERVICES;
    const markup = String(breadcrumb(\`/services/\${service.slug}\`));
    expect(markup).toContain('<li><a href="/">Home</a></li>');
    expect(markup).toContain('<li><a href="/services/">Services</a></li>');
    expect(markup).toContain(\`<li aria-current="page">\${service.name}</li>\`);
    expect(markup.match(/<li/g)).toHaveLength(3);
  });

  it('reads a path with a trailing slash the same way', () => {
    expect(String(breadcrumb('/services/'))).toBe(String(breadcrumb('/services')));
  });

  it('throws with the path when a page is in no navigation list', () => {
    expect(() => breadcrumb('/pricing')).toThrow('No navigation entry for "/pricing"');
  });

  it('escapes a label with markup in it', () => {
    const markup = String(breadcrumbItems([{ label: 'Home', href: '/' }, { label: '<b>R&D</b>', href: '/r-and-d' }]));
    expect(markup).toContain('<li aria-current="page">&lt;b&gt;R&amp;D&lt;/b&gt;</li>');
  });
});
`,
  ],
  [
    "src/components/call-to-action/call-to-action.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('call-to-action component', () => {
  const path = join(process.cwd(), 'src/components/call-to-action/call-to-action.html');

  it('is a section named by its heading that links to the contact page', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<section[^>]*aria-labelledby="heading"/);
    expect(html).toContain('<h2 id="heading">');
    expect(html).toMatch(/<a href="\\/contact"[^>]*data-testid="call-to-action-contact"/);
  });
});
`,
  ],
  [
    "src/components/client-logos/client-logos.test.ts",
    `import { describe, it, expect } from 'vitest';
import { esc } from '@bascik/bascik/html';
import { CLIENTS, clientLogos } from './clients.ts';

describe('client-logos component', () => {
  it('draws each client as an SVG named by its aria-label', () => {
    const markup = String(clientLogos());
    expect(markup.match(/<svg /g)).toHaveLength(CLIENTS.length);
    for (const client of CLIENTS) {
      expect(markup).toContain(\`role="img" aria-label="\${esc(client.name)}"\`);
    }
    expect(markup).not.toContain('<img');
  });

  it('escapes a client name in both the label and the drawing', () => {
    const markup = String(clientLogos([{ name: 'Ink & "Quill" <Co>', style: 'serif' }]));
    expect(markup).toContain('aria-label="Ink &amp; &quot;Quill&quot; &lt;Co&gt;"');
    expect(markup).toContain('>Ink &amp; ');
    expect(markup).not.toContain('<Co>');
  });
});
`,
  ],
  [
    "src/components/company-timeline/company-timeline.test.ts",
    `import { describe, it, expect } from 'vitest';
import { MILESTONES, timeline } from './milestones.ts';

describe('company-timeline component', () => {
  it('prints each milestone with its year in a time element', () => {
    const markup = String(timeline());
    expect(markup.match(/<li class="milestone">/g)).toHaveLength(MILESTONES.length);
    for (const milestone of MILESTONES) {
      expect(markup).toContain(\`<time datetime="\${milestone.year}">\${milestone.year}</time>\`);
      expect(markup).toContain(\`<h3>\${milestone.title}</h3>\`);
    }
  });

  it('lists the milestones oldest first, with years a time element accepts', () => {
    const years = MILESTONES.map((milestone) => milestone.year);
    for (const year of years) expect(year).toMatch(/^\\d{4}$/);
    expect(years).toEqual([...years].sort());
  });

  it('escapes a title with markup in it', () => {
    const markup = String(timeline([{ year: '2026', title: 'Mergers & <em>more</em>', text: 'x' }]));
    expect(markup).toContain('<h3>Mergers &amp; &lt;em&gt;more&lt;/em&gt;</h3>');
  });
});
`,
  ],
  [
    "src/components/contact-form/contact-form.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('contact-form component', () => {
  const folder = join(process.cwd(), 'src/components/contact-form');
  const fields = ['name', 'email', 'topic', 'message'];

  it('labels every field, requires it, and ties it to its own error line', async () => {
    const html = await readFile(join(folder, 'contact-form.html'), 'utf8');
    for (const id of fields) {
      expect(html).toContain(\`<label for="\${id}">\`);
      expect(html).toMatch(new RegExp(\`id="\${id}" name="\${id}"[^>]*required[^>]*aria-describedby="\${id}-error"\`));
      expect(html).toMatch(new RegExp(\`<p id="\${id}-error" class="error"[^>]*hidden></p>\`));
    }
    expect(html).toContain('type="email"');
    expect(html).toContain('minlength="20"');
    expect(html).toContain('role="status"');
  });

  it('never names a control after a form property', async () => {
    const html = await readFile(join(folder, 'contact-form.html'), 'utf8');
    const names = [...html.matchAll(/ name="([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(fields);
    for (const reserved of ['action', 'method', 'submit', 'reset', 'elements']) {
      expect(names).not.toContain(reserved);
    }
  });

  it('checks each field by id in a TypeScript script that stops the submit', async () => {
    const html = await readFile(join(folder, 'contact-form.html'), 'utf8');
    const script = await readFile(join(folder, 'contact-form.ts'), 'utf8');
    expect(html).toContain('<script src="contact-form.ts"></script>');
    // A literal id is what Bascik rewrites per instance: a computed one would miss.
    for (const id of fields) {
      expect(script).toContain(\`getElementById("\${id}")\`);
      expect(script).toContain(\`getElementById("\${id}-error")\`);
    }
    expect(script).toContain('form.noValidate = true');
    expect(script).toContain('event.preventDefault()');
    expect(script).toContain('aria-invalid');
  });
});
`,
  ],
  [
    "src/components/home-hero/home-hero.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('home-hero component', () => {
  const path = join(process.cwd(), 'src/components/home-hero/home-hero.html');

  it('holds the page heading and links to the contact and services pages', async () => {
    const html = await readFile(path, 'utf8');
    expect(html.match(/<h1[\\s>]/g)).toHaveLength(1);
    expect(html).toContain('href="/contact"');
    expect(html).toContain('href="/services/"');
  });

  it('draws its picture as inline SVG with a text alternative, and loads no image', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-labelledby="shelf-title"/);
    expect(html).toMatch(/<title id="shelf-title">[^<]+<\\/title>/);
    expect(html).not.toContain('<img');
  });
});
`,
  ],
  [
    "src/components/key-figures/key-figures.test.ts",
    `import { describe, it, expect } from 'vitest';
import { FIGURES, figureList } from './figures.ts';

describe('key-figures component', () => {
  it('prints a term and a value for every figure', () => {
    const markup = String(figureList());
    expect(markup.match(/<dt>/g)).toHaveLength(FIGURES.length);
    expect(markup.match(/<dd>/g)).toHaveLength(FIGURES.length);
    for (const figure of FIGURES) {
      expect(markup).toContain(\`<dd>\${figure.value}</dd>\`);
    }
  });

  it('prints nothing for an empty list and escapes what it is given', () => {
    expect(String(figureList([]))).toBe('');
    const markup = String(figureList([{ value: '<1%', label: 'Returns & refunds' }]));
    expect(markup).toContain('<dd>&lt;1%</dd>');
    expect(markup).toContain('<dt>Returns &amp; refunds</dt>');
  });
});
`,
  ],
  [
    "src/components/legal-text/legal-text.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('legal-text component', () => {
  const path = join(process.cwd(), 'src/components/legal-text/legal-text.html');

  it('opens with a labeled notice that the text is a placeholder and not a legal document', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<aside[^>]*aria-label="Placeholder notice"/);
    expect(html).toContain('<strong>Placeholder.</strong>');
    expect(html).toContain('not a legal document');
    // The notice comes before the page's own text.
    expect(html.indexOf('<aside')).toBeLessThan(html.indexOf('<div data-bascik-slot></div>'));
  });

  it('holds the text of both legal pages, so each one carries the notice', async () => {
    for (const page of ['privacy', 'terms']) {
      const source = await readFile(join(process.cwd(), \`src/pages/\${page}.html\`), 'utf8');
      expect(source, page).toMatch(/<legal-text>[\\s\\S]*<h2>[\\s\\S]*<\\/legal-text>/);
    }
  });
});
`,
  ],
  [
    "src/components/news-list/news-list.test.ts",
    `import { describe, it, expect } from 'vitest';
import { NEWS, assertDate, formatDate, newsList, sortedNews, type NewsEntry } from './news.ts';

describe('news-list component', () => {
  it('prints each entry as an article with a machine-readable date', () => {
    const markup = String(newsList());
    expect(markup.match(/<article /g)).toHaveLength(NEWS.length);
    for (const entry of NEWS) {
      expect(markup).toContain(\`<time datetime="\${entry.date}">\${formatDate(entry.date)}</time>\`);
      expect(markup).toContain(\`<h3>\${entry.title}</h3>\`);
    }
  });

  it('lists the newest entry first, whatever the order of the data', () => {
    const entry = (slug: string, date: string): NewsEntry => ({ ...NEWS[0], slug, date });
    const sorted = sortedNews([entry('old', '2024-01-31'), entry('new', '2026-03-01'), entry('mid', '2025-12-31')]);
    expect(sorted.map(({ slug }) => slug)).toEqual(['new', 'mid', 'old']);
  });

  it('formats a date in UTC, so the day does not depend on where the build runs', () => {
    expect(formatDate('2026-01-01')).toBe('January 1, 2026');
    expect(formatDate('2026-12-31')).toBe('December 31, 2026');
  });

  it('refuses a date that is not a real YYYY-MM-DD day, naming the entry', () => {
    for (const date of ['2026-02-30', '06/10/2026', '2026-1-5', 'soon', '']) {
      expect(() => assertDate({ slug: 'launch', date }), date).toThrow(\`news ("launch"): the date "\${date}"\`);
    }
    expect(() => assertDate({ slug: 'launch', date: '2028-02-29' })).not.toThrow();
  });

  it('escapes an entry title with markup in it', () => {
    const markup = String(newsList([{ ...NEWS[0], title: 'Q&A: <b>what next?</b>' }]));
    expect(markup).toContain('<h3>Q&amp;A: &lt;b&gt;what next?&lt;/b&gt;</h3>');
  });
});
`,
  ],
  [
    "src/components/office-details/office-details.test.ts",
    `import { describe, it, expect } from 'vitest';
import { SITE } from '../../lib/site.ts';
import { officeDetails } from './office.ts';

describe('office-details component', () => {
  it('puts the postal address, phone and email in one address element', () => {
    const markup = String(officeDetails());
    expect(markup.match(/<address>/g)).toHaveLength(1);
    const address = markup.slice(markup.indexOf('<address>'), markup.indexOf('</address>'));
    expect(address).toContain(SITE.address.street);
    expect(address).toContain(\`\${SITE.address.city}, \${SITE.address.region} \${SITE.address.postalCode}\`);
    expect(address).toContain(\`href="\${SITE.phone.href}"\`);
    expect(address).toContain(\`href="mailto:\${SITE.email}"\`);
    expect(markup).toContain(\`<p>\${SITE.hours}</p>\`);
  });

  it('escapes a company name and street with markup in them', () => {
    const markup = String(
      officeDetails({ ...SITE, name: 'Ink & <b>Quill</b>', address: { ...SITE.address, street: '1 "Main" St <rear>' } }),
    );
    expect(markup).toContain('Ink &amp; &lt;b&gt;Quill&lt;/b&gt;');
    expect(markup).not.toContain('<rear>');
  });
});
`,
  ],
  [
    "src/components/page-intro/page-intro.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('page-intro component', () => {
  const path = join(process.cwd(), 'src/components/page-intro/page-intro.html');

  it('puts the breadcrumb before the one heading, and takes the heading and intro as props', async () => {
    const html = await readFile(path, 'utf8');
    expect(html.match(/<h1[\\s>]/g)).toHaveLength(1);
    expect(html).toContain('<h1 data-bascik-prop-title>');
    expect(html).toContain('data-bascik-prop-text');
    expect(html.indexOf('<bread-crumbs />')).toBeGreaterThan(-1);
    expect(html.indexOf('<bread-crumbs />')).toBeLessThan(html.indexOf('<h1'));
  });
});
`,
  ],
  [
    "src/components/page-section/page-section.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('page-section component', () => {
  const path = join(process.cwd(), 'src/components/page-section/page-section.html');

  it('is a section named by its own heading, with a slot for the content', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<section[^>]*aria-labelledby="title"/);
    expect(html).toMatch(/<h2 id="title" data-bascik-prop-title>/);
    expect(html).toContain('data-bascik-prop-label');
    expect(html).toContain('data-bascik-prop-text');
    expect(html).toContain('<div data-bascik-slot></div>');
    expect(html).toContain('data-testid="page-section"');
  });
});
`,
  ],
  [
    "src/components/role-list/role-list.test.ts",
    `import { describe, it, expect } from 'vitest';
import { ROLES, applyHref, roleList, type Role } from './roles.ts';

describe('role-list component', () => {
  it('prints each open role with its facts and an apply link', () => {
    const markup = String(roleList());
    expect(markup.match(/<li class="role">/g)).toHaveLength(ROLES.length);
    for (const role of ROLES) {
      expect(markup).toContain(\`<h3>\${role.title}</h3>\`);
      expect(markup).toContain(\`\${role.team} · \${role.location} · \${role.type}\`);
    }
    expect(markup.match(/data-testid="role-list-apply"/g)).toHaveLength(ROLES.length);
  });

  it('says so when there are no open roles, in place of an empty list', () => {
    const markup = String(roleList([]));
    expect(markup).toContain('There are no open roles right now.');
    expect(markup).toContain('href="/contact"');
  });

  it('puts the role in the subject of the application email, encoded for a URL', () => {
    const role: Role = { ...ROLES[0], title: 'Editor & "proofreader"' };
    expect(applyHref(role, 'jobs@example.com')).toBe(
      'mailto:jobs@example.com?subject=Application%3A%20Editor%20%26%20%22proofreader%22',
    );
  });

  it('escapes a role title with markup in it', () => {
    const markup = String(roleList([{ ...ROLES[0], title: '<script>alert(1)</script>' }]));
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('<h3>&lt;script&gt;alert(1)&lt;/script&gt;</h3>');
  });
});
`,
  ],
  [
    "src/components/service-detail/service-detail.test.ts",
    `import { describe, it, expect } from 'vitest';
import { SERVICES, type Service } from '../../lib/services.ts';
import { routeService, serviceDetail } from './detail.ts';

describe('service-detail component', () => {
  it('prints the intro, every included item and every step of a service', () => {
    const [service] = SERVICES;
    const markup = String(serviceDetail(service));
    expect(markup).toContain(\`data-bascik-prop-title="\${service.name}"\`);
    expect(markup.match(/<h2>/g)).toHaveLength(3);
    for (const item of service.includes) expect(markup).toContain(\`<li>\${item}</li>\`);
    for (const step of service.steps) expect(markup).toContain(\`<strong>\${step.title}.</strong>\`);
    // The heading is <page-intro>'s <h1>: a second one here would give the page two.
    expect(markup).not.toContain('<h1');
  });

  it('reads the service from the route data', () => {
    const [service] = SERVICES;
    const route = JSON.stringify({ params: { slug: service.slug }, data: service });
    expect(routeService(route)).toEqual(service);
  });

  it('throws when it is used on a page that has no route data', () => {
    expect(() => routeService('')).toThrow('found no service in BASCIK_ROUTE');
    expect(() => routeService('{"params":{}}')).toThrow('src/pages/services/[slug].html');
  });

  it('escapes a service whose text contains markup, in props and in text', () => {
    const hostile: Service = {
      ...SERVICES[0],
      name: '"><script>alert(1)</script>',
      includes: ['<img src=x>'],
    };
    const markup = String(serviceDetail(hostile));
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('data-bascik-prop-title="&quot;&gt;&lt;script&gt;');
  });
});
`,
  ],
  [
    "src/components/service-list/service-list.test.ts",
    `import { describe, it, expect } from 'vitest';
import { SERVICES, type Service } from '../../lib/services.ts';
import { serviceCards } from './cards.ts';

describe('service-list component', () => {
  it('prints one card per service, linking to its page', () => {
    const markup = String(serviceCards());
    expect(markup.match(/<li class="card service">/g)).toHaveLength(SERVICES.length);
    for (const service of SERVICES) {
      expect(markup).toContain(\`href="/services/\${service.slug}"\`);
      expect(markup).toContain(\`<h3>\${service.name}</h3>\`);
    }
  });

  it('escapes a service name and summary that contain markup', () => {
    const hostile: Service = {
      ...SERVICES[0],
      name: '<img src=x onerror=alert(1)>',
      summary: 'Fast & "careful" <b>edits</b>',
    };
    const markup = String(serviceCards([hostile]));
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<b>');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).toContain('Fast &amp; ');
  });
});
`,
  ],
  [
    "src/components/site-footer/site-footer.test.ts",
    `import { describe, it, expect } from 'vitest';
import { FOOTER_GROUPS } from '../../lib/navigation.ts';
import { SITE } from '../../lib/site.ts';
import { footerAbout, footerColumns, legalLine } from './footer-nav.ts';

describe('site-footer component', () => {
  it('prints one column per group, each with a heading and its links', () => {
    const markup = String(footerColumns());
    expect(markup.match(/<h2>/g)).toHaveLength(FOOTER_GROUPS.length);
    for (const group of FOOTER_GROUPS) {
      expect(markup).toContain(\`<h2>\${group.heading}</h2>\`);
      for (const link of group.links) expect(markup).toContain(\`<a href="\${link.href}">\`);
    }
  });

  it('links the email address and the phone number', () => {
    const markup = String(footerAbout());
    expect(markup).toContain(\`href="mailto:\${SITE.email}"\`);
    expect(markup).toContain(\`href="\${SITE.phone.href}"\`);
  });

  it('escapes a company name with markup in it, in the contact block and the legal line', () => {
    const site = { ...SITE, name: 'Ink & <b>Quill</b>' };
    expect(String(footerAbout(site))).toContain('Ink &amp; &lt;b&gt;Quill&lt;/b&gt;');
    expect(String(legalLine(site, 2026))).toBe('&copy; 2026 Ink &amp; &lt;b&gt;Quill&lt;/b&gt;. All rights reserved.');
  });

  it('turns a javascript: link in the data into a harmless one', () => {
    const markup = String(footerColumns([{ heading: 'Bad', links: [{ label: 'x', href: 'javascript:alert(1)' }] }]));
    expect(markup).not.toContain('javascript:');
  });
});
`,
  ],
  [
    "src/components/site-head/site-head.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-head component', () => {
  const path = join(process.cwd(), 'src/components/site-head/site-head.html');

  it('has the charset, viewport, icon and stylesheet tags, and leaves the title and description to each page', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('favicon.ico');
    expect(html).toContain('favicon.svg');
    expect(html).toContain('apple-touch-icon.png');
    expect(html).toContain('href="/css/styles.css"');
    // pageHead() writes these per page: a second copy here would ship twice.
    expect(html).not.toContain('<title');
    expect(html).not.toContain('name="description"');
  });
});
`,
  ],
  [
    "src/components/site-header/site-header.test.ts",
    `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIMARY_NAV, type NavItem } from '../../lib/navigation.ts';
import { primaryNav } from './primary-nav.ts';

describe('site-header component', () => {
  const folder = join(process.cwd(), 'src/components/site-header');

  it('starts with the skip link, which is clipped until it has focus', async () => {
    const html = await readFile(join(folder, 'site-header.html'), 'utf8');
    const header = html.slice(html.indexOf('<header'));
    expect(header).toMatch(/^<header[^>]*>\\s*<a href="#main" class="skip-link"/);
    const css = await readFile(join(folder, 'site-header.css'), 'utf8');
    expect(css).toMatch(/\\.skip-link:not\\(:focus\\) \\{[^}]*clip-path: inset\\(50%\\)/);
  });

  it('keeps the menu toggle hidden until the script shows it, so the menu is plain links without JavaScript', async () => {
    const html = await readFile(join(folder, 'site-header.html'), 'utf8');
    expect(html).toMatch(/<button id="nav-toggle"[^>]*aria-controls="nav-menu"[^>]*aria-expanded="false"[^>]*hidden>/);
    const script = await readFile(join(folder, 'site-header.ts'), 'utf8');
    expect(script).toContain('toggle.hidden = false');
    expect(script).toContain('caret.hidden = false');
    expect(script).toContain('"Escape"');
    expect(script).toContain('"ArrowDown"');
  });

  it('prints every top-level link, and a hidden button and a list for an entry with children', () => {
    const markup = String(primaryNav('/'));
    for (const item of PRIMARY_NAV) expect(markup).toContain(\`<a href="\${item.href}">\${item.label}</a>\`);
    const withChildren = PRIMARY_NAV.filter((item) => item.children?.length);
    expect(withChildren).toHaveLength(1);
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Services menu"[^>]*hidden/);
    for (const child of withChildren[0].children!) expect(markup).toContain(\`<a href="\${child.href}">\${child.label}</a>\`);
  });

  it('marks the current page, and the section a deeper page is in', () => {
    expect(String(primaryNav('/about'))).toContain('<a href="/about" aria-current="page">About</a>');
    const service = PRIMARY_NAV[0].children![0];
    const markup = String(primaryNav(service.href));
    expect(markup).toContain('<a href="/services/" aria-current="true">Services</a>');
    expect(markup).toContain(\`<a href="\${service.href}" aria-current="page">\${service.label}</a>\`);
    // The home page marks nothing: no link in the menu points at it.
    expect(String(primaryNav('/'))).not.toContain('aria-current');
  });

  it('prints an entry with an empty children list as a plain link, and escapes labels', () => {
    const items: NavItem[] = [{ label: 'R&D <lab>', href: '/lab', children: [] }];
    const markup = String(primaryNav('/', items));
    expect(markup).not.toContain('<button');
    expect(markup).toContain('<li><a href="/lab">R&amp;D &lt;lab&gt;</a></li>');
  });
});
`,
  ],
  [
    "src/components/team-list/team-list.test.ts",
    `import { describe, it, expect } from 'vitest';
import { TEAM, initials, teamList } from './team.ts';

describe('team-list component', () => {
  it('prints a name, a role and a biography for each person', () => {
    const markup = String(teamList());
    expect(markup.match(/<li class="member">/g)).toHaveLength(TEAM.length);
    for (const member of TEAM) {
      expect(markup).toContain(\`<h3>\${member.name}</h3>\`);
      expect(markup).toContain(\`<p class="role">\${member.role}</p>\`);
    }
  });

  it('hides the initials from assistive technology, since the name follows', () => {
    expect(String(teamList([TEAM[0]]))).toContain('<span class="avatar" aria-hidden="true">MO</span>');
  });

  it('takes initials from the first and last names, whatever the spacing', () => {
    expect(initials('Lucia Ferreira-Nakamura')).toBe('LF');
    expect(initials('  ana maria   de souza ')).toBe('AS');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('');
  });

  it('escapes a name with markup in it', () => {
    const markup = String(teamList([{ name: '<u>Sam</u> & Co', role: 'Editor', bio: 'Reads.' }]));
    expect(markup).toContain('<h3>&lt;u&gt;Sam&lt;/u&gt; &amp; Co</h3>');
  });
});
`,
  ],
  [
    "src/components/testimonial-list/testimonial-list.test.ts",
    `import { describe, it, expect } from 'vitest';
import { esc } from '@bascik/bascik/html';
import { TESTIMONIALS, testimonialList } from './testimonials.ts';

describe('testimonial-list component', () => {
  it('prints each quote as a figure with a blockquote and a caption naming the author and the book', () => {
    const markup = String(testimonialList());
    expect(markup.match(/<figure /g)).toHaveLength(TESTIMONIALS.length);
    expect(markup.match(/<blockquote>/g)).toHaveLength(TESTIMONIALS.length);
    for (const item of TESTIMONIALS) {
      expect(markup).toContain(\`<cite>\${esc(item.book)}</cite>\`);
      expect(markup).toContain(\`\${item.author}, author of\`);
    }
  });

  it('escapes a quote that contains markup', () => {
    const markup = String(
      testimonialList([{ quote: '</blockquote><script>alert(1)</script>', author: 'A & B', book: '<i>Draft</i>' }]),
    );
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<i>');
    expect(markup).toContain('A &amp; B');
  });
});
`,
  ],
];
