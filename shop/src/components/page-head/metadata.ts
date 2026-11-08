import { html } from "@bascik/bascik/html";
import { products } from "../../lib/catalog.ts";
import { policyPages } from "../../lib/policies.ts";

export default () => {
  const route = process.env.BASCIK_PAGE_PATH;
  if (!route) throw new Error("Page metadata requires BASCIK_PAGE_PATH.");
  const product = products.find(
    (product) => route === `/products/${product.slug}`,
  );
  const title =
    product?.title ??
    policyPages.find((policy) => route === `/${policy.route}`)?.title ??
    (
      {
        "/": "Official merch",
        "/cart": "Your cart",
        "/checkout": "Delivery and checkout",
        "/order": "Order status",
        "/404": "Not found",
      } as Record<string, string>
    )[route];
  if (!title) throw new Error(`No metadata for ${route}`);
  const description =
    product?.description ??
    "Bascik organic shirts, sweatshirts, hats, and vinyl decals. Shop the official Bascik collection.";
  const url = `https://shop.bascik.dev${route}`;
  const image = `https://shop.bascik.dev${(product ?? products[0]).images[0].src}`;
  return html` <title>${title} | Bascik Shop</title>
    <meta name="description" content="${description}" />
    <meta
      name="robots"
      content="${route === "/" || product ? "index,follow" : "noindex,nofollow"}"
    />
    <link rel="canonical" href="${url}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${url}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${image}" />`;
};
