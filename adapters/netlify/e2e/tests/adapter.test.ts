import { expect, test } from "@playwright/test";

test("the playground stays readable at desktop and mobile widths", async ({
  page,
}) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, title, heading] of [
      ["/", "Bascik · Overview", "Overview"],
      ["/server?name=collin", "Bascik · Server scripts", "Server scripts"],
      ["/stream?delay=0", "Bascik · Stream swap", "Stream swap"],
      ["/stream-append?delay=0", "Bascik · Stream append", "Stream append"],
      ["/mixed?delay=0", "Bascik · Mixed execution", "Mixed execution"],
      ["/catalog", "Bascik · Server-rendered cards", "Server-rendered cards"],
      ["/catalog-stream?delay=0", "Bascik · Streamed cards", "Streamed cards"],
      ["/api-demo", "Bascik · API client", "API client"],
      ["/errors", "Bascik · Error demo", "Error demo"],
    ]) {
      await page.goto(path);
      await expect(page).toHaveTitle(title);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await page.getByTestId("demo-menu").locator("summary").click();
      await expect(page.getByTestId("fixture-nav")).toBeVisible();
      const current = page
        .getByTestId("fixture-nav")
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
});

test("the API client displays responses and failures without leaving the page", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("demo-menu").locator("summary").click();
  await page.getByTestId("fixture-nav-api").click();
  await expect(page).toHaveURL(/\/api-demo$/);
  const ping = page.getByTestId("demo-api-send");
  await ping.click();
  await expect(page.getByTestId("demo-api-status")).toContainText("HTTP 200");
  await expect(page.getByTestId("demo-api-response")).toContainText(
    '"pong": true',
  );
  await expect(ping).toBeEnabled();
  const send = page.getByTestId("fixture-api-send");
  await send.click();
  await expect(page.getByTestId("fixture-api-status")).toContainText(
    "HTTP 200",
  );
  await expect(page.getByTestId("fixture-api-response")).toContainText(
    '"platform": "netlify"',
  );
  await expect(page).toHaveURL(/\/api-demo$/);
  await page.route("**/api/context", (route) =>
    route.fulfill({ status: 503, body: "Service unavailable" }),
  );
  await send.click();
  await expect(page.getByTestId("fixture-api-status")).toContainText(
    "HTTP 503",
  );
  await expect(page.getByTestId("fixture-api-response")).toHaveText(
    "Service unavailable",
  );
  await expect(send).toBeEnabled();
  await page.route("**/api/context", (route) => route.abort());
  await send.click();
  await expect(page.getByTestId("fixture-api-status")).toHaveText(
    "Request failed.",
  );
  await expect(send).toBeEnabled();
  await expect(page.getByTestId("fixture-nav-failure")).toHaveText(
    "Error demo",
  );
  await expect(page.getByTestId("fixture-nav-failure")).toHaveAttribute(
    "href",
    "/errors",
  );
});

test("navigation looks interactive and the greeting form uses the query string", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("demo-menu").locator("summary").click();
  const server = page.getByTestId("fixture-nav-server");
  await server.hover();
  expect(
    await server.evaluate(
      (link) =>
        link.ownerDocument.defaultView?.getComputedStyle(link, "::before")
          .backgroundColor,
    ),
  ).toBe("rgb(36, 38, 40)");
  await server.click();
  await expect(page.getByTestId("fixture-greeting")).toHaveText(
    "Hello, collin",
  );
  await expect(server).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Name", { exact: true }).fill("Test visitor");
  await page.getByRole("button", { name: "Update greeting" }).click();
  await expect(page.getByTestId("fixture-greeting")).toHaveText(
    "Hello, Test visitor",
  );
  await expect(page).toHaveURL(/name=Test\+visitor/);
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
      await expect(page.getByTestId("fixture-nav")).toBeHidden();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("fixture-nav")).toBeVisible();
      expect(
        await page.getByTestId("fixture-nav").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= element.ownerDocument.documentElement.clientWidth
          );
        }),
      ).toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("fixture-nav")).toBeHidden();
    }
  } finally {
    await context.close();
  }
});

