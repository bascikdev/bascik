import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraph } from './open-graph.js';

describe('openGraph', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'open-graph-test-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty string if env vars are missing', async () => {
    delete process.env.BASCIK_SITE_URL;
    delete process.env.BASCIK_PAGE_FILE;
    delete process.env.BASCIK_PAGES_DIR;

    const result = await openGraph();
    expect(result).toBe('');
  });

  it('generates OG and Twitter card tags with image for NAV documentation pages', async () => {
    const pageFile = join(tempDir, 'getting-started.html');
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Getting Started - Bascik Docs</title>
  <meta name="description" content="Learn all about Bascik static site generator." />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await openGraph();
    expect(result).toContain('<meta property="og:type" content="website" />');
    expect(result).toContain('<meta property="og:site_name" content="Bascik" />');
    expect(result).toContain('<meta property="og:url" content="https://bascik.dev/getting-started" />');
    expect(result).toContain('<meta property="og:locale" content="en_US" />');
    expect(result).toContain('<meta property="og:title" content="Getting Started" />');
    expect(result).toContain('<meta property="og:description" content="Learn all about Bascik static site generator." />');
    expect(result).toContain('<meta property="og:image" content="https://bascik.dev/assets/og/getting-started.jpg" />');
    expect(result).toContain('<meta property="og:image:type" content="image/jpeg" />');
    expect(result).toContain('<meta property="og:image:width" content="1200" />');
    expect(result).toContain('<meta property="og:image:height" content="630" />');
    expect(result).toContain('<meta property="og:image:alt" content="Getting Started open graph social card" />');
    expect(result).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(result).toContain('<meta name="twitter:site" content="@bascikdev" />');
    expect(result).toContain('<meta name="twitter:title" content="Getting Started" />');
    expect(result).toContain('<meta name="twitter:image" content="https://bascik.dev/assets/og/getting-started.jpg" />');
  });

  it('falls back to home.jpg og:image for non-documentation utility pages like search or 404', async () => {
    const pageFile = join(tempDir, 'search.html');
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Search - Bascik Docs</title>
  <meta name="description" content="Search the Bascik documentation." />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await openGraph();
    expect(result).toContain('<meta property="og:title" content="Search" />');
    expect(result).toContain('<meta property="og:image" content="https://bascik.dev/assets/og/home.jpg" />');
    expect(result).toContain('<meta name="twitter:image" content="https://bascik.dev/assets/og/home.jpg" />');
  });

  it('cleans site branding from og:title per Apple TN3156 guidelines', async () => {
    const pageFile = join(tempDir, 'getting-started.html');
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Getting Started - Bascik Docs</title>
  <meta name="description" content="Get started with Bascik." />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await openGraph();
    expect(result).toContain('<meta property="og:title" content="Getting Started" />');
    expect(result).toContain('<meta property="og:site_name" content="Bascik" />');
    expect(result).toContain('<meta name="twitter:title" content="Getting Started" />');
  });
});
