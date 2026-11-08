import { findVariant, money } from "../../lib/catalog.ts";
import { cart, variantImage } from "../../browser/cart.ts";
import { componentElements } from "../../browser/dom.ts";
export function initCheckoutSummary(root: HTMLElement) {
  const { element } = componentElements(root);
  function checkoutTotals(shipping?: number) {
    const subtotal = cart().reduce(
      (sum, item) =>
        sum + (findVariant(item.variantId)?.product.price ?? 0) * item.quantity,
      0,
    );
    const entries = [
      ["[data-checkout-subtotal]", money(subtotal)],
      [
        "[data-checkout-shipping]",
        shipping === undefined ? "Calculated next" : money(shipping),
      ],
      ["[data-checkout-total]", money(subtotal + (shipping ?? 0))],
    ];
    for (const [selector, text] of entries) {
      const target = element(selector);
      if (target) target.textContent = text;
    }
  }
  function renderCheckoutSummary() {
    const container = element("[data-checkout-lines]");
    if (!container) return;
    container.replaceChildren();
    const items = cart();
    for (const item of items) {
      const match = findVariant(item.variantId);
      if (!match) continue;
      const line = document.createElement("article");
      line.className = "order-line";
      line.dataset.testid = "checkout-line";
      const image = variantImage(match);
      if (image) {
        const img = document.createElement("img");
        img.src = image.src;
        img.srcset = image.srcset;
        img.sizes = "64px";
        img.alt = "";
        img.width = img.height = 64;
        line.append(img);
      }
      const description = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = match.product.title;
      const details = document.createElement("p");
      details.textContent = `${match.variant.title} · Qty ${item.quantity}`;
      const price = document.createElement("p");
      price.textContent = money(match.product.price * item.quantity);
      description.append(title, details, price);
      line.append(description);
      container.append(line);
    }
    if (!items.length) {
      container.textContent =
        "Your cart is empty. Add an item before choosing shipping.";
    }
    checkoutTotals();
  }
  renderCheckoutSummary();

  document.addEventListener("shop:cart-changed", renderCheckoutSummary);
  document.addEventListener("shop:checkout-shipping", (event) => {
    checkoutTotals(
      (event as CustomEvent<{ shipping?: number }>).detail.shipping,
    );
  });
}
