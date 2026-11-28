/**
 * The all-in-one, and the data parts it is made of.
 *
 * The starter (examples/starter, its own server) is a page that is
 * `<chat-app />` and nothing else: these specs use it the way a reader would,
 * so they show that the parts' defaults add up to a chat. The demo's
 * /fixtures pages fill chat-app's slots, and place each data part on a page
 * with none of the others.
 */
import { expect, test, type Page } from "@playwright/test";

/** The starter's server, started by playwright.config.ts. */
const STARTER = "http://127.0.0.1:4478";

/** True in the project that runs with the client runtime. */
const withScripts = (): boolean => test.info().project.name === "js";

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

test.describe("the starter: a page that is chat-app", () => {
  test.use({ baseURL: STARTER });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("is one tag in the page, with the head link a component cannot carry", async ({
    request,
  }) => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../examples/starter/src/pages/index.html", import.meta.url),
      "utf8",
    );
    const body = /<body>([\s\S]*)<\/body>/.exec(source)![1]!;
    expect(body.replace(/<!--[\s\S]*?-->/g, "").trim()).toBe("<chat-app />");
    const served = await (await request.get("/")).text();
    const head = served.slice(0, served.indexOf("</head>"));
    expect(head).toMatch(
      /<link rel="?expect"? href="?#thread-ready"? blocking="?render"?/,
    );
    expect(served).toContain('id="thread-ready"');
  });

  test("shows the project's welcome in an empty conversation, under one root", async ({
    page,
  }) => {
    const app = page.getByTestId("chat-app");
    await expect(app).toHaveAttribute("data-chat", "");
    await expect(page.locator("[data-chat]")).toHaveCount(1);
    // Every part is inside the root, the sidebar too.
    for (const part of ["sidebar", "composer", "thread", "welcome", "ready"]) {
      await expect(app.locator(`[data-chat-part="${part}"]`)).toHaveCount(1);
    }
    const welcome = page.getByTestId("chat-welcome");
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole("heading")).toHaveText(
      "What are you reading next?",
    );
    await expect(welcome.getByTestId("ask-button")).toHaveCount(2);
    await expect(page.getByTestId("chat-composer-input")).toBeFocused();
    // What the starter did not ask for is not there.
    await expect(page.getByTestId("chat-sidebar-model")).toHaveCount(0);
    // With no model to pick, the sidebar's foot is empty and takes no room.
    await expect(page.getByTestId("chat-sidebar-foot")).toBeHidden();
    await expect(page.getByTestId("voice-call")).toHaveCount(0);
    await expect(page.getByTestId("chat-sidebar-item")).toHaveCount(0);
    await expect(page.getByTestId("chat-setup-failed")).toHaveCount(0);
  });

  test("fills the window: the sidebar beside the chat, the composer at the bottom", async ({
    page,
  }) => {
    const size = page.viewportSize()!;
    const app = (await page.getByTestId("chat-app").boundingBox())!;
    expect(app).toEqual({ x: 0, y: 0, width: size.width, height: size.height });
    const side = (await page.getByTestId("chat-sidebar").boundingBox())!;
    const main = (await page.getByTestId("chat-app-main").boundingBox())!;
    expect(side.x).toBe(0);
    expect(side.width).toBe(256);
    expect(side.height).toBe(size.height);
    expect(main.x).toBe(256);
    expect(main.width).toBe(size.width - 256);
    const composer = (await page.getByTestId("chat-composer").boundingBox())!;
    // The page's 1rem under the composer, and nothing below that.
    expect(Math.round(composer.y + composer.height)).toBe(size.height - 16);
    expect(
      await page.evaluate(
        "document.documentElement.scrollHeight <= window.innerHeight",
      ),
    ).toBe(true);
  });

  test("answers a message, lists the conversation, and opens it again", async ({
    page,
  }) => {
    await page.evaluate("window.kept = true").catch(() => {});
    await send(page, "Recommend a book");
    await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
    const reply = page.locator(
      '[data-chat-part="turn"][data-role="assistant"]',
    );
    await expect(reply.getByTestId("stat-tile")).toHaveCount(3);
    await expect(reply).toContainText("You said: “Recommend a book”.");
    await expect(page.getByTestId("chat-welcome")).toBeHidden();
    if (withScripts()) {
      // The client runtime answered in the open page.
      expect(await page.evaluate("window.kept === true")).toBe(true);
    }
    // The sidebar is inside the root, and holds the conversation now.
    const item = page.getByTestId("chat-app").getByTestId("chat-sidebar-item");
    await expect(item).toHaveCount(1);
    await expect(item).toHaveText("Recommend a book");
    await expect(item).toHaveAttribute("aria-current", "true");

    await page.getByTestId("chat-sidebar-new").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByTestId("turn-user")).toHaveCount(0);
    await expect(item).toHaveAttribute("aria-current", "false");

    await item.click();
    await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
    await expect(page.getByTestId("turn-assistant")).toBeVisible();
    await expect(
      page.getByTestId("turn-assistant").getByTestId("stat-tile"),
    ).toHaveCount(3);
    await expect(item).toHaveAttribute("aria-current", "true");
  });

  test("sends a suggestion from the welcome", async ({ page }) => {
    await page
      .getByTestId("chat-welcome")
      .getByTestId("ask-button-submit")
      .first()
      .click();
    await settled(page);
    await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
  });

  test("finds a conversation by its words, and clears the search", async ({
    page,
  }) => {
    await send(page, "Tell me about lighthouses");
    await page.getByTestId("chat-sidebar-search-input").fill("lighthouses");
    await page.getByTestId("chat-sidebar-search-go").click();
    await expect(page).toHaveURL(/\?q=lighthouses$/);
    // The words are in the box again, and the results stand where the list was.
    await expect(page.getByTestId("chat-sidebar-search-input")).toHaveValue(
      "lighthouses",
    );
    const results = page.getByTestId("search-results");
    await expect(results).toBeVisible();
    await expect(page.getByTestId("chat-sidebar-search-note")).toContainText(
      "1 found",
    );
    await expect(results.getByTestId("search-result")).toHaveCount(1);
    await expect(results.locator("mark")).toHaveText("lighthouses");
    // The list is beside the results, so it is not shown.
    await expect(page.getByTestId("conversation-list")).toBeHidden();
    // The project names no page: the box and Clear stay on the page they
    // are on.
    await expect(
      page.getByTestId("chat-sidebar-search").locator("form"),
    ).not.toHaveAttribute("action");
    await expect(page.getByTestId("chat-sidebar-search-clear")).toHaveAttribute(
      "href",
      "/",
    );

    // A result opens its conversation, which loads the page with no search.
    await page.getByTestId("chat-sidebar-new").click();
    await page.goto("/?q=lighthouses");
    await page.getByTestId("search-result-open").click();
    await expect(page).toHaveURL(`${STARTER}/`);
    await expect(page.getByTestId("turn-user")).toHaveText(
      "Tell me about lighthouses",
    );

    await page.goto("/?q=zeppelins");
    await expect(page.getByTestId("chat-sidebar-search-empty")).toHaveText(
      "No conversation mentions “zeppelins”.",
    );
    await expect(page.getByTestId("search-result")).toHaveCount(0);
    await page.getByTestId("chat-sidebar-search-clear").click();
    await expect(page).toHaveURL(`${STARTER}/`);
    await expect(page.getByTestId("search-results")).toHaveCount(0);
    await expect(page.getByTestId("conversation-list")).toBeVisible();
  });

  test("is laid out the same on a page with no box-sizing reset", async ({
    page,
  }) => {
    await send(page, "Tell me about lighthouses");
    /** Where every part is, on a wide and a narrow screen, with the sidebar open. */
    const measure = async (): Promise<Record<string, string>> => {
      const boxes: Record<string, string> = {};
      for (const [width, address] of [
        [1280, "/"],
        [1280, "/?q=lighthouses"],
        [390, "/"],
        [390, "/?q=lighthouses"],
      ] as const) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(address);
        if (width === 390 && address === "/") {
          await page.getByTestId("chat-sidebar-toggle").click();
        }
        Object.assign(
          boxes,
          await page.evaluate(
            ([at]) => {
              const found: Record<string, string> = {};
              const seen = new Map<string, number>();
              for (const element of document.querySelectorAll(
                "[data-testid]",
              )) {
                const id = element.getAttribute("data-testid")!;
                const nth = seen.get(id) ?? 0;
                seen.set(id, nth + 1);
                const box = element.getBoundingClientRect();
                found[`${at} ${id} ${nth}`] = [
                  box.x,
                  box.y,
                  box.width,
                  box.height,
                ]
                  .map((value) => Math.round(value))
                  .join(" ");
              }
              found[`${at} page`] = String(
                document.documentElement.scrollWidth,
              );
              return found;
            },
            [`${width} ${address}`],
          ),
        );
      }
      return boxes;
    };
    const withReset = await measure();
    expect(Object.keys(withReset).length).toBeGreaterThan(60);
    // The same pages with the starter's `* { box-sizing: border-box }` gone:
    // a part that fills its width with padding sets its own box.
    let stripped = 0;
    await page.route("**/style.css", async (route) => {
      const response = await route.fetch();
      const css = (await response.text()).replace(
        /\*\s*\{\s*box-sizing:\s*border-box;?\s*\}/,
        () => {
          stripped++;
          return "";
        },
      );
      await route.fulfill({ response, body: css });
    });
    const without = await measure();
    expect(stripped).toBeGreaterThan(0);
    expect(without).toEqual(withReset);
  });

  test("keeps and serves a file sent with a message", async ({ page }) => {
    await page.getByTestId("chat-composer-files-input").setInputFiles({
      name: "reading-list.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Dune\nEmma\n"),
    });
    await send(page, "Here is my list");
    const file = page.getByTestId("turn-files").getByTestId("chat-attachment");
    await expect(file).toHaveCount(1);
    await expect(file.getByTestId("chat-attachment-name")).toHaveText(
      "reading-list.txt",
    );
    const href = await file.getAttribute("href");
    expect(href).toMatch(/^\/api\/file\?id=[\w-]+$/);
    const served = await page.request.get(href!);
    expect(served.status()).toBe(200);
    expect(await served.text()).toBe("Dune\nEmma\n");
  });

  test.describe("on a narrow screen", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("is a bar above the chat whose control opens the sidebar", async ({
      page,
    }) => {
      await send(page, "Recommend a book");
      const toggle = page.getByTestId("chat-sidebar-toggle");
      const item = page.getByTestId("chat-sidebar-item");
      await expect(toggle).toBeVisible();
      await expect(item).toBeHidden();
      const bar = (await page.getByTestId("chat-sidebar").boundingBox())!;
      const main = (await page.getByTestId("chat-app-main").boundingBox())!;
      expect(bar.y).toBe(0);
      expect(bar.width).toBe(390);
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // The chat takes the rest of the window, under the bar.
      expect(Math.round(main.y)).toBe(Math.round(bar.height));
      expect(Math.round(main.y + main.height)).toBe(844);

      await toggle.click();
      await expect(item).toBeVisible();
      await expect(page.getByTestId("chat-composer-input")).toBeVisible();
      await toggle.click();
      await expect(item).toBeHidden();
    });

    test("shows a page of search results whole, with no control, until cleared", async ({
      page,
    }) => {
      await send(page, "Tell me about lighthouses");
      await page.goto("/?q=lighthouses");
      // The sidebar is written in a template, so nothing set it open: it
      // shows because it holds the results.
      await expect(page.getByTestId("chat-sidebar-drawer")).not.toHaveAttribute(
        "open",
      );
      await expect(page.getByTestId("chat-sidebar-toggle")).toBeHidden();
      await expect(page.getByTestId("search-result")).toBeVisible();
      await expect(page.getByTestId("chat-sidebar-search-input")).toBeVisible();
      await expect(page.getByTestId("chat-composer-input")).toBeVisible();

      await page.getByTestId("chat-sidebar-search-clear").click();
      await expect(page.getByTestId("chat-sidebar-toggle")).toBeVisible();
      await expect(page.getByTestId("chat-sidebar-new")).toBeHidden();
    });
  });

  test("tells its page what happens, from the root", async ({ page }) => {
    test.skip(!withScripts(), "the events are the client runtime's");
    await page.evaluate(`{
      window.heard = [];
      const root = document.querySelector('[data-testid="chat-app"]');
      for (const type of ["chat:send", "chat:reply-start", "chat:reply-end"]) {
        root.addEventListener(type, (event) => window.heard.push(event.type));
      }
    }`);
    await send(page, "Recommend a book");
    expect(await page.evaluate("window.heard")).toEqual([
      "chat:send",
      "chat:reply-start",
      "chat:reply-end",
    ]);
    await expect(page.getByTestId("chat-app")).toHaveAttribute(
      "data-genui",
      "idle",
    );
  });
});

