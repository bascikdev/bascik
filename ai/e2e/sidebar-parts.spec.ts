/**
 * The sidebar as parts, and the memory list's slots.
 *
 * /parts holds the parts placed by hand: a sidebar inside a chat with every
 * prop set, each sidebar part alone with none, and the memory list with its
 * own words, other words, and none. A route that starts with /parts/ is not
 * served: the spec answers it, which shows where the request went and
 * whether the browser or the client runtime sent it. The demo's own pages
 * show the sidebar with real conversations, on a wide and a narrow screen.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

/** True in the project that runs with the client runtime. */
const withScripts = (): boolean => test.info().project.name === "js";

const TAKEN = `<!doctype html><title>Taken</title><p data-testid="parts-taken">Taken</p>`;

/** Answer every request to a /parts/ route with a page, and keep the requests. */
async function taken(page: Page): Promise<Request[]> {
  const seen: Request[] = [];
  await page.route("**/parts/**", async (route) => {
    seen.push(route.request());
    await route.fulfill({ status: 200, contentType: "text/html", body: TAKEN });
  });
  return seen;
}

/** Wait for the reply's last chunk, and for the client runtime to be idle. */
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

test.describe("the sidebar parts, each alone", () => {
  test("have words and routes of their own", async ({ page }) => {
    await page.goto("/parts");
    const alone = page.getByTestId("parts-alone");

    const fresh = alone.getByTestId("chat-new");
    await expect(fresh).toHaveAttribute("action", "/api/open");
    await expect(fresh).toHaveAttribute("method", "post");
    await expect(fresh.getByTestId("chat-sidebar-new")).toHaveText(
      "+ New chat",
    );

    // With no route, a search loads the page the form is on.
    const search = alone.getByTestId("chat-sidebar-search");
    await expect(search.locator("form")).not.toHaveAttribute("action");
    await expect(search.locator("form")).toHaveAttribute("method", "get");
    const box = search.getByTestId("chat-sidebar-search-input");
    await expect(box).toHaveAttribute("placeholder", "Search conversations");
    await expect(box).toHaveValue("");
    await expect(search.getByRole("searchbox")).toHaveAccessibleName(
      "Search conversations",
    );
    await expect(search.getByTestId("chat-sidebar-search-go")).toHaveText(
      "Search",
    );

    await expect(
      alone.getByRole("navigation", { name: "Conversations" }),
    ).toHaveAttribute("data-testid", "conversation-list");

    const item = alone.getByTestId("conversation-item").first();
    await expect(item).toHaveAttribute("action", "/api/open");
    await expect(item.getByTestId("chat-sidebar-item")).toHaveText(
      "Conversation",
    );
    await expect(item.getByTestId("chat-sidebar-item")).not.toHaveAttribute(
      "aria-current",
    );

    const model = alone.getByTestId("chat-sidebar-model");
    await expect(model).toHaveAttribute("action", "/api/model");
    await expect(model.getByRole("combobox")).toHaveAccessibleName("Model");
    await expect(model.getByTestId("chat-sidebar-model-use")).toHaveText("Use");

    // An empty sidebar: its foot takes no room.
    const sidebar = alone.getByTestId("chat-sidebar");
    await expect(sidebar).toHaveAttribute("data-chat-part", "sidebar");
    await expect(sidebar.getByTestId("chat-sidebar-foot")).toBeHidden();
    await expect(sidebar.getByTestId("chat-sidebar-toggle")).toHaveText("Menu");
  });

  test("take their words, their state and their routes from props", async ({
    page,
  }) => {
    await page.goto("/parts");
    const side = page.getByTestId("parts-side");

    await expect(side.getByTestId("chat-sidebar-toggle")).toHaveText("Shelves");
    await expect(side.getByTestId("chat-sidebar-new")).toHaveText("Start over");

    const box = side.getByTestId("chat-sidebar-search-input");
    await expect(box).toHaveValue("sea");
    await expect(box).toHaveAttribute("placeholder", "Find…");
    await expect(box).toHaveAccessibleName("Find a conversation");
    await expect(side.getByTestId("chat-sidebar-search-go")).toHaveText("Find");

    const list = side.getByRole("navigation", { name: "Recent conversations" });
    const items = list.getByTestId("chat-sidebar-item");
    await expect(items).toHaveText([
      "Books about the sea",
      "Ursula K. Le Guin",
    ]);
    await expect(items.first()).toHaveAttribute("aria-current", "true");
    await expect(items.last()).not.toHaveAttribute("aria-current");

    const model = side.getByTestId("chat-sidebar-model");
    await expect(model.getByRole("combobox")).toHaveAccessibleName(
      "Model for answers",
    );
    await expect(model.getByTestId("chat-sidebar-model-select")).toHaveValue(
      "large",
    );
    await expect(model.getByTestId("chat-sidebar-model-use")).toHaveText(
      "Choose",
    );
    // The note is the page's paragraph, in the picker's small print.
    const note = model.getByTestId("parts-model-note");
    await expect(note).toBeVisible();
    await expect(note).toHaveCSS("font-size", "12px");

    // The foot holds the picker, under everything else in the sidebar.
    const foot = side.getByTestId("chat-sidebar-foot");
    await expect(foot.getByTestId("chat-sidebar-model")).toBeVisible();
    const footTop = (await foot.boundingBox())!.y;
    const resultBottom = await side
      .getByTestId("search-result")
      .boundingBox()
      .then((at) => at!.y + at!.height);
    expect(footTop).toBeGreaterThanOrEqual(resultBottom);
  });

  test("a conversation fills a plain column and cuts a long title short", async ({
    page,
  }) => {
    await page.goto("/parts");
    const column = page.getByTestId("parts-narrow");
    const open = column.getByTestId("chat-sidebar-item");
    const width = (await column.boundingBox())!.width;
    expect((await open.boundingBox())!.width).toBe(width);
    expect(
      await open.evaluate((button) => button.scrollWidth > button.clientWidth),
    ).toBe(true);
    // A short title is as wide a target as a long one.
    const short = page
      .getByTestId("parts-alone")
      .getByTestId("chat-sidebar-item")
      .first();
    const row = await short.evaluate(
      (button) => button.closest("section")!.getBoundingClientRect().width,
    );
    expect((await short.boundingBox())!.width).toBe(row);
  });

  test("the narrow screen's control is a finger tall whatever the page's line height", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/parts");
    // The fixture sets a line height of 1 around this sidebar.
    const toggle = page
      .getByTestId("parts-alone")
      .getByTestId("chat-sidebar-toggle");
    await expect(toggle).toBeVisible();
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("a search is a page load with the words in the address", async ({
    page,
  }) => {
    await page.goto("/parts");
    const sent = await taken(page);
    const side = page.getByTestId("parts-side");
    await side.getByTestId("chat-sidebar-search-input").fill("the sea");
    await side.getByTestId("chat-sidebar-search-go").click();
    await expect(page.getByTestId("parts-taken")).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method()).toBe("GET");
    expect(sent[0]!.isNavigationRequest()).toBe(true);
    const url = new URL(sent[0]!.url());
    expect(url.pathname).toBe("/parts/search");
    expect(url.searchParams.get("q")).toBe("the sea");
  });
});

