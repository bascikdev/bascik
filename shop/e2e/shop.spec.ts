import { test, expect } from "@playwright/test";
import { products } from "../src/lib/catalog.ts";

test("catalog is complete and independent of Shopify at runtime", async ({
  page,
}) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (/shopify|cdn\.shopify|shop\.bascik\.dev/.test(request.url()))
      external.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByTestId("product-card")).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "Bascik merch" })).toHaveCount(
    1,
  );
  await expect(page.getByText("Keep it bascik.")).toHaveCount(0);
  for (const product of products)
    await expect(
      page.getByRole("heading", { name: product.title }),
    ).toBeVisible();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
for (const product of products) {
  test(`${product.slug} preserves all option combinations and real image views`, async ({
    page,
  }) => {
    await page.goto(`/products/${product.slug}`);
    await expect(
      page.getByRole("heading", { name: product.title }),
    ).toBeVisible();
    await expect(page.getByTestId("gallery-image")).toHaveCount(
      product.images.length,
    );
    for (const variant of product.variants) {
      await page.getByTestId("product-color").selectOption(variant.color);
      if (variant.size)
        await page.getByTestId("product-size").selectOption(variant.size);
      await page.getByTestId("add-to-cart").click();
      await expect(page.getByTestId("product-form")).toContainText(
        "Added to your cart.",
      );
    }
    const color = product.variants[0].color;
    await page.getByTestId("product-color").selectOption(color);
    const nextIndex = product.images.findIndex(
      (image, index) => index > 0 && image.color === color,
    );
    await page
      .getByRole("button", {
        name: `Show product view ${nextIndex + 1}`,
        exact: true,
      })
      .click();
    await expect(page.getByTestId("product-image")).toHaveAttribute(
      "src",
      product.images[nextIndex].src,
    );
    await page.getByTestId("shop-nav-cart").click();
    await expect(page.getByTestId("cart-line")).toHaveCount(
      product.variants.length,
    );
    await page.reload();
    await expect(page.getByTestId("cart-line")).toHaveCount(
      product.variants.length,
    );
    for (const variant of product.variants) {
      const image = product.images.find(
        (image) => image.sourceId === variant.imageId,
      );
      expect(image?.color).toBe(variant.color);
      const line = page.getByTestId("cart-line").filter({
        has: page.getByText(`${variant.title} ·`, { exact: false }),
      });
      await expect(line).toHaveCount(1);
      await expect(line.getByTestId("cart-image")).toHaveAttribute(
        "src",
        image!.src,
      );
      await expect(line.getByTestId("cart-image")).toHaveAttribute(
        "srcset",
        image!.srcset,
      );
      await expect(line.getByTestId("cart-image")).toHaveAttribute(
        "sizes",
        "80px",
      );
      await line.getByTestId("cart-quantity").fill("2");
      await line.getByTestId("cart-quantity").dispatchEvent("change");
      await expect(line.getByTestId("cart-image")).toHaveAttribute(
        "src",
        image!.src,
      );
    }
  });
}
test("collection cards switch colors and browse only matching views independently", async ({
  page,
}) => {
  await page.goto("/");
  for (const product of products) {
    const card = page
      .getByTestId("product-card")
      .filter({ has: page.getByRole("heading", { name: product.title }) });
    const colors = [
      ...new Set(product.variants.map((variant) => variant.color)),
    ];
    for (const color of colors) {
      const views = product.images.filter((image) => image.color === color);
      expect(views.length).toBeGreaterThan(1);
      await card.getByRole("button", { name: color, exact: true }).click();
      await expect(card.getByTestId("card-image")).toHaveAttribute(
        "src",
        views[0].src,
      );
      await expect(
        card.getByRole("button", { name: color, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await card.getByTestId("card-next").click();
      await expect(card.getByTestId("card-image")).toHaveAttribute(
        "src",
        views[1].src,
      );
      await card.getByTestId("card-previous").click();
      await expect(card.getByTestId("card-image")).toHaveAttribute(
        "src",
        views[0].src,
      );
      await card.getByTestId("card-previous").click();
      await expect(card.getByTestId("card-image")).toHaveAttribute(
        "src",
        views.at(-1)!.src,
      );
    }
  }
});
test("product gallery filters views when color changes", async ({ page }) => {
  for (const product of products) {
    await page.goto(`/products/${product.slug}`);
    for (const color of [
      ...new Set(product.variants.map((variant) => variant.color)),
    ]) {
      await page.getByTestId("product-color").selectOption(color);
      const visible = product.images.filter((image) => image.color === color);
      await expect(page.getByTestId("product-image")).toHaveAttribute(
        "src",
        visible[0].src,
      );
      await expect(
        page.getByTestId("gallery-image").filter({ visible: true }),
      ).toHaveCount(visible.length);
    }
  }
});
test("docs-style navigation works at every viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const nav = page.getByTestId("shop-nav");
  await expect(nav.getByTestId("shop-nav-cart")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await nav.getByTestId("shop-nav-menu").click();
    await expect(nav.getByRole("link", { name: "Docs" })).toBeVisible();
    await nav.getByTestId("shop-nav-menu").click();
  } else await expect(nav.getByRole("link", { name: "Docs" })).toBeVisible();
  await nav.getByTestId("shop-nav-theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page
      .getByTestId("shop-footer")
      .getByRole("link", { name: "Shipping & returns" }),
  ).toBeVisible();
});
test("cart edits and removals update the owned subtotal", async ({ page }) => {
  await page.goto(`/products/${products[0].slug}`);
  await page.getByTestId("add-to-cart").click();
  await page.getByTestId("shop-nav-cart").click();
  await expect(page.getByTestId("cart")).toContainText("$30.00");
  await page.getByTestId("cart-quantity").fill("2");
  await page.getByTestId("cart-quantity").press("Tab");
  await expect(page.getByTestId("cart")).toContainText("$60.00");
  await page.getByTestId("cart-remove").click();
  await expect(page.getByTestId("cart-checkout")).toBeHidden();
});
test("shipping button has clear space below the country field in both themes", async ({
  page,
}) => {
  await page.goto("/checkout");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const country = page.getByTestId("shipping-country");
    await country.focus();
    const field = await country.boundingBox();
    const button = await page.getByTestId("shipping-quote").boundingBox();
    expect(field).not.toBeNull();
    expect(button).not.toBeNull();
    expect(button!.y - (field!.y + field!.height)).toBeGreaterThanOrEqual(24);
  }
});
test("checkout remains safely disabled and reports a useful error", async ({
  page,
  request,
}) => {
  await page.goto("/checkout");
  await page.evaluate(
    (variantId) =>
      localStorage.setItem(
        "bascik-shop-cart",
        JSON.stringify([{ variantId, quantity: 1 }]),
      ),
    products[0].variants[0].id,
  );
  await page.reload();
  await page.getByLabel("Full name").fill("Test Buyer");
  await page.getByLabel("Email", { exact: true }).fill("buyer@example.com");
  await page.getByLabel("Street address").fill("Example street");
  await page.getByLabel("City", { exact: true }).fill("Example");
  await page.getByLabel("State / province", { exact: false }).fill("CA");
  await page.getByLabel("Postal code").fill("90001");
  await page.getByTestId("shipping-country").selectOption("US");
  await page.getByTestId("shipping-quote").click();
  await expect(page.getByRole("status")).toContainText(
    "Checkout is not open yet",
  );
  const response = await request.post("/api/quote", {
    headers: { origin: "http://127.0.0.1:8790" },
    data: {},
  });
  expect(response.status()).toBe(503);
  expect(response.headers()["cache-control"]).toContain("no-store");
});
test("delivery uses US-first Printful destinations without embedded payment fields", async ({
  page,
}) => {
  await page.goto("/checkout");
  const options = await page
    .getByTestId("shipping-country")
    .locator("option")
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLOptionElement).value),
    );
  expect(options[1]).toBe("US");
  expect(options).not.toContain("RU");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByTestId("shipping-form")).toBeVisible();
  await expect(page.getByTestId("checkout-pay")).toHaveText(
    "Continue to Stripe",
  );
});
test("hosted checkout rejects delivery changes during a pending quote and permits a fresh Stripe redirect", async ({
  page,
}) => {
  await page.goto("/checkout");
  await page.evaluate(
    (variantId) =>
      localStorage.setItem(
        "bascik-shop-cart",
        JSON.stringify([{ variantId, quantity: 1 }]),
      ),
    products[0].variants[0].id,
  );
  await page.reload();
  await page.getByLabel("Full name").fill("Test Buyer");
  await page.getByLabel("Email", { exact: true }).fill("buyer@example.com");
  await page.getByLabel("Street address").fill("Example street");
  await page.getByLabel("City", { exact: true }).fill("Phoenix");
  await page.getByLabel("State / province", { exact: false }).fill("Arizona");
  await page.getByLabel("Postal code").fill("85007");
  await page.getByTestId("shipping-country").selectOption("US");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/quote", async (route) => {
    await pending;
    await route.fulfill({
      json: {
        quoteId: "quote_fixture",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        subtotal: 3000,
        rates: [{ id: "STANDARD", name: "Standard", amount: 500 }],
      },
    });
  });
  const requested = page.waitForRequest("**/api/quote");
  await page.getByTestId("shipping-quote").click();
  await requested;
  await page.getByLabel("Street address").fill("Another street");
  release();
  await expect(page.getByRole("status")).toContainText("changed");
  await expect(page.getByTestId("checkout-pay")).toBeHidden();
  await page.getByTestId("shipping-quote").click();
  await expect(page.getByTestId("checkout-pay")).toBeVisible();
  await page.route("**/api/checkout", (route) =>
    route.fulfill({
      json: { url: "https://checkout.stripe.com/c/pay/test_hosted" },
    }),
  );
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Stripe hosted payment</h1>",
    }),
  );
  await page.getByTestId("checkout-pay").click();
  await expect(page).toHaveURL("https://checkout.stripe.com/c/pay/test_hosted");
});
test("private order status cannot be accessed with a public identifier", async ({
  request,
}) => {
  expect(
    (
      await request.post("/api/order", {
        headers: { origin: "http://127.0.0.1:8790" },
        data: { token: "cs_test_public" },
      })
    ).status(),
  ).toBe(404);
  expect((await request.get("/.env")).status()).toBe(404);
  expect((await request.get("/printful-openapi.json")).status()).toBe(404);
  expect((await request.get("/order")).headers()["cache-control"]).toContain(
    "no-store",
  );
  expect(
    (await request.get(products[0].images[0].src)).headers()["cache-control"],
  ).toContain("immutable");
});
test("responsive images reserve space and stay within the mobile transfer budget", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const initialImages = await page.locator("main img").evaluateAll((images) =>
    images.map((image) => {
      const img = image as HTMLImageElement;
      return {
        src: img.currentSrc,
        width: img.width,
        natural: img.naturalWidth,
        height: img.height,
      };
    }),
  );
  expect(initialImages.length).toBe(4);
  for (const image of initialImages) {
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    expect(image.src).toContain(".webp");
  }
  if (testInfo.project.name === "mobile") {
    const bytes = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/assets/products/"))
        .reduce(
          (sum, entry) =>
            sum + (entry as PerformanceResourceTiming).encodedBodySize,
          0,
        ),
    );
    expect(bytes).toBeLessThan(500 * 1024);
    expect(bytes).toBeGreaterThan(0);
  }
});

