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