test.describe("inside a chat, a sidebar form that must load a page is the browser's", () => {
  for (const [name, hook, path, field, value] of [
    ["chat-new", "chat-sidebar-new", "/parts/new", "id", null],
    [
      "conversation-item",
      "chat-sidebar-item",
      "/parts/open-item",
      "id",
      "conversation-1",
    ],
    [
      "search-result",
      "search-result-open",
      "/parts/open-result",
      "id",
      "conversation-3",
    ],
    [
      "model-picker",
      "chat-sidebar-model-use",
      "/parts/model",
      "model",
      "large",
    ],
    ["memory-item", "memory-item-forget", "/parts/forget", "id", "memory-7"],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto("/parts");
      const sent = await taken(page);
      await page.evaluate("window.kept = true");
      await page.getByTestId("parts-side").getByTestId(hook).first().click();
      // The page was loaded: the client runtime did not fetch the answer.
      await expect(page.getByTestId("parts-taken")).toBeVisible();
      expect(await page.evaluate("window.kept")).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method()).toBe("POST");
      expect(sent[0]!.isNavigationRequest()).toBe(true);
      expect(new URL(sent[0]!.url()).pathname).toBe(path);
      const fields = new URLSearchParams(sent[0]!.postData() ?? "");
      expect(fields.get("app")).toBe("books");
      expect(fields.get(field)).toBe(value);
    });
  }

  test("and it is the mark on the form that says so", async ({ page }) => {
    test.skip(!withScripts(), "the client runtime is a script");
    await page.goto("/parts");
    const sent = await taken(page);
    const side = page.getByTestId("parts-side");
    for (const hook of [
      "chat-new",
      "conversation-item",
      "chat-sidebar-model",
    ]) {
      await expect(side.getByTestId(hook).first()).toHaveAttribute(
        "data-genui",
        "native",
      );
    }
    for (const hook of ["search-result", "memory-item"]) {
      await expect(side.getByTestId(hook).locator("form")).toHaveAttribute(
        "data-genui",
        "native",
      );
    }
    // Without the mark the client runtime takes the form, as it takes any
    // other in the chat: the first request is its fetch, not a page load.
    await side
      .getByTestId("chat-new")
      .evaluate((form) => form.removeAttribute("data-genui"));
    await side.getByTestId("chat-sidebar-new").click();
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]!.isNavigationRequest()).toBe(false);
  });
});

