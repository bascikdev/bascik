import { html } from "@bascik/bascik/html";
import { pageProduct } from "./product.ts";
export default () =>
  html`${[...new Set(pageProduct().variants.map((variant) => variant.color))].map((color) => html`<option>${color}</option>`)}`;
