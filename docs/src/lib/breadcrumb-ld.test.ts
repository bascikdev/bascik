import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { breadcrumbLd } from './breadcrumb-ld.js';

describe('breadcrumbLd', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'breadcrumb-ld-test-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty string if env vars are missing', async () => {
    delete process.env.BASCIK_SITE_URL;
    delete process.env.BASCIK_PAGE_FILE;
    delete process.env.BASCIK_PAGES_DIR;

    const result = await breadcrumbLd();
    expect(result).toBe('');
  });

  it('returns empty string for top-level pages (less than 2 path segments)', async () => {
    const pageFile = join(tempDir, 'index.html');
    await writeFile(pageFile, '<html><head><title>Home</title></head><body></body></html>');

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await breadcrumbLd();
    expect(result).toBe('');
  });

  it('generates breadcrumbs for nested section pages (e.g. how-to/server-scripts)', async () => {
    const sectionDir = join(tempDir, 'how-to');
    const pageFile = join(sectionDir, 'server-scripts.html');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sectionDir, { recursive: true });
    await writeFile(
      pageFile,
      '<html><head><title>Server Scripts - Bascik Docs</title></head><body></body></html>',
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await breadcrumbLd();
    expect(result).toContain('"@type": "BreadcrumbList"');
    expect(result).toContain('"name": "Bascik"');
    expect(result).toContain('"name": "Server Scripts"');
    const parsed = JSON.parse(result.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
    expect(parsed.itemListElement).toHaveLength(2);
    expect(parsed.itemListElement[0].name).toBe('Bascik');
    expect(parsed.itemListElement[1].name).toBe('Server Scripts');
  });

  it('includes section index link for SECTIONS_WITH_PAGE (e.g. internals/architecture)', async () => {
    const sectionDir = join(tempDir, 'internals');
    const pageFile = join(sectionDir, 'architecture.html');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sectionDir, { recursive: true });
    await writeFile(
      pageFile,
      '<html><head><title>Architecture - Bascik Docs</title></head><body></body></html>',
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await breadcrumbLd();
    const parsed = JSON.parse(result.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
    expect(parsed.itemListElement).toHaveLength(3);
    expect(parsed.itemListElement[0].name).toBe('Bascik');
    expect(parsed.itemListElement[1].name).toBe('Internals');
    expect(parsed.itemListElement[1].item).toBe('https://bascik.dev/internals');
    expect(parsed.itemListElement[2].name).toBe('Architecture');
  });
});