test.describe("the demo's sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
  });

  test("is replaced by the answer's after a reply, and still works", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the client runtime is a script");
    await page.evaluate(`
      window.kept = true;
      document.querySelector('[data-testid="chat-sidebar"]').old = true;
    `);
    await send(page, "Recommend a book");
    // No page was loaded, and the sidebar in the page is a new element.
    expect(await page.evaluate("window.kept")).toBe(true);
    const sidebar = page.getByTestId("chat-sidebar");
    await expect(sidebar).toHaveCount(1);
    expect(await sidebar.evaluate((element) => "old" in element)).toBe(false);
    await expect(sidebar).toHaveAttribute("data-chat-part", "sidebar");
    // It holds what the server now knows: the conversation, marked as open.
    const first = sidebar.getByTestId("chat-sidebar-item").first();
    await expect(first).toHaveText("Recommend a book");
    await expect(first).toHaveAttribute("aria-current", "true");
    await expect(sidebar.getByTestId("chat-sidebar-app")).toHaveCount(4);
    await expect(
      sidebar
        .getByTestId("chat-sidebar-foot")
        .getByTestId("chat-sidebar-model-select"),
    ).toBeVisible();
    await expect(
      sidebar
        .getByTestId("chat-sidebar-foot")
        .getByTestId("chat-sidebar-memory"),
    ).toBeVisible();
    // Its forms still load a page.
    for (const hook of [
      "chat-new",
      "conversation-item",
      "chat-sidebar-model",
    ]) {
      await expect(sidebar.getByTestId(hook).first()).toHaveAttribute(
        "data-genui",
        "native",
      );
    }
    await sidebar.getByTestId("chat-sidebar-new").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    expect(await page.evaluate("window.kept")).toBeUndefined();
  });

  test("on a wide screen shows everything, with no control to open it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const sidebar = page.getByTestId("chat-sidebar");
    await expect(sidebar.getByTestId("chat-sidebar-toggle")).toBeHidden();
    await expect(
      sidebar.getByTestId("chat-sidebar-drawer"),
    ).not.toHaveAttribute("open");
    await expect(sidebar.getByTestId("chat-sidebar-new")).toBeVisible();
    await expect(
      sidebar.getByTestId("chat-sidebar-search-input"),
    ).toBeVisible();
    await expect(sidebar.getByTestId("chat-sidebar-memory")).toBeVisible();
    // It is a column the height of the window, with its foot at the bottom.
    const column = (await sidebar.boundingBox())!;
    expect(column.width).toBe(256);
    expect(column.height).toBe(800);
    const foot = (await sidebar
      .getByTestId("chat-sidebar-foot")
      .boundingBox())!;
    expect(Math.round(foot.y + foot.height)).toBe(800 - 16);
  });

  test("on a narrow screen opens from one control, and a chosen conversation closes it", async ({
    page,
  }) => {
    await send(page, "Tell me about lighthouses");
    await page.getByTestId("chat-sidebar-new").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await send(page, "Recommend a book");

    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByTestId("chat-sidebar");
    const toggle = sidebar.getByTestId("chat-sidebar-toggle");
    const drawer = sidebar.getByTestId("chat-sidebar-drawer");
    const items = sidebar.getByTestId("chat-sidebar-item");
    const composer = page.getByTestId("chat-composer");

    // Closed: a labeled bar above the chat, a finger wide.
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Menu");
    const bar = (await toggle.boundingBox())!;
    expect(bar.y).toBe(0);
    expect(bar.width).toBe(390);
    expect(bar.height).toBeGreaterThanOrEqual(44);
    await expect(drawer).not.toHaveAttribute("open");
    await expect(items.first()).toBeHidden();
    await expect(sidebar.getByTestId("chat-sidebar-memory")).toBeHidden();
    await expect(composer).toBeInViewport({ ratio: 1 });

    // Open, from the keyboard: everything in it can be reached, and the
    // composer is still on the screen.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(drawer).toHaveAttribute("open");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS("outline-style", "solid");
    await expect(items).toHaveCount(2);
    await expect(items.last()).toBeVisible();
    await expect(sidebar.getByTestId("chat-sidebar-new")).toBeVisible();
    await expect(
      sidebar.getByTestId("chat-sidebar-search-input"),
    ).toBeVisible();
    await expect(
      sidebar.getByTestId("chat-sidebar-model-select"),
    ).toBeVisible();
    await sidebar.getByTestId("chat-sidebar-memory").scrollIntoViewIfNeeded();
    await expect(sidebar.getByTestId("chat-sidebar-memory")).toBeVisible();
    await expect(composer).toBeInViewport({ ratio: 1 });
    // The control stays in view while the content scrolls.
    await expect(toggle).toBeInViewport({ ratio: 1 });

    // And closed again from the same control.
    await toggle.click();
    await expect(drawer).not.toHaveAttribute("open");
    await expect(items.first()).toBeHidden();

    // Choosing a conversation loads it, and the page it loads is closed.
    await toggle.click();
    await page.evaluate("window.kept = true");
    await items.filter({ hasText: "Tell me about lighthouses" }).click();
    await expect(page.getByTestId("turn-user")).toHaveText(
      "Tell me about lighthouses",
    );
    expect(await page.evaluate("window.kept")).toBeUndefined();
    await expect(drawer).not.toHaveAttribute("open");
    await expect(items.first()).toBeHidden();
    await expect(toggle).toBeVisible();
  });

  test("on a narrow screen a search loads with its results showing", async ({
    page,
  }) => {
    await send(page, "Tell me about lighthouses");
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByTestId("chat-sidebar");
    const toggle = sidebar.getByTestId("chat-sidebar-toggle");
    await toggle.click();
    await sidebar.getByTestId("chat-sidebar-search-input").fill("lighthouses");
    await sidebar.getByTestId("chat-sidebar-search-go").click();
    await expect(sidebar.getByTestId("chat-sidebar-drawer")).toHaveAttribute(
      "open",
    );
    await expect(sidebar.getByTestId("search-result-title")).toBeVisible();
    // The reader can still close it.
    await toggle.click();
    await expect(sidebar.getByTestId("search-result-title")).toBeHidden();
    await expect(page.getByTestId("chat-composer")).toBeInViewport({
      ratio: 1,
    });
  });

  test("on a narrow screen the client runtime's answer leaves it as the reader had it", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the client runtime is a script");
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByTestId("chat-sidebar");
    const drawer = sidebar.getByTestId("chat-sidebar-drawer");
    // Open: the answer's sidebar takes its place, open, so nothing moves
    // under a finger when the reply ends.
    await sidebar.getByTestId("chat-sidebar-toggle").click();
    await expect(sidebar.getByTestId("chat-sidebar-new")).toBeVisible();
    await send(page, "Recommend a book");
    await expect(sidebar.getByTestId("chat-sidebar-item").first()).toHaveText(
      "Recommend a book",
    );
    await expect(drawer).toHaveAttribute("open");
    await expect(
      sidebar.getByTestId("chat-sidebar-item").first(),
    ).toBeVisible();
    // Closed: it stays closed.
    await sidebar.getByTestId("chat-sidebar-toggle").click();
    await expect(drawer).not.toHaveAttribute("open");
    await send(page, "And one by Octavia Butler");
    await expect(page.getByTestId("turn-user")).toHaveCount(2);
    await expect(drawer).not.toHaveAttribute("open");
    await expect(sidebar.getByTestId("chat-sidebar-new")).toBeHidden();
  });
});

