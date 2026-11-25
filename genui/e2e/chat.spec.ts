import { expect, test, type Page } from "@playwright/test";

/** True in the project that runs with the client runtime. */
const withScripts = (): boolean => test.info().project.name === "js";

/**
 * Wait for the reply's last chunk. With the client runtime the page is not
 * reloaded, so the previous reply's marker is still there for a moment: wait
 * for the runtime to say it is idle first.
 */
async function settled(page: Page): Promise<void> {
  if (withScripts()) {
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
  }
  await expect(page.getByTestId("turn-done")).toBeAttached();
}

/** Send from the composer and wait for the reply's last chunk. */
async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
  await settled(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("chat-sidebar-new").click();
  await expect(page.getByTestId("chat-welcome")).toBeVisible();
});

test("a reply renders catalog components with their scoped styles", async ({
  page,
}) => {
  await send(page, "Recommend a book");
  await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
  const cards = page.getByTestId("turn-live").getByTestId("book-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.first().getByTestId("book-card-title")).toHaveText(
    "Refactoring the Monolith",
  );
  await expect(cards.first().getByTestId("book-card-rating")).toHaveText("4.7");
  // Scoped CSS arrived with the stream: the card is a bordered grid.
  await expect(cards.first()).toHaveCSS("display", "grid");
  await expect(cards.first()).toHaveCSS("border-top-style", "solid");
  await expect(page.getByTestId("chat-welcome")).toBeHidden();
});

test("a generated button sends the next message", async ({ page }) => {
  await send(page, "Recommend a book");
  await page
    .getByTestId("ask-button-submit")
    .filter({ hasText: "Compare lengths" })
    .click();
  await settled(page);
  await expect(page.getByTestId("turn-user").last()).toHaveText(
    "Compare the page counts of every book",
  );
  await expect(
    page.getByTestId("turn-live").getByTestId("bar-row"),
  ).toHaveCount(4);
  // The first reply is now history, rendered from the stored model text.
  await expect(
    page.getByTestId("turn-assistant").getByTestId("book-card"),
  ).toHaveCount(3);
});

test("a mermaid fence arrives as a drawn diagram, live and from history", async ({
  page,
}) => {
  await send(page, "Show me a diagram of how you pick a book");
  const live = page.getByTestId("turn-live").getByTestId("diagram");
  await expect(live).toBeVisible();
  // Drawn on the server: the page runs no script, and the source is not shown.
  await expect(live.locator("svg")).toBeVisible();
  await expect(live).toContainText("Know your mood?");
  await expect(page.getByTestId("turn-live")).not.toContainText("flowchart TD");
  // The diagram takes its colors from the page, so nothing is fetched for it.
  await expect(live.locator("svg")).not.toHaveAttribute("style", /./);

  await page.reload();
  const stored = page.getByTestId("turn-assistant").getByTestId("diagram");
  await expect(stored).toContainText("Know your mood?");
});

test("a generated choice form and input form post their answers", async ({
  page,
}) => {
  await send(page, "Help me choose a book");
  const form = page.getByTestId("turn-live").getByTestId("choice-form");
  await form.getByText("Short enough for a weekend").click();
  await form.getByTestId("choice-form-submit").click();
  await settled(page);
  await expect(page.getByTestId("turn-user").last()).toHaveText("Mood: short");
  await expect(
    page.getByTestId("turn-live").getByTestId("book-card-title"),
  ).toHaveText("Shipping Small Changes");

  await send(page, "Add a book to my reading log");
  const fields = page.getByTestId("turn-live").getByTestId("text-field");
  await fields.getByLabel("Book").fill("Shipping Small Changes");
  await fields.getByLabel("Pages read").fill("42");
  await fields.getByLabel("One-line note").fill("Great so far");
  await page.getByTestId("input-form-submit").click();
  await settled(page);
  await expect(page.getByTestId("turn-user").last()).toHaveText(
    "Book: Shipping Small Changes\nPages read: 42\nNote: Great so far",
  );
});

test("markup in a message is shown as text and never becomes an element", async ({
  page,
}) => {
  const hostile = `<script>window.x=1</script> <admin-panel> <img src=x onerror=alert(1)> $& $1`;
  await send(page, `tell me ${hostile}`);
  await expect(page.getByTestId("turn-user")).toHaveText(`tell me ${hostile}`);
  // The scripted model echoes the message back; the echo is text too.
  await expect(page.getByTestId("turn-live")).toContainText(hostile);
  const thread = page.getByTestId("chat-thread");
  await expect(thread.locator("script, img, admin-panel")).toHaveCount(0);
  // Reloading renders the same reply from history, still as text.
  await page.reload();
  await expect(page.getByTestId("turn-assistant")).toContainText(hostile);
  await expect(thread.locator("script, img, admin-panel")).toHaveCount(0);
});

test("the docs app answers from the real docs and stays on its own page", async ({
  page,
}) => {
  await page.goto("/docs");
  await page.getByTestId("chat-sidebar-new").click();
  await send(page, "How do I stream rows from a slow source?");
  await expect(page).toHaveURL(/\/docs$/);
  const links = page.getByTestId("turn-live").getByTestId("doc-link");
  await expect(links.first()).toHaveAttribute(
    "href",
    /^https:\/\/bascik\.dev\/scripts\/stream/,
  );
  // A cited page opens in a new tab, so the conversation stays open.
  await expect(links.first()).toHaveAttribute("target", "_blank");
  await expect(links.first()).toHaveAttribute("rel", /noopener/);
  expect(await links.count()).toBeGreaterThan(2);
});

