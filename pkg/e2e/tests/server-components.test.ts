/**
 * E2E for request-time component rendering (prompt 157, "Jack's gap"): a
 * `data-bascik-server` or `data-bascik-stream` script that returns a component
 * tag gets that tag expanded with the same power as page markup, on Node, in
 * dev and under `bascik --server` (HTTP/1.1 and HTTP/2).
 *
 * Fixtures:
 *   - src/components/server-card/                 props, named + default slot,
 *                                                  scoped CSS, a nested server
 *                                                  script, a client script
 *   - src/pages/server-components.html             three cards from server
 *                                                  scripts (?title=), misuse
 *                                                  output, an escaped usage in
 *                                                  <pre><code>
 *   - src/pages/server-components-stream.html      two cards from stream
 *                                                  scripts (?delay=)
 *   - src/pages/server-components-pre.html         a card returned inside a
 *                                                  <pre>, whose spacing must
 *                                                  survive minify.html
 *
 * No page uses `<server-card>` in its own markup, so every instance observed
 * here was rendered at request time. The static harness serves files and
 * never runs server scripts, so playwright.config.ts ignores this suite; it
 * runs in dev and under `--server` only, and asserts there that no request
 * marker or staged placeholder ever reaches the client.
 *
 * Rules: data-testid via getByTestId only; no waitForTimeout.
 */
import { test, expect, type Page } from "@playwright/test";

const CARD_CLASS = "bascik__server-card__card";
const STOCK_CLASS = "bascik__server-card__stock";
/**
 * A scoped id keeps the build's grammar, `bascik__<component>__<id>__<name>`,
 * with a request-time instance id of `r` + 7 hex in the id slot, a shape no
 * build id (8 hex) takes (D4).
 */
const REQUEST_SCOPED_ID = /^bascik__server-card__r[0-9a-f]{7}__card$/;

const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
};

