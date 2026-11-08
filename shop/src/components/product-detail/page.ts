import { html, json } from "@bascik/bascik/html";
import { money } from "../../lib/catalog.ts";
import { pageProduct } from "./product.ts";

export default () => {
  const product = pageProduct();
  return html` <p class="crumbs"><a href="/">Shop</a> / ${product.title}</p>
    <product-detail
      data-bascik-prop-product="${product.id}"
      data-bascik-prop-title="${product.title}"
      data-bascik-prop-price="${money(product.price)}"
      data-bascik-prop-description="${product.description}"
    />
    <script type="application/ld+json">
      ${json({
        "@context": "https://schema.org",
        "@type": "Product",
        name: product.title,
        description: product.description,
        image: product.images.map(
          (image) => `https://shop.bascik.dev${image.src}`,
        ),
        brand: { "@type": "Brand", name: "Bascik" },
        offers: {
          "@type": "Offer",
          url: `https://shop.bascik.dev/products/${product.slug}`,
          priceCurrency: "USD",
          price: (product.price / 100).toFixed(2),
        },
      })}
    </script>`;
};
