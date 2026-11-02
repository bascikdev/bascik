/**
 * Browser acceptance for the Cloudflare adapter (prompts 134/135), against the
 * emitted `_worker.js` running in local workerd with the asset layer in front.
 *
 * Only runs under `playwright.cloudflare.config.ts`. Every assertion uses
 * data-testid; ordering is observed with `waitUntil: 'commit'` and locator
 * expectations, never `waitForTimeout`. JavaScript is disabled in the browser
 * for the paint test so nothing but streamed HTML can produce the result.
 */
import { test, expect, type Page } from "@playwright/test";

test("the playground stays readable at desktop and mobile widths", async ({
  page,
}) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/server",
      "/stream",
      "/stream-append",
      "/mixed",
      "/catalog",
      "/catalog-stream",
      "/api-demo",
    ]) {
      await page.goto(path);
      await page.getByTestId("demo-menu").locator("summary").click();
      await expect(
        page.getByRole("navigation", { name: "Site" }),
      ).toBeVisible();
      const current = page
        .getByTestId("demo-nav")
        .locator('[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveCSS("color", "rgb(24, 25, 27)");
      await expect(current).toHaveCSS("min-height", "40px");
      expect(
        await current.evaluate(
          (link) =>
            link.ownerDocument.defaultView?.getComputedStyle(link, "::before")
              .backgroundColor,
        ),
      ).toBe("rgb(211, 255, 141)");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const logo = page.getByRole("img", { name: "Bascik", exact: true });
      await expect(logo).toBeVisible();
      expect(
        await logo.evaluate((image) =>
          "naturalWidth" in image ? image.naturalWidth : 0,
        ),
      ).toBeGreaterThan(0);
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgb(24, 25, 27)",
      );
      expect(
        await page
          .locator("html")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        `${path} at ${width}px`,
      ).toBe(true);
    }
  }
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Bascik home" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Bascik home" })).toHaveCSS(
    "outline-style",
    "solid",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stream", { waitUntil: "commit" });
  await expect(page.getByTestId("cf-skeleton-3")).toHaveCSS(
    "animation-name",
    "none",
  );
});

test("navigation links have hover feedback and open their example", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("demo-menu").locator("summary").click();
  const server = page
    .getByTestId("demo-nav")
    .getByRole("link", { name: "Server scripts" });
  await server.hover();
  expect(
    await server.evaluate(
      (link) =>
        link.ownerDocument.defaultView?.getComputedStyle(link, "::before")
          .backgroundColor,
    ),
  ).toBe("rgb(36, 38, 40)");
  await server.click();
  await expect(page.getByTestId("cf-server-greeting")).toContainText("collin");
  await expect(page.getByTestId("demo-nav")).toBeHidden();
  await page.getByTestId("demo-menu").locator("summary").click();
  await expect(server).toHaveAttribute("aria-current", "page");
});

test("the collapsible menu works without JavaScript on desktop and mobile", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const menu = page.getByTestId("demo-menu");
      const summary = menu.locator("summary");
      await expect(page.getByTestId("demo-nav")).toBeHidden();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("demo-nav")).toBeVisible();
      expect(
        await page.getByTestId("demo-nav").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= element.ownerDocument.documentElement.clientWidth
          );
        }),
      ).toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("demo-nav")).toBeHidden();
    }
  } finally {
    await context.close();
  }
});

test.describe("cloudflare adapter: static bypass", () => {
  test("the static home page is served by the asset layer", async ({
    page,
  }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("cf-static-heading")).toBeVisible();
    // A static page carries no dynamic cache policy.
    expect(res?.headers()["cache-control"]).not.toBe("private, no-store");
  });

  test("the static home page sends the same security headers as a Worker-rendered page, each once", async ({
    request,
  }) => {
    // Static files get them from the generated public/_headers; the Worker
    // sets them on what it renders. A header both set would be joined with
    // a comma.
    const names = [
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
    ];
    const staticHeaders = (await request.get("/")).headers();
    const workerHeaders = (await request.get("/server?name=Alice")).headers();
    for (const name of names) {
      expect(staticHeaders[name], name).toBeDefined();
      expect(staticHeaders[name], name).toBe(workerHeaders[name]);
      expect(staticHeaders[name], name).not.toContain(",");
    }
    // The asset layer sends HSTS on every response, as the _headers rule
    // says (a browser ignores it over http); the Worker sends it over https.
    expect(staticHeaders["strict-transport-security"]).toBe("max-age=31536000");
  });

  test("an unknown path is a 404 without any placeholder markup", async ({
    page,
  }) => {
    const res = await page.request.get("/does-not-exist");
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain("text/bascik-server");
  });

  test("every demo page links the Bascik favicon, and the asset layer serves it", async ({
    page,
  }) => {
    for (const path of [
      "/",
      "/server",
      "/stream",
      "/stream-append",
      "/mixed",
      "/api-demo",
      "/catalog",
      "/catalog-stream",
    ]) {
      await page.goto(path);
      await expect(
        page.locator('link[rel="icon"][type="image/svg+xml"]'),
        path,
      ).toHaveAttribute("href", "/assets/favicon.svg");
    }
    for (const asset of [
      "/favicon.ico",
      "/assets/favicon.svg",
      "/assets/favicon-32x32.png",
      "/assets/apple-touch-icon.png",
    ]) {
      const res = await page.request.get(asset);
      expect(res.status(), asset).toBe(200);
    }
  });
});

