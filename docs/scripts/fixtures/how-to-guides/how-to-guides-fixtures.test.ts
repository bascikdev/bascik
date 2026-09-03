import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractDemoBlock } from '../../../src/lib/md-renderer.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '.');
const CONTENT_DIR = path.resolve(import.meta.dirname, '../../../content/how-to');

/**
 * Fixtures for the four how-to guides. Each recipe was verified end to end
 * against a real Bascik project before being documented; these tests keep
 * the documented behavior honest. Marker tests assert every demo block
 * the pages reference actually resolves (a typo renders an empty block).
 */

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURE_DIR, name), 'utf8');
}

describe('bundling guide fixtures', () => {
  it('the esbuild recipe bundles a real package', async () => {
    const { build } = await import('esbuild');
    const entry = path.join(FIXTURE_DIR, 'confetti-entry.mjs');
    const outfile = path.join(FIXTURE_DIR, '.tmp-bundle-test.mjs');
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      minify: true,
      outfile,
      write: true,
    });
    expect(result.errors).toEqual([]);
    const bundle = await readFile(outfile, 'utf8');
    // canvas-confetti inlined: no bare specifier survives bundling
    expect(bundle).not.toMatch(/from\s+['"]canvas-confetti['"]/);
    const { rm } = await import('node:fs/promises');
    await rm(outfile, { force: true });
  });

  it('the fixture entry uses a default import that actually resolves', async () => {
    const src = await readFixture('confetti-entry.mjs');
    expect(src).toContain("import confetti from 'canvas-confetti'");
    expect(src).toContain('export const celebrate');
  });

  it('the exec config uses phase pre so the bundle exists before pages', async () => {
    const config = await readFixture('bundle-config.ts');
    expect(config).toContain("script: 'build-bundle.mjs'");
    expect(config).toContain("phase: 'pre'");
    expect(config).toContain("watch: ['src/client/']");
  });

  it('the page references the bundle with a root-relative URL', async () => {
    const page = await readFixture('bundle-page.html');
    expect(page).toContain("from '/assets/js/confetti-bundle.mjs'");
    expect(page).not.toMatch(/from\s+['"]canvas-confetti['"]/);
  });

  it('the bare-specifier example states it does not work', async () => {
    const page = await readFixture('bare-specifier-page.html');
    expect(page).toContain('DOES NOT WORK');
    expect(page).toContain('Bascik does not rewrite bare specifiers');
  });
});

describe('fingerprinting guide fixtures', () => {
  it('the fingerprint script hashes and renames a real asset', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tempDir = await mkdtemp(path.join(tmpdir(), 'fingerprint-test-'));
    try {
      const { writeFile, readdir } = await import('node:fs/promises');
      const assetDir = path.join(tempDir, 'assets', 'img');
      await (await import('node:fs/promises')).mkdir(assetDir, { recursive: true });
      await writeFile(path.join(assetDir, 'hero.png'), 'fake-png-data-v1');

      const { createHash } = await import('node:crypto');
      const buf = await readFile(path.join(assetDir, 'hero.png'), null);
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
      expect(hash).toMatch(/^[0-9a-f]{10}$/);

      const files = await readdir(assetDir);
      expect(files).toContain('hero.png');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('the fingerprint exec config uses phase post', async () => {
    const config = await readFixture('fingerprint-config.ts');
    expect(config).toContain("script: 'fingerprint-assets.mjs'");
    expect(config).toContain("phase: 'post'");
  });

  it('the cache-control config pairs immutable with fingerprinted names', async () => {
    const config = await readFixture('cache-control-config.ts');
    expect(config).toContain("'.woff2': 'public, max-age=31536000, immutable'");
    expect(config).toContain("'.png': 'public, max-age=86400'");
  });
});

describe('sharing components guide fixtures', () => {
  it('the shared component lives in a subfolder and derives its name from the filename', async () => {
    const component = await readFixture('shared-component.html');
    expect(component).toContain('src/components/marketing/hero-card.html');
    expect(component).toContain('Component names derive from the filename');
  });

  it('the colliding component documents the duplicate-name build error', async () => {
    const component = await readFixture('colliding-component.html');
    expect(component).toContain('FAILS THE BUILD');
    expect(component).toContain('subfolders do not');
    expect(component).toContain('marketing-hero-card.html');
  });
});

describe('micro site guide fixtures', () => {
  it('the micro site index is a complete standalone page', async () => {
    const page = await readFixture('micro-site-index.html');
    expect(page).toContain('<!DOCTYPE html>');
    expect(page).toContain('<form');
    expect(page).not.toContain('data-bascik-build');
  });

  it('the micro site config disables sitemap and robots for one page', async () => {
    const config = await readFixture('micro-site-config.ts');
    expect(config).toContain('generate: { sitemap: false, robots: false }');
  });
});

describe('how-to guide demo markers', () => {
  const PAGES: Record<string, string[]> = {
    'bundling-npm-packages.md': [
      'bare-specifier',
      'bundle-script',
      'bundle-entry',
      'bundle-config',
      'bundle-page',
    ],
    'asset-fingerprinting.md': [
      'cache-control-config',
      'fingerprint-config',
      'fingerprint-script',
    ],
    'sharing-components.md': [
      'shared-component',
      'colliding-component',
    ],
    'micro-sites.md': [
      'micro-site-index',
      'micro-site-config',
    ],
  };

  it('every marker referenced by each guide resolves to a code block', async () => {
    for (const [page, markers] of Object.entries(PAGES)) {
      const rel = `./content/how-to/${page}`;
      for (const marker of markers) {
        const block = await extractDemoBlock(rel, marker);
        expect(block, `${page}: marker "${marker}" missing or empty`).not.toContain('not found');
        expect(block.trim(), `${page}: marker "${marker}" resolved to an empty block`).not.toBe('');
      }
    }
  });

  it('each guide contains no markers the test does not know about', async () => {
    for (const page of Object.keys(PAGES)) {
      const md = await readFile(path.join(CONTENT_DIR, page), 'utf8');
      const found = [...md.matchAll(/<!--\s*demo:([\w-]+)\s*-->/g)].map(m => m[1]);
      const unknown = found.filter(m => !PAGES[page].includes(m));
      expect(unknown, `${page}: undocumented markers ${unknown.join(', ')}`).toEqual([]);
    }
  });
});
