import { readFile, writeFile } from "node:fs/promises";
import type { Product } from "../src/lib/catalog.ts";
import { productTemplates } from "./product-templates.ts";
import { importProductImage } from "./import-product-images.ts";

const entries = [
  {
    slug: "bascik-logo-vinyl-decal",
    title: 'Bascik Logo Kiss-Cut Vinyl Decal (4.5" x 1")',
    size: '4.5" x 1"',
    images: ["logo-front", "logo-laptop"],
  },
  {
    slug: "bascik-insignia-vinyl-decal",
    title: 'Bascik Insignia Kiss-Cut Vinyl Decal (2" x 2")',
    size: '2" x 2"',
    images: ["insignia-front", "insignia-laptop"],
  },
];
const catalog: Product[] = JSON.parse(
  await readFile("catalog/products.json", "utf8"),
);
const manifest = JSON.parse(
  await readFile("image-originals/manifest.json", "utf8"),
);
for (const entry of entries) {
  const images = [];
  for (const [index, name] of entry.images.entries()) {
    const file = `image-originals/decals/${name}.png`;
    const imported = await importProductImage(
      file,
      name,
      "Satin",
      `${entry.title}, ${index === 0 ? "front view" : "on a laptop"}`,
    );
    images.push(imported.image);
    const existing = manifest.findIndex(
      (image: { file: string }) => image.file === file,
    );
    const record = {
      source: `owner-supplied:${name}`,
      ...imported.record,
    };
    if (existing >= 0) manifest[existing] = record;
    else manifest.push(record);
  }
  const product: Product = {
    id: entry.slug,
    slug: entry.slug,
    title: entry.title,
    description: `Kiss-cut vinyl decal featuring the Bascik ${entry.slug.includes("insignia") ? "insignia" : "logo"}. Decal dimensions: ${entry.size}. Vinyl with a satin finish and removable adhesive. Bubble-free application. Water, scratch, and UV resistant. Dishwasher-safe. Suitable for indoor and outdoor use on laptops, bottles, and notebooks.`,
    price: 500,
    taxCode: "txcd_99999999",
    variants: [
      {
        id: entry.slug,
        title: entry.size,
        sku: `bascik-decal-${productTemplates[entry.slug].id}`,
        color: "Satin",
        size: null,
        available: true,
        imageId: entry.images[0],
      },
    ],
    images,
  };
  const existing = catalog.findIndex((product) => product.slug === entry.slug);
  if (existing >= 0) catalog[existing] = product;
  else catalog.push(product);
}
await writeFile(
  "catalog/products.json",
  JSON.stringify(catalog, null, 2) + "\n",
);
await writeFile(
  "image-originals/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  "Imported two $5 decals with four responsive WebP views; original product images retained.",
);