for (const state of [
  {
    status: "expired",
    paymentConfirmed: false,
    lines: 1,
    label: "expired without payment",
  },
  {
    status: "paid",
    paymentConfirmed: true,
    lines: 0,
    label: "Payment received",
  },
  {
    status: "test_draft",
    paymentConfirmed: true,
    lines: 0,
    label: "Nothing will be produced or shipped",
  },
]) {
  test(`cart clearing requires confirmed payment, not just ${state.status} status`, async ({
    page,
  }) => {
    await page.goto(`/products/${products[0].slug}`);
    await page.getByTestId("add-to-cart").click();
    await page.route("**/api/order", (route) =>
      route.fulfill({
        json: {
          orderId: "browser-fixture",
          status: state.status,
          paymentConfirmed: state.paymentConfirmed,
          items: [{ variantId: products[0].variants[0].id, quantity: 1 }],
          shipments: [],
        },
      }),
    );
    await page.goto("/order#token=browser-fixture");
    await expect(page.getByRole("status")).toContainText(state.label);
    await page.getByTestId("shop-nav-cart").click();
    await expect(page.getByTestId("cart-line")).toHaveCount(state.lines);
  });
}

test("order polling follows payment and asynchronous draft readiness", async ({
  page,
}) => {
  await page.clock.install();
  const states = ["pending", "paid", "submitting", "test_draft"];
  let calls = 0;
  await page.route("**/api/order", (route) =>
    route.fulfill({
      json: {
        orderId: "polling-fixture",
        status: states[Math.min(calls++, states.length - 1)],
        paymentConfirmed: calls > 1,
        testMode: true,
        items: [],
        shipments: [],
      },
    }),
  );
  await page.goto("/order#token=polling-fixture");
  await expect(page.getByRole("status")).toContainText("Waiting for payment");
  await page.clock.fastForward(3000);
  await expect(page.getByRole("status")).toContainText("Payment received");
  await page.clock.fastForward(6000);
  await expect(page.getByRole("status")).toContainText("submitted to Printful");
  await page.clock.fastForward(9000);
  await expect(page.getByRole("status")).toContainText(
    "Nothing will be produced or shipped",
  );
  await page.clock.fastForward(30000);
  expect(calls).toBe(4);
});

