import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateOgImages, renderOgSvg } from './generate-og-images.js';

describe('generate-og-images', () => {
  it('renders valid SVG markup with renderOgSvg', () => {
    const svg = renderOgSvg('Getting Started with Bascik', 'Overview', 'Learn how to install and build HTML components.');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 1200 630"');
    expect(svg).toContain('OVERVIEW');
    expect(svg).toContain('Getting Started');
    expect(svg).toContain('with Bascik');
    expect(svg).toContain('Learn how to install and build');
    expect(svg).toContain('bascik.dev');
  });

  it('generates dist/assets/og/*.jpg files for all pages', async () => {
    await generateOgImages();

    const ogDir = path.resolve(import.meta.dirname, '../dist/assets/og');
    const homeJpg = await fs.readFile(path.join(ogDir, 'home.jpg'));
    expect(homeJpg.length).toBeGreaterThan(0);
    expect(homeJpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const gettingStartedJpg = await fs.readFile(path.join(ogDir, 'getting-started.jpg'));
    expect(gettingStartedJpg.length).toBeGreaterThan(0);
    expect(gettingStartedJpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const markdownJpg = await fs.readFile(path.join(ogDir, 'how-to-markdown.jpg'));
    expect(markdownJpg.length).toBeGreaterThan(0);
    expect(markdownJpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 30000);
});