/** Every `<style>` block of `html` whose text mentions `needle`. */
const styleBlocksContaining = (html: string, needle: string): string[] =>
  [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .filter((m) => m[1].includes(needle))
    .map((m) => m[0]);

/** Index of the first rendered instance (`class="..."` or minified `class=...`). */
const firstInstanceIndex = (html: string): number =>
  html.search(new RegExp(`class="?${CARD_CLASS}(?:["\\s>])`));

/**
 * What the renderer splices or the server replaces, and must never leave in
 * a response: its request-local job markers and the build's staged
 * placeholders (both `type="text/bascik-server"` script elements).
 */
const expectNoMarkers = (html: string) => {
  expect(html).not.toContain("data-bascik-job");
  expect(html).not.toContain("data-bascik-server-id");
  expect(html).not.toContain("text/bascik-server");
};

test.describe("request-time components: nothing internal reaches the client", () => {
  for (const route of [
    "/server-components",
    "/server-components-stream?delay=0",
    "/server-components-pre",
  ]) {
    test(`${route}: no job marker or staged placeholder in the response`, async ({
      request,
    }) => {
      const response = await request.get(route);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toMatch(new RegExp(`class="?${CARD_CLASS}`));
      expectNoMarkers(html);
    });
  }
});

test.describe("request-time components: minify.html", () => {
  test("a card returned inside a <pre> keeps its slot text's spacing", async ({
    page,
    request,
  }) => {
    const html = await (await request.get("/server-components-pre")).text();
    expect(html).toContain("if  (x)\n    next");
    await page.goto("/server-components-pre");
    const pre = page.getByTestId("scp-pre");
    await expect(pre.locator(`.${CARD_CLASS}`)).toHaveCount(1);
    expect(await page.getByTestId("scp-code").textContent()).toBe(
      "if  (x)\n    next",
    );
    await expect(pre.getByTestId("server-card-stock")).toHaveText(
      "stock for /server-components-pre",
    );
  });
});

test.describe("request-time components: server scripts", () => {
  test("a server script returning <server-card> is expanded: no literal tag reaches the browser", async ({
    request,
  }) => {
    const html = await (await request.get("/server-components")).text();
    // The literal usage tag is what the fixture scripts return; the response
    // must carry the rendered instance instead. (The misuse job's attribute
    // value `title="<server-card>"` is text and legitimately survives.)
    expect(html).not.toContain("<server-card data-bascik-prop-title");
    expect(html).not.toContain("</server-card>");
    expect(html).toMatch(new RegExp(`class="?${CARD_CLASS}`));
  });

  test("props, named slot, default slot and the nested job render per instance with the scoped class", async ({
    page,
  }) => {
    const consoleErrors = collectConsoleErrors(page);
    await page.goto("/server-components?title=Alpha%20%26%20Co");

    const server = page.getByTestId("sc-server");
    const card = server.locator(`.${CARD_CLASS}`);
    await expect(card).toHaveCount(1);
    // The prop was escaped by the author and injected into the template.
    await expect(server.getByTestId("server-card-title")).toHaveText(
      "Alpha & Co",
    );
    // Named slot content replaced the fallback; default slot content too.
    await expect(server.getByTestId("sc-badge")).toHaveText("new");
    await expect(server.getByTestId("server-card-default-badge")).toHaveCount(
      0,
    );
    await expect(server.getByTestId("sc-body")).toHaveText("body from server");
    await expect(server.getByTestId("server-card-default-body")).toHaveCount(0);
    // The nested server script ran with the current request and its output
    // received the component's element classes.
    const stock = server.getByTestId("server-card-stock");
    await expect(stock).toHaveText("stock for /server-components");
    await expect(stock).toHaveClass(STOCK_CLASS);

    // Two instances from one job keep their fallbacks where no slot was given.
    const list = page.getByTestId("sc-list");
    await expect(list.locator(`.${CARD_CLASS}`)).toHaveCount(2);
    await expect(list.getByTestId("server-card-title")).toHaveText([
      "Beta",
      "Gamma",
    ]);
    await expect(list.getByTestId("server-card-default-badge")).toHaveText([
      "no badge",
      "no badge",
    ]);
    await expect(list.getByTestId("sc-list-body")).toHaveText([
      "Beta body",
      "Gamma body",
    ]);
    await expect(list.getByTestId("server-card-stock")).toHaveCount(2);

    // The component CSS applies to the request-rendered instance.
    await expect(card).toHaveCSS("border-top-color", "rgb(22, 101, 52)");
    expect(consoleErrors).toHaveLength(0);
  });

  test("each instance gets a distinct request-time id and runs the client script once", async ({
    page,
  }) => {
    await page.goto("/server-components");
    const ids = await page
      .locator(`.${CARD_CLASS}`)
      .evaluateAll((cards) => cards.map((card) => card.id));
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(REQUEST_SCOPED_ID);
    expect(new Set(ids).size).toBe(3);
    // The client script inside the template ran in place, once per instance.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __serverCardScripts?: number })
            .__serverCardScripts,
      ),
    ).toBe(3);
  });

  test("the component's style block is emitted exactly once per response, before the first instance", async ({
    request,
  }) => {
    const html = await (await request.get("/server-components")).text();
    const blocks = styleBlocksContaining(html, CARD_CLASS);
    expect(blocks).toHaveLength(1);
    // Not used in page markup, so nothing was hoisted to <head> at build time;
    // the one block is the request-time one, in the body ahead of the card.
    const headEnd = html.indexOf("</head>");
    const styleIndex = html.indexOf(blocks[0]);
    expect(styleIndex).toBeGreaterThan(headEnd);
    expect(styleIndex).toBeLessThan(firstInstanceIndex(html));
  });

  test("HEAD content-length equals the GET body length", async ({
    request,
  }) => {
    const head = await request.head("/server-components");
    expect(head.status()).toBe(200);
    expect((await head.body()).length).toBe(0);
    const get = await request.get("/server-components");
    expect(get.status()).toBe(200);
    expect(get.headers()["content-encoding"]).toBeUndefined();
    const body = await get.body();
    expect(Number(head.headers()["content-length"])).toBe(body.length);
    expect(Number(get.headers()["content-length"])).toBe(body.length);
  });

  test("an escaped usage inside <pre><code> in page markup is unchanged", async ({
    page,
    request,
  }) => {
    const html = await (await request.get("/server-components")).text();
    expect(html).toContain(
      '&lt;server-card data-bascik-prop-title="Docs"&gt;&lt;/server-card&gt;',
    );
    await page.goto("/server-components");
    await expect(page.getByTestId("sc-code")).toHaveText(
      '<server-card data-bascik-prop-title="Docs"></server-card>',
    );
    // Three instances from scripts, none from the page's own markup.
    await expect(page.locator(`.${CARD_CLASS}`)).toHaveCount(3);
  });

  test("misuse: a typo'd tag, an escaped tag and a tag inside an attribute value pass through verbatim", async ({
    page,
    request,
  }) => {
    const html = await (await request.get("/server-components")).text();
    // No component is named server-crad: the author's markup is kept as is.
    expect(html).toContain("<server-crad");
    expect(html).toContain("</server-crad>");

    await page.goto("/server-components");
    const misuse = page.getByTestId("sc-misuse");
    await expect(misuse.locator("server-crad")).toHaveText(
      "typo stays verbatim",
    );
    await expect(misuse.getByTestId("sc-escaped")).toHaveText(
      "<server-card> stays text",
    );
    await expect(misuse.getByTestId("sc-attr")).toHaveAttribute(
      "title",
      "<server-card>",
    );
    await expect(misuse.locator(`.${CARD_CLASS}`)).toHaveCount(0);
  });
});