test("the data app runs SQL and renders a chart and a table", async ({
  page,
}) => {
  await page.goto("/data");
  await page.getByTestId("chat-sidebar-new").click();
  await send(page, "What are the top selling books?");
  const reply = page.getByTestId("turn-live");
  // The query is a tool part. It was sent twice, running and then done, and
  // CSS shows only the one that says how it ended.
  const query = reply.locator('.part[data-tool="run_sql"]');
  await expect(query).toHaveCount(2);
  await expect(query.first()).toHaveAttribute("data-state", "running");
  await expect(query.first()).toBeHidden();
  await expect(query.last()).toHaveAttribute("data-state", "done");
  await expect(query.last().getByTestId("tool-note")).toHaveText(
    "Querying the database",
  );
  await expect(reply.getByTestId("bar-row")).toHaveCount(8);
  await expect(reply.locator("tbody tr")).toHaveCount(8);
  await expect(reply.locator("code[data-line]")).toContainText("SELECT");

  // A button the model generated has no app field: it is routed by the page
  // it was pressed on.
  await send(page, "hello");
  await page
    .getByTestId("ask-button-submit")
    .filter({ hasText: "By genre" })
    .click();
  await settled(page);
  await expect(page).toHaveURL(/\/data$/);
  await expect(
    page.getByTestId("turn-live").getByTestId("stat-tile"),
  ).toHaveCount(5);
});

test("a visitor sees only their own conversations", async ({
  page,
  browser,
}) => {
  await send(page, "Recommend a book");
  await expect(page.getByTestId("chat-sidebar-item")).toHaveCount(1);
  const other = await browser.newContext({ javaScriptEnabled: false });
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByTestId("chat-welcome")).toBeVisible();
  await expect(otherPage.getByTestId("chat-sidebar-item")).toHaveCount(0);
  await other.close();
});

test("the shell is sent before the reply and the reply arrives in pieces", async ({
  page,
  baseURL,
}) => {
  test.skip(
    withScripts(),
    "reads the raw response, which needs no browser script",
  );
  await page.getByTestId("chat-composer-input").fill("Recommend a book");
  // Stop the browser from following the redirect so this test reads the stream.
  await page.route("**/", (route) => route.abort());
  await page
    .getByTestId("chat-composer-send")
    .click()
    .catch(() => {});
  const cookie = (await page.context().cookies())
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");

  const response = await fetch(`${baseURL}/`, { headers: { cookie } });
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const bytes of response.body!) {
    chunks.push(decoder.decode(bytes as Uint8Array, { stream: true }));
  }
  expect(chunks.length).toBeGreaterThan(5);
  const first = chunks[0]!;
  expect(first).toContain(`data-testid="chat-composer"`);
  expect(first).not.toContain(`data-testid="book-card"`);
  expect(chunks.join("")).toContain(`data-testid="turn-done"`);
});

test("a review is validated item by item and every answer is recorded", async ({
  page,
}) => {
  await page.goto("/review");
  await page.getByTestId("chat-sidebar-new").click();
  await send(page, "Start the review");

  // A fact, shown with its source and its place in the process.
  const live = page.getByTestId("turn-live");
  await expect(live.getByTestId("flow-stage")).toHaveCount(5);
  await expect(
    live.getByTestId("flow-stage").filter({ hasText: "Check receipt" }),
  ).toHaveAttribute("data-state", "current");
  await expect(live.getByTestId("source-quote-source")).toHaveText(
    "Returns policy, section 2",
  );
  await live.getByTestId("fact-check-note").fill("The emailed receipt counts.");
  await live.getByTestId("fact-check-confirm").click();
  await settled(page);
  await expect(page.getByTestId("turn-user").last()).toContainText(
    "Decision on returns-window (fact): confirmed",
  );

  // An open rule: pick a branch.
  await expect(live.getByTestId("fork-branch")).toHaveCount(3);
  await live
    .getByTestId("fork-branch")
    .filter({ hasText: "cannot be found" })
    .getByRole("radio")
    .check();
  await live.getByTestId("decision-fork-submit").click();
  await settled(page);

  // Replacement codes: every row starts as right, flag one.
  await expect(live.getByTestId("code-row")).toHaveCount(4);
  await live
    .getByTestId("code-row")
    .filter({ hasText: "CKB-003" })
    .getByTestId("code-row-wrong")
    .check();
  await live.getByTestId("code-map-submit").click();
  await settled(page);
  await expect(live).toContainText("I will hold CKB-003");

  // A gap: the answer is required, "I do not know" is not.
  await live.getByTestId("gap-question-unknown").click();
  await settled(page);
  await expect(live).toContainText("Recorded as unknown");

  // A plan, then the record of everything decided.
  await live.getByTestId("plan-review-approve").click();
  await settled(page);
  const rows = live.getByRole("row");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText("The emailed receipt counts.");
  await expect(rows.nth(2)).toContainText("store-credit");
  await expect(rows.nth(3)).toContainText("wrong: CKB-003");
  await expect(rows.nth(4)).toContainText("unknown");
  await expect(rows.nth(5)).toContainText("approved");
});

test("a post that is not a review decision is refused", async ({ request }) => {
  const response = await request.post("/api/decide", {
    form: { kind: "fact", item: "<script>", verdict: "confirmed" },
  });
  expect(response.status()).toBe(400);
});

test("a stored reply shows each tool call once, as it ended", async ({
  page,
}) => {
  await page.goto("/data");
  await page.getByTestId("chat-sidebar-new").click();
  await send(page, "What are the top selling books?");
  await page.reload();
  const stored = page.getByTestId("turn-assistant").locator(".part");
  await expect(stored).toHaveCount(1);
  await expect(stored).toHaveAttribute("data-state", "done");
  await expect(
    page.getByTestId("turn-assistant").locator("tbody tr"),
  ).toHaveCount(8);
});

