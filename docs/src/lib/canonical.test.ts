import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canonical } from './canonical.js';

describe('canonical', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';
    process.env.BASCIK_PAGES_DIR = '/app/src/pages';
    process.env.BASCIK_SOURCE_FILE = '/app/src/pages/about.html';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns empty string if env vars are missing', async () => {
    delete process.env.BASCIK_SITE_URL;
    expect(await canonical()).toBe('');
  });

  it('generates canonical link for a standard page', async () => {
    const link = await canonical();
    expect(link).toBe('<link rel="canonical" href="https://bascik.dev/about" />');
  });

  it('generates canonical link for index page', async () => {
    process.env.BASCIK_SOURCE_FILE = '/app/src/pages/index.html';
    const link = await canonical();
    expect(link).toBe('<link rel="canonical" href="https://bascik.dev/" />');
  });

  it('generates canonical link for sub-directory index page', async () => {
    process.env.BASCIK_SOURCE_FILE = '/app/src/pages/blog/index.html';
    const link = await canonical();
    expect(link).toBe('<link rel="canonical" href="https://bascik.dev/blog/" />');
  });

  it('falls back to BASCIK_PAGE_FILE if BASCIK_SOURCE_FILE is unset', async () => {
    delete process.env.BASCIK_SOURCE_FILE;
    process.env.BASCIK_PAGE_FILE = '/app/src/pages/about.html';
    const link = await canonical();
    expect(link).toBe('<link rel="canonical" href="https://bascik.dev/about" />');
  });

  it('uses routeOverride when provided', async () => {
    const link = await canonical('custom-route');
    expect(link).toBe('<link rel="canonical" href="https://bascik.dev/custom-route" />');
  });
});
