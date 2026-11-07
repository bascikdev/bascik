import catalog from "../../catalog/products.json" with { type: "json" };

export interface ProductImage {
  src: string;
  srcset: string;
  width: number;
  height: number;
  alt: string;
  sourceId: string;
  color: string;
}
export interface Variant {
  id: string;
  title: string;
  sku: string;
  color: string;
  size: string | null;
  available: boolean;
  imageId: string | null;
}
export interface Product {
  id: string;
  slug: string;
  title: string;
  description: string;
  price: number;
  taxCode?: string;
  variants: Variant[];
  images: ProductImage[];
}
export const products: Product[] = catalog;
export const findVariant = (id: string) => {
  for (const product of products) {
    const variant = product.variants.find((entry) => entry.id === id);
    if (variant) return { product, variant };
  }
  return undefined;
};
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export { esc as escapeHtml } from "@bascik/bascik/html";
