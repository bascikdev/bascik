import { html } from "@bascik/bascik/html";
import { requestProduct } from "./product.ts";

export default (request: Request) => {
  const { product, color, imageIndex } = requestProduct(request);
  return html`${product.images.map((image, index) => {
    const preview = html`<img
      src="${image.srcset.split(", ")[0].split(" ")[0]}"
      width="320"
      height="320"
      alt=""
      loading="lazy"
    />`;
    return image.color === color
      ? html`<button
          type="button"
          data-gallery="${index}"
          aria-label="Show product view ${index + 1}"
          aria-pressed="${index === imageIndex}"
          data-testid="gallery-image"
        >
          ${preview}
        </button>`
      : html`<button
          type="button"
          data-gallery="${index}"
          aria-label="Show product view ${index + 1}"
          aria-pressed="false"
          data-testid="gallery-image"
          hidden
        >
          ${preview}
        </button>`;
  })}`;
};
