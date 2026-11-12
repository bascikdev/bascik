/**
 * E2E for `data-bascik-stream` (prompts 65-68): a real browser must PAINT the
 * author's placeholder before the slow script resolves, over a real HTTP/1.1
 * chunked body and a real HTTP/2 DATA-frame sequence, and on the dev server.
 *
 * Fixtures:
 *   - src/pages/server-scripts-stream-test.html       one stream script (?delay=)
 *                                                      plus one server script (?second=)
 *   - src/components/stream-dashboard/                  layout with two stream cards
 *   - src/pages/server-scripts-dashboard-test.html      uses it (?sub= ?bill=)
 *   - src/components/stream-rows/                       one stream script that yields
 *                                                      rows (?rows= ?gap= ?fail=)
 *   - src/pages/server-scripts-stream-rows-test.html    uses it, plus a script that
 *                                                      yields <server-card> tags
 *                                                      (?cards= ?cardgap=) and a
 *                                                      server script that yields
 *
 * Runs under playwright.dev.config.ts, playwright.server.config.ts, and
 * playwright.server-http2.config.ts. Ignored under playwright.config.ts: the
 * static harness serves files and cannot execute server scripts, so it can
 * only fail for the wrong reason.
 *
 * Rules: data-testid via getByTestId only; no waitForTimeout. Ordering is
 * observed with waitUntil: 'commit' followed by locator expectations and
 * synchronous count() checks.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const streamFixturePath = join(
  e2eDir,
  "src/pages/server-scripts-stream-test.html",
);

const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
};

const isDevServer = async (page: Page): Promise<boolean> => {
  const res = await page.request.get("/server-scripts-stream-test");
  return (await res.text()).includes("bascik-live-reload");
};

test.describe("data-bascik-stream: paint order in a real browser", () => {
  test("skeleton paints before the slow script resolves", async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    const t0 = Date.now();
    await page.goto("/server-scripts-stream-test?delay=1500", {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("stream-skeleton")).toBeVisible();
    const tSkeleton = Date.now() - t0;
    expect(await page.getByTestId("stream-result").count()).toBe(0);

    await expect(page.getByTestId("stream-result")).toBeVisible();
    const tResult = Date.now() - t0;

    expect(tSkeleton).toBeLessThan(1000);
    expect(tResult).toBeGreaterThanOrEqual(1500);
    await expect(page.getByTestId("stream-second")).toHaveText("second");
    await expect(page.getByTestId("stream-footer")).toHaveText("footer");
    expect(consoleErrors).toHaveLength(0);
  });

  test("server script output on a mixed page gates the first byte and lands in source order", async ({
    page,
  }) => {
    // The `server` script resolved before commit, but its BYTES come after
    // the stream tag in source order, so while the skeleton is visible and
    // the stream result is absent, neither `second` nor the footer is in the
    // DOM yet.
    await page.goto("/server-scripts-stream-test?delay=1500", {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("stream-skeleton")).toBeVisible();
    expect(await page.getByTestId("stream-result").count()).toBe(0);
    expect(await page.getByTestId("stream-second").count()).toBe(0);
    expect(await page.getByTestId("stream-footer").count()).toBe(0);
    await expect(page.getByTestId("stream-result")).toBeVisible();
    await expect(page.getByTestId("stream-second")).toBeVisible();
    await expect(page.getByTestId("stream-footer")).toBeVisible();

    // A slow `server` script delays the FIRST chunk: commit waits for every
    // server job, so the skeleton cannot appear before the server delay.
    const t0 = Date.now();
    await page.goto("/server-scripts-stream-test?delay=0&second=800", {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("stream-skeleton")).toBeVisible();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
  });

  test("document order is preserved regardless of resolution order", async ({
    page,
  }) => {
    await page.goto("/server-scripts-stream-test?delay=300");
    await expect(page.getByTestId("stream-result")).toBeVisible();
    const text = await page.evaluate(() => document.body.innerText);
    const order = ["header", "account loaded", "second", "footer"].map((s) =>
      text.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("data-bascik-server pages are still buffered; stream pages have no content-length", async ({
    request,
  }) => {
    const buffered = await request.get("/server-scripts-test");
    expect(buffered.status()).toBe(200);
    expect(buffered.headers()["content-length"]).toBeDefined();

    const streamed = await request.get("/server-scripts-stream-test?delay=50");
    expect(streamed.status()).toBe(200);
    expect(streamed.headers()["content-length"]).toBeUndefined();
    expect(streamed.headers()["cache-control"]).toBe("private, no-store");
    expect(streamed.headers()["etag"]).toBeUndefined();
    expect(streamed.headers()["content-encoding"]).toBeUndefined();
  });

  test("fast path renders everything with delay=0", async ({ page }) => {
    await page.goto("/server-scripts-stream-test");
    for (const id of [
      "stream-header",
      "stream-result",
      "stream-second",
      "stream-footer",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test("HEAD returns 200 with content-length and no body", async ({
    request,
  }) => {
    const res = await request.head("/server-scripts-stream-test?delay=300");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-length"]).toBeDefined();
    expect((await res.body()).length).toBe(0);
  });

  test("navigating away mid-stream leaves the server healthy", async ({
    page,
    request,
  }) => {
    await page.goto("/server-scripts-stream-test?delay=3000", {
      waitUntil: "commit",
    });
    await expect(page.getByTestId("stream-skeleton")).toBeVisible();
    await page.goto("/scope-test");
    await expect(page.locator("body")).toBeVisible();
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
  });
});

test.describe("data-bascik-stream: dashboard layout", () => {
  test("whole layout paints while two cards load, in visual position, with zero layout shift", async ({
    page,
  }) => {
    const consoleErrors = collectConsoleErrors(page);
    // Delays are long enough that browser cold-start cannot mask the order:
    // the shell must be visible while BOTH results are still absent. That
    // absence is the proof (a buffered response would deliver the results in
    // the same chunk as the shell); the elapsed time is recorded as evidence
    // only, since first-navigation cost varies by machine.
    // Raw TCP timeline for this URL (recorded while writing the test): chunk 1
    // (nav, usage, footer, subscription placeholder) at 7ms, the subscription
    // result PLUS the billing card at 2010ms, the billing result at 3209ms.
    // Source order is delivery order: the billing card sits after the
    // subscription script in source, so its placeholder cannot arrive before
    // that script resolves. The clock starts at response commit.
    await page.goto("/server-scripts-dashboard-test?sub=2000&bill=3200", {
      waitUntil: "commit",
    });
    const tCommit = Date.now();
    for (const id of [
      "dash-footer",
      "dash-nav",
      "dash-usage",
      "dash-sub-pending",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    const tShell = Date.now() - tCommit;
    expect(tShell).toBeLessThan(2000);
    expect(await page.getByTestId("dash-sub-result").count()).toBe(0);
    expect(await page.getByTestId("dash-bill").count()).toBe(0);

    const box = async (id: string) =>
      (await page.getByTestId(id).boundingBox())!;
    const before = {
      sub: await box("dash-sub"),
      usage: await box("dash-usage"),
      footer: await box("dash-footer"),
    };
    // Visual order follows the author's grid (sub above usage above footer),
    // not source order (nav, usage, footer, sub).
    expect(before.sub.y).toBeLessThan(before.usage.y);
    expect(before.usage.y).toBeLessThan(before.footer.y);

    // First card fills; the second card (placeholder) arrives in the same
    // chunk and is still pending.
    await expect(page.getByTestId("dash-sub-result")).toBeVisible();
    await expect(page.getByTestId("dash-bill-pending")).toBeVisible();
    expect(await page.getByTestId("dash-bill-result").count()).toBe(0);
    // Author :has() rule hides the first placeholder (still in the DOM). This
    // is what proves the class in the returned markup was scoped to match the
    // component CSS; under identifier minification a mismatch would leave the
    // placeholder visible.
    await expect(page.getByTestId("dash-sub-pending")).toBeHidden();
    expect(await page.getByTestId("dash-sub-pending").count()).toBe(1);
    const billBox = await box("dash-bill");
    expect(before.usage.y).toBeLessThan(billBox.y);
    expect(billBox.y).toBeLessThan((await box("dash-footer")).y);

    await expect(page.getByTestId("dash-bill-result")).toBeVisible();
    await expect(page.getByTestId("dash-bill-pending")).toBeHidden();

    // Reserved boxes: the static blocks did not move when either result landed.
    const after = {
      usage: await box("dash-usage"),
      footer: await box("dash-footer"),
    };
    expect(Math.abs(after.usage.y - before.usage.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.footer.y - before.footer.y)).toBeLessThanOrEqual(1);
    expect(consoleErrors).toHaveLength(0);
  });
});

test.describe("data-bascik-stream: a script that yields", () => {
  const ROWS = "/server-scripts-stream-rows-test";

  /**
   * Fetch `url` in the page and record each read of the body with the time
   * it arrived, so chunk boundaries and pacing are observed over the real
   * transport (HTTP/1.1 chunks, HTTP/2 DATA frames).
   */
  const readChunks = (page: Page, url: string) =>
    page.evaluate(async (target) => {
      const started = performance.now();
      const response = await fetch(target);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: { at: number; text: string }[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push({
          at: performance.now() - started,
          text: decoder.decode(value, { stream: true }),
        });
      }
      return { status: response.status, chunks };
    }, url);

  /** When the read that carried `needle` arrived. */
  const arrival = (
    chunks: { at: number; text: string }[],
    needle: string,
  ): number => {
    const found = chunks.find((chunk) => chunk.text.includes(needle));
    if (!found) throw new Error(`no chunk carried ${needle}`);
    return found.at;
  };

  test("rows are appended one at a time, where the script tag was", async ({
    page,
  }) => {
    const consoleErrors = collectConsoleErrors(page);
    await page.goto(`${ROWS}?rows=4&gap=600`, { waitUntil: "commit" });
    const rows = page.getByTestId("rows-row");
    // The first row is in the document while the later ones do not exist
    // yet: a buffered or single-flush response would deliver all four at once.
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThan(4);
    expect(await page.getByTestId("rows-done").count()).toBe(0);

    await expect(rows).toHaveText(["Order 1", "Order 2", "Order 3", "Order 4"]);
    // Appended inside the list the script tag was in, in yield order.
    await expect(
      page.getByTestId("rows-list").getByTestId("rows-row"),
    ).toHaveCount(4);
    expect(
      await rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-n")),
      ),
    ).toEqual(["1", "2", "3", "4"]);
    await expect(page.getByTestId("rows-after")).toHaveText("after");
    expect(consoleErrors).toHaveLength(0);
  });

  test("each yielded row is its own chunk on the wire, paced by the script", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    const { status, chunks } = await readChunks(page, `${ROWS}?rows=4&gap=400`);
    expect(status).toBe(200);
    const first = arrival(chunks, ">Order 1<");
    const last = arrival(chunks, ">Order 4<");
    // Three gaps of 400ms separate the first row from the last. A response
    // that held the rows back would deliver them in one read.
    expect(last - first).toBeGreaterThanOrEqual(1000);
    expect(arrival(chunks, ">Order 2<")).toBeGreaterThan(first);
    // The static shell (heading, footer, status line, skeletons) left before
    // the first row was produced.
    expect(arrival(chunks, 'data-testid="rows-foot"')).toBeLessThan(first);
    expect(arrival(chunks, 'data-testid="rows-skeletons"')).toBeLessThan(first);
  });

  test("content below the list paints first, and nothing moves as rows arrive", async ({
    page,
  }) => {
    await page.goto(`${ROWS}?rows=4&gap=700`, { waitUntil: "commit" });
    // The footer is below the card on screen but ahead of it in source, so
    // it is visible while no row exists.
    for (const id of ["rows-head", "rows-foot", "rows-pending"])
      await expect(page.getByTestId(id)).toBeVisible();
    expect(await page.getByTestId("rows-row").count()).toBe(0);

    const top = async (id: string) =>
      (await page.getByTestId(id).boundingBox())!.y;
    const before = {
      card: await top("rows-card"),
      foot: await top("rows-foot"),
    };
    // Visual order follows the author's grid, not source order.
    expect(await top("rows-head")).toBeLessThan(before.card);
    expect(before.card).toBeLessThan(before.foot);

    await expect(page.getByTestId("rows-row")).toHaveCount(4);
    await expect(page.getByTestId("rows-done")).toHaveCount(1);
    expect(
      Math.abs((await top("rows-foot")) - before.foot),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((await top("rows-card")) - before.card),
    ).toBeLessThanOrEqual(1);
  });

  test("the skeleton swap is author CSS: the status line hides at the first row and the skeleton list at the last yield", async ({
    page,
  }) => {
    await page.goto(`${ROWS}?rows=3&gap=700`, { waitUntil: "commit" });
    await expect(page.getByTestId("rows-pending")).toBeVisible();
    await expect(page.getByTestId("rows-skeletons")).toBeVisible();

    // First row: :has(.row) hides the status line (still in the DOM), which
    // proves the class in the yielded chunk was scoped like the component's
    // CSS. The skeleton rows stay until the script is done.
    await expect(page.getByTestId("rows-row").first()).toBeVisible();
    await expect(page.getByTestId("rows-pending")).toBeHidden();
    expect(await page.getByTestId("rows-pending").count()).toBe(1);
    expect(await page.getByTestId("rows-done").count()).toBe(0);
    await expect(page.getByTestId("rows-skeletons")).toBeVisible();

    // Each row lands on top of the skeleton row it replaces.
    const rowBox = (await page.getByTestId("rows-row").first().boundingBox())!;
    const skeletonBox = (await page
      .getByTestId("rows-skeletons")
      .boundingBox())!;
    expect(Math.abs(rowBox.y - skeletonBox.y)).toBeLessThanOrEqual(1);
    // And it is the row that is painted there, not the skeleton under it.
    // The skeleton rows pulse, so each is a stacking layer of its own; the
    // list of rows has its own layer above them, or it would flash with
    // the pulse.
    expect(
      await page
        .getByTestId("rows-row")
        .first()
        .evaluate((row) => {
          const box = row.getBoundingClientRect();
          const top = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return top !== null && row.contains(top);
        }),
    ).toBe(true);

    // Last yield: :has(.done) hides the skeleton rows that were left over
    // (four skeletons, three rows).
    await expect(page.getByTestId("rows-done")).toHaveCount(1);
    await expect(page.getByTestId("rows-skeletons")).toBeHidden();
    await expect(page.getByTestId("rows-row")).toHaveCount(3);
  });

  test("a failure part-way keeps the rows already sent and completes the page", async ({
    page,
  }) => {
    const response = await page.goto(`${ROWS}?rows=4&fail=3`);
    expect(response!.status()).toBe(200);
    await expect(page.getByTestId("rows-row")).toHaveText([
      "Order 1",
      "Order 2",
    ]);
    expect(await page.getByTestId("rows-done").count()).toBe(0);
    // Everything after the failed script still arrives.
    await expect(page.getByTestId("server-card-title")).toHaveCount(2);
    await expect(page.getByTestId("rows-after")).toHaveText("after");
    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);
  });

  test("component tags in each yielded chunk are rendered, with one stylesheet and no repeated id", async ({
    page,
  }) => {
    const html = await (await page.request.get(`${ROWS}?cards=3`)).text();
    // The literal usage tag is what the script yields; the response must
    // carry the rendered instances instead. (The page's own comment names
    // the tag, and the dev server keeps comments.)
    expect(html).not.toContain("<server-card data-bascik-prop-title");
    expect(html).not.toContain("</server-card>");

    await page.goto(`${ROWS}?cards=3&cardgap=300`, { waitUntil: "commit" });
    const cards = page.getByTestId("rows-cards");
    await expect(cards.getByTestId("server-card-title").first()).toBeVisible();
    await expect(cards.getByTestId("server-card-title")).toHaveText([
      "Card 1",
      "Card 2",
      "Card 3",
    ]);
    await expect(cards.getByTestId("rows-card-body")).toHaveText([
      "body 1",
      "body 2",
      "body 3",
    ]);
    // The component's own server script ran for the card of every chunk.
    await expect(cards.getByTestId("server-card-stock")).toHaveCount(3);
    // One stylesheet for the component, ahead of the first card.
    expect(await cards.locator("style").count()).toBe(1);
    const ids = await cards
      .getByTestId("server-card")
      .evaluateAll((items) => items.map((item) => item.id));
    expect(new Set(ids).size).toBe(3);
    // The client script ran once per card.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __serverCardScripts?: number })
            .__serverCardScripts,
      ),
    ).toBe(3);
  });

  test("a server script that yields is joined into the page", async ({
    page,
  }) => {
    await page.goto(ROWS);
    await expect(page.getByTestId("rows-joined")).toHaveText([
      "joined",
      "one",
      "two",
    ]);
  });

  test("HEAD is buffered: the yielded rows are joined for a content-length, and there is no body", async ({
    request,
  }) => {
    const head = await request.head(`${ROWS}?rows=3&gap=50`);
    expect(head.status()).toBe(200);
    expect(head.headers()["content-length"]).toBeDefined();
    expect((await head.body()).length).toBe(0);
    const get = await request.get(`${ROWS}?rows=3`);
    expect(get.headers()["content-length"]).toBeUndefined();
    expect(Number(head.headers()["content-length"])).toBe(
      (await get.body()).length,
    );
  });

  test("navigating away while rows are arriving leaves the server healthy", async ({
    page,
    request,
  }) => {
    await page.goto(`${ROWS}?rows=20&gap=500`, { waitUntil: "commit" });
    await expect(page.getByTestId("rows-row").first()).toBeVisible();
    await page.goto("/scope-test");
    await expect(page.locator("body")).toBeVisible();
    expect((await request.get("/api/health")).status()).toBe(200);
    // A fresh request still streams.
    await page.goto(`${ROWS}?rows=2`);
    await expect(page.getByTestId("rows-row")).toHaveCount(2);
  });
});

test.describe("data-bascik-stream: dev server edit round-trip", () => {
  let original: string;

  test.beforeAll(async () => {
    original = await readFile(streamFixturePath, "utf8");
  });

  test.afterEach(async () => {
    if ((await readFile(streamFixturePath, "utf8")) !== original) {
      await writeFile(streamFixturePath, original, "utf8");
    }
  });

  test("editing a stream script recomputes the plan and serves the new output", async ({
    page,
  }) => {
    test.skip(
      !(await isDevServer(page)),
      "only the dev server re-stores pages on edit",
    );
    await page.goto("/server-scripts-stream-test");
    await expect(page.getByTestId("stream-result")).toHaveText(
      "account loaded",
    );

    await writeFile(
      streamFixturePath,
      original.replace("account loaded", "account reloaded"),
      "utf8",
    );

    // The live-reload client reloads the page when the transpile finishes.
    await expect(page.getByTestId("stream-result")).toHaveText(
      "account reloaded",
      { timeout: 15000 },
    );
  });
});