test.describe("cloudflare adapter: request-time pages", () => {
  test("a pure server script page composes per request with context and headers", async ({
    page,
  }) => {
    const res = await page.goto("/server?name=Alice&role=Architect");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.getByTestId("cf-server-heading")).toBeVisible();
    await expect(page.getByTestId("cf-server-greeting")).toContainText("Alice");
    await expect(page.getByTestId("cf-server-greeting")).toContainText(
      "Architect",
    );
    await expect(page.getByTestId("cf-platform-name")).toHaveText("cloudflare");
    await expect(page.getByTestId("cf-remote-ip")).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("text/bascik-server");
  });

  test("a Worker-rendered page carries the default security headers, and a dotfile is a 404", async ({
    request,
  }) => {
    // The `security` defaults (Collin 2026-10-29), from the build's config.
    const res = await request.get("/server?name=Alice");
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-opener-policy"]).toBe(
      "same-origin-allow-popups",
    );
    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
    // Local workerd serves plain http: no HSTS (https is covered in process).
    expect(headers["strict-transport-security"]).toBeUndefined();
    expect((await request.get("/.env")).status()).toBe(404);
  });

  test("a server script composes per request with the platform context on the stream page", async ({
    page,
  }) => {
    const res = await page.goto("/stream?name=Jane");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.getByTestId("cf-greeting")).toContainText(
      "Welcome back, Jane",
    );
    await expect(page.getByTestId("cf-greeting")).toContainText("cloudflare");
    const html = await page.content();
    expect(html).not.toContain("text/bascik-server");
  });

  test("misuse: markup in the visitor's name is shown as text on the server and stream pages, with every character kept", async ({
    page,
  }) => {
    // The demo builds its greeting with html from @bascik/bascik/html, so a name is escaped where it lands instead
    // of having < > & and quotes deleted (which turned "Fish & Chips" into "Fish  Chips").
    const name = `<b data-testid="injected">Milk & "Foam"</b>`;
    const pages = [
      [
        `/server?name=${encodeURIComponent(name)}&role=${encodeURIComponent("<i>Admin</i>")}`,
        "cf-server-greeting",
      ],
      [`/stream?name=${encodeURIComponent(name)}`, "cf-greeting"],
      [`/stream-append?name=${encodeURIComponent(name)}`, "cf-append-greeting"],
    ] as const;
    for (const [url, testId] of pages) {
      expect((await page.goto(url))?.status(), url).toBe(200);
      await expect(page.getByTestId(testId), url).toContainText(name);
      await expect(page.getByTestId("injected"), url).toHaveCount(0);
    }
    await page.goto(`/server?role=${encodeURIComponent("<i>Admin</i>")}`);
    await expect(page.getByTestId("cf-server-greeting")).toContainText(
      "Role: <i>Admin</i>",
    );
  });

  test("an API route dispatches inside the worker", async ({ page }) => {
    const res = await page.request.get("/api/ping");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ pong: true, platform: "cloudflare" });
    const options = await page.request.fetch("/api/ping", {
      method: "OPTIONS",
    });
    expect(options.status()).toBe(204);
    expect(options.headers()["allow"]).toBe("GET, HEAD, OPTIONS");
  });

  test("a catch-all API route captures decoded segments and respects precedence in the worker", async ({
    page,
  }) => {
    const many = await page.request.get(
      "/api/files/reports/2026/caf%C3%A9%20menu?x=1",
    );
    expect(many.status()).toBe(200);
    expect(await many.json()).toEqual({
      route: "catch-all",
      segments: ["reports", "2026", "café menu"],
      platform: "cloudflare",
    });

    const once = await page.request.get("/api/files/%2541");
    expect((await once.json()).segments).toEqual(["%41"]);

    const staticRoute = await page.request.get("/api/files/latest");
    expect(await staticRoute.json()).toEqual({ route: "static" });

    // Required catch-all: nothing remains, so the worker does not run the handler.
    const none = await page.request.get("/api/files");
    expect(await none.text()).not.toContain('"segments"');
  });

  test("a catch-all API route rejects unsafe paths with 400 and answers methods like any other route", async ({
    page,
  }) => {
    for (const unsafe of [
      "/api/files/a%2Fb",
      "/api/files/a%5Cb",
      "/api/files/%E0%A4%A",
      "/api/files/a%00b",
      "/api/files/a//b",
    ]) {
      const res = await page.request.get(unsafe);
      expect(res.status(), unsafe).toBe(400);
    }
    const put = await page.request.put("/api/files/a/b");
    expect(put.status()).toBe(405);
    expect(put.headers()["allow"]).toBe("GET, HEAD, OPTIONS");
  });

  test("progressive append stream page paints chunks in order", async ({
    page,
  }) => {
    const res = await page.goto("/stream-append?delay=500");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.locator("h1")).toContainText("Stream append");
    await expect(page.locator(".stream-card")).toHaveCount(3);
  });

  test("mixed server and stream execution page composes properly", async ({
    page,
  }) => {
    const res = await page.goto("/mixed");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.locator("h1")).toContainText("Mixed execution");
    await expect(page.locator(".stream-resolved")).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("text/bascik-server");
    expect(html).toContain("Public Visitor");
  });

  test("interactive API client page is served and can fetch from /api/ping", async ({
    page,
  }) => {
    const res = await page.goto("/api-demo");
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toContainText("API client");
    await page.click("#fetch-btn");
    await expect(page.locator("#response-status")).toContainText("HTTP 200 OK");
    await expect(page.locator("#json-display")).toContainText('"pong": true');
  });
});

