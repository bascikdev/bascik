/**
 * The books chat in local workerd (`wrangler dev`, see playwright.config.ts),
 * with the client runtime on: every reply is written by a request, read by
 * others through the conversation's ConversationLive object, and stored in
 * the reader's ReaderData object. Each test is a new browser context, so a
 * new reader.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";

/** Wait for the client runtime to finish the reply in the open page. */
async function settled(page: Page): Promise<void> {
  // The runtime marks the document itself, which has no test id to locate.
  await expect
    .poll(() => page.evaluate("document.documentElement.dataset.genui"))
    .toBe("idle");
  await expect(page.getByTestId("turn-done")).toBeAttached();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
  await settled(page);
}

/** Send without waiting for the reply: it is still being written. */
async function start(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
  await expect(page.getByTestId("turn-writing")).toBeAttached();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("chat-welcome")).toBeVisible();
});

test("a message gets a streamed reply with book cards, kept after a reload", async ({
  page,
}) => {
  await expect(page.getByTestId("chat-retention")).toContainText("24 hours");
  await send(page, "Recommend a book");
  const cards = page.getByTestId("turn-live").getByTestId("book-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.first().getByTestId("book-card-title")).toHaveText(
    "Refactoring the Monolith",
  );
  await expect(cards.first()).toHaveCSS("display", "grid");
  await page.reload();
  await expect(
    page.getByTestId("turn-assistant").getByTestId("book-card"),
  ).toHaveCount(3);
});

test("a tool that changes something waits for approval; a denied one never runs", async ({
  page,
}) => {
  await send(page, "Hold a copy of The Quiet Network");
  await expect(page.getByTestId("tool-approval")).toHaveCount(1);
  await page.getByTestId("tool-approval-allow").click();
  await settled(page);
  await expect(page.getByTestId("turn-live")).toContainText("Hold number H-");

  await send(page, "Hold a copy of Shipping Small Changes");
  await page.getByTestId("tool-approval-deny").click();
  await settled(page);
  await expect(page.getByTestId("turn-live")).toContainText("nothing was held");
});

test("a memory is saved with the reader's OK and used in a new conversation", async ({
  page,
}) => {
  await send(page, "Remember that I prefer short books");
  await page.getByTestId("tool-approval-allow").click();
  await settled(page);
  await expect(page.getByTestId("memory-note")).toContainText(
    "I prefer short books",
  );
  await page.getByTestId("chat-sidebar-new").click();
  await expect(page.getByTestId("chat-welcome")).toBeVisible();
  await send(page, "What do you know about me?");
  await expect(page.getByTestId("turn-live")).toContainText(
    "I prefer short books",
  );
  await page.getByTestId("chat-sidebar-memory").click();
  await expect(page.getByTestId("memory-item")).toHaveCount(1);
});

test("on a narrow screen the sidebar opens from its control, and a conversation closes it", async ({
  page,
}) => {
  await send(page, "Recommend a book");
  await page.getByTestId("chat-sidebar-new").click();
  await expect(page.getByTestId("chat-welcome")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByTestId("chat-sidebar-toggle");
  const item = page.getByTestId("chat-sidebar-item");
  await expect(toggle).toBeVisible();
  await expect(item).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId("chat-sidebar-memory")).toBeVisible();
  await expect(page.getByTestId("chat-composer")).toBeInViewport({ ratio: 1 });
  // The form is the browser's to send: the page it loads is closed again.
  await item.click();
  await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
  await expect(page.getByTestId("chat-sidebar-drawer")).not.toHaveAttribute(
    "open",
  );
  await expect(item).toBeHidden();
});

test("search finds an earlier conversation", async ({ page }) => {
  await send(page, "Recommend a book");
  await page.getByTestId("chat-sidebar-new").click();
  await send(page, "Help me choose a book");
  await page.getByTestId("chat-sidebar-search-input").fill("Recommend");
  await page.getByTestId("chat-sidebar-search-go").click();
  const results = page.getByTestId("chat-sidebar-search-results");
  await expect(results.getByTestId("search-result")).toHaveCount(1);
  await expect(results).toContainText("Recommend");
});

test("a small picture is accepted, and a body over the cap gets 413", async ({
  page,
}) => {
  // A PNG signature and 500 KB after it: the server checks the leading bytes.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(500 * 1024),
  ]);
  await page
    .getByTestId("chat-composer-files-input")
    .setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
  await send(page, "What do you make of this?");
  await expect(page.getByTestId("turn-live")).toContainText(
    "cover.png (image/png)",
  );
  await page.reload();
  await expect(page.getByTestId("chat-attachment")).toHaveCount(1);

  const refused = await page.request.post("/api/send", {
    multipart: {
      app: "books",
      text: "too big",
      files: {
        name: "big.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(3 * 1024 * 1024),
      },
    },
  });
  expect(refused.status()).toBe(413);
});

test("Stop ends the reply, and what was written is kept", async ({ page }) => {
  await start(page, "Recommend a book");
  await page.getByTestId("chat-composer-stop").click();
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("turn-assistant")).toHaveCount(1);
  await expect(page.getByTestId("turn-writing")).toHaveCount(0);
  await expect(
    page.getByTestId("turn-assistant").getByTestId("book-card"),
  ).toHaveCount(0);
});

