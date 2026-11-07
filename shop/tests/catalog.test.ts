import { describe, expect, test } from "vitest";
import { statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { format } from "prettier";
import { products, escapeHtml } from "../src/lib/catalog.ts";
import { shippingCountries } from "../src/lib/shipping-countries.ts";
import destinations from "../catalog/shipping-countries.json" with { type: "json" };
import { cartItems, recipient } from "../src/lib/checkout.ts";
import { cents, ProviderError } from "../src/lib/providers.ts";
import { equal, hmac, now, boundedText, body } from "../src/lib/platform.ts";
import { verifyStripeSignature } from "../src/lib/webhooks.ts";
import { imageColor } from "../src/lib/image-colors.ts";
import { productDescription } from "../scripts/product-description.ts";
import {
  policyPages,
  refundPolicy,
  termsPolicy,
  privacyPolicy,
  supportEmail,
} from "../src/lib/policies.ts";
import { originalImagePath } from "../scripts/image-cache.ts";
import {
  templateFingerprint,
  type TemplateMapping,
} from "../scripts/template-fingerprint.ts";

describe("owned product catalog", () => {
  test("generated storefront pages use default Prettier HTML formatting", async () => {
    const routes = [
      "index",
      "cart",
      "checkout",
      "order",
      "404",
      ...products.map((product) => `products/${product.slug}`),
      ...policyPages.map((policy) => policy.route),
    ];
    for (const route of routes) {
      const markup = readFileSync(`src/pages/${route}.html`, "utf8");
      expect(markup).toBe(await format(markup, { parser: "html" }));
      expect(markup.split("\n").length).toBeGreaterThan(1);
    }
  });
  test("owner-supplied decal PNGs produce correctly sized WebP assets without losing transparency", async () => {
    const manifest = JSON.parse(
      readFileSync("image-originals/manifest.json", "utf8"),
    ) as {
      source: string;
      file: string;
      width: number;
      outputs: { url: string; width: number; bytes: number }[];
    }[];
    const decals = manifest.filter((image) =>
      image.source.startsWith("owner-supplied:"),
    );
    expect(decals).toHaveLength(4);
    for (const image of decals) {
      const source = await sharp(image.file).metadata();
      const { isOpaque } = await sharp(image.file).stats();
      expect(source.width).toBe(768);
      expect(image.outputs.map((output) => output.width)).toEqual([320, 640]);
      for (const output of image.outputs) {
        const file = `src/pages${output.url}`;
        const actual = await sharp(file).metadata();
        expect(actual.format).toBe("webp");
        expect(actual.width).toBe(output.width);
        expect(actual.height).toBe(output.width);
        expect((await sharp(file).stats()).isOpaque).toBe(isOpaque);
        if (!isOpaque) expect(actual.hasAlpha).toBe(true);
        expect(statSync(file).size).toBe(output.bytes);
      }
    }
    for (const product of products.filter((product) =>
      product.slug.includes("decal"),
    )) {
      expect(product.price).toBe(500);
      expect(product.taxCode).toBe("txcd_99999999");
      expect(product.variants).toHaveLength(1);
      expect(product.variants[0].size).toBeNull();
    }
  });
  test("shipping countries are cart-specific, US-first, and otherwise alphabetical", () => {
    const supported: Record<string, string[]> = destinations;
    for (const ids of [
      [],
      ...products.map((product) => [product.id]),
      products.map((product) => product.id),
    ]) {
      const list = shippingCountries(ids);
      expect(list[0].code).toBe("US");
      const remaining = list.slice(1).map((country) => country.name);
      expect(remaining).toEqual(
        [...remaining].sort((a, b) => a.localeCompare(b, "en")),
      );
      for (const productId of ids.length ? ids : Object.keys(supported))
        expect(
          list.every((country) => supported[productId].includes(country.code)),
        ).toBe(true);
      expect(list.some((country) => country.code === "RU")).toBe(false);
    }
    expect(() => shippingCountries(["unknown"])).toThrow(
      "Shipping countries missing",
    );
  });
  test("carries owner-approved policy decisions and legacy URLs into the new shop", () => {
    expect(supportEmail).toBe("shop@bascik.dev");
    for (const text of [
      "All sales are final",
      "within 7 days",
      "within 14 days",
      "within 10 business days",
      "responsibility of the customer",
      "without prior authorization",
    ])
      expect(refundPolicy).toContain(text);
    expect(termsPolicy).toContain("Risk of loss and title");
    expect(termsPolicy).not.toContain("hosted on Shopify");
    expect(privacyPolicy).toContain("Cloudflare");
    expect(privacyPolicy).toContain("Stripe");
    expect(privacyPolicy).toContain("Printful");
    expect(privacyPolicy).not.toContain("powered by Shopify");
    for (const route of [
      "policies/refund-policy",
      "policies/privacy-policy",
      "policies/terms-of-service",
      "policies/contact-information",
      "pages/contact",
      "pages/data-sharing-opt-out",
    ])
      expect(policyPages.some((page) => page.route === route)).toBe(true);
    for (const policy of policyPages)
      expect(policy.content).not.toMatch(
        /awaiting owner approval|terms are approved|cdn-cgi\/l\/email-protection/,
      );
  });
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
  test("contains two shirts, two hats, and two $5 decals with all 26 variants", () => {
    expect(products).toHaveLength(6);
    expect(products.flatMap((product) => product.variants)).toHaveLength(26);
    expect(
      new Set(
        products.flatMap((product) =>
          product.variants.map((variant) => variant.id),
        ),
      ).size,
    ).toBe(26);
    for (const product of products) {
      expect(product.slug).not.toContain("sticker");
      expect(product.price).toBe(
        product.slug.includes("decal")
          ? 500
          : product.slug.includes("hat")
            ? 2500
            : 3000,
      );
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
  test("all 56 captured image views have real local responsive WebP files", () => {
    expect(products.flatMap((product) => product.images)).toHaveLength(56);
    for (const image of products.flatMap((product) => product.images)) {
      expect(image.width).toBeGreaterThan(0);
      expect(image.src.startsWith("/assets/products/")).toBe(true);
      for (const candidate of image.srcset.split(", ")) {
        const [url, width] = candidate.split(" ");
        expect(url).toMatch(/\.webp$/);
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
  test("Singapore's omitted Stripe city is normalized without accepting incomplete addresses", () => {
    const input = {
      name: "Test Buyer",
      email: "buyer@example.com",
      address1: "1 Parliament Pl",
      city: "",
      country_code: "SG",
      zip: "178880",
    };
    expect(recipient(input).city).toBe("Singapore");
    expect(() => recipient({ ...input, zip: "" })).toThrow(
      "Postal code is required",
    );
    expect(() => recipient({ ...input, country_code: "US" })).toThrow(
      "required delivery fields",
    );
  });
  test.each([
    ["US", "Arizona", "AZ"],
    ["US", " az ", "AZ"],
    ["US", "ARIZONA", "AZ"],
    ["CA", "Ontario", "ON"],
    ["AU", "Queensland", "QLD"],
  ])("normalizes %s state %s to %s", (country, state, code) => {
    expect(
      recipient({
        name: "Test Buyer",
        email: "buyer@example.com",
        address1: "Example street",
        city: "Example",
        country_code: country,
        state_code: state,
        zip: "12345",
      }).state_code,
    ).toBe(code);
  });
  test.each(["United States", "ZZ", "Not a state"])(
    "rejects invalid US state %s with an actionable error",
    (state) => {
      expect(() =>
        recipient({
          name: "Test Buyer",
          email: "buyer@example.com",
          address1: "Example street",
          city: "Example",
          country_code: "US",
          state_code: state,
          zip: "85007",
        }),
      ).toThrow("valid state/province name or code for United States");
    },
  );
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
