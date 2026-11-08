import { products } from "../../lib/catalog.ts";
import { cart, save } from "../../browser/cart.ts";
import { componentElements } from "../../browser/dom.ts";

export function initProductDetail(root: HTMLElement) {
  const { element, elements, status } = componentElements(root);
  const detail = root;
  const product = products.find(
    (entry) => entry.id === detail?.dataset.product,
  );
  const form = element<HTMLFormElement>("[data-product-form]");
  function showImage(index: number) {
    const image = product?.images[index];
    const target = element<HTMLImageElement>("[data-main-image]");
    if (!image || !target) return;
    target.src = image.src;
    target.srcset = image.srcset;
    target.alt = image.alt;
    for (const button of elements<HTMLButtonElement>("[data-gallery]"))
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.gallery) === index),
      );
  }
  function showColor(color: string) {
    for (const button of elements<HTMLButtonElement>("[data-gallery]")) {
      const image = product?.images[Number(button.dataset.gallery)];
      button.hidden = image?.color !== color;
    }
    const index =
      product?.images.findIndex((image) => image.color === color) ?? -1;
    if (index >= 0) showImage(index);
  }
  for (const button of elements<HTMLButtonElement>("[data-gallery]"))
    button.addEventListener("click", () =>
      showImage(Number(button.dataset.gallery)),
    );
  form?.addEventListener("change", (event) => {
    if (
      !(event.target instanceof HTMLSelectElement) ||
      event.target.name !== "color"
    )
      return;
    const data = new FormData(form);
    const color = data.get("color");
    if (typeof color === "string") showColor(color);
  });
  const requestedColor = new URLSearchParams(location.search).get("color");
  const colorSelect = form?.querySelector<HTMLSelectElement>(
    "select[name='color']",
  );
  if (
    requestedColor !== null &&
    colorSelect &&
    product?.variants.some((variant) => variant.color === requestedColor)
  )
    colorSelect.value = requestedColor;
  const initialColor = form && new FormData(form).get("color");
  if (typeof initialColor === "string") showColor(initialColor);
  function showCartLink() {
    const link = element("[data-testid=product-view-cart]");
    if (link) link.hidden = cart().length === 0;
  }
  if (cart().length) showCartLink();
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const variant = product?.variants.find(
      (variant) =>
        variant.color === data.get("color") &&
        (!variant.size || variant.size === data.get("size")),
    );
    if (!variant)
      return status(
        "[data-product-status]",
        "Choose an available size and color.",
        true,
      );
    const quantity = Number(data.get("quantity"));
    const items = cart();
    const existing = items.find((item) => item.variantId === variant.id);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity + (existing?.quantity ?? 0) > 10
    )
      return status(
        "[data-product-status]",
        "Please choose up to 10 of each item.",
        true,
      );
    if (existing) existing.quantity += quantity;
    else items.push({ variantId: variant.id, quantity });
    try {
      save(items);
      status("[data-product-status]", "Added to your cart.");
      showCartLink();
    } catch (error) {
      console.error(error);
      status(
        "[data-product-status]",
        "Your browser could not save the cart. Check storage permissions.",
        true,
      );
    }
  });

  document.addEventListener("shop:cart-changed", showCartLink);
}
