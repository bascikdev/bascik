import { test, expect } from "@playwright/test";

const pages = [
  ["/", "Overview"],
  ["/server?name=collin", "Server scripts"],
  ["/stream", "Stream swap"],
  ["/stream-append", "Stream append"],
  ["/mixed", "Mixed execution"],
  ["/catalog", "Server-rendered cards"],
  ["/catalog-stream", "Streamed cards"],
  ["/api-demo", "API client"],
  ["/errors", "Error demo"],
] as const;

const products = [
  "Pour-over kettle",
  "Ceramic dripper",
  "Milk frother",
  "Glass carafe",
  "Filters & holder",
];
const prices = ["$48", "$22", "$129", "$31", "$9"];

test.describe("shared adapter demo contract", () => {
  test("canonical routes have the same titles, headings, and navigation", async ({
    page,
  }) => {
    for (const [path, title] of pages) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page).toHaveTitle(`Bascik · ${title}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      const menu = page.getByTestId("demo-menu");
      await expect(menu).not.toHaveAttribute("open");
      await menu.locator("summary").click();
      const links = menu.getByRole("link");
      await expect(links).toHaveText(pages.map(([, label]) => label));
      expect(
        await links.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("href")),
        ),
      ).toEqual(pages.map(([href]) => href));
      await expect(menu.locator('[aria-current="page"]')).toHaveText(title);
    }
  });

  test("the same menu is usable without JavaScript at desktop and mobile widths", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
    });
    try {
      const page = await context.newPage();
      for (const width of [1280, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        const menu = page.getByTestId("demo-menu");
        await menu.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect(menu.getByRole("link")).toHaveCount(pages.length);
        expect(
          await menu.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left >= 0 &&
              bounds.right <= element.ownerDocument.documentElement.clientWidth
            );
          }),
        ).toBe(true);
        await page.keyboard.press("Enter");
        await expect(menu.getByRole("link").first()).toBeHidden();
        expect(
          await page
            .locator("html")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test("static assets and isolated component client scripts work", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response?.headers()["cache-control"]).not.toContain("private");
    const logo = await page.request.get("/assets/bascik-logo.svg");
    expect(logo.status()).toBe(200);
    expect(logo.headers()["content-type"]).toContain("image/svg+xml");
    const counters = page.getByTestId("fixture-counter");
    await expect(counters).toHaveCount(2);
    await counters.first().getByRole("button", { name: "Increment" }).click();
    await expect(counters.getByTestId("fixture-counter-value")).toHaveText([
      "1",
      "0",
    ]);
  });

  test("server query input is escaped, and page aliases preserve it", async ({
    page,
  }) => {
    const name = '<b data-testid="injected">Milk & "Foam"</b>';
    for (const route of ["/server", "/server/", "/server.html"]) {
      const response = await page.goto(
        `${route}?name=${encodeURIComponent(name)}`,
      );
      expect(response?.status(), route).toBe(200);
      expect(response?.headers()["cache-control"]).toContain("no-store");
      await expect(
        page.getByTestId(/^(cf-server-greeting|fixture-server-greeting)$/),
      ).toContainText(name);
      await expect(page.getByTestId("injected")).toHaveCount(0);
    }
    await page.goto("/server?name=collin&role=Architect");
    await expect(
      page.getByTestId(/^(cf-server-greeting|fixture-server-greeting)$/),
    ).toContainText("Architect");
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("collin");
    await page.getByRole("button", { name: "Update greeting" }).click();
    await expect(page).toHaveURL(/\/server\?name=collin$/);
    for (const [route, greeting] of [
      ["/stream", "cf-greeting"],
      ["/stream-append", "cf-append-greeting"],
    ]) {
      await page.goto(`${route}?delay=0&name=${encodeURIComponent(name)}`);
      await expect(page.getByTestId(greeting)).toContainText(name);
      await expect(page.getByTestId("injected")).toHaveCount(0);
    }
  });

  test("server-rendered cards share product data, slots, filtering, and nested scripts", async ({
    page,
  }) => {
    await page.goto("/catalog");
    const results = page.getByTestId("catalog-results");
    await expect(results.getByTestId("product-card-name")).toHaveText(products);
    await expect(results.getByTestId("product-card-price")).toHaveText(prices);
    await expect(results.getByTestId("product-card-badge")).toHaveText([
      "New",
      "Standard",
      "Best seller",
      "Standard",
      "Standard",
    ]);
    await expect(page.getByTestId("product-card-live")).toContainText(
      "In stock",
    );
    await page.getByTestId("catalog-search").fill("frother");
    await page.getByTestId("catalog-search").press("Enter");
    await expect(results.getByTestId("product-card-name")).toHaveText([
      "Milk frother",
    ]);
    await page.goto("/catalog?q=nothing-matches");
    await expect(page.getByTestId("catalog-empty")).toBeVisible();
    await expect(results.getByTestId("product-card")).toHaveCount(0);
    await page.goto(
      `/catalog?q=${encodeURIComponent('<script data-testid="injected">bad()</script>')}`,
    );
    await expect(page.getByTestId("catalog-empty")).toContainText("<script");
    await expect(page.getByTestId("injected")).toHaveCount(0);
  });

  test("API methods, parameters, catch-all routes, and precedence are consistent", async ({
    request,
  }) => {
    const ping = await request.get("/api/ping");
    expect(ping.status()).toBe(200);
    expect(await ping.json()).toMatchObject({ pong: true });
    const echo = await request.post("/api/echo", { data: "Milk & foam" });
    expect(echo.status()).toBe(201);
    expect(echo.headers()["x-fixture"]).toBe("echo");
    expect(await echo.json()).toEqual({ body: "Milk & foam" });
    const item = await request.get("/api/items/milk%20frother");
    expect(await item.json()).toEqual({ id: "milk frother" });
    const files = await request.get("/api/files/reports/caf%C3%A9%20menu");
    expect(await files.json()).toMatchObject({
      route: "catch-all",
      segments: ["reports", "café menu"],
    });
    expect(await (await request.get("/api/files/latest")).json()).toEqual({
      route: "static",
    });
    const unsupported = await request.put("/api/files/a/b");
    expect(unsupported.status()).toBe(405);
    expect(unsupported.headers()["allow"]).toBe("GET, HEAD, OPTIONS");
    const head = await request.head("/api/ping");
    expect(head.status()).toBe(200);
    expect(await head.body()).toHaveLength(0);
    const options = await request.fetch("/api/ping", { method: "OPTIONS" });
    expect(options.status()).toBe(204);
    expect(options.headers()["allow"]).toBe("GET, HEAD, OPTIONS");
    for (const path of [
      "/api/files/a%2Fb",
      "/api/files/a%5Cb",
      "/api/files/%E0%A4%A",
      "/api/files/a%00b",
    ]) {
      expect((await request.get(path)).status(), path).toBe(400);
    }
    const repeatedSlash = await request.get("/api/files/a//b");
    // Netlify Dev collapses repeated slashes before the function sees the URL.
    if (repeatedSlash.status() === 200) {
      expect(await repeatedSlash.json()).toMatchObject({
        route: "catch-all",
        segments: ["a", "b"],
      });
    } else {
      expect(repeatedSlash.status()).toBe(400);
    }
  });

  test("request-time cards keep scoped styles and run client scripts once per instance", async ({
    page,
    request,
  }) => {
    await page.goto("/catalog");
    const cards = page.getByTestId(/^(product-card|product-card-live)$/);
    const ids = await cards.evaluateAll((elements) =>
      elements.map((element) => element.id),
    );
    expect(ids).toHaveLength(6);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(6);
    expect(
      await page.locator("body").evaluate((element) => {
        const view = element.ownerDocument.defaultView;
        return view && "__productCards" in view
          ? view.__productCards
          : undefined;
      }),
    ).toBe(6);
    await expect(
      page
        .getByTestId("catalog-results")
        .getByTestId("product-card-name")
        .first(),
    ).toHaveCSS("color", "rgb(211, 255, 141)");
    await expect(page.getByTestId("product-card-stock")).toHaveCSS(
      "color",
      "rgb(254, 240, 138)",
    );
    const className = await page
      .getByTestId("product-card")
      .first()
      .getAttribute("class");
    expect(className).toMatch(/^\S+$/);
    expect(className).not.toBe("tile");
    const html = await (await request.get("/catalog")).text();
    const styles = [
      ...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),
    ].filter((match) => match[1].includes(`.${className}{`));
    expect(styles).toHaveLength(1);
    expect(html.indexOf(styles[0][0])).toBeLessThan(
      html.indexOf('data-testid="product-card"'),
    );
    expect(html).not.toMatch(
      /text\/bascik-server|data-bascik-server-id|bascik-job:/,
    );
  });

  test("static and dynamic responses preserve the same security headers", async ({
    request,
  }) => {
    const staticResponse = await request.get("/");
    const dynamicResponse = await request.get("/server");
    for (const header of [
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
    ]) {
      const value = staticResponse.headers()[header];
      expect(value, header).toBeDefined();
      expect(value, header).not.toContain(",");
      expect(dynamicResponse.headers()[header], header).toBe(value);
    }
    for (const response of [staticResponse, dynamicResponse]) {
      expect(response.headers()["content-security-policy"]).toContain(
        "script-src",
      );
    }
  });
  test("the API client handles success, HTTP errors, and network failures in place", async ({
    page,
  }) => {
    await page.goto("/api-demo");
    const send = page.getByTestId("demo-api-send");
    const response = page.getByTestId("demo-api-response");
    await send.click();
    await expect(response).toContainText('"pong": true');
    await expect(page.getByTestId("demo-api-status")).toContainText("200");
    await expect(send).toBeEnabled();
    await page.route("**/api/ping", (route) =>
      route.fulfill({ status: 503, body: "Unavailable" }),
    );
    await send.click();
    await expect(response).toContainText("503");
    await expect(send).toBeEnabled();
    await page.unroute("**/api/ping");
    await page.route("**/api/ping", (route) => route.abort("failed"));
    await send.click();
    await expect(page.getByTestId("demo-api-status")).toContainText(
      /fail|error/i,
    );
    await expect(send).toBeEnabled();
    await expect(page).toHaveURL(/\/api-demo$/);
  });

  test.describe("native streaming without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("swap paints a skeleton and footer before replacing the placeholder", async ({
      page,
    }) => {
      await page.goto("/stream?name=collin&delay=1500", {
        waitUntil: "commit",
      });
      const skeleton = page.getByRole("status").first();
      const result = page.getByTestId(/^(cf-result|fixture-stream-result)$/);
      await expect(skeleton).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      expect(await result.count()).toBe(0);
      await expect(result).toBeVisible();
      await expect(skeleton).toBeHidden();
      await expect(page.locator("body")).toContainText("collin");
    });

    test("append paints the shell before three ordered chunks", async ({
      page,
    }) => {
      await page.goto("/stream-append?delay=1200", { waitUntil: "commit" });
      await expect(page.getByRole("contentinfo")).toBeVisible();
      expect(await page.getByRole("article").count()).toBe(0);
      await expect(page.getByRole("article")).toHaveCount(3);
      await expect(page.getByRole("article").first()).toContainText("99.99%");
      await expect(page.getByRole("article").last()).toContainText("64.2");
    });

    test("mixed execution resolves server work before streaming", async ({
      page,
    }) => {
      await page.goto("/mixed?delay=1500", { waitUntil: "commit" });
      await expect(page.getByRole("contentinfo")).toBeVisible();
      await expect(
        page.getByText("Public Visitor", { exact: true }),
      ).toBeVisible();
      const streamed = page.getByText("Phase 3 Stream Chunk Resolved", {
        exact: false,
      });
      expect(await streamed.count()).toBe(0);
      await expect(streamed).toBeVisible();
    });

    test("streamed cards arrive after the shell in the same product order", async ({
      page,
      request,
    }) => {
      await page.goto("/catalog-stream?delay=1000", { waitUntil: "commit" });
      await expect(page.getByRole("contentinfo")).toBeVisible();
      const cards = page
        .getByTestId("catalog-stream-grid")
        .getByTestId("product-card-name");
      expect(await cards.count()).toBe(0);
      await expect(cards).toHaveText(products);
      await expect(
        page
          .getByTestId("catalog-stream-grid")
          .getByTestId("product-card-price"),
      ).toHaveText(prices);
      await expect(cards.first()).toHaveCSS("color", "rgb(211, 255, 141)");
      const className = await page
        .getByTestId("product-card")
        .first()
        .getAttribute("class");
      const html = await (await request.get("/catalog-stream?delay=0")).text();
      const styles = [
        ...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),
      ].filter((match) => match[1].includes(`.${className}{`));
      expect(styles).toHaveLength(1);
      expect(html.indexOf(styles[0][0])).toBeLessThan(
        html.indexOf('data-testid="product-card"'),
      );
    });
  });

  test("failures are safe, streamed shells survive, and private routes are blocked", async ({
    page,
    request,
  }) => {
    for (const path of ["/failure", "/api/failure", "/timeout"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(500);
      const body = await response.text();
      expect(body).not.toMatch(
        /fixture-(server|api)-failure|at file:|Error:.*\n\s+at /,
      );
    }
    const response = await page.goto("/stream-failure");
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("fixture-stream-shell")).toHaveText(
      "The shell survives.",
    );
    await expect(page.getByRole("contentinfo")).toBeVisible();
    expect(await page.content()).not.toContain("Error: fixture-stream-failure");
    for (const path of ["/not-a-page", "/.env", "/bascik.config.ts"]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });
});
