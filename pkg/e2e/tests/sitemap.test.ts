/**
 * e2e tests for sitemap.xml and robots.txt generation.
 *
 * The webServer command in playwright.config.ts sets
 * `BASCIK_SITE_URL=http://localhost:4200` through the environment (not a
 * checked-in .env or config key), which triggers Bascik to write
 * dist/sitemap.xml and dist/robots.txt at the end of `--build`. These tests
 * verify the generated files are correct.
 *
 * The static server (server.ts) serves dist/ files so both files are
 * accessible via plain HTTP GET requests.
 */
import { test, expect } from '@playwright/test';

test.describe('sitemap.xml', () => {
  test('is served and contains valid XML sitemap structure', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    expect(resp.ok()).toBe(true);
    const text = await resp.text();
    expect(text).toContain('<?xml version="1.0"');
    expect(text).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
  });

  test('includes the siteUrl in every <loc>', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    expect(text).toContain('http://localhost:4200');
  });

  test('every <loc> is an absolute URL with the BASCIK_SITE_URL origin', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    const locs = (text.match(/<loc>[^<]+<\/loc>/g) ?? []).map(l =>
      l.replace(/<\/?loc>/g, '')
    );
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      const url = URL.parse(loc);
      expect(url, `<loc>${loc}</loc> is not a valid absolute URL`).not.toBeNull();
      expect(url?.origin).toBe('http://localhost:4200');
    }
  });

  test('contains at least one page URL', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    expect(text).toContain('<loc>');
    // The scope-test page is always present in the fixture site
    expect(text).toContain('/scope-test');
  });

  test('maps index.html at the root to /', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    // Root index.html → / (not /index)
    expect(text).toContain('<loc>http://localhost:4200/</loc>');
    expect(text).not.toContain('/index</loc>');
  });

  test('maps pages/nested/index.html to /nested (strip trailing /index)', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    expect(text).toContain('<loc>http://localhost:4200/nested</loc>');
  });

  test('does not include the 404 page', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    // /404 must be excluded — it is an error document, not a crawlable URL
    const locLines = text.match(/<loc>[^<]+<\/loc>/g) ?? [];
    for (const loc of locLines) {
      expect(loc).not.toContain('/404');
    }
  });

  test('URLs are sorted alphabetically', async ({ request }) => {
    const resp = await request.get('/sitemap.xml');
    const text = await resp.text();
    const locs = (text.match(/<loc>[^<]+<\/loc>/g) ?? []).map(l =>
      l.replace(/<\/?loc>/g, '').replace('http://localhost:4200', '')
    );
    const sorted = [...locs].sort();
    expect(locs).toEqual(sorted);
  });
});

test.describe('robots.txt', () => {
  test('is served successfully', async ({ request }) => {
    const resp = await request.get('/robots.txt');
    expect(resp.ok()).toBe(true);
  });

  test('allows all user agents', async ({ request }) => {
    const resp = await request.get('/robots.txt');
    const text = await resp.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Allow: /');
  });

  test('includes the sitemap URL', async ({ request }) => {
    const resp = await request.get('/robots.txt');
    const text = await resp.text();
    expect(text).toContain('Sitemap: http://localhost:4200/sitemap.xml');
  });
});
