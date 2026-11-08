import { products } from "../../lib/catalog.ts";

export function pageProduct() {
  const route = process.env.BASCIK_PAGE_PATH;
  const product = products.find(
    (product) => route === `/products/${product.slug}`,
  );
  if (!product) throw new Error(`No catalog product for ${route}`);
  return product;
}

export function requestProduct(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "").replace(/\.html$/, "");
  const product = products.find(
    (product) => path === `/products/${product.slug}`,
  );
  if (!product) throw new Error(`No catalog product for ${path}`);
  const requestedColor = url.searchParams.get("color");
  const color = product.variants.some(
    (variant) => variant.color === requestedColor,
  )
    ? requestedColor!
    : product.variants[0].color;
  const imageIndex = product.images.findIndex((image) => image.color === color);
  if (imageIndex < 0)
    throw new Error(`No image for ${product.id} color ${color}`);
  return { product, color, imageIndex };
}