test.describe("chat-app's slots", () => {
  test("each replaces its part, and the default slot goes before the turns", async ({
    page,
  }) => {
    await page.goto("/fixtures/app-slots");
    const app = page.getByTestId("chat-app");

    // The sidebar is the page's: its own words, its own choice of parts.
    const side = app.getByTestId("chat-sidebar");
    await expect(side).toHaveCount(1);
    await expect(side.getByTestId("fixture-side")).toBeVisible();
    await expect(side.getByTestId("conversation-list")).toHaveCount(1);
    await expect(page.getByTestId("chat-sidebar-new")).toHaveCount(0);
    await expect(page.getByTestId("chat-sidebar-search")).toHaveCount(0);
    await expect(page.getByTestId("chat-sidebar-toggle")).toHaveText("Chats");

    // The composer is the page's: other words, and no attachments.
    await expect(app.getByTestId("chat-composer")).toHaveCount(1);
    await expect(page.getByTestId("chat-composer-input")).toHaveAttribute(
      "placeholder",
      "Write to the shop…",
    );
    await expect(page.getByTestId("chat-composer-attach")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer")).not.toHaveAttribute(
      "enctype",
    );
    await expect(page.getByTestId("chat-composer-input")).not.toBeFocused();

    // The notice is the thread's first child, before whatever chat-turns prints.
    const notice = page.getByTestId("fixture-notice");
    await expect(notice).toBeVisible();
    expect(
      await page.evaluate(`(() => {
        const thread = document.querySelector('[data-chat-part="thread"]');
        const notice = document.querySelector('[data-testid="fixture-notice"]');
        return (
          thread.firstElementChild === notice &&
          Boolean(thread.querySelector('[data-chat-part="ready"]'))
        );
      })()`),
    ).toBe(true);
    // The frame is still chat-app's.
    const main = (await page.getByTestId("chat-app-main").boundingBox())!;
    expect(main.x).toBe(256);
  });

  test("with none filled, a project that lists models gets the picker in the sidebar's foot", async ({
    page,
  }) => {
    await page.goto("/fixtures/app-plain");
    const side = page.getByTestId("chat-app").getByTestId("chat-sidebar");
    await expect(side.getByTestId("chat-sidebar-new")).toBeVisible();
    await expect(side.getByTestId("chat-sidebar-search")).toBeVisible();
    await expect(side.getByTestId("conversation-list")).toHaveCount(1);
    const foot = side.getByTestId("chat-sidebar-foot");
    await expect(foot).toBeVisible();
    await expect(foot.getByTestId("chat-sidebar-model")).toHaveCount(1);
    await expect(
      foot.getByTestId("chat-sidebar-model-select").locator("option"),
    ).not.toHaveCount(0);
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByTestId("chat-composer-attach")).toBeVisible();
  });

  test("an emptied sidebar slot leaves the chat the whole width", async ({
    page,
  }) => {
    await page.goto("/fixtures/app-bare");
    await expect(page.getByTestId("chat-sidebar")).toHaveCount(0);
    const size = page.viewportSize()!;
    const main = (await page.getByTestId("chat-app-main").boundingBox())!;
    expect(main).toEqual({
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
    });
    // The default composer and the default thread are still there.
    await expect(page.getByTestId("chat-composer-attach")).toBeVisible();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
  });
});

