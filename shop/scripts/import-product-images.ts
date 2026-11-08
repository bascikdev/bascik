import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import type { ProductImage } from "../src/lib/catalog.ts";

export async function importProductImage(
  file: string,
  sourceId: string,
  color: string,
  alt: string,
) {
  const bytes = await readFile(file);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error(`Missing dimensions: ${file}`);
  const outputs = [];
  for (const width of [320, 640, 960, 1600].filter(
    (width) => width <= metadata.width!,
  )) {
    const encoded = await sharp(bytes)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const url = `/assets/products/${hash}-${width}.webp`;
    await writeFile(`src/pages${url}`, encoded);
    outputs.push({ url, width, bytes: encoded.length });
  }
  if (!outputs.length) throw new Error(`Image too small: ${file}`);
  const image: ProductImage = {
    src: (outputs.find((output) => output.width === 640) ?? outputs[0]).url,
    srcset: outputs
      .map((output) => `${output.url} ${output.width}w`)
      .join(", "),
    width: metadata.width,
    height: metadata.height,
    alt,
    sourceId,
    color,
  };
  return {
    image,
    record: {
      file,
      hash,
      width: metadata.width,
      height: metadata.height,
      outputs,
    },
  };
}
