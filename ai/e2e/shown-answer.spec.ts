import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * What the thread shows for an answer the reader gave by pressing a form.
 * A form's message can be a record for the model ("Decision on ...: unsure"),
 * and the thread then shows what the reader pressed ("Not sure"), other
 * words the form names in a `show` field, or nothing. The model reads the
 * message either way, and a reload shows the same thing.
 */

/** True in the project that runs with the client runtime. */
const withScripts = (): boolean => test.info().project.name === "js";

/** Wait for the reply's last chunk (see chat.spec.ts). */
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

/** Give a form a `show` field, as its developer would write one in its markup. */
async function showField(form: Locator, value: string): Promise<void> {
  await form.evaluate((element, shown) => {
    const input = element.ownerDocument.createElement("input");
    input.type = "hidden";
    input.name = "show";
    input.value = shown;
    element.prepend(input);
  }, value);
}

const COMMAND = "Decision on returns-window (fact): unsure";

test.describe("a review answer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/review");
    await page.getByTestId("chat-sidebar-new").click();
    await send(page, "Start the review");
  });

  // Runs with scripts and without: the label comes from the server.
  test("shows what was pressed, and the model still gets the record", async ({
    page,
  }) => {
    const live = page.getByTestId("turn-live");
    await live.getByTestId("fact-check-unsure").click();
    await settled(page);
    const mine = page.getByTestId("turn-user");
    await expect(mine).toHaveCount(2);
    await expect(mine.last()).toHaveText("Not sure");
    await expect(page.getByTestId("chat-thread")).not.toContainText(COMMAND);
    // The reviewer's reply is to the record, not to the label.
    await expect(live).toContainText("Recorded as not sure");

    // The stored turn shows the same thing.
    await page.reload();
    await expect(page.getByTestId("turn-user").last()).toHaveText("Not sure");
    await expect(page.getByTestId("chat-thread")).not.toContainText(COMMAND);

    // And the stored history still holds the record: the summary reads it.
    await send(page, "Show me the summary");
    const row = page
      .getByTestId("turn-live")
      .getByRole("row")
      .filter({ hasText: "returns-window" });
    await expect(row).toContainText("unsure");
  });

  test("shows the note the reviewer wrote under what they pressed", async ({
    page,
  }) => {
    const live = page.getByTestId("turn-live");
    await live.getByTestId("fact-check-note").fill("It is 45 days <b>now</b>.");
    await live.getByTestId("fact-check-wrong").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Wrong\nIt is 45 days <b>now</b>.",
    );
    await expect(live).toContainText("Recorded as wrong");
  });

  test("shows the branch that was picked for a rule, by its condition", async ({
    page,
  }) => {
    const live = page.getByTestId("turn-live");
    await live.getByTestId("fact-check-confirm").click();
    await settled(page);
    await live
      .getByTestId("fork-branch")
      .filter({ hasText: "cannot be found" })
      .getByRole("radio")
      .check();
    await live.getByTestId("decision-fork-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "If the sale cannot be found",
    );
    await expect(live).toContainText('follows the "store-credit" rule');
  });
});

