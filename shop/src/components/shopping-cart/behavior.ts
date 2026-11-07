import { findVariant, money } from "../../lib/catalog.ts";
import { cart, save, variantImage } from "../../browser/cart.ts";
import { componentElements } from "../../browser/dom.ts";

export function initShoppingCart(root: HTMLElement) {
  const { element, status } = componentElements(root);
  const container = element("[data-cart-lines]");
  const template = element<HTMLTemplateElement>("[data-cart-line-template]");
  if (!container || !template) throw new Error("Cart template is missing.");
  function render() {
    container!.replaceChildren();
    let total = 0;
    const items = cart();
    if (!items.length)
      container!.textContent =
        "Your cart is empty. Find your everyday favorite in the collection.";
    for (const item of items) {
      const match = findVariant(item.variantId);
      if (!match) continue;
      total += match.product.price * item.quantity;
      const fragment = template!.content.cloneNode(true) as DocumentFragment;
      const img = fragment.querySelector<HTMLImageElement>("img")!;
      const image = variantImage(match);
      if (image) {
        img.src = image.src;
        img.srcset = image.srcset;
      } else {
        console.error("Cart variant image is missing", {
          variantId: match.variant.id,
          color: match.variant.color,
        });
      }
      const link = fragment.querySelector("a")!;
      link.href = `/products/${match.product.slug}`;
      link.textContent = match.product.title;
      fragment.querySelector("p")!.textContent =
        `${match.variant.title} · ${money(match.product.price)}`;
      fragment
        .querySelector("button")!
        .addEventListener("click", () =>
          save(cart().filter((entry) => entry.variantId !== item.variantId)),
        );
      const quantity = fragment.querySelector("input")!;
      quantity.value = String(item.quantity);
      quantity.addEventListener("change", () => {
        const count = Number(quantity.value);
        if (!Number.isInteger(count) || count < 1 || count > 10) {
          quantity.value = String(item.quantity);
          return status(
            "[data-cart-status]",
            "Choose a quantity between 1 and 10.",
            true,
          );
        }
        save(
          cart().map((entry) =>
            entry.variantId === item.variantId
              ? { ...entry, quantity: count }
              : entry,
          ),
        );
      });
      container!.append(fragment);
    }
    const subtotal = element("[data-cart-total]");
    if (subtotal) subtotal.textContent = money(total);
    const checkout = element("[data-testid=cart-checkout]");
    if (checkout) checkout.hidden = !items.length;
  }
  document.addEventListener("shop:cart-changed", render);
  document.addEventListener("shop:cart-error", (event) =>
    status("[data-cart-status]", (event as CustomEvent<string>).detail, true),
  );
  render();
}
