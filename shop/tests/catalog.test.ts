import { describe, expect, test } from "vitest";
import { statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { products, escapeHtml } from "../src/lib/catalog.ts";
import { cartItems, recipient } from "../src/lib/checkout.ts";
import { cents, ProviderError } from "../src/lib/providers.ts";
import { equal, hmac, now, boundedText, body } from "../src/lib/platform.ts";
import { verifyStripeSignature } from "../src/lib/webhooks.ts";
import { imageColor } from "../src/lib/image-colors.ts";
import { productDescription } from "../scripts/product-description.ts";
import { originalImagePath } from "../scripts/image-cache.ts";
import {
  templateFingerprint,
  type TemplateMapping,
} from "../scripts/template-fingerprint.ts";

describe("owned product catalog", () => {
  test("original image cache follows the source URL and version, not gallery position", () => {
    const source = new URL("https://cdn.shopify.com/a.jpg?v=1");
    const old = originalImagePath("shirt", source);
    expect(originalImagePath("shirt", new URL(source))).toBe(old);
    expect(
      originalImagePath("shirt", new URL("https://cdn.shopify.com/a.jpg?v=2")),
    ).not.toBe(old);
    expect(
      originalImagePath("shirt", new URL("https://cdn.shopify.com/b.jpg?v=1")),
    ).not.toBe(old);
  });
  test("template evidence fingerprint binds exact template and design references", () => {
    const mapping: TemplateMapping = {
      variant_id: "1",
      store_id: 19022802,
      catalog_variant_id: 456,
      product_template_id: 123,
      shipping_placements: [{ placement: "front", technique: "dtg" }],
    };
    const hash = templateFingerprint([mapping]);
    expect(
      templateFingerprint([{ ...mapping, product_template_id: 124 }]),
    ).not.toBe(hash);
    expect(
      templateFingerprint([{ ...mapping, catalog_variant_id: 457 }]),
    ).not.toBe(hash);
    expect(
      templateFingerprint([
        {
          ...mapping,
          shipping_placements: [{ placement: "back", technique: "dtg" }],
        },
      ]),
    ).not.toBe(hash);
    expect(templateFingerprint([{ ...mapping, store_id: 1 }])).not.toBe(hash);
  });
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
  describe("bounded request bodies", () => {
    test("cancels oversized streams before consuming the remaining chunks", async () => {
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(8192));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const init = { method: "POST", body: stream, duplex: "half" };
      const request = new Request("https://example.com", init);
      await expect(boundedText(request, 16384)).rejects.toMatchObject({
        status: 413,
      });
      expect(pulls).toBe(3);
      expect(cancelled).toBe(true);
    });
    test("measures UTF-8 bytes and preserves raw signed payload across chunk boundaries", async () => {
      const payload = '{"message":"é😀"}\n';
      const bytes = new TextEncoder().encode(payload);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      });
      const init = { method: "POST", body: stream, duplex: "half" };
      expect(
        await boundedText(
          new Request("https://example.com", init),
          bytes.length,
        ),
      ).toBe(payload);
      await expect(
        boundedText(
          new Request("https://example.com", { method: "POST", body: payload }),
          bytes.length - 1,
        ),
      ).rejects.toMatchObject({ status: 413 });
    });
    test("JSON endpoints enforce the 16 KiB limit on actual bytes", async () => {
      await expect(
        body(
          new Request("https://example.com", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "é".repeat(8192) }),
          }),
        ),
      ).rejects.toMatchObject({ status: 413 });
    });
    test("raw signature text retains a BOM and rejects invalid UTF-8", async () => {
      const payload = '\uFEFF{"id":"event"}';
      expect(
        await boundedText(
          new Request("https://example.com", { method: "POST", body: payload }),
          100,
        ),
      ).toBe(payload);
      await expect(
        boundedText(
          new Request("https://example.com", {
            method: "POST",
            body: new Uint8Array([255]),
          }),
          100,
        ),
      ).rejects.toThrow("Invalid UTF-8");
    });
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