test("a reload mid-reply rejoins it from its first piece", async ({ page }) => {
  await start(page, "Recommend a book");
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByTestId("turn-writing")).toBeAttached();
  await expect(page.getByTestId("turn-done")).toHaveCount(0);
  const live = page.getByTestId("turn-live");
  await expect(live).toContainText("Three picks from the catalog");
  await expect(page.getByTestId("turn-done")).toBeAttached();
  await expect(live.getByTestId("book-card")).toHaveCount(3);
  await expect(page.getByTestId("turn-gap")).toHaveCount(0);
});

test("a second tab follows the live reply, and its Stop ends it", async ({
  page,
}) => {
  await start(page, "Recommend a book");
  const second = await page.context().newPage();
  // Not waiting for "load": that fires only once the streamed page ends.
  await second.goto("/", { waitUntil: "commit" });
  await expect(second.getByTestId("turn-writing")).toBeAttached();
  await expect(second.getByTestId("turn-live")).toContainText(
    "Three picks from the catalog",
  );
  await expect(second.getByTestId("turn-done")).toHaveCount(0);
  // Stop from the second tab: the request goes through the shared object.
  const stopped = await second.request.post("/api/stop", {
    form: { app: "books" },
  });
  expect(stopped.status()).toBe(204);
  await expect(second.getByTestId("turn-done")).toBeAttached();
  await settled(page);
  await second.reload();
  await expect(second.getByTestId("turn-assistant")).toHaveCount(1);
  await expect(
    second.getByTestId("turn-assistant").getByTestId("book-card"),
  ).toHaveCount(0);
});

// Local workerd does not report a closed tab, so the writer's request runs
// on here with or without waitUntil: this checks what a reader sees, and
// tests/routes.workers.test.ts checks that the reply is handed to waitUntil.
test("a tab closed mid-reply, opened again, shows the whole reply", async ({
  page,
  context,
}) => {
  await start(page, "Recommend a book");
  await expect(page.getByTestId("turn-live")).toContainText(
    "Three picks from the catalog",
  );
  await page.close();
  const again = await context.newPage();
  await again.goto("/", { waitUntil: "commit" });
  await settled(again);
  await again.reload();
  await expect(again.getByTestId("turn-assistant")).toHaveCount(1);
  await expect(
    again.getByTestId("turn-assistant").getByTestId("book-card"),
  ).toHaveCount(3);
  await expect(again.getByTestId("turn-writing")).toHaveCount(0);
});

const objectsRoot = () =>
  join(process.env.BASCIK_AI_CF_E2E_PERSIST!, "v3", "do");

/** Every Durable Object database wrangler dev keeps for this run, by path. */
function objectFiles(): string[] {
  if (!existsSync(objectsRoot())) return [];
  return readdirSync(objectsRoot(), { recursive: true, encoding: "utf8" })
    .filter(
      (path) => path.endsWith(".sqlite") && !path.endsWith("metadata.sqlite"),
    )
    .sort();
}

/**
 * What an object's database holds beyond what local workerd writes for any
 * object it starts (its name, and the empty tables of its key-value API):
 * the chat's tables, stored keys, or an alarm.
 */
function storedIn(path: string): string[] {
  const db = new DatabaseSync(join(objectsRoot(), path), { readOnly: true });
  try {
    const held: string[] = [];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (name === "__miniflare_do_name") continue;
      const { rows } = db
        .prepare(`SELECT COUNT(*) AS rows FROM "${name}"`)
        .get() as { rows: number };
      if (!name.startsWith("_cf_") || rows > 0) held.push(`${name}=${rows}`);
    }
    return held;
  } finally {
    db.close();
  }
}

test("a visitor with no cookie can read every page without anything being stored", async () => {
  const before = new Set(objectFiles());
  // The check can see stored data: the specs before this one stored some.
  if (before.size > 0) {
    expect([...before].some((path) => storedIn(path).length > 0)).toBe(true);
  }
  for (const path of [
    "/",
    "/memory",
    "/api/file?app=books&id=nothing-here",
    "/?c=99999999-9999-4999-8999-999999999999",
  ]) {
    // Node's fetch keeps no cookies: each request is a first visit.
    const response = await fetch(
      new URL(path, test.info().project.use.baseURL!).href,
      { redirect: "manual" },
    );
    await response.arrayBuffer();
    expect(response.status, path).toBeLessThan(500);
  }
  // Local workerd makes a file for every object a request reaches; none of
  // the new ones may hold anything.
  const reached = objectFiles().filter((path) => !before.has(path));
  expect(
    reached
      .map((path) => [path, storedIn(path)])
      .filter(([, held]) => held.length),
  ).toEqual([]);
});

test("the API refuses a method it does not take, and a body with no length", async ({
  request,
}) => {
  expect((await request.put("/api/send", { data: "x" })).status()).toBe(405);
  const chunked = await fetch(
    new URL("/api/send", test.info().project.use.baseURL!).href,
    {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("text=hi"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit,
  );
  expect(chunked.status).toBe(411);
});
