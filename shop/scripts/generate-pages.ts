import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import {
  products,
  escapeHtml as e,
  money,
  type ProductImage,
} from "../src/lib/catalog.ts";

await mkdir("src/pages/products", { recursive: true });
await mkdir("src/pages/assets", { recursive: true });
for (const name of ["bascik-logo.svg", "favicon.svg"])
  await copyFile(
    `../docs/src/pages/assets/${name}`,
    `src/pages/assets/${name}`,
  );
await build({
  entryPoints: ["src/browser/shop.ts"],
  outfile: "src/pages/assets/shop.js",
  bundle: true,
  minify: true,
  target: "es2022",
});
const img = (image: ProductImage, priority = false, gallery = false) =>
  `<img src="${image.src}" srcset="${image.srcset}" sizes="${gallery ? "(max-width: 640px) calc(100vw - 40px), (max-width: 1280px) 52vw, 640px" : "(max-width: 640px) calc((100vw - 54px)/2), (max-width: 1000px) 46vw, 280px"}" width="${image.width}" height="${image.height}" alt="${e(image.alt)}" ${priority ? 'fetchpriority="high"' : 'loading="lazy"'} ${gallery ? 'data-main-image data-testid="product-image"' : ""}>`;
const shell = (title: string, route: string, content: string, index = true) => {
  const description =
    "Organic cotton Bascik shirts and hats. Two designs, made to order by Printful. Shop the official Bascik collection.";
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} | Bascik Shop</title><meta name="description" content="${description}"><meta name="referrer" content="no-referrer"><meta name="robots" content="${index ? "index,follow" : "noindex,nofollow"}"><link rel="canonical" href="https://shop.bascik.dev${route}"><meta property="og:title" content="${e(title)}"><meta property="og:type" content="website"><meta property="og:url" content="https://shop.bascik.dev${route}"><meta property="og:description" content="${description}"><meta property="og:image" content="https://shop.bascik.dev${products[0].images[0].src}"><link rel="icon" href="/assets/favicon.svg"><script src="/assets/shop.js" defer></script></head><body><shop-nav /><main id="main" data-testid="main">${content}</main><shop-footer /></body></html>`;
};
const cards = products.map((product, index) => {
  const colors = [...new Set(product.variants.map((variant) => variant.color))];
  return `<product-card><div data-card-product="${e(product.id)}"><div class="card-photo"><a class="photo" href="/products/${product.slug}" aria-label="${e(product.title)}">${img(product.images[0], index === 0).replace("<img ", '<img data-card-image data-testid="card-image" ')}</a><div class="image-arrows" data-card-controls hidden><button type="button" data-card-previous aria-label="Previous image" data-testid="card-previous">&#8592;</button><button type="button" data-card-next aria-label="Next image" data-testid="card-next">&#8594;</button></div></div><div class="card-controls" data-card-controls hidden><div class="color-options" role="group" aria-label="Color">${colors.map((color, colorIndex) => `<button type="button" data-card-color="${e(color)}" aria-label="${e(color)}" aria-pressed="${colorIndex === 0}" data-testid="card-color">${e(color.replace(/^G\. Dyed /, ""))}</button>`).join("")}</div></div><h2 class="card-title"><a href="/products/${product.slug}">${e(product.title)}</a></h2><div class="meta"><span class="price">${money(product.price)}</span></div></div></product-card>`;
});
await writeFile(
  "src/pages/index.html",
  shell(
    "Official merch",
    "/",
    `<section aria-label="Merchandise"><h1 class="visually-hidden">Bascik merch</h1><div class="grid">${cards.join("")}</div></section>`,
  ),
);
for (const product of products) {
  const colors = [...new Set(product.variants.map((variant) => variant.color))];
  const sizes = [...new Set(product.variants.map((variant) => variant.size))];
  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    image: product.images.map((image) => `https://shop.bascik.dev${image.src}`),
    brand: { "@type": "Brand", name: "Bascik" },
    offers: {
      "@type": "Offer",
      url: `https://shop.bascik.dev/products/${product.slug}`,
      priceCurrency: "USD",
      price: (product.price / 100).toFixed(2),
    },
  }).replace(/</g, "\\u003c");
  await writeFile(
    `src/pages/products/${product.slug}.html`,
    shell(
      product.title,
      `/products/${product.slug}`,
      `<p class="crumbs"><a href="/">Shop</a> / ${e(product.title)}</p><section class="detail" data-testid="product-detail" data-product="${e(product.id)}"><div><div class="photo">${img(product.images[0], true, true)}</div><div class="thumbnails" role="group" aria-label="Product images">${product.images.map((image, index) => `<button type="button" data-gallery="${index}" aria-label="Show product view ${index + 1}" aria-pressed="${index === 0}" data-testid="gallery-image"><img src="${image.srcset.split(", ")[0].split(" ")[0]}" width="320" height="320" alt="" loading="lazy"></button>`).join("")}</div></div><div><p class="eyebrow">THE BASCIK COLLECTION</p><h1>${e(product.title)}</h1><p class="price">${money(product.price)}</p><p class="muted">Shipping and applicable tax calculated at checkout.</p><form data-product-form data-testid="product-form"><label for="color">Color</label><select id="color" name="color" data-testid="product-color">${colors.map((color) => `<option>${e(color)}</option>`).join("")}</select>${sizes[0] !== null ? `<label for="size">Size</label><select id="size" name="size" data-testid="product-size">${sizes.map((size) => `<option>${e(size ?? "")}</option>`).join("")}</select>` : ""}<label for="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min="1" max="10" value="1" required data-testid="product-quantity"><button class="primary" data-testid="add-to-cart">Add to cart</button><p class="status" role="status" data-product-status></p></form><h2>Details</h2><p class="description">${e(product.description)}</p><p><a href="/shipping">Shipping, sizing &amp; returns</a></p></div></section><script type="application/ld+json">${schema}</script>`,
    ),
  );
}
await writeFile(
  "src/pages/cart.html",
  shell(
    "Your cart",
    "/cart",
    `<section class="narrow" data-testid="cart"><h1>Your cart.</h1><div data-cart-lines></div><p class="status" role="status" data-cart-status></p><div class="summary"><strong>Subtotal</strong><strong data-cart-total>$0.00</strong></div><p class="muted">Shipping and applicable taxes calculated next.</p><div class="actions"><a href="/">Continue shopping</a><a href="/checkout" class="button primary" data-testid="cart-checkout">Choose shipping</a></div></section>`,
    false,
  ),
);
await writeFile(
  "src/pages/checkout.html",
  shell(
    "Delivery and checkout",
    "/checkout",
    `<section class="narrow" data-testid="checkout"><p class="crumbs"><a href="/cart">Cart</a> / Delivery / Secure payment</p><h1>Where to?</h1><p>Choose your delivery address and shipping service here. Then pay securely with Stripe.</p><p class="notice">The new shop is being prepared. Checkout stays disabled until tax, fulfillment, and email setup have been verified.</p><form data-shipping-form data-testid="shipping-form">${[
      ["name", "Full name", "name"],
      ["email", "Email", "email"],
      ["address1", "Street address", "address-line1"],
      ["address2", "Apartment, suite (optional)", "address-line2"],
      ["city", "City", "address-level2"],
      [
        "state_code",
        "State / province code (required for US, CA, AU)",
        "address-level1",
      ],
      ["zip", "Postal code", "postal-code"],
    ]
      .map(
        ([name, label, autocomplete]) =>
          `<label for="${name}">${label}</label><input id="${name}" name="${name}" autocomplete="${autocomplete}" ${["address2", "state_code"].includes(name) ? "" : "required"} ${name === "email" ? 'type="email"' : ""}>`,
      )
      .join(
        "",
      )}<label for="country">Country / region</label><select id="country" name="country_code" autocomplete="country" required data-testid="shipping-country"><option value="">Choose your country</option></select><button class="primary" type="submit" data-testid="shipping-quote">Get shipping options</button></form><div class="status" role="status" data-checkout-status></div><section data-rates-section hidden><h2>Shipping options</h2><p>Availability and rates are specific to your cart and destination. Delivery estimates are not guarantees. Import duties may be payable on delivery.</p><div class="rates" data-rates></div><button class="primary" data-pay data-testid="checkout-pay">Continue to Stripe</button><p class="muted">USD pricing. Stripe will show your final total including applicable tax before payment. To change the delivery address, return here and request a new quote.</p></section></section>`,
    false,
  ),
);
await writeFile(
  "src/pages/order.html",
  shell(
    "Order status",
    "/order",
    `<section class="narrow" data-testid="order"><h1>Your order.</h1><p class="status" role="status" data-order-status>Checking your order...</p><div data-shipments></div><p>Keep this private link to check fulfillment and tracking. Payment confirmation can take a moment.</p><a href="/">Back to the collection</a></section>`,
    false,
  ),
);
for (const [route, title, content] of [
  [
    "shipping",
    "Shipping & returns",
    "Products are made to order by Printful. Delivery availability, prices, and estimates are calculated for your items and destination before payment. International orders may incur customs or import charges. Size guides, support contact, returns terms, and cancellation rules are awaiting owner approval. Ordering remains disabled until these details are published.",
  ],
  [
    "privacy",
    "Privacy",
    "The shop requires delivery and contact details to process orders through Stripe and Printful. Private order pages are not publicly indexed. The final seller contact, retention policy, and privacy terms are awaiting owner approval; ordering remains disabled until they are published.",
  ],
  [
    "terms",
    "Terms",
    "The seller's contact information, refund terms, applicable taxes, and international sales policies must be confirmed before launch. The shop is not accepting orders until these terms are approved.",
  ],
]) {
  await writeFile(
    `src/pages/${route}.html`,
    shell(
      title,
      `/${route}`,
      `<section class="narrow"><h1>${title}</h1><p>${e(content)}</p><a href="/">Back to the collection</a></section>`,
      false,
    ),
  );
}
await writeFile(
  "src/pages/404.html",
  shell(
    "Not found",
    "/404",
    '<section class="narrow"><h1>Not in the collection.</h1><p>This page or product is no longer available.</p><a class="button primary" href="/">Browse shirts and hats</a></section>',
    false,
  ),
);
