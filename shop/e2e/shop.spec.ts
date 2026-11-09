import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { products } from "../src/lib/catalog.ts";
import {
  TEST_CONTROL_PORT,
  type FixtureOrder,
  fixtureOrders,
  fixtureTicket,
  fixtureToken,
} from "../scripts/order-fixtures.ts";
import { shippingCountries } from "../src/components/checkout-form/shipping-countries.ts";

for (const path of [
  "/",
  ...products.map((product) => `/products/${product.slug}`),
  ...products.flatMap((product) =>
    [...new Set(product.variants.map((variant) => variant.color))].map(
      (color) => `/products/${product.slug}?color=${encodeURIComponent(color)}`,
    ),
  ),
]) {
  test(`product controls keep their first-paint layout on ${path}`, async ({
    page,
  }) => {
    let releaseScripts!: () => void;
    let releaseImages!: () => void;
    const scripts = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    const images = new Promise<void>((resolve) => {
      releaseImages = resolve;
    });
    await page.route("**/assets/shop.js", async (route) => {
      await scripts;
      await route.continue();
    });
    await page.route(/\.webp$/, async (route) => {
      await images;
      await route.continue();
    });
    try {
      await page.goto(path, { waitUntil: "commit" });
      const root = page.getByTestId(
        path === "/" ? "product-card" : "product-detail",
      );
      await expect(root.first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (path === "/") {
        for (const product of products) {
          const card = root.filter({ hasText: product.title });
          await expect(card.getByTestId("card-color")).toHaveCount(
            new Set(product.variants.map((variant) => variant.color)).size,
          );
          for (const control of await card.getByTestId("card-color").all())
            await expect(control).toBeVisible();
          await expect(card.getByTestId("card-previous")).toBeVisible();
          await expect(card.getByTestId("card-next")).toBeVisible();
          await expect(
            card.getByTestId("card-color").filter({
              hasText: product.images[0].color.replace(/^G\. Dyed /, ""),
            }),
          ).toHaveAttribute("aria-pressed", "true");
        }
      } else {
        const product = products.find(
          (product) => path.split("?")[0] === `/products/${product.slug}`,
        )!;
        const color =
          new URL(path, "https://shop.bascik.dev").searchParams.get("color") ??
          product.variants[0].color;
        await expect(page.getByTestId("product-color")).toHaveValue(color);
        await expect(page.getByTestId("product-image")).toHaveAttribute(
          "src",
          product.images.find((image) => image.color === color)!.src,
        );
        await expect(
          page.getByTestId("gallery-image").filter({ visible: true }),
        ).toHaveCount(
          product.images.filter((image) => image.color === color).length,
        );
      }
      const geometry = () =>
        root.evaluateAll((roots) =>
          roots.flatMap((root) =>
            [...root.querySelectorAll<HTMLElement>("img, button, h2")]
              .filter((element) => element.getClientRects().length)
              .map((element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
              }),
          ),
        );
      const before = await geometry();
      expect(
        before.filter((box) => box.width > 0 && box.height > 0),
      ).toHaveLength(before.length);
      releaseScripts();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByTestId("shop-nav-count")).toHaveText("0");
      expect(await geometry()).toEqual(before);
      releaseImages();
      await page.waitForLoadState("load");
      await root.evaluateAll(async (roots) => {
        await Promise.all(
          roots.flatMap((root) =>
            [...root.querySelectorAll<HTMLImageElement>("img")]
              .filter(
                (image) =>
                  image.getClientRects().length &&
                  image.getBoundingClientRect().top < innerHeight,
              )
              .map((image) => image.decode()),
          ),
        );
      });
      expect(await geometry()).toEqual(before);
    } finally {
      releaseScripts();
      releaseImages();
    }
  });
}

