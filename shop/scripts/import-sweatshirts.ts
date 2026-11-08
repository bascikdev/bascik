import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Product, ProductImage } from "../src/lib/catalog.ts";
import { importProductImage } from "./import-product-images.ts";
import { productTemplates } from "./product-templates.ts";

const sourceRoot = process.argv[2];
if (!sourceRoot)
  throw new Error(
    "Usage: node scripts/import-sweatshirts.ts PATH-TO-TEMPLATE-FOLDERS",
  );
const catalog: Product[] = JSON.parse(
  await readFile("catalog/products.json", "utf8"),
);
const manifest: { file: string; source: string }[] = JSON.parse(
  await readFile("image-originals/manifest.json", "utf8"),
);
const entries = [
  {
    slug: "organic-cotton-bascik-logo-sweatshirt-unisex",
    design: "Logo",
    front: "6aefd845dec0c",
    blackFront: "6aefd845dd678",
  },
  {
    slug: "organic-cotton-bascik-insignia-sweatshirt-unisex",
    design: "Insignia",
    front: "6aefd857a7c78",
    blackFront: "6aefd857a6bd5",
  },
];
const imported: Product[] = [];
for (const entry of entries) {
  const approved = productTemplates[entry.slug];
  if (!approved.catalogVariantIds)
    throw new Error(`Missing sweatshirt variants: ${entry.slug}`);
  const source = resolve(sourceRoot, String(approved.id));
  const output = `image-originals/sweatshirts/${approved.id}`;
  await mkdir(output, { recursive: true });
  const files = (await readdir(source))
    .filter((name) => name.endsWith(".png"))
    .sort();
  if (files.length !== 14)
    throw new Error(`Expected all 14 mockups for ${approved.id}`);
  const images: ProductImage[] = [];
  for (const color of ["Black", "Desert Dust"]) {
    const names = files.filter((name) =>
      name.includes(color === "Black" ? "-black-" : "-desert-dust-"),
    );
    const hero = color === "Black" ? entry.blackFront : entry.front;
    if (
      names.length !== 7 ||
      names.filter((name) => name.includes(hero)).length !== 1
    )
      throw new Error(
        `Expected seven ${color} mockups with a flat front for ${approved.id}`,
      );
    names.sort(
      (a, b) =>
        Number(b.includes(hero)) - Number(a.includes(hero)) ||
        a.localeCompare(b),
    );
    for (const name of names) {
      const file = join(output, name);
      if (resolve(file) !== join(source, name))
        await copyFile(join(source, name), file);
      const sourceId = name.replace(/\.png$/, "");
      const view = name.match(
        /-(left-front|front|back|left|right)-[a-f0-9]+\.png$/,
      )?.[1];
      if (!view) throw new Error(`Unrecognized sweatshirt mockup ${name}`);
      const result = await importProductImage(
        file,
        sourceId,
        color,
        `Bascik ${entry.design} sweatshirt in ${color}, ${view.replace("-", " ")} view`,
      );
      images.push(result.image);
      const record = {
        source: `owner-supplied:printful-template-${approved.id}:${name}`,
        ...result.record,
      };
      const existing = manifest.findIndex((image) => image.file === file);
      if (existing >= 0) manifest[existing] = record;
      else manifest.push(record);
    }
  }
  const title = `Organic Cotton Bascik ${entry.design} Sweatshirt (Unisex)`;
  imported.push({
    id: entry.slug,
    slug: entry.slug,
    title,
    price: 4500,
    description: `A cozy, mid-weight sweatshirt with the Bascik ${entry.design.toLowerCase()} on the front. The relaxed fit makes it an easy layer for those not-too-hot, not-too-cold days, with a subtle half-moon detail on the back.\n\n• US fulfillment: 80% organic combed ring-spun cotton, 20% recycled polyester\n\n• European fulfillment: 85% organic combed ring-spun cotton, 15% recycled polyester\n\n• Fabric weight: 8.3 oz./yd.² (280 g/m²)\n\n• Relaxed fit with set-in sleeves\n\n• Ribbed collar, cuffs, and hem\n\n• Twin-needle top stitching and herringbone back neck tape\n\n• Certified organic cotton and recycled content (GOTS, OCS, and GRS)\n\n• Blank product sourced from Bangladesh\n\nSizing: US sizes are shown. European customers should order one size down. Made on demand.`,
    variants: Object.entries(approved.catalogVariantIds).map(
      ([title, catalogId]) => {
        const [color, size] = title.split(" / ");
        return {
          id: `${entry.slug}-${catalogId}`,
          title,
          sku: `bascik-${approved.id}-${catalogId}`,
          color,
          colorCode: color === "Black" ? "#0b0b0b" : "#dcccb4",
          size,
          available: true,
          imageId: images.find((image) => image.color === color)!.sourceId,
        };
      },
    ),
    images,
  });
}
const existing = catalog.filter(
  (product) => !entries.some((entry) => entry.slug === product.slug),
);
const position = existing.findIndex((product) => product.slug.includes("hat"));
if (position < 0) throw new Error("Hat catalog insertion point is missing");
existing.splice(position, 0, ...imported);
await writeFile(
  "catalog/products.json",
  JSON.stringify(existing, null, 2) + "\n",
);
await writeFile(
  "image-originals/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  "Imported two $45 sweatshirts before hats, Black first, with 20 variants and 28 responsive image views.",
);