test.describe("request-time components: stream scripts", () => {
  test("a stream script returning <server-card> is expanded and the shell paints first", async ({
    page,
    request,
  }) => {
    const html = await (
      await request.get("/server-components-stream?delay=0")
    ).text();
    expect(html).not.toContain("<server-card data-bascik-prop-title");
    expect(html).not.toContain("</server-card>");

    const consoleErrors = collectConsoleErrors(page);
    await page.goto("/server-components-stream?delay=800", {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("scs-skeleton")).toBeVisible();
    expect(await page.locator(`.${CARD_CLASS}`).count()).toBe(0);

    const cards = page.locator(`.${CARD_CLASS}`);
    await expect(cards).toHaveCount(2);
    await expect(page.getByTestId("server-card-title")).toHaveText([
      "Stream one",
      "Stream two",
    ]);
    await expect(page.getByTestId("scs-badge")).toHaveText("first");
    await expect(page.getByTestId("scs-body-1")).toHaveText("stream body one");
    await expect(page.getByTestId("scs-body-2")).toHaveText("stream body two");
    await expect(page.getByTestId("server-card-stock")).toHaveText([
      "stock for /server-components-stream",
      "stock for /server-components-stream",
    ]);
    await expect(page.getByTestId("scs-footer")).toHaveText("footer");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __serverCardScripts?: number })
            .__serverCardScripts,
      ),
    ).toBe(2);
    expect(consoleErrors).toHaveLength(0);
  });

  test("one style block lands before the first card in document order even when the first job finishes last", async ({
    request,
  }) => {
    // The first job waits, the second returns at once: completion order is
    // reversed, document order decides where the single block goes.
    const html = await (
      await request.get("/server-components-stream?delay=300")
    ).text();
    const blocks = styleBlocksContaining(html, CARD_CLASS);
    expect(blocks).toHaveLength(1);
    expect(html.indexOf(blocks[0])).toBeLessThan(firstInstanceIndex(html));
    // `minify.html` may drop the attribute quotes under `--server`.
    expect(html.search(/data-testid="?scs-body-1/)).toBeLessThan(
      html.search(/data-testid="?scs-body-2/),
    );
  });
});
