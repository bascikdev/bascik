import { componentElements } from "../../browser/dom.ts";
import { cart } from "../../browser/cart.ts";
import { findVariant } from "../../lib/catalog.ts";
import { freeShippingProgress } from "../../lib/free-shipping.ts";
export function initShippingPromotion(root: HTMLElement) {
  const { element } = componentElements(root);
  let destination: { country: string; state: string } | undefined;
  const render = () => {
    const subtotal = cart().reduce(
      (sum, item) =>
        sum + (findVariant(item.variantId)?.product.price ?? 0) * item.quantity,
      0,
    );
    const message = element("[data-free-shipping-progress]");
    if (message)
      message.textContent = freeShippingProgress(subtotal, destination);
  };
  document.addEventListener("shop:cart-changed", render);
  document.addEventListener("shop:destination-changed", (event) => {
    destination = (event as CustomEvent<{ country: string; state: string }>)
      .detail;
    render();
  });
  render();
}
