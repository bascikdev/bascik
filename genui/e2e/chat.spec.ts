import { expect, test, type Page } from "@playwright/test";

/** Send from the composer and wait for the reply's last chunk. */
async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
  await expect(page.getByTestId("turn-done")).toBeAttached();
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
  await expect(page.getByTestId("turn-done")).toBeAttached();
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

test("a generated choice form and input form post their answers", async ({
  page,
}) => {
  await send(page, "Help me choose a book");
  const form = page.getByTestId("turn-live").getByTestId("choice-form");
  await form.getByText("Short enough for a weekend").click();
  await form.getByTestId("choice-form-submit").click();
  await expect(page.getByTestId("turn-done")).toBeAttached();
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
  await expect(page.getByTestId("turn-done")).toBeAttached();
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

test("the shell is sent before the reply and the reply arrives in pieces", async ({
  page,
  baseURL,
}) => {
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
