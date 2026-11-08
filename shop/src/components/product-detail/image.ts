import { html } from "@bascik/bascik/html";
import { requestProduct } from "./product.ts";

export default (request: Request) => {
  const { product, imageIndex } = requestProduct(request);
  const image = product.images[imageIndex];
  return html`<img
    data-main-image
    data-testid="product-image"
    src="${image.src}"
    srcset="${image.srcset}"
    alt="${image.alt}"
    width="${image.width}"
    height="${image.height}"
    sizes="(max-width: 640px) calc(100vw - 40px), (max-width: 1280px) 52vw, 640px"
    fetchpriority="high"
  />`;
};