test.describe("cloudflare adapter: streamed paint order", () => {
  test.use({ javaScriptEnabled: false });

  test("the skeleton paints before the slow stream job resolves, with JS disabled", async ({
    page,
  }) => {
    const t0 = Date.now();
    await page.goto("/stream?delay=1500", { waitUntil: "commit" });
    await expect(page.getByTestId("cf-skeleton")).toBeVisible();
    const tSkeleton = Date.now() - t0;
    expect(await page.getByTestId("cf-result").count()).toBe(0);
    await expect(page.getByTestId("cf-greeting")).toContainText(
      "Welcome back, Guest",
    );

    await expect(page.getByTestId("cf-result")).toBeVisible();
    // Once the streamed chunk arrives, the CSS :has() selector hides the loading skeleton.
    await expect(page.getByTestId("cf-skeleton")).toBeHidden();
    const tResult = Date.now() - t0;

    expect(tSkeleton).toBeLessThan(1000);
    expect(tResult).toBeGreaterThanOrEqual(1500);
    await expect(page.getByTestId("cf-footer")).toContainText(
      "Zero client JS framework hydration",
    );
  });

  test("the mixed page footer paints in the initial chunk, before the stream job resolves", async ({
    page,
  }) => {
    await page.goto("/mixed?delay=1500", { waitUntil: "commit" });
    await expect(page.getByTestId("cf-mixed-footer")).toBeVisible();
    expect(await page.locator(".stream-resolved").count()).toBe(0);

    await expect(page.locator(".stream-resolved")).toBeVisible();
    await expect(page.getByTestId("cf-mixed-footer")).toBeVisible();
  });
});

// ─── Components returned by scripts (prompt 157) ────────────────────────────
//
// catalog.html and catalog-stream.html are the live demo the docs link to.
// No page uses <product-card> or <product-card-live> in its own markup, so
// every tile observed here was rendered by the Worker per request.

/**
 * Markup outside HTML comments (component comments are author text). A
 * comment ends where the HTML parser ends it ("-->", "--!>", an abrupt
 * "<!-->" or the end of input), in one pass: removing again could join text
 * around a comment into a new one and hide a tag the browser shows.
 */
const markup = (html: string): string =>
  html.replace(/<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g, "");

