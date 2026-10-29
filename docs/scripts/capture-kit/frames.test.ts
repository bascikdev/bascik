import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { encodeStill, writeScene, type Frame } from "./frames.ts";

/** A flat UI-like picture: a few solid panels and a line of "text". */
async function uiFrame(step: number): Promise<Buffer> {
  const width = 320;
  const height = 200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#18191b"/>
    <rect x="16" y="16" width="288" height="40" rx="6" fill="#242628"/>
    <rect x="16" y="72" width="${40 + step * 30}" height="10" fill="#d3ff8d"/>
    <rect x="16" y="96" width="200" height="10" fill="#8d929e"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A photo-like picture with noise everywhere, which lossless WebP compresses badly. */
async function noisyFrame(): Promise<Buffer> {
  const width = 160;
  const height = 120;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    pixels[i] = (seed >>> 16) & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe("capture-kit frames", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capture-kit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("encodes a still both ways and keeps the smaller one", async () => {
    for (const png of [await uiFrame(2), await noisyFrame()]) {
      const lossless = await sharp(png)
        .webp({ lossless: true, effort: 6 })
        .toBuffer();
      const lossy = await sharp(png)
        .webp({ quality: 80, effort: 6 })
        .toBuffer();
      const still = await encodeStill(png);
      expect(still.length).toBe(Math.min(lossless.length, lossy.length));
    }
  });

  it("never writes a reduced-motion still larger than the animation it replaces", async () => {
    // Flat UI is where the old lossy still came out at twice the size of the whole lossless animation.
    const frames: Frame[] = [];
    for (let step = 0; step < 4; step++)
      frames.push({ png: await uiFrame(step), hold: 500 });
    await writeScene(dir, "ui", frames);
    const animation = (await stat(join(dir, "ui@2x.webp"))).size;
    const still = (await stat(join(dir, "ui-still@2x.webp"))).size;
    expect(still).toBeLessThanOrEqual(animation);
    expect((await readdir(dir)).sort()).toEqual([
      "ui-still@2x.webp",
      "ui@2x.webp",
    ]);
  });
});

describe("published demo stills", () => {
  it.each(["demos", "vscode"])(
    "every still in src/pages/assets/%s is no larger than its animation",
    async (folder) => {
      const assets = join(process.cwd(), "src/pages/assets", folder);
      const files = await readdir(assets);
      const stills = files.filter((file) => file.includes("-still@"));
      expect(stills.length).toBeGreaterThan(0);
      const larger: string[] = [];
      for (const still of stills) {
        const animation = still.replace("-still@", "@");
        if (!files.includes(animation)) continue;
        const [stillSize, animationSize] = await Promise.all([
          stat(join(assets, still)).then((s) => s.size),
          stat(join(assets, animation)).then((s) => s.size),
        ]);
        if (stillSize > animationSize)
          larger.push(
            `${still}: ${stillSize} B > ${animation}: ${animationSize} B`,
          );
      }
      expect(larger).toEqual([]);
    },
  );
});