test("static pages, assets and scoped client scripts work without invoking the function", async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-bascik-handler"]).toBeUndefined();
  await expect(page.getByTestId("fixture-static")).toBeVisible();
  await expect(page.getByTestId("fixture-counter")).toHaveCount(0);
  const interactive = await page.goto("/static");
  expect(interactive?.headers()["x-bascik-handler"]).toBeUndefined();
  const counters = page.getByTestId("fixture-counter");
  await counters.first().getByTestId("fixture-counter-increment").click();
  await expect(
    counters.first().getByTestId("fixture-counter-value"),
  ).toHaveText("1");
  await expect(counters.last().getByTestId("fixture-counter-value")).toHaveText(
    "0",
  );
  const asset = await request.get("/asset.txt");
  expect(await asset.text()).toBe("Netlify adapter static asset\n");
  expect(asset.headers()["x-bascik-handler"]).toBeUndefined();
  expect(browserErrors).toEqual([]);
});

test("static and dynamic security headers are present once, with CSP", async ({
  request,
}) => {
  const staticResponse = await request.get("/");
  const dynamicResponse = await request.get("/server");
  for (const name of [
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
  ]) {
    const value = staticResponse.headers()[name];
    expect(value, name).toBeTruthy();
    expect(value, name).toBe(dynamicResponse.headers()[name]);
    expect(value, name).not.toContain(",");
  }
  for (const response of [staticResponse, dynamicResponse]) {
    expect(response.headers()["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.headers()["content-security-policy"]).not.toContain(
      "unsafe-inline",
    );
  }
});

test("server scripts render escaped values and every page alias", async ({
  page,
  request,
}) => {
  const name = '<b data-testid="injected">Books & "Notes"</b>';
  const response = await page.goto(`/server?name=${encodeURIComponent(name)}`);
  expect(response?.headers()["x-bascik-handler"]).toBe("bascik-pages");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByTestId("fixture-greeting")).toContainText(name);
  await expect(page.getByTestId("fixture-platform")).toHaveText("netlify");
  await expect(page.getByTestId("injected")).toHaveCount(0);
  for (const path of ["/server/", "/server.html"]) {
    expect((await request.get(path)).headers()["x-bascik-handler"]).toBe(
      "bascik-pages",
    );
  }
  await page.goto("/server?user=Legacy+visitor&role=Designer");
  await expect(page.getByTestId("fixture-server-greeting")).toContainText(
    "Legacy visitor",
  );
  await expect(page.getByTestId("fixture-server-greeting")).toContainText(
    "Designer",
  );
  const head = await request.head("/server");
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  const post = await request.post("/server");
  expect(post.status()).toBe(405);
  expect(post.headers()["allow"]).toBe("GET, HEAD");
});