test.describe("the memory list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/parts");
  });

  test("has words of its own", async ({ page }) => {
    const list = page
      .getByTestId("parts-memory-default")
      .getByTestId("memory-list");
    await expect(list.getByRole("heading", { level: 1 })).toHaveText(
      "What I remember about you",
    );
    await expect(list.getByTestId("memory-list-about")).toContainText(
      "Memory is what the assistant keeps about you between conversations",
    );
    await expect(list.getByTestId("memory-list-empty")).toBeVisible();
    await expect(list.getByTestId("memory-list-empty")).toContainText(
      "Nothing is remembered yet.",
    );
  });

  test("takes other words, and a heading of the page's level", async ({
    page,
  }) => {
    const list = page
      .getByTestId("parts-memory-words")
      .getByTestId("memory-list");
    await expect(list.getByRole("heading")).toHaveCount(1);
    const heading = list.getByRole("heading", { level: 3 });
    await expect(heading).toHaveText("Remembered");
    // The page's heading is drawn as the list's own is.
    await expect(heading).toHaveCSS("font-size", "24px");
    await expect(heading).toHaveCSS("margin-top", "0px");
    await expect(list.getByTestId("memory-list-about")).toHaveText(
      "Kept for this shelf only.",
    );
    await expect(list.getByTestId("memory-list-empty")).toBeVisible();
    await expect(list.getByTestId("memory-list-empty")).toHaveText(
      "No notes on this shelf yet.",
    );
  });

  test("leaves out a piece the page blanks, with the room it took", async ({
    page,
  }) => {
    const bare = page
      .getByTestId("parts-memory-bare")
      .getByTestId("memory-list");
    await expect(bare.getByRole("heading")).toHaveCount(0);
    await expect(bare.getByTestId("memory-list-about")).toBeHidden();
    await expect(bare.getByTestId("memory-list-empty")).toBeHidden();
    expect((await bare.boundingBox())!.height).toBe(0);

    // With an item, and no line under the heading: the item follows the
    // heading at one gap, and the empty state is not shown.
    const filled = page
      .getByTestId("parts-memory-items")
      .getByTestId("memory-list");
    await expect(filled.getByTestId("memory-list-about")).toBeHidden();
    await expect(filled.getByTestId("memory-list-empty")).toBeHidden();
    const heading = (await filled.getByRole("heading").boundingBox())!;
    const item = (await filled.getByTestId("memory-item").boundingBox())!;
    expect(Math.round(item.y - (heading.y + heading.height))).toBe(12);
  });

  test("fills the width it is given, with no space around itself", async ({
    page,
  }) => {
    const list = page
      .getByTestId("parts-memory-default")
      .getByTestId("memory-list");
    await expect(list).toHaveCSS("max-inline-size", "none");
    await expect(list).toHaveCSS("padding-top", "0px");
    await expect(list).toHaveCSS("margin-left", "0px");
    await page.getByTestId("parts-memory-default").evaluate((holder) => {
      holder.style.inlineSize = "20rem";
    });
    expect((await list.boundingBox())!.width).toBe(320);
  });
});

test("the memory page gives the list its column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/memory");
  const list = (await page.getByTestId("memory-list").boundingBox())!;
  const back = (await page.getByTestId("memory-back").boundingBox())!;
  // 46rem wide, centered in what the sidebar leaves, under the link back.
  expect(list.width).toBe(736);
  expect(list.x).toBe(256 + (1280 - 256 - 736) / 2);
  expect(back.x).toBe(list.x);
  expect(Math.round(list.y - (back.y + back.height))).toBe(24);
});
