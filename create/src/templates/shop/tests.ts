/**
 * @module templates/shop/tests
 *
 * The tests a scaffolded shop gets: Vitest tests of the cart, price and catalog
 * rules, one test per component, and the Playwright spec.
 */

import type { Adapter } from "../../scaffold.js";

/**
 * A component's unit test, like the default starter's: it reads the template
 * and checks the parts other code and the E2E spec rely on.
 */
export const componentTest = (
  name: string,
  claim: string,
  parts: readonly string[],
): string => `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("${name} component", () => {
  const path = join(process.cwd(), "src/components/${name}/${name}.html");

  it(${JSON.stringify(claim)}, async () => {
    const html = await readFile(path, "utf8");
    for (const part of ${JSON.stringify(parts)}) {
      expect(html).toContain(part);
    }
  });
});
`;

export const MONEY_TEST_TS = `import { describe, it, expect } from "vitest";
import { formatCents } from "./money.ts";

describe("formatCents", () => {
  it("formats whole cents as dollars", () => {
    expect(formatCents(1499)).toBe("$14.99");
    expect(formatCents(2400)).toBe("$24.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("groups thousands", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
  });

  it("adds cents without rounding drift", () => {
    // 0.1 + 0.2 is not 0.3 in floating point, which is why prices are whole cents.
    expect(formatCents(10 + 20)).toBe("$0.30");
  });
});
`;

export const CATALOG_TEST_TS = `import { describe, it, expect } from "vitest";
import { bookPath, books, findBook, validateCatalog } from "./catalog.ts";

const valid = {
  slug: "a-test-book",
  title: "A Test Book",
  author: "Test Author",
  description: "A book that exists for one test.",
  format: "Paperback",
  priceCents: 1200,
  rating: 4,
  tone: "ink",
};

describe("the catalog", () => {
  it("has books, each with its own slug", () => {
    expect(books.length).toBeGreaterThan(0);
    expect(new Set(books.map((book) => book.slug)).size).toBe(books.length);
  });

  it("features at least one book on the home page", () => {
    expect(books.some((book) => book.featured)).toBe(true);
  });

  it("finds a book by slug, and nothing for an unknown or missing slug", () => {
    expect(findBook(books[0].slug)).toBe(books[0]);
    expect(findBook("no-such-book")).toBeUndefined();
    expect(findBook(undefined)).toBeUndefined();
  });

  it("builds each book's path from its slug", () => {
    expect(bookPath({ slug: "the-glass-tide" })).toBe("/books/the-glass-tide");
  });
});

describe("validateCatalog", () => {
  it("accepts a complete entry", () => {
    expect(validateCatalog([valid])).toEqual([valid]);
  });

  it("refuses a catalog that is not an array", () => {
    expect(() => validateCatalog({ books: [] })).toThrow(/must be an array/);
  });

  it.each(["slug", "title", "author", "description"])(
    "names the item that is missing %s",
    (field) => {
      const broken: Record<string, unknown> = { ...valid, slug: "second-book" };
      delete broken[field];
      expect(() => validateCatalog([valid, broken])).toThrow(
        new RegExp(\`item 2 .* is missing "\${field}"\`),
      );
    },
  );

  it("treats an empty or blank field as missing", () => {
    expect(() => validateCatalog([{ ...valid, title: "   " }])).toThrow(
      'item 1 ("a-test-book") is missing "title".',
    );
  });

  it.each([-500, 0, 12.5, "1200", Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    "names the item whose price is %s",
    (priceCents) => {
      expect(() => validateCatalog([{ ...valid, priceCents }])).toThrow(
        /item 1 \\("a-test-book"\\) needs "priceCents" as a whole number of cents/,
      );
    },
  );

  it("names the item that repeats a slug", () => {
    expect(() =>
      validateCatalog([valid, { ...valid, title: "Another Book" }]),
    ).toThrow('item 2 ("a-test-book") repeats the slug of an earlier item.');
  });

  it("refuses a slug that would not make a clean URL", () => {
    for (const slug of ["Has Spaces", "UPPER", "trailing-", "a--b", "../up"]) {
      expect(() => validateCatalog([{ ...valid, slug }])).toThrow(/has a slug/);
    }
  });

  it("refuses an unknown format, rating or tone", () => {
    expect(() => validateCatalog([{ ...valid, format: "Scroll" }])).toThrow(/"format"/);
    expect(() => validateCatalog([{ ...valid, rating: 6 }])).toThrow(/"rating"/);
    expect(() => validateCatalog([{ ...valid, rating: "5" }])).toThrow(/"rating"/);
    expect(() => validateCatalog([{ ...valid, tone: "neon" }])).toThrow(/"tone"/);
  });

  it("names an item that is not an object by its position", () => {
    expect(() => validateCatalog([valid, null])).toThrow(/item 2 \\("no slug or title"\\)/);
  });
});
`;

