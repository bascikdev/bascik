# Exec Scripts

Lifecycle build scripts (configured via the `exec` option in `bascik.config.ts`) execute Node.js tasks during compilation to generate automated artifacts, such as XML sitemaps, search indexes, RSS feeds, or optimized Open Graph social images.

Because lifecycle scripts run in the main build process, they should be designed as modular, testable TypeScript helpers. This allows verifying their logic in Vitest without needing to launch a full CLI transpiler or production web server.

## Lifecycle Execution Context

Bascik supports registering scripts that execute before or after the main compilation pass:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  exec: [
    'scripts/generate-sitemap.ts',
    'scripts/generate-search-index.ts',
  ],
});
```

To ensure these scripts are robust and do not fail silently during CI/CD or block local development:

1. **Keep script entrypoints thin**: The entrypoint script should simply parse arguments, resolve paths, and pass configuration to an exported generator function.
2. **Write unit tests for the core logic**: Test that file structures are generated correctly.
3. **Follow the Lifecycle Output Rule**: Build-time generation scripts must write their generated output files directly to `dist/`, never to `src/`. Writing build artifacts into source directories pollutes source control and triggers infinite file watcher loops.

---

## Designing a Testable Lifecycle Script

By separating the file-writing layer from the XML/JSON generation logic, you can test the layout, structure, and formatting of your output files as pure functions.

### 1. The Core Module (`scripts/generate-sitemap.ts`)

Export the generator and output functions so they can be imported and executed in isolation:

```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SitemapConfig {
  siteUrl: string;
  distDir: string;
  routes: string[];
}

export function buildSitemapXml(siteUrl: string, routes: string[]): string {
  const cleanUrl = siteUrl.replace(/\/$/, '');
  const urlEntries = routes.map(r => {
    const path = r === '/' ? '' : r.startsWith('/') ? r : `/${r}`;
    return `  <url>\n    <loc>${cleanUrl}${path}</loc>\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;
}

export async function generateSitemap(config: SitemapConfig): Promise<void> {
  const xml = buildSitemapXml(config.siteUrl, config.routes);
  await writeFile(join(config.distDir, 'sitemap.xml'), xml, 'utf8');
}
```

### 2. The Vitest Test Suite (`scripts/generate-sitemap.test.ts`)

Test the string builder as a pure function first, then verify the asynchronous disk-writing layer using a temporary directory:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSitemapXml, generateSitemap } from './generate-sitemap.ts';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

describe('buildSitemapXml', () => {
  it('generates valid sitemap XML structure from a list of routes', () => {
    const xml = buildSitemapXml('https://bascik.dev', ['/', '/docs', '/about']);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<loc>https://bascik.dev</loc>');
    expect(xml).toContain('<loc>https://bascik.dev/docs</loc>');
    expect(xml).toContain('<loc>https://bascik.dev/about</loc>');
  });
});

describe('generateSitemap disk operations', () => {
  const tempDistDir = join(process.cwd(), 'temp-dist-sitemap');
  const sitemapPath = join(tempDistDir, 'sitemap.xml');

  beforeEach(async () => {
    await mkdir(tempDistDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDistDir, { recursive: true, force: true });
  });

  it('writes sitemap XML directly to the specified destination directory', async () => {
    await generateSitemap({
      siteUrl: 'https://bascik.dev',
      distDir: tempDistDir,
      routes: ['/', '/docs'],
    });

    const fileContent = await readFile(sitemapPath, 'utf8');
    expect(fileContent).toContain('<loc>https://bascik.dev/docs</loc>');
  });
});
```

---

## Verification of Search Index Generation

For complex JSON artifacts (such as client-side search indexes), verify that fields are mapped accurately and internal markup is sanitized.

### 1. The Search Index Module (`scripts/generate-search-index.ts`)

```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SearchRecord {
  title: string;
  route: string;
  text: string;
}

export function buildSearchIndexJson(records: SearchRecord[]): string {
  // Strip raw HTML elements or markdown markers before indexing
  const cleanedRecords = records.map(r => ({
    title: r.title,
    route: r.route,
    text: r.text.replace(/<[^>]*>/g, '').replace(/[*#`]/g, '').trim(),
  }));

  return JSON.stringify(cleanedRecords, null, 2);
}
export async function generateSearchIndex(distDir: string, records: SearchRecord[]): Promise<void> {
  const json = buildSearchIndexJson(records);
  await writeFile(join(distDir, 'search-index.json'), json, 'utf8');
}
```

### 2. The Vitest Test Suite (`scripts/generate-search-index.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { buildSearchIndexJson } from './generate-search-index.ts';

describe('buildSearchIndexJson', () => {
  it('sanitizes text content by removing HTML elements and markdown markers', () => {
    const rawRecords = [
      {
        title: 'Introduction',
        route: '/intro',
        text: '<p>Welcome to **Bascik**! Let`s build fast sites.</p>',
      },
    ];

    const json = buildSearchIndexJson(rawRecords);
    const parsed = JSON.parse(json);

    expect(parsed[0].title).toBe('Introduction');
    expect(parsed[0].route).toBe('/intro');
    // HTML tag and markdown ** stripped
    expect(parsed[0].text).toBe('Welcome to Bascik! Let`s build fast sites.');
  });
});
```

---

## Best Practices for Lifecycle Scripts

- **Never write to source**: Ensure all generated files target `dist/` or a temporary path passed dynamically during tests.
- **Fail gracefully**: Wrap complex external actions (such as fetching remote assets) in try-catch statements to prevent build termination in local development.
- **Isolate file system calls**: Run disk-writing tests inside unique temporary folders and clean up in `afterEach` hooks to prevent test cross-contamination.