test.describe("a form that says what to show", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await send(page, "Recommend a book");
  });

  const compare = (page: Page): Locator =>
    page
      .getByTestId("turn-live")
      .getByTestId("ask-button")
      .filter({ hasText: "Compare lengths" });

  test("shows the form's own words in place of the message", async ({
    page,
  }) => {
    await showField(compare(page), "Compare them for me");
    await compare(page).getByTestId("ask-button-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Compare them for me",
    );
    // The model was sent the button's message.
    await expect(
      page.getByTestId("turn-live").getByTestId("bar-row"),
    ).toHaveCount(4);

    await page.reload();
    await expect(page.getByTestId("turn-user")).toHaveText([
      "Recommend a book",
      "Compare them for me",
    ]);
    await expect(page.getByTestId("chat-thread")).not.toContainText(
      "Compare the page counts of every book",
    );
  });

  test("shows nothing for the reader's turn when the words are empty", async ({
    page,
  }) => {
    await showField(compare(page), "");
    await compare(page).getByTestId("ask-button-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user")).toHaveText([
      "Recommend a book",
    ]);
    // The model was still sent the message, and answered it.
    await expect(
      page.getByTestId("turn-live").getByTestId("bar-row"),
    ).toHaveCount(4);

    await page.reload();
    await expect(page.getByTestId("turn-user")).toHaveText([
      "Recommend a book",
    ]);
    await expect(
      page.getByTestId("turn-assistant").getByTestId("bar-row"),
    ).toHaveCount(4);
  });

  test("shows the message itself when the form says nothing", async ({
    page,
  }) => {
    await compare(page).getByTestId("ask-button-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Compare the page counts of every book",
    );
  });

  test("with the client runtime a button that carries the answer shows its words", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the label is read from the page by a script");
    // A button with a name and a value is the answer itself, as on a
    // Correct / Wrong / Not sure card.
    await compare(page)
      .getByTestId("ask-button-submit")
      .evaluate((button) => {
        button.setAttribute("name", "verdict");
        button.setAttribute("value", "compare");
      });
    await compare(page).getByTestId("ask-button-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Compare lengths",
    );
    await expect(
      page.getByTestId("turn-live").getByTestId("bar-row"),
    ).toHaveCount(4);
    await page.reload();
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Compare lengths",
    );
  });

  test("with the client runtime the message is shown when the form asks for it", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the label is read from the page by a script");
    await compare(page).evaluate((form) => {
      form.setAttribute("data-answer", "message");
      const button = form.querySelector("button")!;
      button.setAttribute("name", "verdict");
      button.setAttribute("value", "compare");
    });
    await compare(page).getByTestId("ask-button-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Compare the page counts of every book",
    );
  });

  test("with the client runtime a named button does not replace words the reader typed", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the label is read from the page by a script");
    // A box named text that the reader fills in, sent by a button with a name.
    await compare(page).evaluate((form) => {
      const box = form.querySelector("input")!;
      box.type = "text";
      box.value = "Which of these is the longest?";
      const button = form.querySelector("button")!;
      button.setAttribute("name", "intent");
      button.setAttribute("value", "ask");
    });
    await compare(page).getByTestId("ask-button-submit").click();
    await settled(page);
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Which of these is the longest?",
    );
    await page.reload();
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "Which of these is the longest?",
    );
  });

  test("with the client runtime the form's own words are shown at once when it has no text field", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the echo is written by a script");
    await showField(compare(page), "Compare them for me");
    // The message goes under another name, as in a form of name: value lines.
    await compare(page).evaluate((form) => {
      form.querySelector('input[name="text"]')!.setAttribute("name", "Ask");
    });
    // Hold the request, so that what the page shows is its own echo.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/send", async (route) => {
      await held;
      await route.continue();
    });
    await compare(page).getByTestId("ask-button-submit").click();
    await expect(page.getByTestId("turn-pending")).toBeAttached();
    await expect(page.getByTestId("turn-user")).toHaveText([
      "Recommend a book",
      "Compare them for me",
    ]);
    release();
    await settled(page);
    await expect(page.getByTestId("turn-user")).toHaveText([
      "Recommend a book",
      "Compare them for me",
    ]);
  });
});

test.describe("a form whose fields the model named", () => {
  // Runs with scripts and without: the server reads the form's fields.
  test("sends a field named show as an answer, and shows the whole message", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await send(page, "Add a book to my reading log");
    const form = page.getByTestId("turn-live").getByTestId("input-form");
    const fields = form.getByTestId("text-field");
    // The model may name a field anything, show among them.
    await fields
      .getByLabel("One-line note")
      .evaluate((input) => input.setAttribute("name", "show"));
    await fields.getByLabel("Book").fill("Shipping Small Changes");
    await fields.getByLabel("Pages read").fill("42");
    await fields.getByLabel("One-line note").fill("Great so far");
    await form.getByTestId("input-form-submit").click();
    await settled(page);
    const message =
      "Book: Shipping Small Changes\nPages read: 42\nshow: Great so far";
    await expect(page.getByTestId("turn-user").last()).toHaveText(message);
    await page.reload();
    await expect(page.getByTestId("turn-user").last()).toHaveText(message);
  });
});

test.describe("a form pressed during a voice call", () => {
  /** The stand-in voice pauses on purpose: waits across a pause get room. */
  const PAUSED = { timeout: 30_000 };

  test("shows the form's words, tells the model its message, and stores both", async ({
    page,
  }) => {
    test.skip(!withScripts(), "a voice call is a script");
    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await page.addInitScript(
      "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no', 'NotAllowedError'); };",
    );
    await page.reload();
    const toggle = page.getByTestId("voice-call-toggle");
    await toggle.click();
    await expect(page.getByTestId("voice-call-status")).toHaveText(
      "No microphone: type to talk.",
    );
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    const form = page.getByTestId("turn-voice").getByTestId("ask-button");
    await expect(form).toHaveCount(1, PAUSED);

    await showField(form, "The short one, please");
    await form.getByTestId("ask-button-submit").click();
    await expect(page.getByTestId("turn-user").last()).toHaveText(
      "The short one, please",
      PAUSED,
    );
    // The model heard the message: it asks to hold the book.
    await expect(
      page.getByTestId("turn-voice").last().getByTestId("tool-approval"),
    ).toContainText("The Quiet Network", PAUSED);
    await expect(page.getByTestId("chat-thread")).not.toContainText(
      "Hold a copy of Shipping Small Changes",
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(page.getByTestId("turn-user")).toHaveText([
      "Recommend a book",
      "The short one, please",
    ]);
  });
});