test("requested product colors render without JavaScript and do not leak between requests", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    for (const product of products) {
      for (const requested of [
        ...new Set(product.variants.map((variant) => variant.color)),
        "unknown",
        '<script>alert("color")</script>',
      ]) {
        const color = product.variants.some(
          (variant) => variant.color === requested,
        )
          ? requested
          : product.variants[0].color;
        const response = await page.goto(
          `/products/${product.slug}?color=${encodeURIComponent(requested)}`,
        );
        expect(response?.status()).toBe(200);
        await expect(page.getByTestId("product-color")).toHaveValue(color);
        await expect(page.getByTestId("product-image")).toHaveAttribute(
          "src",
          product.images.find((image) => image.color === color)!.src,
        );
        await expect(
          page.getByTestId("gallery-image").filter({ visible: true }),
        ).toHaveCount(
          product.images.filter((image) => image.color === color).length,
        );
        await expect(page.locator("h1")).toHaveText(product.title);
      }
    }
  } finally {
    await context.close();
  }
});

for (const path of ["/", `/products/${products[0].slug}`, "/cart"]) {
  test(`navigation reserves cart count space before initialization on ${path}`, async ({
    page,
    context,
  }) => {
    const items = products
      .flatMap((product) => product.variants)
      .map((variant) => ({ variantId: variant.id, quantity: 10 }));
    await page.addInitScript(
      (items) =>
        localStorage.setItem("bascik-shop-cart", JSON.stringify(items)),
      items,
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/assets/shop.js", async (route) => {
      await pending;
      await route.continue();
    });
    await page.goto(path, { waitUntil: "commit" });
    const link = page.getByTestId("shop-nav-cart");
    const count = page.getByTestId("shop-nav-count");
    try {
      await expect(link).toBeVisible();
      await expect(link.locator("svg")).toBeVisible();
      await expect(count).toBeEmpty();
      await expect(count).toBeHidden();
      await page.evaluate(() => document.fonts.ready);
      const before = await link.boundingBox();
      const themeBefore = await page
        .getByTestId("shop-nav-theme")
        .boundingBox();
      const countBefore = await count.boundingBox();
      expect(countBefore!.width).toBeGreaterThan(0);
      release();
      await expect(count).toHaveText(String(items.length * 10));
      await expect(count).toBeVisible();
      expect(await link.boundingBox()).toEqual(before);
      expect(await count.boundingBox()).toEqual(countBefore);
      expect(await page.getByTestId("shop-nav-theme").boundingBox()).toEqual(
        themeBefore,
      );

      const otherTab = await context.newPage();
      await otherTab.goto("/");
      for (const saved of [[{ ...items[0], quantity: 1 }], []]) {
        await otherTab.evaluate(
          (saved) =>
            localStorage.setItem("bascik-shop-cart", JSON.stringify(saved)),
          saved,
        );
        await expect(count).toHaveText(saved.length ? "1" : "0");
        expect(await link.boundingBox()).toEqual(before);
      }
      await otherTab.close();
    } finally {
      release();
    }
  });
}

