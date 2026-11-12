/**
 * Every still image the docs site shows has width variants for `srcset`, made by scripts/responsive-images.ts.
 * This fails when someone adds or re-records a still and does not run that script.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_FOLDERS, VARIANT } from "../../scripts/responsive-images.ts";

const ASSETS = join(import.meta.dirname, "../pages/assets");

/** The pixel width a WebP file's header records, and whether the file is animated. */
function webpHeader(file: string): { width: number; animated: boolean } {
  const bytes = readFileSync(file);
  const format = bytes.toString("latin1", 12, 16);
  if (format === "VP8X")
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      animated: (bytes[20] & 0x02) !== 0,
    };
  if (format === "VP8L")
    return { width: 1 + (bytes.readUInt32LE(21) & 0x3fff), animated: false };
  return { width: bytes.readUInt16LE(26) & 0x3fff, animated: false };
}

const images = IMAGE_FOLDERS.flatMap((folder) =>
  readdirSync(join(ASSETS, folder))
    .filter((name) => name.endsWith(".webp"))
    .map((name) => ({ folder, name, file: join(ASSETS, folder, name) })),
);
const originals = images.filter((image) => !VARIANT.test(image.name));
const variantsOf = (original: (typeof images)[number]) =>
  images.filter(
    (image) =>
      image.folder === original.folder &&
      VARIANT.test(image.name) &&
      image.name.replace(VARIANT, ".webp") === original.name,
  );

describe("docs image width variants", () => {
  it("every still image has at least one narrower variant (run node scripts/responsive-images.ts)", () => {
    const missing = originals
      .filter((image) => !webpHeader(image.file).animated)
      .filter((image) => variantsOf(image).length === 0)
      .map((image) => `${image.folder}/${image.name}`);
    expect(missing).toEqual([]);
  });

  it("no animated recording has variants: resizing a lossless animation makes it larger", () => {
    const resized = originals
      .filter((image) => webpHeader(image.file).animated)
      .filter((image) => variantsOf(image).length > 0)
      .map((image) => `${image.folder}/${image.name}`);
    expect(resized).toEqual([]);
  });

  it("each variant is the width its name says, and a narrower one is smaller than the file it stands in for", () => {
    const wrong: string[] = [];
    for (const original of originals) {
      const own = webpHeader(original.file).width;
      for (const variant of variantsOf(original)) {
        const named = Number(VARIANT.exec(variant.name)![1]);
        const actual = webpHeader(variant.file).width;
        if (actual !== named)
          wrong.push(`${variant.name}: ${actual} pixels wide`);
        if (
          named < own &&
          statSync(variant.file).size >= statSync(original.file).size
        )
          wrong.push(`${variant.name}: not smaller than ${original.name}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every variant belongs to an image that exists", () => {
    const orphans = images
      .filter((image) => VARIANT.test(image.name))
      .filter(
        (image) =>
          !originals.some(
            (original) =>
              original.folder === image.folder &&
              original.name === image.name.replace(VARIANT, ".webp"),
          ),
      )
      .map((image) => `${image.folder}/${image.name}`);
    expect(orphans).toEqual([]);
  });
});
