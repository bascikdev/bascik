import { html } from "@bascik/bascik/html";
import { pageProduct } from "./product.ts";
export default () => {
  const sizes = [
    ...new Set(pageProduct().variants.map((variant) => variant.size)),
  ];
  return sizes[0] === null
    ? html``
    : html` <label for="size">Size</label>
        <select id="size" name="size" data-testid="product-size">
          ${sizes.map((size) => html`<option>${size ?? ""}</option>`)}
        </select>`;
};
