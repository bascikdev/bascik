import { products } from "../../lib/catalog.ts";

export function pageProduct() {
  const route = process.env.BASCIK_PAGE_PATH;
  const product = products.find(
    (product) => route === `/products/${product.slug}`,
  );
  if (!product) throw new Error(`No catalog product for ${route}`);
  return product;
}