test("cart link and icon remain usable without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const link = page.getByTestId("shop-nav-cart");
    await expect(link).toBeVisible();
    await expect(link.locator("svg")).toBeVisible();
    await expect(page.getByTestId("shop-nav-count")).toBeHidden();
    await link.click();
    await expect(page).toHaveURL(/\/cart$/);
  } finally {
    await context.close();
  }
});

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
  await expect(page.getByTestId("product-card")).toHaveCount(products.length);
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
test("sweatshirts appear before hats, default to Black and all colors and sizes add the correct $45 variant", async ({
  page,
}) => {
  await page.goto("/");
  const headings = await page
    .getByTestId("product-card")
    .getByRole("heading")
    .allTextContents();
  expect(headings).toEqual(products.map((product) => product.title));
  for (const product of products.filter((product) =>
    product.slug.includes("sweatshirt"),
  )) {
    for (const variant of product.variants) {
      await page.goto(`/products/${product.slug}`);
      await expect(page.getByTestId("product-color")).toHaveValue("Black");
      await expect(page.getByTestId("product-image")).toHaveAttribute(
        "src",
        product.images[0].src,
      );
      await page.evaluate(() => localStorage.clear());
      await page.getByTestId("product-color").selectOption(variant.color);
      await page.getByTestId("product-size").selectOption(variant.size!);
      const photo = page.getByTestId("product-image");
      await expect(photo).toHaveAttribute(
        "src",
        product.images.find((image) => image.color === variant.color)!.src,
      );
      await expect
        .poll(() =>
          photo.evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
        )
        .toBe(true);
      await page.getByTestId("add-to-cart").click();
      await page.goto("/cart");
      await expect(page.getByTestId("cart-line")).toHaveCount(1);
      await expect(page.getByTestId("cart-line")).toContainText(product.title);
      await expect(page.getByTestId("cart-line")).toContainText(variant.title);
      await expect(page.getByTestId("cart-total")).toHaveText("$45.00");
      await expect(
        page.getByTestId("cart-line").getByTestId("cart-image"),
      ).toHaveAttribute(
        "src",
        product.images.find((image) => image.color === variant.color)!.src,
      );
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
test("checkout refreshes destinations after cross-tab cart edits and resets unsupported selections", async ({
  page,
  context,
}) => {
  await page.goto("/checkout");
  const country = page.getByTestId("shipping-country");
  const state = page.getByTestId("checkout-state");
  const zip = page.getByTestId("checkout-zip");
  const optionCodes = () =>
    country
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
  await expect(country.locator("option")).toHaveCount(
    shippingCountries([]).length + 1,
  );
  expect(await optionCodes()).not.toContain("IN");
  await expect(page.getByTestId("shipping-form")).toBeHidden();
  const otherTab = await context.newPage();
  try {
    await otherTab.goto("/");
    const shirt = products[0];
    const decal = products.find((product) => product.slug.includes("decal"))!;
    const setCart = (items: { variantId: string; quantity: number }[]) =>
      otherTab.evaluate(
        (items) =>
          localStorage.setItem("bascik-shop-cart", JSON.stringify(items)),
        items,
      );
    await setCart([{ variantId: shirt.variants[0].id, quantity: 1 }]);
    await expect(country.locator("option")).toHaveCount(
      shippingCountries([shirt.id]).length + 1,
    );
    expect(await optionCodes()).toEqual([
      "",
      ...shippingCountries([shirt.id]).map((country) => country.code),
    ]);
    await expect(page.getByTestId("shipping-form")).toBeVisible();
    await country.selectOption("US");
    await expect(state).toHaveAttribute("required", "");
    await expect(zip).toHaveAttribute("required", "");
    await expect(state).toHaveAttribute("placeholder", /AL/);
    await page.getByTestId("checkout-name").fill("Test Buyer");
    await page.getByTestId("checkout-email").fill("buyer@example.com");
    await page.getByTestId("checkout-address1").fill("Example Street");
    await page.getByTestId("checkout-city").fill("Los Angeles");
    await state.fill("CA");
    await zip.fill("90001");
    await page.route("**/api/quote", (route) =>
      route.fulfill({
        json: {
          quoteId: "quote_cart_country_fixture",
          expiresAt: Math.floor(Date.now() / 1000) + 900,
          subtotal: 3000,
          rates: [{ id: "STANDARD", name: "Standard", amount: 500 }],
        },
      }),
    );
    await page.getByTestId("shipping-quote").click();
    await expect(page.getByTestId("checkout-pay")).toBeVisible();
    await setCart([{ variantId: shirt.variants[0].id, quantity: 2 }]);
    await expect(page.locator("[data-checkout-subtotal]")).toHaveText("$60.00");
    await expect(country).toHaveValue("US");
    await expect(page.getByTestId("checkout-pay")).toBeHidden();
    await expect(page.locator("[data-checkout-shipping]")).toHaveText(
      "Calculated next",
    );
    await country.selectOption("IN");
    await expect(state).not.toHaveAttribute("required");
    await expect(zip).not.toHaveAttribute("required");
    await setCart([
      { variantId: shirt.variants[0].id, quantity: 2 },
      { variantId: decal.variants[0].id, quantity: 1 },
    ]);
    await expect(country.locator("option")).toHaveCount(
      shippingCountries([shirt.id, decal.id]).length + 1,
    );
    expect(await optionCodes()).not.toContain("IN");
    await expect(country).toHaveValue("");
    await expect(state).toHaveAttribute("placeholder", "");
    await expect(state).not.toHaveAttribute("required");
    await expect(zip).not.toHaveAttribute("required");
    await expect(page.locator("[data-checkout-status]")).toContainText(
      "Choose a supported delivery country",
    );
    await country.selectOption("SG");
    await expect(zip).toHaveAttribute("required", "");
    await setCart([]);
    await expect(page.getByTestId("shipping-form")).toBeHidden();
    await expect(country).toHaveValue("SG");
    await expect(zip).toHaveAttribute("required", "");
  } finally {
    await otherTab.close();
  }
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
        src: img.src,
        width: img.width,
        natural: img.naturalWidth,
        height: img.height,
      };
    }),
  );
  expect(initialImages.length).toBe(products.length);
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
  for (const image of await page.locator("main img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
      )
      .toBe(true);
    expect(
      await image.evaluate((img: HTMLImageElement) => img.currentSrc),
    ).toContain(".webp");
  }
});

