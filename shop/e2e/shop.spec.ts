import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { products } from "../src/lib/catalog.ts";

test("all rendered storefront buttons have explicit types, including cloned controls", async ({
  page,
}) => {
  for (const path of [
    "/",
    ...products.map((product) => `/products/${product.slug}`),
    "/cart",
    "/checkout",
    "/order",
    "/contact",
    "/missing-product",
  ]) {
    await page.goto(path);
    if (path.startsWith("/products/"))
      await page.getByTestId("add-to-cart").click();
    const missing = await page
      .locator("button")
      .evaluateAll((buttons) =>
        buttons
          .filter(
            (button) =>
              !["button", "submit", "reset"].includes(
                button.getAttribute("type") ?? "",
              ),
          )
          .map((button) => button.outerHTML),
      );
    expect(missing, path).toEqual([]);
  }
});

test("legacy Shopify page URLs permanently redirect to root pages", async ({
  page,
  request,
}) => {
  for (const [oldPath, currentPath] of [
    ["/pages/contact", "/contact"],
    ["/pages/data-sharing-opt-out", "/data-sharing-opt-out"],
  ]) {
    for (const suffix of ["", "/"]) {
      const response = await request.get(`${oldPath}${suffix}`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(301);
      expect(
        new URL(response.headers().location, response.url()).pathname,
      ).toBe(currentPath);
    }
    await page.goto(oldPath);
    await expect(page).toHaveURL(new RegExp(`${currentPath}$`));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://shop.bascik.dev${currentPath}`,
    );
  }
  await expect(
    page
      .getByTestId("shop-footer")
      .getByRole("link", { name: "Contact", exact: true }),
  ).toHaveAttribute("href", "/contact");
});

test("free shipping promotion and cart feedback update at the strict merchandise threshold", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("free-shipping-banner")).toContainText(
    "over $50",
  );
  await expect(page.getByTestId("free-shipping-banner")).toContainText(
    "lower 48 states",
  );
  await page.goto(`/products/${products[0].slug}`);
  await expect(page.getByTestId("free-shipping-banner")).toBeVisible();
  await page.getByTestId("add-to-cart").click();
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "over $50",
  );
  await page.getByTestId("product-quantity").fill("1");
  await page.getByTestId("add-to-cart").click();
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "over $50",
  );
  await page.getByTestId("product-view-cart").click();
  await expect(page.getByTestId("cart-total")).toHaveText("$60.00");
  await expect(page.getByTestId("cart-checkout")).toHaveText("Checkout");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "delivery address",
  );
  await page.getByTestId("cart-quantity").fill("1");
  await page.getByTestId("cart-quantity").dispatchEvent("change");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "more than $20.00",
  );
  await page.reload();
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "more than $20.00",
  );
  await page.getByTestId("cart-remove").click();
  await expect(page.getByTestId("cart-checkout")).toBeHidden();
  await expect(page.getByTestId("free-shipping-progress")).not.toContainText(
    "Your cart qualifies",
  );
  const hat = products.find((product) => product.slug.includes("hat"))!;
  await page.evaluate(
    (variantId) =>
      localStorage.setItem(
        "bascik-shop-cart",
        JSON.stringify([{ variantId, quantity: 2 }]),
      ),
    hat.variants[0].id,
  );
  await page.reload();
  await expect(page.getByTestId("cart-total")).toHaveText("$50.00");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "Add another item",
  );
  await page.goto("/");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "over $50",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("shipping notes stay compact and contextual, with full terms one link away", async ({
  page,
}) => {
  for (const path of ["/", `/products/${products[0].slug}`, "/cart"]) {
    await page.goto(path);
    const note = page.getByTestId("free-shipping-banner");
    await expect(note).toBeVisible();
    await expect(note.getByTestId("free-shipping-terms")).toHaveAttribute(
      "href",
      "/shipping",
    );
    await expect(note).not.toContainText("other services retain");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute("data-theme", theme),
        theme,
      );
      const style = await note.evaluate((element) => {
        const css = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          background: css.backgroundColor,
          border: css.borderTopWidth,
          padding: css.paddingTop,
          fontSize: parseFloat(css.fontSize),
        };
      });
      expect(style.height).toBeLessThan(100);
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      expect(style.border).toBe("0px");
      expect(style.padding).toBe("0px");
      expect(style.fontSize).toBeLessThanOrEqual(14);
    }
    if (path.startsWith("/products/"))
      await expect(
        page.getByTestId("product-detail").getByTestId("free-shipping-banner"),
      ).toBeVisible();
    if (path === "/cart") {
      await expect(
        page.getByTestId("cart").getByTestId("free-shipping-banner"),
      ).toBeVisible();
      const subtotal = await page.getByTestId("cart-total").boundingBox();
      const shipping = await note.boundingBox();
      expect(shipping!.y).toBeGreaterThan(subtotal!.y);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByTestId("free-shipping-terms").click();
  await expect(page.getByTestId("shop-policy")).toContainText(
    "The lowest-cost available shipping option is free; other services retain their full price.",
  );
  await expect(page.getByTestId("shop-policy")).toContainText(
    "Before tax and shipping",
  );
});

