import { products } from "../../lib/catalog.ts";
import { componentElements } from "../../browser/dom.ts";

export function initProductCard(root: HTMLElement) {
  const { element, elements } = componentElements(root);
  const card = root;
  const item = products.find((entry) => entry.id === card.dataset.cardProduct);
  const image = element<HTMLImageElement>("[data-card-image]");
  const controls = elements<HTMLElement>("[data-card-controls]");
  if (!item || !image || !controls.length)
    throw new Error("Product card catalog data or image controls are missing.");
  const colors = element("[data-card-colors]");
  const template = element<HTMLTemplateElement>("[data-card-color-template]");
  if (!colors || !template)
    throw new Error("Product card controls are missing.");
  for (const color of new Set(item.variants.map((variant) => variant.color))) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const button = fragment.querySelector<HTMLButtonElement>("button")!;
    button.dataset.cardColor = color;
    button.setAttribute("aria-label", color);
    button.textContent = color.replace(/^G\. Dyed /, "");
    colors.append(fragment);
  }
  let color = item.images[0].color;
  let position = 0;
  const show = () => {
    const images = item.images.filter((entry) => entry.color === color);
    const selected = images[position];
    if (!selected) return;
    image.src = selected.src;
    image.srcset = selected.srcset;
    image.alt = selected.alt;
    for (const link of elements<HTMLAnchorElement>(
      `a[href^="/products/${item.slug}"]`,
    )) {
      const url = new URL(`/products/${item.slug}`, location.origin);
      url.searchParams.set("color", color);
      link.href = url.pathname + url.search;
    }
    for (const button of elements<HTMLButtonElement>("[data-card-color]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.cardColor === color),
      );
  };
  for (const button of elements<HTMLButtonElement>("[data-card-color]"))
    button.addEventListener("click", () => {
      if (!button.dataset.cardColor) return;
      color = button.dataset.cardColor;
      position = 0;
      show();
    });
  for (const [selector, direction] of [
    ["[data-card-previous]", -1],
    ["[data-card-next]", 1],
  ] as const)
    element(selector)?.addEventListener("click", () => {
      const count = item.images.filter((entry) => entry.color === color).length;
      if (!count) return;
      position = (position + direction + count) % count;
      show();
    });
  for (const control of controls) control.hidden = false;
  show();
}