test("published customer policies preserve previous shop routes and decisions", async ({
  page,
}) => {
  for (const [route, title] of [
    ["/policies/refund-policy", "Refund policy"],
    ["/policies/privacy-policy", "Privacy policy"],
    ["/policies/terms-of-service", "Terms of service"],
    ["/policies/contact-information", "Contact information"],
    ["/pages/contact", "Contact"],
    ["/pages/data-sharing-opt-out", "Privacy choices"],
    ["/shipping", "Shipping & returns"],
    ["/privacy", "Privacy policy"],
    ["/terms", "Terms of service"],
  ]) {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByTestId("shop-policy").getByRole("heading", { level: 1 }),
    ).toHaveText(title);
    await expect(
      page
        .getByTestId("shop-policy")
        .getByRole("link", { name: "collin@bascik.dev" })
        .first(),
    ).toHaveAttribute("href", "mailto:collin@bascik.dev");
  }
  await page.goto("/policies/refund-policy");
  await expect(page.getByTestId("shop-policy")).toContainText("within 14 days");
  await expect(page.getByTestId("shop-policy")).toContainText(
    "within 10 business days",
  );
  await expect(page.getByTestId("shop-policy")).toContainText("within 7 days");
});

test.describe("high-density image selection", () => {
  test.use({ deviceScaleFactor: 2 });
  test("selects appropriately sized native candidates in a fresh context", async ({
    page,
  }) => {
    await page.goto(`/products/${products[0].slug}`);
    const image = page.getByTestId("product-image");
    await expect(image).toBeVisible();
    const selected = await image.evaluate((element) => {
      const img = element as HTMLImageElement;
      return {
        encodedWidth: Number(img.currentSrc.match(/-(\d+)\.webp/)?.[1]),
        neededWidth: img.getBoundingClientRect().width * devicePixelRatio,
      };
    });
    expect(selected.encodedWidth).toBeGreaterThanOrEqual(
      selected.neededWidth * 0.8,
    );
    expect(selected.encodedWidth).toBeLessThanOrEqual(selected.neededWidth * 2);
    const bytes = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/assets/products/"))
        .reduce(
          (sum, entry) =>
            sum + (entry as PerformanceResourceTiming).encodedBodySize,
          0,
        ),
    );
    expect(bytes).toBeLessThan(750 * 1024);
  });
});
