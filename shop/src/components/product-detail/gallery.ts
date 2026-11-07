import { html } from "@bascik/bascik/html";
import { pageProduct } from "./product.ts";

export default () =>
  html`${pageProduct().images.map(
    (image, index) => html`
      <button
        type="button"
        class="thumbnail"
        data-gallery="${index}"
        aria-label="Show product view ${index + 1}"
        aria-pressed="${index === 0}"
        data-testid="gallery-image"
      >
        <img
          src="${image.srcset.split(", ")[0].split(" ")[0]}"
          width="320"
          height="320"
          alt=""
          loading="lazy"
        />
      </button>
    `,
  )}`;