test("HTML streaming swaps three reserved skeleton panels without layout shift and without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    const name = '<b data-testid="injected">Books & "Notes"</b>';
    await page.goto(`/stream?name=${encodeURIComponent(name)}&delay=1500`, {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("fixture-stream-shell")).toBeVisible();
    const skeletons = [
      page.getByTestId("fixture-stream-skeleton"),
      page.getByTestId("fixture-stream-skeleton-2"),
      page.getByTestId("fixture-stream-skeleton-3"),
    ];
    for (const skeleton of skeletons) await expect(skeleton).toBeVisible();
    const placeholder = await skeletons[0].boundingBox();
    const footer = page.getByTestId("fixture-footer");
    await expect(footer).toBeVisible();
    await expect(page.getByTestId("fixture-stream-greeting")).toContainText(
      name,
    );
    await expect(page.getByTestId("injected")).toHaveCount(0);
    await expect(
      footer.getByRole("link", { name: "Back to bascik.dev" }),
    ).toHaveAttribute("href", "https://bascik.dev");
    const results = [
      page.getByTestId("fixture-stream-result"),
      page.getByTestId("fixture-stream-result-2"),
      page.getByTestId("fixture-stream-result-3"),
    ];
    expect(await results[0].count()).toBe(0);
    await expect(results[0]).toBeVisible();
    await expect(skeletons[0]).toBeHidden();
    const result = await results[0].boundingBox();
    expect(Math.abs((result?.x ?? 0) - (placeholder?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((result?.y ?? 0) - (placeholder?.y ?? 0))).toBeLessThan(2);
    expect(
      Math.abs((result?.width ?? 0) - (placeholder?.width ?? 0)),
    ).toBeLessThan(2);
    expect(
      Math.abs((result?.height ?? 0) - (placeholder?.height ?? 0)),
    ).toBeLessThan(2);
    for (let index = 1; index < results.length; index += 1) {
      await expect(results[index]).toBeVisible();
      await expect(skeletons[index]).toBeHidden();
    }
    await expect(page.getByTestId("fixture-stream-server")).toBeVisible();
    expect(
      await footer.evaluate((element) => {
        const main = element.ownerDocument.querySelector("main")!;
        return (
          element.getBoundingClientRect().top >=
          main.getBoundingClientRect().bottom
        );
      }),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/stream?delay=1500", { waitUntil: "commit" });
    await expect(page.getByTestId("fixture-stream-skeleton-3")).toHaveCSS(
      "animation-name",
      "none",
    );
  } finally {
    await context.close();
  }
});

test("stream append and mixed execution progressively render their canonical content", async ({
  browser,
  baseURL,
  page,
}) => {
  await page.goto("/stream-append?name=collin&delay=0");
  await expect(page.getByTestId("cf-append-greeting")).toContainText(
    "Welcome back, collin",
  );
  await expect(page.getByRole("article")).toHaveCount(3);

  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const noScriptPage = await context.newPage();
    await noScriptPage.goto("/mixed?delay=0", { waitUntil: "commit" });
    await expect(noScriptPage.getByText("Public Visitor")).toBeVisible();
    await expect(noScriptPage.getByTestId("cf-mixed-footer")).toBeVisible();
    await expect(
      noScriptPage.getByText("Phase 3 Stream Chunk Resolved"),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("request-time components keep props, slots, nested scripts and scoped styles", async ({
  page,
}) => {
  const response = await page.goto(
    "/components?names=Refactoring%20the%20Monolith,Shipping%20Small%20Changes",
  );
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Server-rendered cards" }),
  ).toBeVisible();
  await expect(page.getByTestId("fixture-card")).toHaveCount(2);
  await expect(page.getByTestId("fixture-card-name")).toHaveText([
    "Refactoring the Monolith",
    "Shipping Small Changes",
  ]);
  await expect(page.getByTestId("fixture-card-slot")).toHaveText([
    "Request-time slot",
    "Request-time slot",
  ]);
  await expect(page.getByTestId("fixture-card-stock").first()).toContainText(
    "/components",
  );
  await expect(page.getByTestId("fixture-card").first()).toHaveCSS(
    "border-top-color",
    "rgba(211, 255, 141, 0.22)",
  );
  expect(await page.content()).not.toContain("<fixture-card");
  await expect(page.locator("style")).toHaveCount(1);
  const hostileName = '<img src=x onerror="alert(1)">';
  await page.goto(`/components?names=${encodeURIComponent(hostileName)}`);
  await expect(page.getByTestId("fixture-card-name")).toHaveText(hostileName);
  await expect(page.getByTestId("fixture-card").locator("img")).toHaveCount(0);
});

test("canonical catalogs render request-time and streamed book cards", async ({
  page,
}) => {
  await page.goto("/catalog?q=monolith");
  const results = page.getByTestId("catalog-results");
  await expect(results.getByTestId("book-card")).toHaveCount(1);
  await expect(results.getByTestId("book-card-title")).toHaveText(
    "Refactoring the Monolith",
  );
  await expect(
    page.getByTestId("catalog-live").getByTestId("book-card-live"),
  ).toHaveCount(1);
  await expect(page.getByTestId("catalog-live")).toContainText(
    "/catalog at request time",
  );
  await page.goto("/catalog?q=nothing-matches");
  await expect(page.getByTestId("catalog-empty")).toBeVisible();
  await expect(page.getByTestId("catalog-empty")).toContainText(
    "nothing-matches",
  );

  await page.goto("/catalog-stream?delay=0");
  const streamed = page.getByTestId("catalog-stream-grid");
  await expect(streamed.getByTestId("book-card")).toHaveCount(5);
  await expect(streamed.getByTestId("book-card-title")).toHaveText([
    "Practical Type Systems",
    "Testing at the Edges",
    "Refactoring the Monolith",
    "Shipping Small Changes",
    "Pairing & Code Review",
  ]);
});

test("API routes dispatch methods, parameters and catch-all precedence", async ({
  request,
}) => {
  expect(await (await request.get("/api/ping")).json()).toEqual({
    pong: true,
    platform: "netlify",
  });
  expect(await (await request.get("/api/echo")).json()).toEqual({
    fixture: "netlify",
  });
  const post = await request.post("/api/echo", {
    data: "refactoring-the-monolith",
  });
  expect(post.status()).toBe(201);
  expect(post.headers()["x-fixture"]).toBe("echo");
  expect(await post.json()).toEqual({ body: "refactoring-the-monolith" });
  const options = await request.fetch("/api/echo", { method: "OPTIONS" });
  expect(options.status()).toBe(204);
  expect(options.headers()["allow"]).toContain("POST");
  expect((await request.delete("/api/echo")).status()).toBe(405);
  expect(await (await request.get("/api/items/42")).json()).toEqual({
    id: "42",
  });
  expect(await (await request.get("/api/files/a/b.txt")).json()).toEqual({
    route: "catch-all",
    segments: ["a", "b.txt"],
  });
  expect(await (await request.get("/api/files/latest")).json()).toEqual({
    route: "static",
  });
});

test("Netlify context and native functions coexist with Bascik API routes on the same Node runtime", async ({
  request,
}) => {
  const response = await request.get("/api/context");
  expect(response.headers()["x-bascik-handler"]).toBe("bascik-pages");
  const context = await response.json();
  // Netlify Dev runs the functions on the machine's Node (the `.nvmrc`
  // version locally and in CI); the hosted project pins NODE_VERSION in
  // netlify.toml. Either way both handlers must see one runtime at or above
  // the published floor.
  expect(context).toEqual({
    platform: "netlify",
    hasCookies: true,
    hasWaitUntil: true,
    nodeMajor: expect.any(Number),
  });
  expect(context.nodeMajor).toBeGreaterThanOrEqual(24);
  const native = await request.get("/native-check");
  expect(await native.json()).toEqual({
    native: true,
    nodeMajor: context.nodeMajor,
  });
  expect(native.headers()["x-bascik-handler"]).toBeUndefined();
});

test("Netlify runtime cookie writes survive the adapter and stay private", async ({
  request,
  baseURL,
}) => {
  const response = await request.post("/api/cookie", {
    headers: { origin: new URL(baseURL!).origin },
    data: {},
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["set-cookie"]).toContain(
    "bascik_fixture=refactoring-the-monolith",
  );
  expect(response.headers()["set-cookie"].toLowerCase()).toContain("httponly");
  if (new URL(baseURL!).protocol === "https:") {
    expect(response.headers()["set-cookie"].toLowerCase()).toContain("secure");
  }
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await (await request.get("/api/cookie")).json()).toEqual({
    value: "refactoring-the-monolith",
  });
});

test("foreign origins cannot write the fixture cookie", async ({ request }) => {
  test.skip(
    !process.env.NETLIFY_ADAPTER_TEST_URL,
    "Netlify Dev 27.14.2 retries function 403s as static paths and returns 404; verify the exact status on Netlify.",
  );
  const denied = await request.post("/api/cookie", {
    headers: { origin: "https://other.example" },
    data: {},
  });
  expect(denied.status()).toBe(403);
  expect(denied.headers()["set-cookie"]).toBeUndefined();
  expect(await (await request.get("/api/cookie")).json()).toEqual({
    value: null,
  });
});

test("server errors, API errors and timeouts are generic, not leaked stacks", async ({
  page,
  request,
}) => {
  const landing = await page.goto("/errors");
  expect(landing?.status()).toBe(200);
  for (const [href, label] of [
    ["/failure", "Server-rendered page failure (500)"],
    ["/stream-failure", "Stream failure (200)"],
    ["/timeout", "Server script timeout (500)"],
    ["/api/failure", "API route failure (500)"],
  ]) {
    await expect(page.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      href,
    );
  }
  for (const path of ["/failure", "/api/failure", "/timeout"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(500);
    expect(response.headers()["x-bascik-handler"], path).toBe("bascik-pages");
    const text = await response.text();
    expect(text).not.toContain("fixture-server-failure");
    expect(text).not.toContain("fixture-api-failure");
    expect(text).not.toContain("at file:");
  }
});

test("stream errors leave a complete shell, and unknown or private paths return 404", async ({
  page,
  request,
}) => {
  const response = await page.goto("/stream-failure");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("fixture-stream-shell")).toHaveText(
    "The shell survives.",
  );
  await expect(page.getByTestId("fixture-footer")).toBeVisible();
  expect(await page.content()).not.toContain("Error: fixture-stream-failure");
  for (const path of ["/not-a-page", "/.env", "/bascik.config.ts"]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});