export const CART_TEST_TS = `import { afterEach, describe, it, expect, vi } from "vitest";
import {
  CART_CHANGED,
  CART_KEY,
  MAX_LINES,
  MAX_QUANTITY,
  addToCart,
  cartCount,
  checkCart,
  loadCart,
  priceCart,
  removeFromCart,
  sanitizeCart,
  saveCart,
  setQuantity,
} from "./cart.ts";

const catalog = [
  { slug: "alpha", priceCents: 1499 },
  { slug: "beta", priceCents: 850 },
];

/** A stand-in for localStorage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => void data.set(key, value),
    removeItem: (key: string): void => void data.delete(key),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeCart", () => {
  it("keeps lines for known products", () => {
    expect(sanitizeCart([{ id: "alpha", quantity: 2 }], catalog)).toEqual([
      { id: "alpha", quantity: 2 },
    ]);
  });

  it.each([null, undefined, "cart", 7, {}, { lines: [] }])(
    "is an empty cart for %j, which is not a list",
    (data) => {
      expect(sanitizeCart(data, catalog)).toEqual([]);
    },
  );

  it("drops unknown products, bad quantities and things that are not lines", () => {
    const garbage = [
      null,
      "alpha",
      42,
      [],
      {},
      { id: "alpha" },
      { quantity: 1 },
      { id: 7, quantity: 1 },
      { id: "no-such-book", quantity: 1 },
      { id: "__proto__", quantity: 1 },
      { id: "alpha", quantity: 0 },
      { id: "alpha", quantity: -3 },
      { id: "alpha", quantity: 1.5 },
      { id: "alpha", quantity: "2" },
      { id: "alpha", quantity: Number.NaN },
      { id: "alpha", quantity: Number.POSITIVE_INFINITY },
      { id: "alpha", quantity: 1_000_000_000 },
      { id: "beta", quantity: 3 },
    ];
    expect(sanitizeCart(garbage, catalog)).toEqual([{ id: "beta", quantity: 3 }]);
  });

  it("merges repeated products, capped at the most one line holds", () => {
    const lines = [
      { id: "alpha", quantity: 60 },
      { id: "beta", quantity: 1 },
      { id: "alpha", quantity: 60 },
    ];
    expect(sanitizeCart(lines, catalog)).toEqual([
      { id: "alpha", quantity: MAX_QUANTITY },
      { id: "beta", quantity: 1 },
    ]);
  });

  it("keeps only the id and quantity, so a stored price is never used", () => {
    const tampered = [{ id: "alpha", quantity: 1, priceCents: 1, title: "<b>x</b>" }];
    expect(sanitizeCart(tampered, catalog)).toEqual([{ id: "alpha", quantity: 1 }]);
  });
});

describe("checkCart", () => {
  it("returns the lines when every one is valid", () => {
    expect(checkCart([{ id: "alpha", quantity: 2 }], catalog)).toEqual({
      lines: [{ id: "alpha", quantity: 2 }],
    });
  });

  it("refuses data that is not a list", () => {
    expect(checkCart({ id: "alpha" }, catalog)).toEqual({
      error: '"lines" must be an array.',
    });
    expect(checkCart(undefined, catalog)).toHaveProperty("error");
  });

  it("names the first bad line without repeating what was sent", () => {
    const sent = [
      { id: "alpha", quantity: 1 },
      { id: "<script>", quantity: 1 },
    ];
    const result = checkCart(sent, catalog);
    expect(result).toEqual({
      error: "Line 2 names a product that is not in the catalog.",
    });
    expect(JSON.stringify(result)).not.toContain("<script>");
  });

  it.each([0, -1, 2.5, "3", null, MAX_QUANTITY + 1, 1e12])(
    "refuses the quantity %j",
    (quantity) => {
      expect(checkCart([{ id: "alpha", quantity }], catalog)).toEqual({
        error: \`Line 1 needs a whole quantity from 1 to \${MAX_QUANTITY}.\`,
      });
    },
  );

  it("refuses more lines than a cart can hold", () => {
    const many = Array.from({ length: MAX_LINES + 1 }, () => ({ id: "alpha", quantity: 1 }));
    expect(checkCart(many, catalog)).toHaveProperty("error");
  });

  it("drops fields a line does not have", () => {
    expect(checkCart([{ id: "beta", quantity: 1, priceCents: 1 }], catalog)).toEqual({
      lines: [{ id: "beta", quantity: 1 }],
    });
  });
});

describe("changing the cart", () => {
  it("adds a new product and adds to one already there", () => {
    const once = addToCart([], "alpha");
    expect(once).toEqual([{ id: "alpha", quantity: 1 }]);
    expect(addToCart(once, "alpha", 2)).toEqual([{ id: "alpha", quantity: 3 }]);
  });

  it("never holds more than the most one line allows", () => {
    const full = addToCart([], "alpha", 1_000_000);
    expect(full).toEqual([{ id: "alpha", quantity: MAX_QUANTITY }]);
    expect(addToCart(full, "alpha")).toEqual(full);
  });

  it.each([0, -1, 0.5, Number.NaN])("adds nothing for the quantity %s", (quantity) => {
    expect(addToCart([{ id: "beta", quantity: 1 }], "alpha", quantity)).toEqual([
      { id: "beta", quantity: 1 },
    ]);
  });

  it("does not change the cart it was given", () => {
    const cart = [{ id: "alpha", quantity: 1 }];
    addToCart(cart, "alpha");
    setQuantity(cart, "alpha", 5);
    removeFromCart(cart, "alpha");
    expect(cart).toEqual([{ id: "alpha", quantity: 1 }]);
  });

  it("sets a quantity", () => {
    expect(setQuantity([{ id: "alpha", quantity: 1 }], "alpha", 4)).toEqual([
      { id: "alpha", quantity: 4 },
    ]);
  });

  it("removes the line for a quantity of zero or less", () => {
    const cart = [
      { id: "alpha", quantity: 2 },
      { id: "beta", quantity: 1 },
    ];
    expect(setQuantity(cart, "alpha", 0)).toEqual([{ id: "beta", quantity: 1 }]);
    expect(setQuantity(cart, "alpha", -4)).toEqual([{ id: "beta", quantity: 1 }]);
  });

  it("caps a huge quantity", () => {
    expect(setQuantity([{ id: "alpha", quantity: 1 }], "alpha", 1e9)).toEqual([
      { id: "alpha", quantity: MAX_QUANTITY },
    ]);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "changes nothing for the quantity %s",
    (quantity) => {
      expect(setQuantity([{ id: "alpha", quantity: 2 }], "alpha", quantity)).toEqual([
        { id: "alpha", quantity: 2 },
      ]);
    },
  );

  it("removes a line, and ignores a product that is not in the cart", () => {
    const cart = [{ id: "alpha", quantity: 2 }];
    expect(removeFromCart(cart, "alpha")).toEqual([]);
    expect(removeFromCart(cart, "beta")).toEqual(cart);
  });
});

describe("counting and pricing", () => {
  const cart = [
    { id: "alpha", quantity: 2 },
    { id: "beta", quantity: 3 },
  ];

  it("counts copies, not lines", () => {
    expect(cartCount(cart)).toBe(5);
    expect(cartCount([])).toBe(0);
  });

  it("prices each line from the catalog and totals in whole cents", () => {
    expect(priceCart(cart, catalog)).toEqual({
      lines: [
        { id: "alpha", quantity: 2, unitCents: 1499, lineCents: 2998 },
        { id: "beta", quantity: 3, unitCents: 850, lineCents: 2550 },
      ],
      totalCents: 5548,
    });
  });

  it("leaves out a product the catalog does not have", () => {
    expect(priceCart([{ id: "gone", quantity: 1 }], catalog)).toEqual({
      lines: [],
      totalCents: 0,
    });
  });
});

describe("loadCart", () => {
  it("is empty when nothing is saved", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(loadCart(catalog)).toEqual([]);
  });

  it("reads a saved cart", () => {
    vi.stubGlobal(
      "localStorage",
      fakeStorage({ [CART_KEY]: JSON.stringify([{ id: "alpha", quantity: 2 }]) }),
    );
    expect(loadCart(catalog)).toEqual([{ id: "alpha", quantity: 2 }]);
  });

  it.each(["{not json", "", "null", '"cart"', "42", '{"id":"alpha","quantity":1}', "[[[]]]"])(
    "is empty when storage holds %j",
    (saved) => {
      vi.stubGlobal("localStorage", fakeStorage({ [CART_KEY]: saved }));
      expect(loadCart(catalog)).toEqual([]);
    },
  );

  it("drops a saved line for a product no longer in the catalog", () => {
    const saved = JSON.stringify([
      { id: "discontinued", quantity: 1 },
      { id: "beta", quantity: 1 },
    ]);
    vi.stubGlobal("localStorage", fakeStorage({ [CART_KEY]: saved }));
    expect(loadCart(catalog)).toEqual([{ id: "beta", quantity: 1 }]);
  });

  it("is empty when reading storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: (): string => {
        throw new Error("blocked");
      },
    });
    expect(loadCart(catalog)).toEqual([]);
  });

  it("is empty when the browser refuses access to storage itself", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: (): never => {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(loadCart(catalog)).toEqual([]);
      expect(saveCart([{ id: "alpha", quantity: 1 }])).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("saveCart", () => {
  it("saves the lines and tells the page", () => {
    const store = fakeStorage();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("document", { dispatchEvent });

    expect(saveCart([{ id: "alpha", quantity: 2 }])).toBe(true);
    expect(store.data.get(CART_KEY)).toBe('[{"id":"alpha","quantity":2}]');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe(CART_CHANGED);
  });

  it("removes the saved cart when it is emptied", () => {
    const store = fakeStorage({ [CART_KEY]: "[]" });
    vi.stubGlobal("localStorage", store);
    expect(saveCart([])).toBe(true);
    expect(store.data.has(CART_KEY)).toBe(false);
  });

  it("returns false, and tells nobody, when storage is full or blocked", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("document", { dispatchEvent });
    vi.stubGlobal("localStorage", {
      setItem: (): void => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(saveCart([{ id: "alpha", quantity: 1 }])).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("returns false when there is no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(saveCart([{ id: "alpha", quantity: 1 }])).toBe(false);
  });
});
`;

