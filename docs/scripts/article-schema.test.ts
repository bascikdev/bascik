import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articleSchema } from './article-schema.js';

describe('articleSchema', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'article-schema-test-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty string if env vars are missing', async () => {
    delete process.env.BASCIK_PAGE_FILE;
    delete process.env.BASCIK_SITE_URL;
    const result = await articleSchema();
    expect(result).toBe('');
  });

  it('extracts headline and description when name precedes content with double quotes', async () => {
    const pageFile = join(tempDir, 'index.html');
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Test Title - Bascik Docs</title>
  <meta name="description" content="A test description for the page." />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await articleSchema();
    expect(result).toContain('<script type="application/ld+json">');
    expect(result).toContain('"headline": "Test Title - Bascik Docs"');
    expect(result).toContain('"description": "A test description for the page."');
    expect(result).toContain('"url": "https://bascik.dev/"');
    expect(result).toContain('"mainEntityOfPage": "https://bascik.dev/"');
    expect(result).toContain('"inLanguage": "en-US"');
  });

  it('extracts description when content precedes name or uses single quotes', async () => {
    const pageFile = join(tempDir, 'topic.html');
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Topic Page</title>
  <meta content='Single quote description.' name='description' />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = 'https://bascik.dev';

    const result = await articleSchema();
    expect(result).toContain('"headline": "Topic Page"');
    expect(result).toContain('"description": "Single quote description."');
    expect(result).toContain('"url": "https://bascik.dev/topic"');
  });
});