test.describe("a data part with none of the others", () => {
  test.beforeEach(async ({ page }) => {
    // A conversation to read: the fixtures share the bookshop's chat.
    await page.goto("/");
    await send(page, "Tell me about lighthouses");
  });

  test("chat-turns prints the conversation, then the welcome when it is new", async ({
    page,
  }) => {
    await page.goto("/fixtures/alone-turns");
    const thread = page.getByTestId("fixture-turns").getByTestId("chat-thread");
    await expect(thread.getByTestId("turn-user")).toHaveText(
      "Tell me about lighthouses",
    );
    await expect(thread.getByTestId("turn-assistant")).toBeVisible();
    await expect(thread.getByTestId("chat-thread-ready")).toBeAttached();
    await expect(page.getByTestId("chat-welcome")).toHaveCount(0);
    await expect(page.getByTestId("chat-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer")).toHaveCount(0);

    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await page.goto("/fixtures/alone-turns");
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByTestId("turn-user")).toHaveCount(0);
  });

  test("chat-conversations prints the list", async ({ page }) => {
    await page.goto("/fixtures/alone-list");
    const main = page.getByTestId("fixture-list");
    await expect(main.getByTestId("conversation-list")).toHaveCount(1);
    const item = main.getByTestId("chat-sidebar-item");
    await expect(item).toHaveText("Tell me about lighthouses");
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("chat-sidebar-search")).toHaveCount(0);
    await expect(page.getByTestId("chat-thread")).toHaveCount(0);
    // The item is the form the open route answers.
    await item.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("turn-user")).toHaveText(
      "Tell me about lighthouses",
    );
  });

  test("chat-conversations prints the list on an address with ?q= too, with no search part beside it", async ({
    page,
  }) => {
    // The page may use `q` for a search of its own.
    await page.goto("/fixtures/alone-list?q=lighthouses");
    const main = page.getByTestId("fixture-list");
    await expect(main.getByTestId("conversation-list")).toBeVisible();
    await expect(main.getByTestId("chat-sidebar-item")).toHaveText(
      "Tell me about lighthouses",
    );
    await expect(page.getByTestId("search-results")).toHaveCount(0);
  });

  test("chat-find prints the box, and the results when the page is a search", async ({
    page,
  }) => {
    await page.goto("/fixtures/alone-find");
    const main = page.getByTestId("fixture-find");
    await expect(main.getByTestId("chat-sidebar-search")).toHaveCount(1);
    await expect(page.getByTestId("search-results")).toHaveCount(0);
    await expect(page.getByTestId("conversation-list")).toHaveCount(0);

    // The box searches the page it is on, and Clear ends the search there.
    await main.getByTestId("chat-sidebar-search-input").fill("lighthouses");
    await main.getByTestId("chat-sidebar-search-go").click();
    await expect(page).toHaveURL(/\/fixtures\/alone-find\?q=lighthouses$/);
    await expect(main.getByTestId("search-result")).toHaveCount(1);
    await main.getByTestId("chat-sidebar-search-clear").click();
    await expect(page).toHaveURL(/\/fixtures\/alone-find$/);
    await expect(page.getByTestId("search-results")).toHaveCount(0);

    await page.goto("/fixtures/alone-find?q=lighthouses");
    await expect(main.getByTestId("chat-sidebar-search-input")).toHaveValue(
      "lighthouses",
    );
    await expect(main.getByTestId("search-result")).toHaveCount(1);
    await expect(main.getByTestId("search-result-title")).toHaveText(
      "Tell me about lighthouses",
    );
    await expect(main.getByTestId("chat-sidebar-search-note")).toContainText(
      "1 found",
    );
  });

  test("chat-models prints the picker with the project's label and notes", async ({
    page,
  }) => {
    await page.goto("/fixtures/alone-models");
    const picker = page
      .getByTestId("fixture-models")
      .getByTestId("chat-sidebar-model");
    await expect(picker).toHaveCount(1);
    await expect(picker).toContainText("Model for typed chat");
    await expect(
      picker.getByTestId("chat-sidebar-model-select").locator("option"),
    ).not.toHaveCount(0);
    await expect(picker.getByTestId("chat-sidebar-voice-note")).toBeVisible();
  });
});
