import { describe, expect, test } from "vitest";
import { statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { products, escapeHtml } from "../src/lib/catalog.ts";
import { cartItems, recipient } from "../src/lib/checkout.ts";
import { cents, ProviderError } from "../src/lib/providers.ts";
import { equal, hmac, now } from "../src/lib/platform.ts";
import { verifyStripeSignature } from "../src/lib/webhooks.ts";
import { imageColor } from "../src/lib/image-colors.ts";
import { productDescription } from "../scripts/product-description.ts";

describe("owned product catalog", () => {
  test("contains exactly two shirts and two hats, with all 24 variants", () => {
    expect(products).toHaveLength(4);
    expect(products.flatMap((product) => product.variants)).toHaveLength(24);
    expect(
      new Set(
        products.flatMap((product) =>
          product.variants.map((variant) => variant.id),
        ),
      ).size,
    ).toBe(24);
    for (const product of products) {
      expect(product.slug).not.toContain("sticker");
      expect(product.price).toBe(product.slug.includes("hat") ? 2500 : 3000);
    }
  });
  test("all 52 captured image views have real local responsive files", () => {
    expect(products.flatMap((product) => product.images)).toHaveLength(52);
    for (const image of products.flatMap((product) => product.images)) {
      expect(image.width).toBeGreaterThan(0);
      expect(image.src.startsWith("/assets/products/")).toBe(true);
      for (const candidate of image.srcset.split(", ")) {
        const [url, width] = candidate.split(" ");
        expect(statSync(`src/pages${url}`).size).toBeGreaterThan(0);
        expect(Number(width.slice(0, -1))).toBeLessThanOrEqual(image.width);
      }
    }
  });
  test("every color has multiple matching product views", () => {
    for (const product of products)
      for (const color of new Set(
        product.variants.map((variant) => variant.color),
      ))
        expect(
          product.images.filter((image) => image.color === color).length,
        ).toBeGreaterThan(1);
  });
  test("rejects ambiguous or conflicting image color metadata", () => {
    const variants = [
      { id: "1", color: "Black" },
      { id: "2", color: "Oyster" },
    ];
    expect(
      imageColor("https://cdn.example/cap-black-front.jpg", variants, [1]),
    ).toBe("Black");
    expect(() =>
      imageColor("https://cdn.example/cap-black-front.jpg", variants, [2]),
    ).toThrow();
    expect(() =>
      imageColor("https://cdn.example/cap-front.jpg", variants, []),
    ).toThrow();
  });
  test("escapes imported content including replacement tokens", () => {
    expect(escapeHtml('<img onerror="$&">')).toBe(
      "&lt;img onerror=&quot;$&amp;&quot;&gt;",
    );
  });
  test("extracts description text with HTML parsing and escapes it at rendering", () => {
    expect(
      productDescription(
        "<p>Books &amp; authors<br />A &lt; B</p><script>alert(1)</script><style>body{}</style><!--hidden-->",
      ),
    ).toBe("Books & authors\nA < B");
    const text = productDescription(
      '<p>&lt;script&gt;literal&lt;/script&gt; $&</p><img src=x onerror="alert(1)">',
    );
    expect(escapeHtml(text)).toBe(
      "&lt;script&gt;literal&lt;/script&gt; $&amp;",
    );
    expect(productDescription("<p>Before</p><p>After")).toBe("Before\nAfter");
  });
  test("built browsing interaction JavaScript stays below 30 KiB gzip", () => {
    expect(
      gzipSync(readFileSync("src/pages/assets/shop.js")).length,
    ).toBeLessThanOrEqual(30 * 1024);
  });
});
describe("checkout inputs", () => {
  const id = products[0].variants[0].id;
  test("uses server prices and accepts an owned variant", () => {
    const cart = cartItems([{ variantId: id, quantity: 2, price: 1 }]);
    expect(cart[0].product.price).toBe(3000);
  });
  test.each(
    [
      [],
      [{ variantId: id, quantity: 0 }],
      [{ variantId: id, quantity: 11 }],
      [{ variantId: "sticker", quantity: 1 }],
      [
        { variantId: id, quantity: 1 },
        { variantId: id, quantity: 1 },
      ],
    ].map((value) => ({ value })),
  )("rejects malformed or unavailable cart shapes: %j", ({ value }) => {
    expect(() => cartItems(value)).toThrow();
  });
  test("enforces state and postal code only where required", () => {
    const input = {
      name: "Test Buyer",
      email: "buyer@example.com",
      address1: "Example street",
      city: "Example",
      country_code: "US",
    };
    expect(() => recipient(input)).toThrow("State/province");
    expect(recipient({ ...input, country_code: "IE" }).zip).toBe("");
  });
  test.each(["-1.00", "1e2", "NaN", "1.001", "0x10", ""])(
    "rejects unsafe shipping amounts: %s",
    (value) => {
      expect(() => cents(value)).toThrow();
    },
  );
  test("converts decimal money without floating point drift", () => {
    expect(cents("13.60")).toBe(1360);
    expect(cents("0.29")).toBe(29);
  });
});
describe("Stripe webhook authentication", () => {
  test("provider backoff honors seconds and HTTP-date Retry-After headers", () => {
    const time = now();
    expect(
      new ProviderError("Printful", 429, "600").retryAt,
    ).toBeGreaterThanOrEqual(time + 600);
    const deadline = new Date((time + 1200) * 1000).toUTCString();
    expect(new ProviderError("Stripe", 429, deadline).retryAt).toBe(
      time + 1200,
    );
    expect(new ProviderError("Stripe", 500, "invalid").retryAt).toBe(0);
  });
  test("accepts a current signature but rejects changed payloads and stale events", async () => {
    const payload = JSON.stringify({ id: "evt_test" });
    const timestamp = now();
    const signed = await hmac("whsec_fixture", `${timestamp}.${payload}`);
    await expect(
      verifyStripeSignature(
        "whsec_fixture",
        payload,
        `t=${timestamp},v1=${signed}`,
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyStripeSignature(
        "whsec_fixture",
        payload + " ",
        `t=${timestamp},v1=${signed}`,
      ),
    ).rejects.toThrow("signature");
    await expect(
      verifyStripeSignature(
        "whsec_fixture",
        payload,
        `t=${timestamp - 301},v1=${signed}`,
      ),
    ).rejects.toThrow("signature");
    expect(equal("aaaa", "aaab")).toBe(false);
  });
});