/** Every `<style>` block of `html` that defines `className`. */
const styleBlocksDefining = (html: string, className: string): string[] =>
  [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .filter((m) => m[1].includes(`.${className}{`))
    .map((m) => m[0]);

const expectNoInternals = (html: string) => {
  expect(html).not.toContain("text/bascik-server");
  expect(html).not.toContain("data-bascik-server-id");
  expect(html).not.toContain("bascik-job:");
};

const classOf = async (page: Page, testid: string): Promise<string> => {
  await expect(page.getByTestId(testid).first()).toBeAttached();
  return page
    .getByTestId(testid)
    .first()
    .evaluate((el) => el.getAttribute("class") ?? "");
};

test.describe("cloudflare adapter: components returned by server scripts (prompt 157)", () => {
  for (const width of [1280, 390]) {
    test(`the catalog next links have breathing room above the footer at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/catalog");
      const next = page.getByTestId("catalog-next-nav");
      const footer = page.getByTestId("catalog-footer");
      await expect(next).toBeVisible();
      const gap = await next.evaluate((el) => {
        const doc = el.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(el);
        const textBottom = range.getBoundingClientRect().bottom;
        const footerTop = doc
          .querySelector('[data-testid="catalog-footer"]')!
          .getBoundingClientRect().top;
        return footerTop - textBottom;
      });
      expect(gap).toBeGreaterThanOrEqual(20);
      await expect(footer).toHaveCSS("padding-top", "24px");
    });
  }

  test("the catalog response carries rendered markup, never the literal tags, and no internal marker", async ({
    request,
  }) => {
    const res = await request.get("/catalog");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    const html = await res.text();
    expect(markup(html)).not.toContain("<product-card");
    expect(markup(html)).not.toContain("</product-card");
    expectNoInternals(html);
    // The escaped sample in <pre><code> is page markup and stays text.
    expect(html).toContain("&lt;product-card data-bascik-prop-name=");
  });

  test("every product renders as a visible tile with its props, badge slot and the component's CSS", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto("/catalog");
    const results = page.getByTestId("catalog-results");
    const tiles = results.getByTestId("product-card");
    await expect(
      page.getByRole("heading", { name: "Server-rendered cards" }),
    ).toBeVisible();
    await expect(tiles).toHaveCount(5);
    await expect(results.getByTestId("product-card-name")).toHaveText([
      "Pour-over kettle",
      "Ceramic dripper",
      "Milk frother",
      "Glass carafe",
      "Filters & holder",
    ]);
    await expect(results.getByTestId("product-card-price").first()).toHaveText(
      "$48",
    );
    // Slot content replaces the fallback; an empty slot keeps it.
    await expect(results.getByTestId("product-card-badge")).toHaveText([
      "New",
      "Standard",
      "Best seller",
      "Standard",
      "Standard",
    ]);
    await expect(tiles.first()).toBeVisible();
    // Computed from the component stylesheet the Worker emitted in the body.
    await expect(results.getByTestId("product-card-name").first()).toHaveCSS(
      "color",
      "rgb(211, 255, 141)",
    );
    await expect(tiles.first()).toHaveCSS("border-top-left-radius", "10px");
    expect(errors).toEqual([]);
  });

  test("the scoped class on each tile is the one the single emitted <style> defines", async ({
    page,
    request,
  }) => {
    await page.goto("/catalog");
    const className = await classOf(page, "product-card");
    expect(className).toMatch(/^\S+$/);
    expect(className).not.toBe("tile");
    const html = await (await request.get("/catalog")).text();
    const blocks = styleBlocksDefining(html, className);
    expect(blocks).toHaveLength(1);
    expect(html.indexOf(blocks[0])).toBeGreaterThan(html.indexOf("</head>"));
    expect(html.indexOf(blocks[0])).toBeLessThan(
      html.indexOf('data-testid="product-card"'),
    );
  });

  test("each tile gets its own instance id, and its client script ran once", async ({
    page,
  }) => {
    await page.goto("/catalog");
    const ids = await page
      .locator(
        '[data-testid="product-card"], [data-testid="product-card-live"]',
      )
      .evaluateAll((els) => els.map((el) => el.id));
    expect(ids).toHaveLength(6);
    for (const id of ids) expect(id).not.toBe("");
    expect(new Set(ids).size).toBe(6);
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { __productCards?: number }).__productCards,
      ),
    ).toBe(6);
  });

  test("the nested server script of <product-card-live> ran with the request and is styled by the component", async ({
    page,
  }) => {
    await page.goto("/catalog");
    const live = page.getByTestId("catalog-live");
    await expect(live.getByTestId("product-card-live")).toHaveCount(1);
    await expect(live.getByTestId("product-card-name")).toHaveText(
      "Milk frother",
    );
    await expect(live.getByTestId("product-card-badge")).toHaveText("Live");
    const stock = live.getByTestId("product-card-stock");
    await expect(stock).toHaveText(
      "In stock · checked for /catalog at request time",
    );
    // The output scope gave the returned <p class="stock"> the scoped class.
    await expect(stock).toHaveCSS("color", "rgb(254, 240, 138)");
  });

  test("?q= filters the tiles on every request, and the search form drives it", async ({
    page,
  }) => {
    await page.goto("/catalog?q=frother");
    const results = page.getByTestId("catalog-results");
    await expect(results.getByTestId("product-card")).toHaveCount(1);
    await expect(results.getByTestId("product-card-name")).toHaveText(
      "Milk frother",
    );

    await page.goto("/catalog?q=nothing-matches");
    await expect(results.getByTestId("product-card")).toHaveCount(0);
    await expect(page.getByTestId("catalog-empty")).toContainText(
      'No products match "nothing-matches"',
    );

    await page.goto("/catalog");
    await page.getByTestId("catalog-search").fill("kettle");
    await page.getByTestId("catalog-search").press("Enter");
    await expect(page).toHaveURL(/\/catalog\?q=kettle$/);
    await expect(results.getByTestId("product-card-name")).toHaveText([
      "Pour-over kettle",
    ]);
  });

  test("misuse: a query that spells a component tag is escaped text, never rendered", async ({
    request,
  }) => {
    const html = await (
      await request.get(
        `/catalog?q=${encodeURIComponent('<product-card data-bascik-prop-name="x">')}`,
      )
    ).text();
    expect(markup(html)).not.toContain(
      '<product-card data-bascik-prop-name="x"',
    );
    expect(html).toContain(
      "&lt;product-card data-bascik-prop-name=&quot;x&quot;",
    );
  });
});

test.describe("cloudflare adapter: components returned by stream scripts (prompt 157)", () => {
  test("the streamed catalog renders every batch in document order with one stylesheet ahead of the first tile", async ({
    page,
    request,
  }) => {
    const html = await (await request.get("/catalog-stream?delay=0")).text();
    expect(markup(html)).not.toContain("<product-card");
    expectNoInternals(html);
    const names = [
      "Pour-over kettle",
      "Ceramic dripper",
      "Milk frother",
      "Glass carafe",
      "Filters &amp; holder",
    ].map((name) => html.indexOf(`>${name}<`));
    expect(names.every((i) => i > 0)).toBe(true);
    expect([...names].sort((a, b) => a - b)).toEqual(names);

    await page.goto("/catalog-stream?delay=0");
    const grid = page.getByTestId("catalog-stream-grid");
    await expect(grid.getByTestId("product-card")).toHaveCount(5);
    await expect(grid.getByTestId("product-card-name").first()).toHaveCSS(
      "color",
      "rgb(211, 255, 141)",
    );
    const className = await classOf(page, "product-card");
    const blocks = styleBlocksDefining(html, className);
    expect(blocks).toHaveLength(1);
    expect(html.indexOf(blocks[0])).toBeLessThan(
      html.indexOf('data-testid="product-card"'),
    );
  });
});

test.describe("cloudflare adapter: streamed catalog paint order (prompt 157)", () => {
  test.use({ javaScriptEnabled: false });

  test("the shell paints before any tile, with JS disabled, and the tiles follow", async ({
    page,
  }) => {
    const t0 = Date.now();
    // Batch 1, first in the document, resolves after 2 x delay.
    await page.goto("/catalog-stream?delay=800", { waitUntil: "commit" });
    await expect(page.getByTestId("catalog-stream-footer")).toBeVisible();
    await expect(page.getByTestId("catalog-stream-intro")).toBeVisible();
    const tShell = Date.now() - t0;
    expect(await page.getByTestId("product-card").count()).toBe(0);

    await expect(
      page.getByTestId("catalog-stream-grid").getByTestId("product-card"),
    ).toHaveCount(5, { timeout: 10_000 });
    const tTiles = Date.now() - t0;
    expect(tShell).toBeLessThan(1200);
    expect(tTiles).toBeGreaterThanOrEqual(1600);
  });
});
