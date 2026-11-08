import { html } from "@bascik/bascik/html";
import { products, money } from "../../lib/catalog.ts";

export default () =>
  html`${products.map((product, index) => {
    const image = product.images[0];
    return html`<product-card
      data-bascik-prop-product="${product.id}"
      data-bascik-prop-title="${product.title}"
      data-bascik-prop-href="/products/${product.slug}"
      data-bascik-prop-price="${money(product.price)}"
      data-bascik-prop-src="${image.src}"
      data-bascik-prop-srcset="${image.srcset}"
      data-bascik-prop-alt="${image.alt}"
      data-bascik-prop-width="${image.width}"
      data-bascik-prop-height="${image.height}"
      data-bascik-prop-loading="${index === 0 ? "eager" : "lazy"}"
      data-bascik-prop-priority="${index === 0 ? "high" : "auto"}"
    />`;
  })}`;