test("a tool that changes something waits for the reader, then runs", async ({
  page,
}) => {
  await send(page, "Hold a copy of The Quiet Network");
  const card = page.getByTestId("tool-approval");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("tool-approval-action")).toHaveText(
    "Place hold",
  );
  await expect(card).toContainText("The Quiet Network");
  // Nothing has run, and the turn is not over: no model was asked again.
  await expect(page.getByTestId("turn-live")).not.toContainText("Hold number");

  // The question survives a reload: it is stored state, not page state.
  await page.reload();
  await expect(page.getByTestId("tool-approval")).toHaveCount(1);

  await page.getByTestId("tool-approval-allow").click();
  await settled(page);
  await expect(page.getByTestId("tool-approval")).toHaveCount(0);
  const live = page.getByTestId("turn-live");
  await expect(live.locator('.part[data-state="done"]')).toHaveCount(1);
  await expect(live).toContainText("Hold number H-");

  // Reloaded, it is one reply: the question, the call, and the answer.
  await page.reload();
  const stored = page.getByTestId("turn-assistant");
  await expect(stored).toHaveCount(1);
  await expect(stored).toContainText("needs your OK first");
  await expect(stored).toContainText("Hold number H-");
  await expect(stored.locator('.part[data-state="done"]')).toHaveCount(1);
});

test("a refused tool call never runs, and the model is told", async ({
  page,
}) => {
  await send(page, "Hold a copy of The Quiet Network");
  await page.getByTestId("tool-approval-deny").click();
  await settled(page);
  const live = page.getByTestId("turn-live");
  await expect(live).toContainText("nothing was held");
  await expect(page.getByTestId("chat-thread")).not.toContainText(
    "Hold number",
  );
  await page.reload();
  await expect(page.getByTestId("tool-status")).toHaveText(
    "You did not allow: Place hold",
  );
  await expect(page.getByTestId("tool-approval")).toHaveCount(0);
});