/** With an adapter: the API route the order summary asks for prices. */
const CART_API_E2E = `
  test("the server prices the cart from the catalog and refuses bad input", async ({ request }) => {
    const priced = await request.post("/api/cart", {
      // The extra price is ignored: the server only reads ids and quantities.
      data: { lines: [{ id: "the-glass-tide", quantity: 2, priceCents: 1 }] },
    });
    expect(priced.status()).toBe(200);
    expect(await priced.json()).toEqual({
      lines: [{ id: "the-glass-tide", quantity: 2, unitCents: 850, lineCents: 1700 }],
      totalCents: 1700,
    });

    for (const data of [
      { lines: [{ id: "no-such-book", quantity: 1 }] },
      { lines: [{ id: "the-glass-tide", quantity: -1 }] },
      { lines: [{ id: "the-glass-tide", quantity: 1e9 }] },
      { lines: "the-glass-tide" },
      {},
    ]) {
      expect((await request.post("/api/cart", { data })).status()).toBe(400);
    }
    const notJson = await request.post("/api/cart", {
      headers: { "Content-Type": "application/json" },
      data: "{not json",
    });
    expect(notJson.status()).toBe(400);
    expect((await request.get("/api/cart")).status()).toBe(405);
  });
`;

/** The Playwright spec. The E2E web server is `bascik --server`, so the API route is testable with an adapter. */
export const shopE2eSpec = (
  adapter?: Adapter,
): string => `import { test, expect, type Page } from "@playwright/test";

// Two books from catalog/books.ts. Change these when you change the catalog.
const TIDE = { slug: "the-glass-tide", title: "The Glass Tide", price: "$8.50" };
const BREAD = { slug: "bread-for-the-long-winter", title: "Bread for the Long Winter", price: "$32.00" };
const BOOK_COUNT = 8;

/** Open a book's page and add it to the cart, once per copy. */
async function addToCart(page: Page, slug: string, copies = 1): Promise<void> {
  await page.goto(\`/books/\${slug}\`);
  for (let added = 1; added <= copies; added += 1) {
    await page.getByTestId("book-detail-add").click();
    await expect(page.getByTestId("book-detail-status")).toContainText(
      \`\${added} \${added === 1 ? "copy" : "copies"}\`,
    );
  }
}

/** The cart line for a book, on the cart page. */
const cartLine = (page: Page, title: string) =>
  page.getByTestId("cart-list-line").filter({ hasText: title });

test.describe("Shop", () => {
  test("home page features books and leads to the catalog", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Books worth reading twice/);
    await expect(page.getByTestId("featured-books").getByTestId("book-card")).toHaveCount(3);

    await page.getByTestId("home-hero-browse").click();
    await expect(page).toHaveURL("/books/");
    await expect(page.getByRole("heading", { level: 1, name: "Books" })).toBeVisible();
  });

  test("catalog sorts by price and filters by format", async ({ page }) => {
    await page.goto("/books/");
    const cards = page.getByTestId("book-catalog").getByTestId("book-card");
    await expect(cards).toHaveCount(BOOK_COUNT);

    await page.getByLabel("Sort by").selectOption("price-low");
    await expect(cards.first()).toContainText(TIDE.title);
    await page.getByLabel("Sort by").selectOption("price-high");
    await expect(cards.first()).toContainText(BREAD.title);

    await page.getByLabel("Format").selectOption("Ebook");
    await expect(cards.filter({ visible: true })).toHaveCount(2);
    await expect(page.getByTestId("book-catalog-status")).toHaveText(
      \`Showing 2 of \${BOOK_COUNT} books\`,
    );
    await page.getByLabel("Format").selectOption("all");
    await expect(cards.filter({ visible: true })).toHaveCount(BOOK_COUNT);
  });

  test("catalog lists every book without JavaScript, with no dead controls", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/books/");
    await expect(page.getByTestId("book-card").filter({ visible: true })).toHaveCount(BOOK_COUNT);
    await expect(page.getByTestId("book-catalog-controls")).toBeHidden();

    await page.getByRole("link", { name: TIDE.title }).click();
    await expect(page.getByRole("heading", { level: 1, name: TIDE.title })).toBeVisible();
    await expect(page.getByTestId("book-detail-add")).toBeHidden();
    await context.close();
  });

  test("book page shows the book, its cover's text alternative and its structured data", async ({ page }) => {
    await page.goto("/books/");
    await page.getByRole("link", { name: TIDE.title }).click();
    await expect(page).toHaveURL(\`/books/\${TIDE.slug}\`);
    await expect(page).toHaveTitle(/The Glass Tide by Rowan Achterberg/);

    const detail = page.getByTestId("book-detail");
    await expect(detail.getByRole("heading", { level: 1 })).toHaveText(TIDE.title);
    await expect(detail.getByTestId("book-detail-price")).toHaveText(TIDE.price);
    await expect(
      detail.getByRole("img", { name: "Cover of The Glass Tide by Rowan Achterberg" }),
    ).toBeVisible();

    const data = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
    );
    expect(data["@type"]).toBe("Product");
    expect(data.name).toBe(TIDE.title);
    expect(data.offers).toMatchObject({ price: "8.50", priceCurrency: "USD" });
  });

  test("adding a book updates the cart count in the header", async ({ page }) => {
    await page.goto(\`/books/\${TIDE.slug}\`);
    const count = page.getByTestId("site-header-cart-count");
    await expect(count).toBeHidden();
    await expect(page.getByTestId("book-detail-view-cart")).toBeHidden();

    await page.getByTestId("book-detail-add").click();
    await expect(count).toHaveText("1");
    await expect(page.getByTestId("book-detail-status")).toContainText("1 copy");

    await page.getByTestId("book-detail-add").click();
    await expect(count).toHaveText("2");

    await page.getByTestId("book-detail-view-cart").click();
    await expect(page).toHaveURL("/cart");
    await expect(cartLine(page, TIDE.title)).toBeVisible();
    await expect(page.getByTestId("cart-list-line").filter({ visible: true })).toHaveCount(1);
    await expect(page.getByTestId("cart-list-total")).toHaveText("$17.00");
  });

  test("changing a quantity updates the line, the total and the count", async ({ page }) => {
    await addToCart(page, TIDE.slug);
    await addToCart(page, BREAD.slug);
    await page.goto("/cart");
    await expect(page.getByTestId("cart-list-total")).toHaveText("$40.50");

    const quantity = cartLine(page, TIDE.title).getByTestId("cart-list-quantity");
    await quantity.fill("3");
    await quantity.blur();
    await expect(cartLine(page, TIDE.title).getByTestId("cart-list-amount")).toHaveText("$25.50");
    await expect(page.getByTestId("cart-list-total")).toHaveText("$57.50");
    await expect(page.getByTestId("site-header-cart-count")).toHaveText("4");
    await expect(page.getByTestId("cart-list-status")).toHaveText("Quantity updated.");

    // A quantity the cart cannot hold is refused and the line goes back to what was saved.
    for (const bad of ["0", "-2", "1.5", "100000"]) {
      await quantity.fill(bad);
      await quantity.blur();
      await expect(page.getByTestId("cart-list-status")).toContainText("Choose a whole quantity");
      await expect(quantity).toHaveValue("3");
    }
    await expect(page.getByTestId("cart-list-total")).toHaveText("$57.50");
  });

  test("removing a line takes it out of the cart", async ({ page }) => {
    await addToCart(page, TIDE.slug);
    await addToCart(page, BREAD.slug);
    await page.goto("/cart");

    await cartLine(page, TIDE.title).getByTestId("cart-list-remove").click();
    await expect(cartLine(page, TIDE.title)).toBeHidden();
    await expect(page.getByTestId("cart-list-total")).toHaveText(BREAD.price);
    await expect(page.getByTestId("site-header-cart-count")).toHaveText("1");

    await cartLine(page, BREAD.title).getByTestId("cart-list-remove").click();
    await expect(page.getByTestId("cart-list-empty")).toBeVisible();
    await expect(page.getByTestId("cart-list-checkout")).toBeHidden();
    await expect(page.getByTestId("site-header-cart-count")).toBeHidden();
  });

  test("the cart survives a reload and a visit to another page", async ({ page }) => {
    await addToCart(page, BREAD.slug, 2);
    await page.goto("/cart");
    await page.reload();
    await expect(cartLine(page, BREAD.title).getByTestId("cart-list-quantity")).toHaveValue("2");
    await expect(page.getByTestId("cart-list-total")).toHaveText("$64.00");

    await page.goto("/");
    await expect(page.getByTestId("site-header-cart-count")).toHaveText("2");
  });

  test("a damaged or tampered saved cart is treated as what can be trusted", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("cart", "{not json"));
    await page.goto("/cart");
    await expect(page.getByTestId("cart-list-empty")).toBeVisible();
    await expect(page.getByTestId("site-header-cart-count")).toBeHidden();

    // An unknown book, a stored price and a bad quantity are all ignored; the one good line stays.
    await page.evaluate(() =>
      localStorage.setItem(
        "cart",
        JSON.stringify([
          { id: "no-such-book", quantity: 2 },
          { id: "the-glass-tide", quantity: 1, priceCents: 1 },
          { id: "bread-for-the-long-winter", quantity: -5 },
        ]),
      ),
    );
    await page.reload();
    await expect(page.getByTestId("cart-list-line").filter({ visible: true })).toHaveCount(1);
    await expect(page.getByTestId("cart-list-total")).toHaveText(TIDE.price);
  });

  test("checkout with an empty cart shows no form", async ({ page }) => {
    await page.goto("/checkout");
    await expect(page.getByTestId("checkout-form-empty")).toBeVisible();
    await expect(page.getByTestId("checkout-form-form")).toBeHidden();
  });

  test("checkout validates the address, then ends on the demo confirmation", async ({ page }) => {
    await addToCart(page, TIDE.slug, 2);
    await page.goto("/cart");
    await page.getByTestId("cart-list-checkout").click();
    await expect(page).toHaveURL("/checkout");

    const summary = page.getByTestId("order-summary");
    await expect(summary.getByTestId("order-summary-line").filter({ visible: true })).toHaveCount(1);
    await expect(summary).toContainText(TIDE.title);
    await expect(page.getByTestId("order-summary-total")).toHaveText("$17.00");

    // Nothing filled in: every field reports, the first one takes focus, and the page stays.
    await page.getByTestId("checkout-form-submit").click();
    await expect(page).toHaveURL("/checkout");
    await expect(page.getByTestId("checkout-form-alert")).toContainText("Some fields need attention");
    await expect(page.getByTestId("form-field-error").filter({ visible: true })).toHaveCount(7);
    await expect(page.getByLabel("Full name")).toBeFocused();
    await expect(page.getByLabel("Full name")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Full name").fill("Ada Reader");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Street address").fill("12 Shelf Lane");
    await page.getByLabel("City").fill("Booktown");
    await page.getByLabel("State or region").fill("   ");
    await page.getByLabel("Postal code").fill("12345");
    await page.getByLabel("Country").fill("United States");
    await page.getByTestId("checkout-form-submit").click();
    await expect(page).toHaveURL("/checkout");
    await expect(page.getByTestId("form-field-error").filter({ visible: true })).toHaveCount(2);
    await expect(page.getByLabel("Email")).toBeFocused();

    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("State or region").fill("Vermont");
    await page.getByTestId("checkout-form-submit").click();

    await expect(page).toHaveURL("/order-confirmed");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("demo");
    await expect(page.getByTestId("order-confirmation-notice")).toContainText(
      "No payment is taken; connect a payment provider here.",
    );
    // The address was never put in the URL, and the cart is empty again.
    expect(page.url()).not.toContain("Ada");
    await expect(page.getByTestId("site-header-cart-count")).toBeHidden();
    await page.getByTestId("order-confirmation-continue").click();
    await expect(page).toHaveURL("/books/");
  });

  test("mobile navigation toggle expands and collapses the menu", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    const toggle = page.getByTestId("site-header-nav-toggle");
    const menu = page.getByTestId("site-header-nav-menu");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();
  });

  test("an unknown URL, or a book that is not in the catalog, is the 404 page", async ({ page }) => {
    for (const path of ["/no-such-page", "/books/no-such-book"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    }
    await page.getByRole("link", { name: "Browse the books" }).click();
    await expect(page).toHaveURL("/books/");
  });
${adapter ? CART_API_E2E : ""}});
`;
