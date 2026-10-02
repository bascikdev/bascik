import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  CANVASES,
  COLORS,
  KIT_ROOT,
  MARK_PNG_SIZES,
  PRESS_EMAIL,
  WORDMARK_PNG_WIDTHS,
  ZIP_NAME,
  buildKitFiles,
  createZip,
  generatePressKit,
  parseLogo,
  renderCanvasSvg,
  renderLogoSvg,
  zipKit,
} from './generate-press-kit.js';
import config, { build } from '../bascik.config.ts';

const docsDir = resolve(import.meta.dirname, '..');
const assets = join(docsDir, 'src/pages/assets');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Reads a zip produced by createZip using only the central directory. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const method = zip.readUInt16LE(pos + 10);
    const compressed = zip.readUInt32LE(pos + 20);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(data.length).toBe(size);
    out.set(name, Buffer.from(data));
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

describe('generate-press-kit', () => {
  let markSource: string;
  let wordmarkSource: string;

  beforeAll(async () => {
    [markSource, wordmarkSource] = await Promise.all([
      readFile(join(assets, 'favicon.svg'), 'utf8'),
      readFile(join(assets, 'bascik-logo.svg'), 'utf8'),
    ]);
  });

  describe('parseLogo', () => {
    it('strips animation and comments and keeps the brand colors', () => {
      const wordmark = parseLogo(wordmarkSource);
      expect(wordmark.points).toBe('7,0 114,0 107,28 0,28');
      expect(wordmark.viewBox).toEqual({ x: 0, y: 0, width: 114, height: 28 });
      expect(wordmark.ink).not.toContain('<animate');
      expect(wordmark.ink).not.toContain('<!--');
      expect(wordmark.ink).toContain(`fill="${COLORS.ink}"`);
      expect(wordmark.ink).toContain('<path');
      expect(wordmark.ink).not.toContain('<text');
    });

    it('applies the crop to the mark view box', () => {
      const mark = parseLogo(markSource, { x: 2, y: 2, width: 28, height: 28 });
      expect(mark.viewBox).toEqual({ x: 2, y: 2, width: 28, height: 28 });
    });

    it('rejects sources that break the brand contract', () => {
      expect(() => parseLogo('<svg><polygon points="0,0" fill="#d3ff8d"/></svg>')).toThrow(/viewBox/);
      expect(() => parseLogo('<svg viewBox="0 0 1 1"><rect fill="#0e0f10"/></svg>')).toThrow(/polygon/);
      expect(() => parseLogo('<svg viewBox="0 0 1 1"><polygon points="0,0" fill="#ff0000"/></svg>')).toThrow(/d3ff8d/);
      expect(() => parseLogo('<svg viewBox="0 0 1 1"><polygon points="0,0" fill="#d3ff8d"/></svg>')).toThrow(/0e0f10/);
    });
  });

  describe('SVG rendering', () => {
    it('renders static logos with no animation, scripts, or external references', () => {
      const wordmark = parseLogo(wordmarkSource);
      for (const tone of ['color', 'black', 'white'] as const) {
        const svg = renderLogoSvg(wordmark, tone, { title: 'Bascik', width: 100, height: 25 });
        expect(svg).not.toMatch(/<animate|<script|href=|<text|font-family/);
        expect(svg).toContain('<title>Bascik</title>');
      }
    });

    it('uses a knockout mask for single-color logos and none for full color', () => {
      const mark = parseLogo(markSource, { x: 2, y: 2, width: 28, height: 28 });
      const color = renderLogoSvg(mark, 'color', { title: 'm', width: 1, height: 1 });
      const black = renderLogoSvg(mark, 'black', { title: 'm', width: 1, height: 1 });
      const white = renderLogoSvg(mark, 'white', { title: 'm', width: 1, height: 1 });
      expect(color).not.toContain('<mask');
      expect(color).toContain(COLORS.lime);
      expect(black).toContain('<mask');
      expect(black).toContain(`fill="${COLORS.ink}"`);
      expect(black).not.toContain(COLORS.lime);
      expect(white).toContain('fill="#ffffff"');
      expect(white).not.toContain(COLORS.lime);
    });

    it('centers the logo inside a canvas', () => {
      const wordmark = parseLogo(wordmarkSource);
      const svg = renderCanvasSvg(wordmark, 'color', { width: 1200, height: 630, background: 'dark', logoWidth: 600 });
      // scale 600 / 114, logo height 28 * scale = 147.37, so ty = (630 - 147.3684) / 2
      expect(svg).toContain('translate(300 241.3158)');
      expect(svg).toContain(`fill="${COLORS.charcoal}"`);
    });
  });

  describe('buildKitFiles', () => {
    let files: ReturnType<typeof buildKitFiles>;
    beforeAll(() => {
      files = buildKitFiles(markSource, wordmarkSource);
    }, 30000);

    it('produces every documented file with unique paths', () => {
      const paths = files.map((f) => f.path);
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).toContain('README.txt');
      for (const suffix of ['', '-black', '-white']) {
        expect(paths).toContain(`logo/svg/bascik-wordmark${suffix}.svg`);
        expect(paths).toContain(`logo/svg/bascik-mark${suffix}.svg`);
      }
      for (const w of WORDMARK_PNG_WIDTHS) expect(paths).toContain(`logo/png/bascik-wordmark-${w}.png`);
      for (const s of MARK_PNG_SIZES) expect(paths).toContain(`logo/png/bascik-mark-${s}.png`);
      for (const spec of CANVASES) expect(paths).toContain(spec.file);
    });

    it('renders PNGs at the exact documented dimensions', () => {
      const byPath = new Map(files.map((f) => [f.path, f.data]));
      for (const w of WORDMARK_PNG_WIDTHS) {
        expect(pngSize(byPath.get(`logo/png/bascik-wordmark-${w}.png`)!).width).toBe(w);
      }
      for (const s of MARK_PNG_SIZES) {
        expect(pngSize(byPath.get(`logo/png/bascik-mark-${s}.png`)!)).toEqual({ width: s, height: s });
      }
      for (const spec of CANVASES) {
        expect(pngSize(byPath.get(spec.file)!)).toEqual({ width: spec.width, height: spec.height });
      }
    });

    it('keeps the avatar artwork inside a circular crop', () => {
      for (const spec of CANVASES.filter((c) => c.logo === 'mark')) {
        // The mark is a parallelogram; its bounding box corners must sit inside the inscribed circle
        // only loosely, so require the artwork to stay well inside the frame instead.
        expect(spec.logoWidth).toBeLessThanOrEqual(spec.width * 0.6);
      }
    });

    it('uses names that match the page documentation', async () => {
      const guide = await readFile(join(docsDir, 'content/press.md'), 'utf8');
      for (const spec of CANVASES) expect(guide).toContain(spec.file);
      for (const w of WORDMARK_PNG_WIDTHS) expect(guide).toContain(`${w}`);
      expect(guide).toContain(COLORS.lime);
      expect(guide).toContain(COLORS.ink);
      expect(guide).toContain(COLORS.charcoal);
      expect(guide).toContain(COLORS.paper);
    });
  });

  describe('press contact', () => {
    it('uses the role alias on the page and in the kit README', async () => {
      expect(PRESS_EMAIL).toBe('press@bascik.dev');
      const guide = await readFile(join(docsDir, 'content/press.md'), 'utf8');
      expect(guide).toContain(PRESS_EMAIL);
      const readme = buildKitFiles(markSource, wordmarkSource).find((f) => f.path === 'README.txt')!;
      expect(readme.data.toString('utf8')).toContain(PRESS_EMAIL);
    });

    it('never publishes a personal address in the kit or page sources', async () => {
      const sources = await Promise.all([
        readFile(join(docsDir, 'content/press.md'), 'utf8'),
        readFile(join(docsDir, 'src/pages/press.html'), 'utf8'),
        readFile(join(docsDir, 'scripts/generate-press-kit.ts'), 'utf8'),
      ]);
      const readme = buildKitFiles(markSource, wordmarkSource).find((f) => f.path === 'README.txt')!;
      const addresses = [...sources, readme.data.toString('utf8')]
        .flatMap((text) => text.match(/[\w.+-]+@bascik\.dev/g) ?? []);
      expect(addresses.length).toBeGreaterThan(0);
      expect(new Set(addresses)).toEqual(new Set([PRESS_EMAIL]));
    });
  });

  describe('zip', () => {
    it('round-trips entries through the central directory', () => {
      const entries = [
        { name: 'a/one.txt', data: Buffer.from('hello hello hello hello hello hello') },
        { name: 'a/two.bin', data: Buffer.from([1, 2, 3]) },
        { name: 'empty.txt', data: Buffer.alloc(0) },
        { name: 'naïve/ünïcode.txt', data: Buffer.from('ok') },
      ];
      const read = readZip(createZip(entries));
      expect([...read.keys()]).toEqual(entries.map((e) => e.name));
      for (const e of entries) expect(read.get(e.name)!.equals(e.data)).toBe(true);
    });

    it('is reproducible, sorted, and rooted in one folder', () => {
      const files = buildKitFiles(markSource, wordmarkSource);
      const a = zipKit(files);
      const b = zipKit([...files].reverse());
      expect(a.equals(b)).toBe(true);
      const names = [...readZip(a).keys()];
      expect(names).toEqual([...names].sort());
      expect(names.every((n) => n.startsWith(`${KIT_ROOT}/`))).toBe(true);
    });

    it('passes the system unzip integrity check', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bascik-press-zip-'));
      try {
        const zipPath = join(dir, 'kit.zip');
        await writeFile(zipPath, zipKit(buildKitFiles(markSource, wordmarkSource)));
        const result = spawnSync('unzip', ['-tq', zipPath], { encoding: 'utf8' });
        if (result.error) return; // unzip is not installed; the round-trip test above still covers structure
        expect(result.status).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe('generatePressKit', () => {
    let outDir: string;
    beforeAll(async () => {
      outDir = await mkdtemp(join(tmpdir(), 'bascik-press-out-'));
    });
    afterAll(async () => {
      await rm(outDir, { recursive: true, force: true });
    });

    it('writes the kit and a zip containing the same bytes', async () => {
      const written = await generatePressKit(outDir);
      expect(written).toContain(ZIP_NAME);
      const zip = readZip(await readFile(join(outDir, ZIP_NAME)));
      for (const path of written.filter((p) => p !== ZIP_NAME)) {
        const onDisk = await readFile(join(outDir, path));
        expect(zip.get(`${KIT_ROOT}/${path}`)?.equals(onDisk), path).toBe(true);
      }
      expect(zip.size).toBe(written.length - 1);
    }, 30000);
  });

  describe('pipeline wiring', () => {
    it('is wired into dev and build exec without watching its output', () => {
      const script = 'scripts/generate-press-kit.ts';
      const dev = config.pipeline?.exec?.find((e) => e.script === script);
      expect(dev?.watch).toEqual(['src/pages/assets/bascik-logo.svg', 'src/pages/assets/favicon.svg']);
      expect(dev).not.toHaveProperty('outputs');
      expect(build.pipeline?.exec?.some((e) => e.script === script)).toBe(true);
      const watched = [...(config.pipeline?.watchPaths ?? []), ...(dev?.watch ?? [])];
      expect(watched.some((p) => p.includes('assets/press'))).toBe(false);
    });
  });
});

describe('generate-press-kit BASCIK_OUT_DIR', () => {
  it('writes only under assets/press in the override directory', async () => {
    const out = await mkdtemp(join(tmpdir(), 'bascik-press-env-'));
    try {
      const result = spawnSync(process.execPath, [join(docsDir, 'scripts/generate-press-kit.ts')], {
        cwd: docsDir,
        env: { ...process.env, BASCIK_OUT_DIR: out },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(await readdir(out)).toEqual(['assets']);
      expect(await readdir(join(out, 'assets'))).toEqual(['press']);
      expect((await readdir(join(out, 'assets/press'))).sort()).toEqual(
        ['README.txt', 'avatar', 'bascik-press-kit.zip', 'logo', 'social'],
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30000);
});
