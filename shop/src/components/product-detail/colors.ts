import { html } from "@bascik/bascik/html";
import { requestProduct } from "./product.ts";
export default (request: Request) => {
  const { product, color: selected } = requestProduct(request);
  return html`${[
    ...new Set(product.variants.map((variant) => variant.color)),
  ].map((color) =>
    color === selected
      ? html`<option selected>${color}</option>`
      : html`<option>${color}</option>`,
  )}`;
};
