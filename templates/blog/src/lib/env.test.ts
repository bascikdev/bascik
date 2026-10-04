import { afterEach, describe, expect, it } from 'vitest';
import { includeDrafts, pagePath, requireSiteOrigin, siteOrigin } from './env.ts';

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['BASCIK_BUILD', 'BASCIK_SITE_URL', 'BASCIK_PAGE_PATH']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('includeDrafts', () => {
  it('is true in development and false only for a production build', () => {
    process.env.BASCIK_BUILD = '0';
    expect(includeDrafts()).toBe(true);
    delete process.env.BASCIK_BUILD;
    expect(includeDrafts()).toBe(true);
    process.env.BASCIK_BUILD = '1';
    expect(includeDrafts()).toBe(false);
  });
});

describe('siteOrigin', () => {
  it('is null when no URL was given, including an empty value', () => {
    delete process.env.BASCIK_SITE_URL;
    expect(siteOrigin()).toBeNull();
    process.env.BASCIK_SITE_URL = '';
    expect(siteOrigin()).toBeNull();
  });

  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['HTTPS://Example.COM', 'https://example.com'],
    ['http://localhost:4321', 'http://localhost:4321'],
  ])('normalizes %s', (value, expected) => {
    process.env.BASCIK_SITE_URL = value;
    expect(siteOrigin()).toBe(expected);
  });

  it.each([
    ['example.com', /not a valid URL/],
    ['ftp://example.com', /must start with https/],
    ['javascript:alert(1)', /must start with https/],
    ['https://example.com/blog', /no path/],
    ['https://example.com/?x=1', /no path/],
    ['https://example.com/#top', /no path/],
  ])('rejects %s', (value, message) => {
    process.env.BASCIK_SITE_URL = value;
    expect(() => siteOrigin()).toThrow(message);
  });

  it('is required for the feed', () => {
    delete process.env.BASCIK_SITE_URL;
    expect(() => requireSiteOrigin()).toThrow(/BASCIK_SITE_URL is required/);
    process.env.BASCIK_SITE_URL = 'https://example.com';
    expect(requireSiteOrigin()).toBe('https://example.com');
  });
});

describe('pagePath', () => {
  it('always ends with a slash and defaults to the home page', () => {
    delete process.env.BASCIK_PAGE_PATH;
    expect(pagePath()).toBe('/');
    process.env.BASCIK_PAGE_PATH = '/blog';
    expect(pagePath()).toBe('/blog/');
    process.env.BASCIK_PAGE_PATH = '/blog/';
    expect(pagePath()).toBe('/blog/');
  });
});
