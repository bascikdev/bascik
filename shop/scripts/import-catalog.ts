import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { imageColor } from "../src/lib/image-colors.ts";
import { productDescription } from "./product-description.ts";
import { originalImagePath } from "./image-cache.ts";
import type { Product } from "../src/lib/catalog.ts";

const handles = [
  "100-organic-cotton-bascik-logo-front-unisex",
  "100-organic-cotton-bascik-insignia-shirt-unisex",
  "100-organic-cotton-bascik-logo-dad-hat-unisex",
  "100-organic-cotton-bascik-insignia-dad-hat-unisex",
];
interface SourceImage {
  id: number;
  src: string;
  variant_ids: number[];
}
interface SourceProduct {
  id: number;
  handle: string;
  title: string;
  body_html: string;
  variants: {
    id: number;
    title: string;
    sku: string;
    price: string;
    available: boolean;
    option1: string;
    option2: string | null;
  }[];
  images: SourceImage[];
}
await mkdir("catalog", { recursive: true });
await mkdir("image-originals", { recursive: true });
await mkdir("src/pages/assets/products", { recursive: true });
const response = await fetch("https://shop.bascik.dev/products.json?limit=250");
if (!response.ok) throw new Error(`Catalog import failed: ${response.status}`);
const source: { products: SourceProduct[] } = await response.json();
const countriesResponse = await fetch("https://api.printful.com/countries");
if (!countriesResponse.ok)
  throw new Error("Could not import Printful country metadata");
const countries: {
  result: {
    code: string;
    name: string;
    states: { code: string; name: string }[] | null;
  }[];
} = await countriesResponse.json();
await writeFile(
  "catalog/countries.json",
  JSON.stringify(countries.result, null, 2) + "\n",
);
const selected = handles.map((handle) => {
  const product = source.products.find((entry) => entry.handle === handle);
  if (!product) throw new Error(`Missing product: ${handle}`);
  return product;
});
if (selected.reduce((sum, product) => sum + product.variants.length, 0) !== 24)
  throw new Error("Expected exactly 24 variants. Review the upstream catalog.");
await writeFile(
  "catalog/source.json",
  JSON.stringify({ products: selected }, null, 2),
);
const manifest: {
  source: string;
  file: string;
  hash: string;
  width: number;
  height: number;
  outputs: { url: string; width: number; bytes: number }[];
}[] = [];
const result: Product[] = [];
for (const product of selected) {
  const images = [];
  for (const [index, image] of product.images.entries()) {
    const url = new URL(image.src);
    if (url.protocol !== "https:" || url.hostname !== "cdn.shopify.com")
      throw new Error("Unexpected image origin");
    const name = `${product.handle}-${index}`;
    const file = originalImagePath(product.handle, url);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      const fetched = await fetch(url);
      if (!fetched.ok)
        throw new Error(`Image import failed: ${fetched.status}`);
      bytes = Buffer.from(await fetched.arrayBuffer());
      await writeFile(file, bytes);
    }
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height)
      throw new Error(`Missing image dimensions: ${name}`);
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
    if (!outputs.length) throw new Error(`Image too small: ${name}`);
    images.push({
      src: (outputs.find((entry) => entry.width === 640) ?? outputs[0]).url,
      srcset: outputs.map((entry) => `${entry.url} ${entry.width}w`).join(", "),
      width: metadata.width,
      height: metadata.height,
      alt: `${product.title}, product view ${index + 1}`,
      sourceId: String(image.id),
      color: imageColor(
        image.src,
        product.variants.map((variant) => ({
          id: String(variant.id),
          color: variant.option1,
        })),
        image.variant_ids,
      ),
    });
    manifest.push({
      source: image.src,
      file,
      hash,
      width: metadata.width,
      height: metadata.height,
      outputs,
    });
  }
  const price = new Set(product.variants.map((variant) => variant.price));
  if (price.size !== 1) throw new Error(`Mixed prices: ${product.handle}`);
  const cents = Math.round(Number(product.variants[0].price) * 100);
  if (cents !== (product.handle.includes("hat") ? 2500 : 3000))
    throw new Error(`Price changed: ${product.handle}`);
  result.push({
    id: String(product.id),
    slug: product.handle,
    title: product.title,
    description: productDescription(product.body_html),
    price: cents,
    variants: product.variants.map((variant) => ({
      id: String(variant.id),
      title: variant.title,
      sku: variant.sku,
      color: variant.option1,
      size: variant.option2,
      available: variant.available,
      imageId: product.images.find((image) =>
        image.variant_ids.includes(variant.id),
      )?.id
        ? String(
            product.images.find((image) =>
              image.variant_ids.includes(variant.id),
            )!.id,
          )
        : null,
    })),
    images,
  });
}
const current: Product[] = existsSync("catalog/products.json")
  ? JSON.parse(await readFile("catalog/products.json", "utf8"))
  : [];
await writeFile(
  "catalog/products.json",
  JSON.stringify(
    [
      ...current.map(
        (product) =>
          result.find((imported) => imported.slug === product.slug) ?? product,
      ),
      ...result.filter(
        (imported) =>
          !current.some((product) => product.slug === imported.slug),
      ),
    ],
    null,
    2,
  ) + "\n",
);
await writeFile(
  "image-originals/manifest.json",
  JSON.stringify(
    [
      ...manifest,
      ...(existsSync("image-originals/manifest.json")
        ? JSON.parse(await readFile("image-originals/manifest.json", "utf8"))
        : []
      ).filter((image: { source: string }) =>
        image.source.startsWith("owner-supplied:"),
      ),
    ],
    null,
    2,
  ) + "\n",
);
console.log(
  `Imported ${result.length} products, 24 variants, ${manifest.length} image views (${new Set(manifest.map((image) => image.hash)).size} unique originals).`,
);
