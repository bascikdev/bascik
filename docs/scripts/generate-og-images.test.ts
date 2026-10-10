import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateOgImages, renderOgJpeg, renderOgSvg } from './generate-og-images.js';

// A valid JPEG shape (SOI ... EOI) that encodes the SVG it came from.
const fakeJpeg = (svg: string): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(svg.slice(0, 64)), Buffer.from([0xff, 0xd9])]);

const temporaryDirs: string[] = [];
const makeTemporaryDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bascik-og-'));
  temporaryDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const countingRenderer = () => {
  const rendered: string[] = [];
  return {
    rendered,
    render: async (svg: string) => {
      rendered.push(svg);
      return fakeJpeg(svg);
    },
  };
};

const readCards = async (dir: string): Promise<Map<string, Buffer>> => {
  const cards = new Map<string, Buffer>();
  for (const name of (await fs.readdir(dir)).sort()) cards.set(name, await fs.readFile(path.join(dir, name)));
  return cards;
};

describe('generate-og-images cache', () => {
  it('renders every card once and copies identical bytes from the cache on the next run', async () => {
    const cacheDir = await makeTemporaryDir();
    const first = countingRenderer();
    const firstOut = await makeTemporaryDir();
    await generateOgImages({ outDir: firstOut, cacheDir, render: first.render });
    const firstCards = await readCards(firstOut);
    expect(first.rendered.length).toBe(firstCards.size);
    expect(firstCards.has('home.jpg')).toBe(true);

    const second = countingRenderer();
    const secondOut = await makeTemporaryDir();
    await generateOgImages({ outDir: secondOut, cacheDir, render: second.render });
    expect(second.rendered).toEqual([]);
    expect(await readCards(secondOut)).toEqual(firstCards);
  });

  it('re-renders a card whose cache entry is missing or corrupt', async () => {
    const cacheDir = await makeTemporaryDir();
    const outDir = await makeTemporaryDir();
    await generateOgImages({ outDir, cacheDir, render: countingRenderer().render });
    const entries = (await fs.readdir(cacheDir)).sort();
    await fs.writeFile(path.join(cacheDir, entries[0]), 'not a jpeg');
    await fs.rm(path.join(cacheDir, entries[1]));

    const again = countingRenderer();
    await generateOgImages({ outDir, cacheDir, render: again.render });
    expect(again.rendered.length).toBe(2);
    const repaired = await fs.readFile(path.join(cacheDir, entries[0]));
    expect(repaired.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('keys cards by their SVG markup, so different markup never shares an entry', async () => {
    const cacheDir = await makeTemporaryDir();
    const outDir = await makeTemporaryDir();
    const run = countingRenderer();
    await generateOgImages({ outDir, cacheDir, render: run.render });
    const distinctSvgs = new Set(run.rendered).size;
    expect((await fs.readdir(cacheDir)).filter((name) => name.endsWith('.jpg')).length).toBe(distinctSvgs);
  });

  it('always renders when the cache is disabled', async () => {
    const outDir = await makeTemporaryDir();
    const first = countingRenderer();
    await generateOgImages({ outDir, cacheDir: false, render: first.render });
    const second = countingRenderer();
    await generateOgImages({ outDir, cacheDir: false, render: second.render });
    expect(second.rendered.length).toBe(first.rendered.length);
  });

  it('renders a real JPEG for one card', async () => {
    const jpeg = await renderOgJpeg(renderOgSvg('Title', 'Overview', 'Description.'));
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

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

  it('generates assets/og/*.jpg files for all pages', async () => {
    const ogDir = await makeTemporaryDir();
    await generateOgImages({ outDir: ogDir, cacheDir: await makeTemporaryDir() });

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