test("shipping offer and terms remain available without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    for (const path of ["/", `/products/${products[0].slug}`, "/cart"]) {
      await page.goto(path);
      await expect(page.getByTestId("free-shipping-banner")).toContainText(
        "merchandise over $50 to the lower 48 states",
      );
      await page.getByTestId("free-shipping-terms").click();
      await expect(page.getByTestId("shop-policy")).toContainText(
        "The lowest-cost available shipping option is free",
      );
    }
  } finally {
    await context.close();
  }
});

test("checkout confirms destination-specific free shipping and invalidates it after address changes", async ({
  page,
}) => {
  await page.goto("/checkout");
  await page.evaluate(
    (variantId) =>
      localStorage.setItem(
        "bascik-shop-cart",
        JSON.stringify([{ variantId, quantity: 2 }]),
      ),
    products[0].variants[0].id,
  );
  await page.reload();
  await expect(page.getByTestId("checkout-line")).toHaveCount(1);
  await page.getByTestId("shipping-country").selectOption("US");
  await page
    .getByLabel("State / province", { exact: false })
    .fill("California");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "qualifies",
  );
  await page.getByLabel("Full name").fill("Test Buyer");
  await page.getByLabel("Email", { exact: true }).fill("buyer@example.com");
  await page.getByLabel("Street address").fill("Example Street");
  await page.getByLabel("City", { exact: true }).fill("Los Angeles");
  await page.getByLabel("Postal code").fill("90001");
  await page.route("**/api/quote", async (route) => {
    const input = route.request().postDataJSON();
    const free = ["CA", "California"].includes(input.recipient.state_code);
    await route.fulfill({
      json: {
        quoteId: "quote_free_fixture",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        subtotal: 6000,
        rates: [
          {
            id: "STANDARD",
            name: free ? "Free standard shipping - Standard" : "Standard",
            amount: free ? 0 : 500,
          },
          { id: "STANDARD_CARBON_OFFSET", name: "Carbon offset", amount: 600 },
        ],
      },
    });
  });
  await page.getByTestId("shipping-quote").click();
  await expect(page.locator("[data-rates]")).toContainText(
    "Free standard shipping",
  );
  await expect(page.locator("[data-checkout-shipping]")).toHaveText("$0.00");
  await expect(page.locator("[data-checkout-total]")).toHaveText("$60.00");
  await page.getByRole("radio", { name: /Carbon offset/ }).check();
  await expect(page.locator("[data-checkout-total]")).toHaveText("$66.00");
  await page.getByLabel("State / province", { exact: false }).fill("HI");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "Regular shipping rates apply",
  );
  await expect(page.getByTestId("checkout-pay")).toBeHidden();
  await expect(page.locator("[data-checkout-shipping]")).toHaveText(
    "Calculated next",
  );
  await page.getByTestId("shipping-quote").click();
  await expect(page.locator("[data-checkout-shipping]")).toHaveText("$5.00");
  await expect(page.locator("[data-checkout-total]")).toHaveText("$65.00");
  await page.getByTestId("shipping-country").selectOption("CA");
  await expect(page.getByTestId("free-shipping-progress")).toContainText(
    "Regular shipping rates apply",
  );
  await expect(page.getByTestId("checkout-pay")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

for (const product of products.filter((product) =>
  product.slug.includes("decal"),
)) {
  test(`${product.slug} has responsive images, a $5 price, and a working cart`, async ({
    page,
  }) => {
    await page.goto(`/products/${product.slug}`);
    await expect(
      page.getByRole("heading", { name: product.title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("product-detail").getByText("$5.00", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      `https://shop.bascik.dev${product.images[0].src}`,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      product.description,
    );
    await expect(page.getByTestId("product-image")).toHaveAttribute(
      "src",
      /\.webp$/,
    );
    await page.getByTestId("add-to-cart").click();
    await page.getByTestId("product-view-cart").click();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await expect(page.getByTestId("cart-line")).toContainText(product.title);
    await expect(page.getByTestId("cart-total")).toHaveText("$5.00");
  });
}

test("email logo is a published PNG rasterized from the shared Bascik SVG", async ({
  request,
}) => {
  const response = await request.get("/assets/bascik-email-logo.png");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const image = await response.body();
  expect(image.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(image.readUInt32BE(16)).toBe(456);
  expect(image.readUInt32BE(20)).toBe(112);
  expect(image).toEqual(
    await sharp("src/pages/assets/bascik-logo.svg", { density: 288 })
      .resize(456, 112)
      .png()
      .toBuffer(),
  );
});

test("adding a product offers a prominent cart link that survives reload", async ({
  page,
}) => {
  await page.goto(`/products/${products[0].slug}`);
  await expect(page.getByTestId("product-view-cart")).toBeHidden();
  await page.getByTestId("add-to-cart").click();
  await expect(page.getByTestId("product-view-cart")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("product-view-cart")).toBeVisible();
  await page.getByTestId("product-view-cart").click();
  await expect(page.getByTestId("cart-line")).toHaveCount(1);
});
test("empty delivery page offers cart recovery instead of an unusable form", async ({
  page,
}) => {
  await page.goto("/checkout");
  await expect(page.getByTestId("shipping-form")).toBeHidden();
  await expect(page.getByTestId("checkout-summary")).toContainText(
    "Your cart is empty",
  );
  await expect(page.getByTestId("checkout-edit-cart")).toBeVisible();
});
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
  await expect(page.getByTestId("product-card")).toHaveCount(6);
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
test("collection image and title links preserve the selected color through reload and adding to cart", async ({
  page,
}) => {
  for (const product of products) {
    for (const color of [
      ...new Set(product.variants.map((variant) => variant.color)),
    ]) {
      for (const linkName of ["image", "title"]) {
        await page.goto("/");
        const card = page.getByTestId("product-card").filter({
          has: page.getByRole("heading", { name: product.title }),
        });
        await card.getByRole("button", { name: color, exact: true }).click();
        await card.getByTestId("card-next").click();
        const link =
          linkName === "image"
            ? card.getByRole("link").filter({
                has: page.getByTestId("card-image"),
              })
            : card
                .getByRole("heading", { name: product.title })
                .getByRole("link");
        await link.click();
        expect(new URL(page.url()).searchParams.get("color")).toBe(color);
        await expect(page.getByTestId("product-color")).toHaveValue(color);
        await page.reload();
        await expect(page.getByTestId("product-color")).toHaveValue(color);
        const images = product.images.filter((image) => image.color === color);
        await expect(page.getByTestId("product-image")).toHaveAttribute(
          "src",
          images[0].src,
        );
        await expect(
          page.getByTestId("gallery-image").filter({ visible: true }),
        ).toHaveCount(images.length);
        await page.getByTestId("add-to-cart").click();
        await expect(page.getByTestId("product-form")).toContainText(
          "Added to your cart.",
        );
        const variant = product.variants.find(
          (variant) => variant.color === color,
        )!;
        expect(
          await page.evaluate(() =>
            JSON.parse(localStorage.getItem("bascik-shop-cart")!),
          ),
        ).toContainEqual({
          variantId: variant.id,
          quantity: linkName === "image" ? 1 : 2,
        });
      }
    }
  }
});
test("invalid color links retain the default product color and gallery", async ({
  page,
}) => {
  for (const product of products) {
    await page.goto(
      `/products/${product.slug}?color=${encodeURIComponent("<invalid color>")}`,
    );
    const color = product.variants[0].color;
    await expect(page.getByTestId("product-color")).toHaveValue(color);
    await expect(page.getByTestId("product-image")).toHaveAttribute(
      "src",
      product.images.find((image) => image.color === color)!.src,
    );
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
  await page.goto(`/products/${products[0].slug}`);
  await page.getByTestId("add-to-cart").click();
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
  await page.goto(`/products/${products[0].slug}`);
  await page.getByTestId("add-to-cart").click();
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
  await expect(page.getByTestId("checkout-line")).toHaveCount(1);
  await expect(page.getByTestId("checkout-summary")).toContainText("$30.00");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
        rates: [
          { id: "STANDARD", name: "Standard", amount: 500 },
          { id: "OFFSET", name: "Carbon offset", amount: 600 },
        ],
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
  await expect(page.locator("[data-checkout-shipping]")).toHaveText("$5.00");
  await expect(page.locator("[data-checkout-total]")).toHaveText("$35.00");
  await page.getByRole("radio", { name: /Carbon offset/ }).check();
  await expect(page.locator("[data-checkout-shipping]")).toHaveText("$6.00");
  await expect(page.locator("[data-checkout-total]")).toHaveText("$36.00");
  const rates = page.locator("[data-rates]");
  const ratesBox = await rates.boundingBox();
  const payBox = await page.getByTestId("checkout-pay").boundingBox();
  expect(payBox!.y - (ratesBox!.y + ratesBox!.height)).toBeGreaterThanOrEqual(
    24,
  );
  await page.getByLabel("Street address").fill("Updated street");
  await expect(page.locator("[data-checkout-shipping]")).toHaveText(
    "Calculated next",
  );
  await expect(page.locator("[data-checkout-total]")).toHaveText("$30.00");
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
  expect(initialImages.length).toBe(6);
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
test("paid orders show a printable confirmation without leaking the private token into print headers", async ({
  page,
}) => {
  await page.clock.install();
  let emailStatus = "pending";
  await page.route("**/api/order", (route) =>
    route.fulfill({
      json: {
        orderId: "confirmation-fixture",
        status: "submitted",
        paymentConfirmed: true,
        confirmationEmail: emailStatus,
        summary: {
          reference: "BASCIK-32CE1859BFE24C8FA5C68863B425379F",
          placedAt: "2026-11-07T19:45:07.000Z",
          items: [
            {
              variantId: products[0].variants[0].id,
              title: "Logo shirt / Black / M",
              quantity: 1,
              price: 3000,
            },
          ],
          subtotal: 3000,
          shipping: 495,
          shippingService: "Standard",
          tax: 276,
          total: 3771,
        },
        items: [],
        shipments: [],
      },
    }),
  );
  await page.goto("/order#token=private-confirmation-fixture");
  await expect(page.getByTestId("order-reference")).toHaveText(
    "BASCIK-32CE1859BFE24C8FA5C68863B425379F",
  );
  await expect(page.getByTestId("order-summary")).toContainText(
    "Logo shirt / Black / M",
  );
  await expect(page.getByTestId("order-summary")).toContainText("$37.71");
  await expect(page.getByTestId("order-summary")).toContainText("$2.76");
  await expect(page.getByTestId("order-email")).toContainText("queued");
  emailStatus = "sent";
  await page.clock.fastForward(3000);
  await expect(page.getByTestId("order-email")).toContainText("has been sent");
  await expect(page.getByTestId("order-print")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    window.print = () => {
      window.dispatchEvent(new Event("beforeprint"));
    };
  });
  await page.getByTestId("order-print").click();
  expect(new URL(page.url()).hash).toBe("");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("shop-nav")).toBeHidden();
  await expect(page.getByTestId("shop-footer")).toBeHidden();
  await expect(page.getByTestId("order-print")).toBeHidden();
  await expect(page.getByTestId("order-summary")).toBeVisible();
  await expect(page.getByTestId("order-help")).toBeHidden();
  await expect(page.getByTestId("order")).toHaveCSS("margin-top", "0px");
  await expect(page.getByTestId("order-summary")).toHaveCSS("padding", "0px");
  await expect(page.getByTestId("order-item")).toHaveCSS(
    "break-inside",
    "avoid",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  expect(new URL(page.url()).hash).toBe("#token=private-confirmation-fixture");
});
test("unpaid orders cannot display or print a paid confirmation", async ({
  page,
}) => {
  await page.route("**/api/order", (route) =>
    route.fulfill({
      json: {
        orderId: "unpaid-fixture",
        status: "pending",
        paymentConfirmed: false,
        summary: null,
        items: [],
        shipments: [],
      },
    }),
  );
  await page.goto("/order#token=unpaid-fixture");
  await expect(page.getByRole("status")).toContainText("Waiting for payment");
  await expect(page.getByTestId("order-summary")).toBeHidden();
  await expect(page.getByTestId("order-print")).toBeHidden();
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
    ["/contact", "Contact"],
    ["/data-sharing-opt-out", "Privacy choices"],
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
        .getByRole("link", { name: "shop@bascik.dev" })
        .first(),
    ).toHaveAttribute("href", "mailto:shop@bascik.dev");
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
