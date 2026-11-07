import { findVariant } from "../lib/catalog.ts";
export interface CartItem {
  variantId: string;
  quantity: number;
}
export const key = "bascik-shop-cart";
export function cart(): CartItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("Invalid saved cart");
    return data.filter(
      (item): item is CartItem =>
        typeof item === "object" &&
        item !== null &&
        typeof item.variantId === "string" &&
        Number.isInteger(item.quantity) &&
        item.quantity > 0 &&
        item.quantity <= 10 &&
        Boolean(findVariant(item.variantId)),
    );
  } catch (error) {
    console.error("Could not read the saved cart", error);
    document.dispatchEvent(
      new CustomEvent("shop:cart-error", {
        detail:
          "Your saved cart could not be read. Please add your items again.",
      }),
    );
    return [];
  }
}
export function save(items: CartItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
  document.dispatchEvent(new CustomEvent("shop:cart-changed"));
}

export function variantImage(
  match: NonNullable<ReturnType<typeof findVariant>>,
) {
  return (
    match.product.images.find(
      (image) =>
        image.sourceId === match.variant.imageId &&
        image.color === match.variant.color,
    ) ??
    match.product.images.find((image) => image.color === match.variant.color)
  );
}

window.addEventListener("storage", (event) => {
  if (event.key === key)
    document.dispatchEvent(new CustomEvent("shop:cart-changed"));
});