test("an approval the reader walks away from is refused, not left open", async ({
  page,
  request,
}) => {
  await send(page, "Hold a copy of The Quiet Network");
  const call = await page
    .getByTestId("tool-approval")
    .locator('input[name="call"]')
    .getAttribute("value");
  await send(page, "Recommend a book");
  await expect(page.getByTestId("tool-approval")).toHaveCount(0);
  await expect(page.getByTestId("tool-status")).toHaveText(
    "You did not allow: Place hold",
  );
  // The old card's answer is no longer accepted, and neither is a made-up one.
  const cookie = (await page.context().cookies())
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
  for (const id of [call!, "call_made_up"]) {
    const response = await request.post("/api/approve", {
      form: { app: "books", call: id, verdict: "approve" },
      headers: { cookie },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(400);
  }
});

test("a data-table is a plain table without scripts and sortable with them", async ({
  page,
}) => {
  await page.goto("/data");
  await page.getByTestId("chat-sidebar-new").click();
  await send(page, "What are the top selling books?");
  const table = page.getByTestId("turn-live").getByTestId("data-table");
  const firstTitle = table.locator("tbody tr:visible td").first();
  await expect(table.locator("tbody tr")).toHaveCount(8);
  await expect(firstTitle).toHaveText("Shipping Monoliths");
  const filter = table.getByTestId("data-table-filter");
  if (!withScripts()) {
    await expect(filter).toBeHidden();
    await expect(table.locator("th button")).toHaveCount(0);
    return;
  }
  // The component's script arrived in the stream and started on its own.
  await table.getByRole("button", { name: "Revenue" }).click();
  await expect(firstTitle).toHaveText("Quiet Type Systems");
  await expect(table.locator("th", { hasText: "Revenue" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await table.getByRole("button", { name: "Revenue" }).click();
  await expect(firstTitle).toHaveText("Shipping Monoliths");
  await filter.fill("quiet");
  await expect(table.locator("tbody tr:visible")).toHaveCount(3);
  await expect(table.getByTestId("data-table-count")).toHaveText("3 of 8 rows");

  // The same script starts for a table in a stored reply.
  await page.reload();
  const stored = page.getByTestId("turn-assistant").getByTestId("data-table");
  await stored.getByRole("button", { name: "Units" }).click();
  await expect(stored.locator("tbody tr td").first()).toHaveText(
    "Refactoring Interfaces",
  );
});

test("with the client runtime a message is answered without a page load", async ({
  page,
}) => {
  test.skip(!withScripts(), "the client runtime is a script");
  // A value on the page object survives only while the document does.
  await page.evaluate("window.kept = true");
  const kept = (): Promise<boolean> => page.evaluate("window.kept === true");

  await send(page, "Recommend a book");
  expect(await kept()).toBe(true);
  await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
  await expect(
    page.getByTestId("turn-live").getByTestId("book-card"),
  ).toHaveCount(3);
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
  await expect(page.getByTestId("chat-composer-input")).toBeFocused();
  // The sidebar was refreshed from the same response.
  await expect(page.getByTestId("chat-sidebar-item")).toContainText([
    "Recommend a book",
  ]);

  // A form a component generated is sent the same way.
  await page
    .getByTestId("ask-button-submit")
    .filter({ hasText: "Compare lengths" })
    .click();
  await settled(page);
  expect(await kept()).toBe(true);
  await expect(page.getByTestId("turn-user")).toHaveCount(2);
  await expect(
    page.getByTestId("turn-live").getByTestId("bar-row"),
  ).toHaveCount(4);
  await expect(page.getByTestId("turn-live")).toHaveCount(1);
});

test("with the client runtime a message shows that a reply is on its way", async ({
  page,
}) => {
  test.skip(!withScripts(), "the client runtime is a script");
  const composer = page.getByTestId("chat-composer");
  const action = await composer.evaluate(
    (form) => (form as unknown as { action: string }).action,
  );
  // Hold the request: nothing has come back, and the page has to say so.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.href === action,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await held;
      return route.fallback();
    },
  );
  await page.getByTestId("chat-composer-input").fill("Recommend a book");
  await page.getByTestId("chat-composer-send").click();
  await expect(composer).toHaveAttribute("data-pending", "");
  const pending = page.getByTestId("turn-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("aria-busy", "true");
  // The message is already shown, before the server has answered, with the
  // same test id as the stored message that replaces it.
  await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
  await expect(page.locator(".turn-user")).toHaveText("Recommend a book");
  // The demo's style: a round dot, where a finished reply's caret is square.
  expect(
    await page.evaluate(
      `getComputedStyle(document.querySelector('[data-testid="turn-pending"]'), "::after").borderTopLeftRadius`,
    ),
  ).toBe("50%");

  release();
  await settled(page);
  await expect(composer).not.toHaveAttribute("data-pending");
  await expect(page.getByTestId("turn-pending")).toHaveCount(0);
});

test("with the client runtime a reply can be stopped, and what arrived is kept", async ({
  page,
}) => {
  test.skip(!withScripts(), "the client runtime is a script");
  const stop = page.getByTestId("chat-composer-stop");
  await expect(stop).toBeHidden();
  await page.getByTestId("chat-composer-input").fill("Recommend a book");
  await page.getByTestId("chat-composer-send").click();
  // The message is echoed before the server answers.
  await expect(page.getByTestId("chat-thread")).toContainText(
    "Recommend a book",
  );
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("chat-composer-send")).toBeHidden();
  await expect(page.getByTestId("turn-live")).toContainText("Three picks");
  await stop.click();
  await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
  await expect(stop).toBeHidden();
  await expect(
    page.getByTestId("turn-live").getByTestId("book-card"),
  ).toHaveCount(0);

  // The server kept the part it had written.
  await page.reload();
  await expect(page.getByTestId("turn-assistant")).toContainText("Three picks");
  await expect(page.getByTestId("turn-live")).toBeHidden();
});

test("a reload in the middle of a reply joins it instead of starting another", async ({
  page,
}) => {
  await page.getByTestId("chat-composer-input").fill("Recommend a book");
  await page.getByTestId("chat-composer-send").click();
  await expect(page.getByTestId("turn-live")).toContainText("Three picks");
  await page.reload();
  // The reply is shown from its start, then goes on to its end.
  const live = page.getByTestId("turn-live");
  await expect(live).toContainText("Three picks");
  await expect(page.getByTestId("turn-done")).toBeAttached();
  await expect(live.getByTestId("book-card")).toHaveCount(3);
  await expect(page.getByTestId("turn-user")).toHaveCount(1);

  // It was written and stored once.
  await page.reload();
  await expect(page.getByTestId("turn-assistant")).toHaveCount(1);
  await expect(page.getByTestId("book-card")).toHaveCount(3);
  await expect(page.getByTestId("turn-live")).toBeHidden();
});

test("a reply is finished and stored when the reader leaves", async ({
  page,
}) => {
  await page.getByTestId("chat-composer-input").fill("Recommend a book");
  await page.getByTestId("chat-composer-send").click();
  await expect(page.getByTestId("turn-live")).toContainText("Three picks");
  await page.goto("about:blank");
  // Nobody is reading. Come back once it has had time to finish.
  await expect
    .poll(
      async () => {
        await page.goto("/");
        return page
          .getByTestId("turn-assistant")
          .getByTestId("book-card")
          .count();
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBe(3);
  await expect(page.getByTestId("turn-assistant")).toHaveCount(1);
});

test("a second tab on the same conversation reads the same reply", async ({
  page,
  context,
}) => {
  await page.getByTestId("chat-composer-input").fill("Recommend a book");
  await page.getByTestId("chat-composer-send").click();
  await expect(page.getByTestId("turn-live")).toContainText("Three picks");
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByTestId("turn-done")).toBeAttached();
  await expect(
    other.getByTestId("turn-live").getByTestId("book-card"),
  ).toHaveCount(3);
  await settled(page);
  await expect(
    page.getByTestId("turn-live").getByTestId("book-card"),
  ).toHaveCount(3);
  await other.reload();
  await expect(other.getByTestId("turn-assistant")).toHaveCount(1);
  await other.close();
});

test.describe("a client tool", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("is answered by the browser with scripts, and by the reader without", async ({
    page,
  }) => {
    await page.getByTestId("chat-composer-input").fill("Is the shop open now?");
    await page.getByTestId("chat-composer-send").click();
    const thread = page.getByTestId("chat-thread");
    if (withScripts()) {
      // The component's script read the clock and sent the form itself.
      await expect(thread).toContainText(/It is \d\d:\d\d Asia\/Tokyo for you/);
    } else {
      // The same form, filled in by hand.
      await expect(page.getByTestId("turn-done")).toBeAttached();
      const form = page.getByTestId("client-local-time");
      await expect(form).toHaveCount(1);
      await page.getByTestId("client-local-time-output").fill("09:30 Lisbon");
      await page.getByTestId("client-local-time-send").click();
      await expect(thread).toContainText("It is 09:30 Lisbon for you");
      await expect(thread).toContainText("The shop is open now");
    }
    await settled(page);
    await expect(page.getByTestId("client-local-time")).toHaveCount(0);

    // One reply, stored with the call and its result.
    await page.reload();
    const stored = page.getByTestId("turn-assistant");
    await expect(stored).toHaveCount(1);
    await expect(stored).toContainText("Let me check the time where you are.");
    await expect(
      stored.locator('.part[data-tool="local_time"]'),
    ).toHaveAttribute("data-state", "done");
    await expect(stored).toContainText("for you. The shop is");
  });

  test("takes no result for a call that is not waiting", async ({
    page,
    request,
  }) => {
    await send(page, "Recommend a book");
    const cookie = (await page.context().cookies())
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const response = await request.post("/api/result", {
      form: { app: "books", call: "call_made_up", output: "23:00" },
      headers: { cookie },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(400);
  });
});

test("the visitor picks the model, and a local model's reply is rendered", async ({
  page,
}) => {
  const select = page.getByTestId("chat-sidebar-model-select");
  // With no key set, the offline script answers until the visitor chooses.
  await expect(select).toHaveValue("offline:script");
  await expect(select.getByRole("option")).toHaveText([
    "Offline script",
    "fake-local:7b",
  ]);

  await select.selectOption("openai:fake-local:7b");
  await page.getByTestId("chat-sidebar-model-use").click();
  await expect(select).toHaveValue("openai:fake-local:7b");

  await send(page, "Recommend a book");
  const live = page.getByTestId("turn-live");
  await expect(live).toContainText("From the fake local model:");
  await expect(live).toContainText("(asked for fake-local:7b)");
  // The model's tags went through the same catalog as any other model's.
  await expect(live.getByTestId("book-card-title")).toHaveText(
    "The Local Model",
  );

  // The choice is the visitor's, on every app, until they change it.
  await page.goto("/review");
  await expect(page.getByTestId("chat-sidebar-model-select")).toHaveValue(
    "openai:fake-local:7b",
  );
  await page
    .getByTestId("chat-sidebar-model-select")
    .selectOption("offline:script");
  await page.getByTestId("chat-sidebar-model-use").click();
  await expect(page.getByTestId("chat-sidebar-model-select")).toHaveValue(
    "offline:script",
  );
});

test("a model the server does not offer cannot be chosen", async ({
  request,
}) => {
  const response = await request.post("/api/model", {
    form: { model: "openai:http://evil.example/v1" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers()["set-cookie"]).toContain("model=offline%3Ascript");
});

test.describe("voice", () => {
  /**
   * Stand-ins for the browser's speech engines, which a headless browser
   * does not have: a synthesizer that "speaks" by sending a word boundary
   * every few milliseconds, and a recognizer that hears one sentence. They
   * record what the page asked them to say, and every word it put in bold.
   */
  const fakeSpeech = `
    window.__spoken = [];
    window.__bold = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    let saying = 0;
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      speak(utterance) {
        const mine = ++saying;
        window.__spoken.push(utterance.text);
        utterance.onstart?.();
        const words = [...utterance.text.matchAll(/\\S+/g)];
        words.forEach((word, index) => setTimeout(() => {
          if (mine === saying) utterance.onboundary?.({ name: "word", charIndex: word.index });
        }, 8 * (index + 1)));
        setTimeout(() => { if (mine === saying) utterance.onend?.(); }, 8 * (words.length + 1));
      },
      cancel() { saying++; },
    }});
    let heard = 0;
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() {
        window.__listening = (window.__listening ?? 0) + 1;
        if (heard++ > 0) return; // after the first sentence, it only listens
        setTimeout(() => {
          this.onresult?.({ results: [Object.assign([{ transcript: "Recommend a book" }], { isFinal: true })] });
        }, 20);
      }
      abort() { this.onend?.(); }
    };
    document.addEventListener("DOMContentLoaded", () => {
      const caption = document.querySelector('[data-testid="chat-voice-caption"]');
      new MutationObserver(() => {
        const bold = caption.querySelector("strong");
        if (bold) window.__bold.push(bold.textContent);
      }).observe(caption, { childList: true, subtree: true });
    });
  `;
  const PROSE = [
    "Three picks from the catalog, each rendered by a book-card component on the server:",
    "Refactoring the Monolith.",
    "Practical Type Systems.",
    "Shipping Small Changes.",
    "Every card has its own button, and each button is a form that posts your next message.",
  ];

  test("is not shown without scripts", async ({ page }) => {
    test.skip(withScripts(), "this is the page with scripts off");
    await expect(page.getByTestId("chat-voice")).toBeHidden();
    await send(page, "Recommend a book");
    await expect(page.getByTestId("chat-voice")).toBeHidden();
  });

  test("reads a reply aloud as it streams, with the current word in bold", async ({
    page,
  }) => {
    test.skip(!withScripts(), "voice is a script");
    await page.addInitScript(fakeSpeech);
    await page.reload();
    await page.getByTestId("chat-voice-summary").click();
    const aloud = page.getByTestId("chat-voice-aloud");
    await aloud.click();
    await expect(aloud).toHaveAttribute("aria-pressed", "true");
    await send(page, "Recommend a book");

    // The prose and what each card says of itself: not the buttons, not the
    // blurbs, and each sentence once.
    await expect.poll(() => page.evaluate("window.__spoken")).toEqual(PROSE);
    // Every word was in bold in turn, in order.
    await expect
      .poll(() => page.evaluate("window.__bold.join(' ')"))
      .toBe(PROSE.join(" "));
    // A few words at a time, and nothing once it has all been said.
    const caption = page.getByTestId("chat-voice-caption");
    await expect(caption).toBeEmpty();
    await expect(caption).toBeHidden();

    // The choice is the reader's, and is kept.
    await page.reload();
    // Closed again after the reload, the line still says what is on.
    await expect(page.getByTestId("chat-voice-summary")).toHaveText(
      "Reading aids: read aloud",
    );
    await expect(page.getByTestId("chat-voice-aloud")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // A stored reply is not read out again.
    expect(await page.evaluate("window.__spoken")).toEqual([]);
  });

  test("captions a reply at a reading pace with the sound off", async ({
    page,
  }) => {
    test.skip(!withScripts(), "voice is a script");
    await page.addInitScript(
      `${fakeSpeech}; Object.defineProperty(window, "speechSynthesis", { value: undefined });`,
    );
    await page.reload();
    await page.getByTestId("chat-voice-summary").click();
    // No speech engine: there is nothing to read aloud with.
    await expect(page.getByTestId("chat-voice-aloud")).toBeHidden();
    await page.getByTestId("chat-voice-speed").selectOption("2");
    await page.getByTestId("chat-voice-captions").click();
    await send(page, "Recommend a book");
    const caption = page.getByTestId("chat-voice-caption");
    await expect(caption).toBeVisible();
    await expect(caption.locator("strong")).toHaveCount(1);
    // At most a few words are shown at once.
    expect(
      (await caption.innerText()).trim().split(/\s+/).length,
    ).toBeLessThanOrEqual(6);
    await expect
      .poll(() => page.evaluate("window.__bold.slice(0, 5).join(' ')"), {
        timeout: 10_000,
      })
      .toBe("Three picks from the catalog,");
    // Turning captions off stops them at once.
    await page.getByTestId("chat-voice-captions").click();
    await expect(caption).toBeEmpty();
  });

  test("holds a conversation: listens, sends, speaks, and listens again", async ({
    page,
  }) => {
    test.skip(!withScripts(), "voice is a script");
    await page.addInitScript(fakeSpeech);
    await page.reload();
    await page.getByTestId("chat-voice-summary").click();
    await page.getByTestId("chat-voice-talk").click();
    // What was heard is sent like a typed message.
    await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
    await settled(page);
    await expect.poll(() => page.evaluate("window.__spoken")).toEqual(PROSE);
    // When the reply has been said, it is the reader's turn again.
    await expect(page.getByTestId("chat-voice")).toHaveAttribute(
      "data-state",
      "listening",
    );
    expect(await page.evaluate("window.__listening")).toBe(2);
    await expect(page.getByTestId("chat-voice-caption")).toHaveText(
      "Listening…",
    );
    await page.getByTestId("chat-voice-talk").click();
    await expect(page.getByTestId("chat-voice")).not.toHaveAttribute(
      "data-state",
      "listening",
    );
  });
});

/**
 * The server is set up for two speech-to-speech providers, each a stand-in.
 * Gemini Live is reached by the browser itself with a one-use token; Azure
 * Voice Live is reached through the server's relay. A call works the same
 * with either, and only Azure says when each word is spoken.
 */
for (const provider of ["gemini-live", "azure-voice-live"]) {
  test.describe(`a voice call (${provider})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.route("**/api/voice-session", (route) =>
        route.continue({
          url: `${route.request().url()}?provider=${provider}`,
        }),
      );
    });

    /**
     * The stand-in servers pause on purpose (the model "thinks" for a couple
     * of seconds, the reader's sentence takes a moment to say, a second tool
     * call comes late), so an assertion that waits across a pause gets room
     * for a slow runner: the default five seconds is barely more than the
     * pauses add up to. This only lengthens the wait; it asserts nothing new.
     */
    const PAUSED = { timeout: 30_000 };

    /**
     * A microphone that needs no device and no permission: a tone from the
     * page's own audio engine, handed out where the browser would hand out the
     * real one. The component still captures it, converts it, and sends it.
     */
    const toneMicrophone = `
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  `;

    test("is not offered without scripts", async ({ page }) => {
      test.skip(withScripts(), "this is the page with scripts off");
      await expect(page.getByTestId("voice-call")).toBeHidden();
    });

    test("hears the reader, speaks, captions, and shows components from the server", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(toneMicrophone);
      await page.reload();
      await page.evaluate("window.kept = true");
      // Every word the caption puts in bold, as it happens.
      await page.evaluate(`
      window.__bold = [];
      const caption = document.querySelector('[data-testid="voice-call-caption"]');
      new MutationObserver(() => {
        const bold = caption.querySelector("strong");
        if (bold) window.__bold.push(bold.textContent);
      }).observe(caption, { childList: true, subtree: true });
    `);
      const toggle = page.getByTestId("voice-call-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");

      // The microphone's sound reached the provider, which heard a sentence.
      await expect(page.getByTestId("turn-user")).toHaveText(
        "Recommend a book",
        PAUSED,
      );
      const reply = page.getByTestId("turn-voice");
      await expect(reply).toContainText(
        "Here are two books from the shelf.",
        PAUSED,
      );
      // What the model showed went to the server, through the catalog, and
      // came back as components with their styles.
      const cards = reply.getByTestId("book-card");
      await expect(cards).toHaveCount(2, PAUSED);
      await expect(cards.first().getByTestId("book-card-title")).toHaveText(
        "Refactoring the Monolith",
        PAUSED,
      );
      await expect(cards.first()).toHaveCSS("border-top-style", "solid");
      await expect(reply.getByTestId("ask-button")).toHaveCount(1);
      // The caption followed the voice, a word at a time.
      await expect
        .poll(
          () => page.evaluate("[...new Set(window.__bold)].join(' ')"),
          PAUSED,
        )
        .toContain("Here are two");
      await expect(page.getByTestId("voice-call-caption")).toHaveAttribute(
        "data-timing",
        provider === "azure-voice-live" ? "words" : "estimate",
      );
      if (provider === "azure-voice-live") {
        // Each word was in bold at its own time, and a full stop stayed with its word.
        await expect
          .poll(
            () => page.evaluate("[...new Set(window.__bold)].join(' ')"),
            PAUSED,
          )
          .toBe("Here are two books from the shelf.");
      }
      // No page load happened, and the composer was not used.
      expect(await page.evaluate("window.kept === true")).toBe(true);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      // What was said and shown is stored: a reload has the same conversation.
      await page.reload();
      await expect(page.getByTestId("turn-user")).toHaveText(
        "Recommend a book",
      );
      const stored = page.getByTestId("turn-assistant");
      await expect(stored.locator(".spoken")).toHaveText(
        "Here are two books from the shelf.",
      );
      await expect(stored.getByTestId("book-card")).toHaveCount(2);
    });

    test("takes a typed message, and waits for the reader before a tool that needs approval", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      // No microphone at all: the call still connects, and the reader types.
      await page.addInitScript(
        "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no', 'NotAllowedError'); };",
      );
      await page.reload();
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );

      // Typed during a call, a message is said to the model, not posted.
      await page
        .getByTestId("chat-composer-input")
        .fill("Please hold one for me");
      await page.getByTestId("chat-composer-send").click();
      await expect(page.getByTestId("turn-user")).toHaveText(
        "Please hold one for me",
      );
      const reply = page.getByTestId("turn-voice");
      const card = reply.getByTestId("tool-approval");
      await expect(card).toContainText("The Quiet Network");
      // The model is waiting on the line: nothing has been held.
      await expect(reply).not.toContainText("Hold number");
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "Waiting for your answer on screen.",
      );

      await card.getByTestId("tool-approval-allow").click();
      await expect(reply.getByTestId("tool-approval")).toHaveCount(0);
      await expect(reply.locator('.part[data-state="done"]')).toHaveCount(1);
      // The tool ran on the server, and the model was told its result.
      await expect(reply).toContainText(
        "The shop says: A copy of The Quiet Network is held",
        PAUSED,
      );
      await expect(reply).toContainText("Hold number H-", PAUSED);
      await page.getByTestId("voice-call-toggle").click();

      await page.reload();
      await expect(
        page.getByTestId("turn-assistant").locator('.part[data-state="done"]'),
      ).toHaveCount(1);
    });
    test("sends a form for the reader who says their answer, and one they press themselves", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(
        "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no', 'NotAllowedError'); };",
      );
      await page.reload();
      await page.evaluate("window.kept = true");
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      const composer = page.getByTestId("chat-composer-input");
      const send = page.getByTestId("chat-composer-send");

      // The model shows a button, which is a form.
      await composer.fill("Recommend a book");
      await send.click();
      const shown = page.getByTestId("turn-voice").getByTestId("ask-button");
      await expect(shown).toHaveCount(1);

      // The reader says what to press. The model presses it for them: the
      // form goes to the server, and what it says goes back to the model.
      await composer.fill("Press that for me");
      await send.click();
      await expect(page.getByTestId("turn-voice").last()).toContainText(
        "Done. Sent for the reader: Hold a copy of Shipping Small Changes",
      );
      // It was the reader's answer, and is shown as theirs. It is sent once.
      await expect(page.getByTestId("turn-user").last()).toContainText(
        "Hold a copy of Shipping Small Changes",
      );
      await expect(shown).toHaveAttribute("data-sent", "");
      await expect(shown.getByTestId("voice-call-answered")).toHaveText(
        "Answered: Hold the short one",
      );
      // No typed reply was started, and the page did not load again.
      await expect(page.getByTestId("turn-assistant")).toHaveCount(0);
      expect(await page.evaluate("window.kept === true")).toBe(true);

      // A form the reader presses themselves is said to the model the same way.
      await composer.fill("Recommend a book");
      await send.click();
      const again = page
        .getByTestId("turn-voice")
        .last()
        .getByTestId("ask-button");
      await again.getByTestId("ask-button-submit").click();
      await expect(page.getByTestId("turn-user").last()).toHaveText(
        "Hold a copy of Shipping Small Changes",
      );
      // The model heard it: it asks to hold the book, which waits for the reader.
      await expect(
        page.getByTestId("turn-voice").last().getByTestId("tool-approval"),
      ).toContainText("The Quiet Network");
      expect(await page.evaluate("window.kept === true")).toBe(true);
      await page.getByTestId("voice-call-toggle").click();
    });

    test("never lets the model allow its own action", async ({ page }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(
        "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no', 'NotAllowedError'); };",
      );
      await page.reload();
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      // The model asks to hold a book and then tries to press Allow itself.
      await page.getByTestId("chat-composer-input").fill("Try to sneak one in");
      await page.getByTestId("chat-composer-send").click();
      const reply = page.getByTestId("turn-voice");
      const card = reply.getByTestId("tool-approval");
      await expect(card).toContainText("The Quiet Network");
      // Give the second call time to arrive: the question is still open.
      await page.waitForTimeout(2500);
      await expect(card).toHaveCount(1);
      await expect(reply).not.toContainText("Hold number");
      await card.getByTestId("tool-approval-deny").click();
      await expect(reply).toContainText("Blocked. Error:", PAUSED);
      await expect(reply).toContainText(
        "The reader declined this action",
        PAUSED,
      );
      await expect(reply).not.toContainText("Hold number");
      await page.getByTestId("voice-call-toggle").click();
    });

    /** A microphone whose tone the test can switch off, to be quiet on cue. */
    const gatedMicrophone = `
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const gain = context.createGain();
      const out = context.createMediaStreamDestination();
      tone.connect(gain);
      gain.connect(out);
      tone.start();
      window.__micGain = gain;
      return out.stream;
    };
  `;
    const noMicrophone =
      "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no', 'NotAllowedError'); };";

    /** A request that waits until the test lets it go. */
    const gate = (): { opened: Promise<void>; open: () => void } => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    };

    test("shows the microphone level, the words as they come, and each wait", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(gatedMicrophone);
      await page.reload();
      const status = page.getByTestId("voice-call-status");
      const meter = page.getByTestId("voice-call-meter");
      await expect(meter).toBeHidden();
      await page.getByTestId("voice-call-toggle").click();

      // The reader speaks: the status says so, and the words arrive as they are said.
      await expect(status).toHaveText("Hearing you…", PAUSED);
      await expect(page.getByTestId("turn-user")).toContainText(
        "Recommend",
        PAUSED,
      );
      // The level is the microphone's own, and the meter is decoration.
      await expect(meter).toBeVisible();
      await expect(meter).toHaveAttribute("aria-hidden", "true");
      await expect(meter).toHaveAttribute("data-speaking", "");
      await expect
        .poll(async () => Number(await meter.getAttribute("data-level")))
        .toBeGreaterThan(0.5);
      await expect(meter).toHaveAttribute("data-level", /^\d\.\d\d$/);

      // The reader stops: the model has not answered yet.
      await page.evaluate("window.__micGain.gain.value = 0");
      await expect(status).toHaveText("Thinking…", PAUSED);
      await expect(meter).not.toHaveAttribute("data-speaking", PAUSED);
      await expect
        .poll(
          async () => Number(await meter.getAttribute("data-level")),
          PAUSED,
        )
        .toBeLessThan(0.1);
      // The words that were said stand as they were completed, not twice.
      await expect(page.getByTestId("turn-user")).toHaveText(
        "Recommend a book",
        PAUSED,
      );

      // The model's first sound ends the wait.
      await expect(page.getByTestId("turn-voice")).toContainText(
        "Here are two books",
        PAUSED,
      );
      await expect(status).not.toHaveText("Thinking…", PAUSED);
      await page.getByTestId("voice-call-toggle").click();
      await expect(meter).toBeHidden();
    });

    test("shows no level when there is no microphone", async ({ page }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.reload();
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      await expect(page.getByTestId("voice-call-meter")).toBeHidden();
      await page.getByTestId("voice-call-toggle").click();
    });

    test("shows that a call is connecting until it is on", async ({ page }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.reload();
      const session = gate();
      await page.route("**/api/voice-session*", async (route) => {
        await session.opened;
        await route.fallback();
      });
      const toggle = page.getByTestId("voice-call-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-busy", "true");
      await expect(page.getByTestId("voice-call-connecting")).toBeVisible();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "Connecting…",
      );
      session.open();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      await expect(toggle).not.toHaveAttribute("aria-busy");
      await toggle.click();
    });

    /** Remembers every audio engine and socket the page makes, and whether it was let go. */
    const countResources = `
    window.__audio = [];
    window.__sockets = [];
    const BaseAudio = window.AudioContext;
    window.AudioContext = class extends BaseAudio {
      constructor(options) { super(options); window.__audio.push(this); }
    };
    const BaseSocket = window.WebSocket;
    window.WebSocket = class extends BaseSocket {
      constructor(...args) { super(...args); window.__sockets.push(this); }
    };
  `;
    const sessionRequests = (page: Page): string[] => {
      const seen: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/voice-session"))
          seen.push(request.url());
      });
      return seen;
    };
    /** Holds the session request until the test lets it go; a cancelled request is not an error. */
    const holdSession = async (
      page: Page,
      session: ReturnType<typeof gate>,
    ) => {
      await page.route("**/api/voice-session*", async (route) => {
        await session.opened;
        await route.fallback().catch(() => {});
      });
    };

    test("starts one call from one press, even while the session is on its way", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.addInitScript(countResources);
      await page.reload();
      const requests = sessionRequests(page);
      const session = gate();
      await holdSession(page, session);
      const toggle = page.getByTestId("voice-call-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-busy", "true");
      session.open();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
        { timeout: 15_000 },
      );
      expect(requests).toHaveLength(1);
      expect(await page.evaluate("window.__sockets.length")).toBe(1);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    });

    test("cancels a call that is still connecting when the button is pressed again", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.addInitScript(countResources);
      await page.reload();
      const requests = sessionRequests(page);
      const session = gate();
      await holdSession(page, session);
      const toggle = page.getByTestId("voice-call-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      // A second press while the session request is pending is a cancel.
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(toggle).not.toHaveAttribute("aria-busy");
      await expect(page.getByTestId("voice-call-meter")).toBeHidden();
      session.open();

      // Nothing was left behind: one request, no socket, and every audio engine closed.
      await expect
        .poll(
          () =>
            page.evaluate(
              "window.__audio.every((context) => context.state === 'closed')",
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      expect(requests).toHaveLength(1);
      expect(await page.evaluate("window.__sockets.length")).toBe(0);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      // The button still works afterwards: a new press starts one call.
      await toggle.click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
        { timeout: 15_000 },
      );
      expect(requests).toHaveLength(2);
      expect(await page.evaluate("window.__sockets.length")).toBe(1);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    });

    test("shows work in progress, and a view on its way", async ({ page }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.reload();
      const tool = gate();
      const view = gate();
      await page.route("**/api/voice-tool*", async (route) => {
        await tool.opened;
        await route.fallback();
      });
      await page.route("**/voice-view*", async (route) => {
        await view.opened;
        await route.fallback();
      });
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      await page.getByTestId("chat-composer-input").fill("Recommend a book");
      await page.getByTestId("chat-composer-send").click();

      // The message is sent and nothing has come back.
      const status = page.getByTestId("voice-call-status");
      await expect(status).toHaveText("Working…");
      const reply = page.getByTestId("turn-voice");
      await expect(reply.getByTestId("voice-call-loading")).toHaveCount(0);

      // The tool has run; its view is on the way, and a block holds its place.
      tool.open();
      const loading = reply.getByTestId("voice-call-loading");
      await expect(loading).toBeVisible();
      await expect(loading).toHaveAttribute("aria-busy", "true");
      await expect(status).toHaveText("Working…");
      await expect(reply.getByTestId("book-card")).toHaveCount(0);

      view.open();
      await expect(reply.getByTestId("book-card")).toHaveCount(2);
      await expect(reply.getByTestId("voice-call-loading")).toHaveCount(0);
      await expect(status).not.toHaveText("Working…");
      await page.getByTestId("voice-call-toggle").click();
    });

    test("takes the placeholder away when a view does not come", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.reload();
      const view = gate();
      await page.route("**/voice-view*", async (route) => {
        await view.opened;
        await route.fulfill({ status: 500, body: "no" });
      });
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      await page.getByTestId("chat-composer-input").fill("Recommend a book");
      await page.getByTestId("chat-composer-send").click();
      const reply = page.getByTestId("turn-voice");
      await expect(reply.getByTestId("voice-call-loading")).toBeVisible();
      view.open();
      await expect(reply.getByTestId("voice-call-loading")).toHaveCount(0);
      await expect(reply.getByTestId("book-card")).toHaveCount(0);
      await page.getByTestId("voice-call-toggle").click();
    });

    test("marks a form busy and locks it while its answer is sent", async ({
      page,
    }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await page.addInitScript(noMicrophone);
      await page.reload();
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "No microphone: type to talk.",
      );
      await page.getByTestId("chat-composer-input").fill("Recommend a book");
      await page.getByTestId("chat-composer-send").click();
      const form = page.getByTestId("turn-voice").getByTestId("ask-button");
      await expect(form).toHaveCount(1);

      const sent = gate();
      const action = await form.evaluate(
        (element) => (element as unknown as { action: string }).action,
      );
      await page.route(
        (url) => url.href === action,
        async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          await sent.opened;
          return route.fallback();
        },
      );
      const submit = form.getByTestId("ask-button-submit");
      await submit.click();
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(submit).toBeDisabled();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "Working…",
      );

      sent.open();
      await expect(form).toHaveAttribute("data-sent", "");
      await expect(form).not.toHaveAttribute("aria-busy");
      await page.getByTestId("voice-call-toggle").click();
    });
  });
}