// The order page renders from real rows seeded by scripts/serve-tests.ts,
// opened through the exact private link format customers already hold.
const fixture = (status: string, extra: Partial<FixtureOrder> = {}) => {
  const order = fixtureOrders.find(
    (candidate) =>
      candidate.status === status &&
      !candidate.broken === !extra.broken &&
      !candidate.readOnly === !extra.readOnly &&
      !candidate.readOnly === !extra.readOnly &&
      Object.entries(extra).every(
        ([key, value]) =>
          JSON.stringify(candidate[key as keyof FixtureOrder]) ===
          JSON.stringify(value),
      ),
  );
  if (!order) throw new Error(`No fixture order with status ${status}`);
  return order;
};
const control = (path: string, data: unknown = {}) =>
  fetch(`http://127.0.0.1:${TEST_CONTROL_PORT}${path}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
const setOrder = (id: string, set: string, params: unknown[] = []) =>
  control("/sql", {
    sql: `UPDATE orders SET ${set} WHERE id=?`,
    params: [...params, id],
  });
/** The plain paid order: no refund, no shipment, an ordinary title. */
const paidOrder = () =>
  fixtureOrders.find(
    (candidate) =>
      candidate.status === "submitted" &&
      candidate.tax === 276 &&
      !candidate.refund &&
      !candidate.shipments &&
      !candidate.title &&
      !candidate.broken,
  )!;
const privateLink = (id: string) => `/order#token=${fixtureToken(id)}`;
const ticketUrl = (id: string, exp = Math.floor(Date.now() / 1000) + 600) =>
  `/order?ticket=${encodeURIComponent(fixtureTicket(id, exp))}`;
const ticketPattern = /\/order\?ticket=[a-f0-9]+\.\d+\.[a-f0-9]{64}/;

test.describe("private order page", () => {
  for (const state of [
    { status: "expired", lines: 1, label: "expired without payment" },
    { status: "paid", lines: 0, label: "Payment received" },
    {
      status: "test_draft",
      lines: 0,
      label: "Nothing will be produced or shipped",
    },
  ]) {
    test(`cart clearing requires confirmed payment, not just ${state.status} status`, async ({
      page,
    }) => {
      await page.goto(`/products/${products[0].slug}`);
      await page.getByTestId("add-to-cart").click();
      await page.goto(privateLink(fixture(state.status).id));
      await expect(page).toHaveURL(ticketPattern);
      await expect(page.locator("[data-order-status]")).toContainText(
        state.label,
      );
      await page.getByTestId("shop-nav-cart").click();
      await expect(page.getByTestId("cart-line")).toHaveCount(state.lines);
    });
  }

  test("the link format already in customers' email lands on a server-rendered ticket URL, and back does not return to the empty shell", async ({
    page,
  }) => {
    const order = paidOrder();
    await page.goto("/");
    await page.goto(privateLink(order.id));
    await expect(page).toHaveURL(ticketPattern);
    expect(new URL(page.url()).hash).toBe(`#token=${fixtureToken(order.id)}`);
    await expect(page.getByTestId("order-summary")).toBeVisible();
    await expect(page.getByTestId("order-reference")).toHaveText(
      `BASCIK-${order.id.toUpperCase()}`,
    );
    await expect(page.getByTestId("order-skeleton")).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL("/");
  });

  test("a ticket URL renders the summary in the first response, with JavaScript off", async ({
    browser,
  }) => {
    const order = paidOrder();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto(ticketUrl(order.id));
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain(
      `BASCIK-${order.id.toUpperCase()}`,
    );
    await expect(page.getByTestId("order-summary")).toBeVisible();
    await expect(page.getByTestId("order-skeleton")).toBeHidden();
    await expect(page.getByTestId("order-item")).toHaveCount(1);
    await context.close();
  });

  test("a bad ticket is a real 404", async ({ page, request }) => {
    const order = paidOrder();
    const genuine = fixtureTicket(
      order.id,
      Math.floor(Date.now() / 1000) + 600,
    );
    const forged = `${genuine.slice(0, -1)}${genuine.endsWith("0") ? "1" : "0"}`;
    const response = await page.goto(
      `/order?ticket=${encodeURIComponent(forged)}`,
    );
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle(/Not found/);
    const garbage = await request.get("/order?ticket=garbage");
    expect(garbage.status()).toBe(404);
    expect(garbage.headers()["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(garbage.headers()["cache-control"]).toBe("no-store");
    expect((await request.head("/order?ticket=garbage")).status()).toBe(404);
    expect((await request.get("/order")).status()).toBe(200);
    expect((await request.get("/order")).headers()["cache-control"]).toContain(
      "no-store",
    );
    expect(
      (await request.get(ticketUrl(order.id))).headers()["cache-control"],
    ).toContain("no-store");
  });

  test("an expired ticket with the private link recovers on its own; without it, the page says to use the email link", async ({
    page,
    browser,
  }) => {
    const order = paidOrder();
    const expired = ticketUrl(order.id, Math.floor(Date.now() / 1000) - 5);
    await page.goto(`${expired}#token=${fixtureToken(order.id)}`);
    await expect(page).toHaveURL(ticketPattern);
    expect(new URL(page.url()).search).not.toBe(
      new URL(expired, "http://x").search,
    );
    await expect(page.getByTestId("order-summary")).toBeVisible();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const plain = await context.newPage();
    await plain.goto(expired);
    await expect(plain.locator("[data-order-status]")).toContainText(
      "Refreshing your order link",
    );
    await expect(plain.getByTestId("order-help")).toContainText("private link");
    await expect(plain.getByTestId("order-summary")).toBeHidden();
    await context.close();
    await page.goto("/order");
    await expect(page.locator("[data-order-status]")).toContainText(
      "Use the private link from your order confirmation.",
    );
  });

  for (const delay of [0, 1500]) {
    test(`a link to an order that no longer exists reports it from the exchange, without a layout change (exchange answers after ${delay} ms)`, async ({
      page,
    }) => {
      // The exchange's 404 may land before or after the component module
      // runs; both orderings must show the message.
      if (delay)
        await page.route("**/api/order", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          await route.continue();
        });
      await page.goto(`/order#token=${fixtureToken("ab".repeat(16))}`);
      if (delay) await expect(page.getByTestId("order-skeleton")).toBeVisible();
      await expect(page.locator("[data-order-status]")).toContainText(
        "This order link has expired.",
      );
      await expect(page).toHaveURL(/\/order#token=/);
      await expect(page.getByTestId("order-summary")).toBeHidden();
      await expect(page.getByTestId("order-skeleton")).toBeHidden();
    });
  }

  test("the skeleton and the result occupy about the same space", async ({
    page,
  }) => {
    const order = paidOrder();
    await page.goto("/");
    await page.evaluate(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        })[])
          if (!entry.hadRecentInput)
            (window as unknown as { __cls: number }).__cls += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    const response = await page.goto(ticketUrl(order.id));
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("order-summary")).toBeVisible();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve, 200)),
        ),
    );
    const cls = await page.evaluate(() => {
      let total = 0;
      for (const entry of performance.getEntriesByType(
        "layout-shift",
      ) as (PerformanceEntry & {
        hadRecentInput: boolean;
        value: number;
      })[])
        if (!entry.hadRecentInput) total += entry.value;
      return total;
    });
    expect(cls).toBeLessThanOrEqual(0.02);
  });

  test("order polling follows payment and asynchronous draft readiness", async ({
    page,
  }, testInfo) => {
    const pendingOrders = fixtureOrders.filter(
      (candidate) => candidate.status === "pending" && !candidate.readOnly,
    );
    const order = pendingOrders[testInfo.project.name === "mobile" ? 1 : 0];
    await page.goto(privateLink(order.id));
    await expect(page).toHaveURL(ticketPattern);
    await expect(page.locator("[data-order-status]")).toContainText(
      "Waiting for payment",
    );
    await expect(page.getByTestId("order-summary")).toBeHidden();
    const before = page.url();
    await control("/sql", {
      sql: "INSERT OR REPLACE INTO payment_events(id,order_id,created_at) VALUES (?,?,?)",
      params: [`evt_${order.id}`, order.id, Math.floor(Date.now() / 1000)],
    });
    await setOrder(
      order.id,
      "status='paid',payment_tax=276,payment_total=3771",
    );
    await expect(page.locator("[data-order-status]")).toContainText(
      "Payment received",
      { timeout: 15000 },
    );
    await expect(page.getByTestId("order-summary")).toBeVisible();
    await expect(page.getByTestId("order-print")).toBeVisible();
    expect(page.url()).toMatch(ticketPattern);
    expect(page.url()).not.toBe(before);
    expect(new URL(page.url()).hash).toBe(`#token=${fixtureToken(order.id)}`);
    await setOrder(order.id, "status='submitting'");
    await expect(page.locator("[data-order-status]")).toContainText(
      "submitted to Printful",
      { timeout: 15000 },
    );
    await setOrder(order.id, "status='test_draft'");
    await expect(page.locator("[data-order-status]")).toContainText(
      "Nothing will be produced or shipped",
      { timeout: 15000 },
    );
    await control("/sql", {
      sql: "DELETE FROM payment_events WHERE order_id=?",
      params: [order.id],
    });
    await setOrder(
      order.id,
      "status='pending',payment_tax=NULL,payment_total=NULL",
    );
  });

  for (const [state, amount, text] of [
    ["refunded", 3771, "Your full refund of $37.71 has been issued."],
    ["partial", 1000, "A partial refund of $10.00 has been issued."],
    ["pending", 0, "A refund is processing."],
    [
      "failed",
      1000,
      "A refund needs attention. $10.00 has already been refunded.",
    ],
    ["none", 0, "A full refund has not yet been confirmed."],
  ] as const) {
    test(`private order shows ${state} refund without rewriting the receipt`, async ({
      page,
    }) => {
      const order = fixtureOrders.find(
        (candidate) =>
          candidate.refund?.state === state &&
          candidate.refund.amount === amount,
      )!;
      await page.goto(privateLink(order.id));
      await expect(page.getByTestId("order-refund")).toBeVisible();
      await expect(page.getByTestId("order-refund")).toContainText(text);
      await expect(page.getByTestId("order-summary")).toContainText("$37.71");
      await expect(page.getByTestId("order-summary")).toContainText(
        "Total paid",
      );
      await expect(page.getByTestId("order-print")).toBeVisible();
    });
  }

  test("item titles with markup and replacement tokens render as text", async ({
    page,
  }) => {
    const order = fixture("submitted", {
      title: 'Logo shirt <script>alert("$&")</script> / Black / M',
    });
    const errors: string[] = [];
    page.on("dialog", (dialog) => {
      errors.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto(ticketUrl(order.id));
    await expect(page.getByTestId("order-item").locator("h3")).toHaveText(
      'Logo shirt <script>alert("$&")</script> / Black / M',
    );
    expect(errors).toEqual([]);
  });

  test("shipments link only to https tracking pages", async ({ page }) => {
    const order = fixture("shipped");
    await page.goto(ticketUrl(order.id));
    await expect(page.locator("[data-order-status]")).toContainText(
      "has shipped",
    );
    const link = page.getByRole("link", { name: "Track shipment" });
    await expect(link).toHaveAttribute("rel", "noreferrer noopener");
    await expect(link).toHaveAttribute("href", /^https:\/\/tools\.usps\.com\//);
  });

  test("paid orders show a printable confirmation without leaking the private link into print headers", async ({
    page,
  }) => {
    const order = paidOrder();
    await page.goto(privateLink(order.id));
    await expect(page).toHaveURL(ticketPattern);
    await expect(page.getByTestId("order-reference")).toHaveText(
      `BASCIK-${order.id.toUpperCase()}`,
    );
    await expect(page.getByTestId("order-summary")).toContainText(
      "Logo shirt / Black / M",
    );
    await expect(page.getByTestId("order-summary")).toContainText("$37.71");
    await expect(page.getByTestId("order-summary")).toContainText("$2.76");
    await expect(page.getByTestId("order-email")).toContainText(
      "disabled for test orders",
    );
    await expect(page.getByTestId("order-print")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const privateUrl = page.url();
    await page.evaluate(() => {
      window.print = () => {
        window.dispatchEvent(new Event("beforeprint"));
      };
    });
    await page.getByTestId("order-print").click();
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(page.url()).search).toBe("");
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
    expect(page.url()).toBe(privateUrl);
  });

  test("legacy paid orders do not invent unrecorded tax or a final total", async ({
    page,
  }) => {
    const order = fixture("submitted", { tax: null });
    await page.goto(ticketUrl(order.id));
    await expect(page.getByTestId("order-summary")).toContainText(
      "See Stripe receipt",
    );
    await expect(page.getByTestId("order-summary")).toContainText(
      "Total before tax",
    );
    await expect(page.getByTestId("order-summary")).toContainText("$34.95");
  });

  test("unpaid orders cannot display or print a paid confirmation", async ({
    page,
  }) => {
    const order = fixture("pending", { readOnly: true });
    await page.goto(ticketUrl(order.id));
    await expect(page.locator("[data-order-status]")).toContainText(
      "Waiting for payment",
    );
    await expect(page.getByTestId("order-summary")).toBeHidden();
    await expect(page.getByTestId("order-print")).toBeHidden();
  });

  test("a lookup that throws mid-stream ends in an error message, not a skeleton that never resolves", async ({
    page,
  }) => {
    const order = fixture("submitted", { broken: true });
    const response = await page.goto(ticketUrl(order.id));
    expect(response?.status()).toBe(200);
    await expect(page.locator("[data-order-status]")).toContainText(
      "Order lookup failed.",
    );
    await expect(page.getByTestId("order-skeleton")).toBeHidden();
    await expect(page.getByTestId("order-summary")).toBeHidden();
    const content = await page.content();
    expect(content).not.toContain("    at ");
    expect(content).not.toContain("SyntaxError");
  });
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
