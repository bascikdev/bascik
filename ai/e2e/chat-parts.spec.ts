/**
 * The contract between the chat's parts.
 *
 * The parts find each other from the nearest `data-chat` element, by
 * `data-chat-part`; a page written before those marks existed is still found
 * by its test hooks. What happens is announced with `chat:*` events from the
 * `data-chat` element. And the thread part styles what is in it by those
 * marks, so a mark that goes missing, or a rule that stops matching, shows
 * here as a style that is no longer applied.
 */
import { expect, test, type Page } from "@playwright/test";

/** True in the project that runs with the client runtime. */
const withScripts = (): boolean => test.info().project.name === "js";

async function settled(page: Page): Promise<void> {
  if (withScripts()) {
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
  }
  await expect(page.getByTestId("turn-done")).toBeAttached();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
  await settled(page);
}

async function freshChat(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await page.getByTestId("chat-sidebar-new").click();
  await expect(page.getByTestId("chat-welcome")).toBeVisible();
}

/** A computed style of the first element `selector` finds. */
const styleOf = (
  page: Page,
  selector: string,
  property: string,
  pseudo?: string,
): Promise<string> =>
  page.evaluate(
    ([selector, property, pseudo]) => {
      const element = document.querySelector(selector!);
      if (!element) throw new Error(`nothing matches ${selector}`);
      return getComputedStyle(element, pseudo ?? null).getPropertyValue(
        property!,
      );
    },
    [selector, property, pseudo] as const,
  );

/** A color the theme names, as the browser computes it for the page. */
const themeColor = (page: Page, token: string): Promise<string> =>
  page.evaluate((token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

test.describe("the thread part styles what is in it", () => {
  test("an empty thread shows the welcome and no reply", async ({ page }) => {
    await freshChat(page);
    const thread = page.getByTestId("chat-thread");
    await expect(thread).toHaveAttribute("data-chat-part", "thread");
    await expect(thread).toHaveCSS("display", "grid");
    await expect(thread).toHaveCSS("row-gap", "24px");
    await expect(thread).toHaveCSS("max-inline-size", "736px");
    const welcome = page.getByTestId("chat-welcome");
    await expect(welcome).toHaveAttribute("data-chat-part", "welcome");
    await expect(welcome).toHaveCSS("text-align", "center");
    await expect(welcome.getByRole("heading", { level: 1 })).toHaveCSS(
      "font-size",
      "28px",
    );
    await expect(welcome.getByTestId("ask-button").first()).toBeVisible();
    // The live turn is in the page, and takes no room until a reply starts.
    await expect(page.getByTestId("turn-live")).toBeHidden();
    await expect(page.getByTestId("chat-thread-ready")).toBeHidden();
  });

  test("a reader's turn, a reply's stack, a code block and a tool line", async ({
    page,
  }) => {
    await freshChat(page, "/data");
    await send(page, "What are the top selling books?");
    await expect(page.getByTestId("chat-welcome")).toBeHidden();

    // The reader's turn: a bubble at the end of the line.
    const user = page.getByTestId("turn-user");
    await expect(user).toHaveAttribute("data-chat-part", "turn");
    await expect(user).toHaveAttribute("data-role", "user");
    await expect(user).toHaveCSS("justify-self", "end");
    await expect(user).toHaveCSS("padding-left", "14.4px");
    await expect(user).toHaveCSS("border-top-left-radius", "10px");
    await expect(user).toHaveCSS("white-space", "pre-wrap");
    await expect(user).toHaveCSS(
      "background-color",
      await themeColor(page, "--surface"),
    );

    // The reply: a measure, and one stack with one gap.
    const reply = page.getByTestId("turn-live");
    await expect(reply).toHaveAttribute("data-chat-part", "turn");
    await expect(reply).toHaveAttribute("data-role", "assistant");
    await expect(reply).toHaveAttribute("data-live", "");
    await expect(reply).toHaveCSS("display", "flow-root");
    await expect(reply).toHaveCSS("max-inline-size", "672px");
    const chart = reply.getByTestId("bar-chart");
    await expect(chart).toHaveCSS("margin-top", "12px");
    await expect(chart).toHaveCSS("margin-bottom", "0px");
    // The reply is over: no caret.
    expect(
      await styleOf(page, '[data-testid="turn-live"]', "content", "::after"),
    ).toBe("none");

    // The tool line: sent running, then done. The running one is hidden,
    // and the done one, the last of its group, keeps a gap under it.
    const query = reply.locator('[data-part][data-tool="run_sql"]');
    await expect(query).toHaveCount(2);
    await expect(query.first()).toHaveAttribute("data-state", "running");
    await expect(query.first()).toHaveCSS("display", "none");
    await expect(query.last()).toHaveCSS("display", "block");
    await expect(query.last()).toHaveCSS("margin-bottom", "12px");
    // Lines that say what was looked up sit close together.
    await expect(query.last()).toHaveCSS("margin-top", "4px");

    // A fenced code block: one element per line, rounded off as one box.
    const lines = reply.locator("code[data-line]");
    await expect(lines.first()).toHaveCSS("display", "block");
    await expect(lines.first()).toHaveCSS("font-size", "13px");
    await expect(lines.first()).toHaveCSS("white-space", "pre-wrap");
    await expect(lines.first()).toHaveCSS("padding-top", "12px");
    await expect(lines.first()).toHaveCSS("border-top-left-radius", "10px");
    await expect(lines.last()).toHaveCSS("padding-bottom", "12px");
    await expect(lines.last()).toHaveCSS("border-bottom-right-radius", "10px");
    await expect(lines.first()).toHaveCSS(
      "background-color",
      await themeColor(page, "--surface"),
    );

    // The model's table.
    const heading = reply.locator("th").first();
    await expect(heading).toHaveCSS("color", await themeColor(page, "--muted"));
    await expect(heading).toHaveCSS("padding-left", "9.6px");
    await expect(reply.locator("table")).toHaveCSS(
      "border-collapse",
      "collapse",
    );

    // The same turn from the store is styled the same way.
    await page.reload();
    const stored = page.getByTestId("turn-assistant");
    await expect(stored).toHaveAttribute("data-chat-part", "turn");
    await expect(stored).toHaveCSS("max-inline-size", "672px");
    await expect(stored.getByTestId("bar-chart")).toHaveCSS(
      "margin-top",
      "12px",
    );
    await expect(stored.locator("code[data-line]").first()).toHaveCSS(
      "padding-top",
      "12px",
    );
    await expect(page.getByTestId("turn-user")).toHaveCSS(
      "justify-self",
      "end",
    );
  });

  test("a reply being written has a caret, and the one asked for a dot", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the placeholder is the client runtime's");
    await freshChat(page);
    const action = await page
      .getByTestId("chat-composer")
      .evaluate((form) => (form as unknown as { action: string }).action);
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
    const pending = page.getByTestId("turn-pending");
    await expect(pending).toBeVisible();
    // What the runtime adds carries the marks the thread styles by.
    await expect(pending).toHaveAttribute("data-chat-part", "turn");
    await expect(pending).toHaveAttribute("data-live", "");
    await expect(page.getByTestId("turn-user")).toHaveAttribute(
      "data-role",
      "user",
    );
    await expect(page.getByTestId("turn-user")).toHaveCSS(
      "justify-self",
      "end",
    );
    const dot = '[data-testid="turn-pending"]';
    expect(await styleOf(page, dot, "border-top-left-radius", "::after")).toBe(
      "50%",
    );
    expect(await styleOf(page, dot, "background-color", "::after")).toBe(
      await themeColor(page, "--accent"),
    );
    // The welcome gives way to the message at once.
    await expect(page.getByTestId("chat-welcome")).toBeHidden();
    release();
    await expect(page.getByTestId("turn-live")).toContainText("Three picks");
    // Still being written: a square caret.
    const caret = '[data-testid="turn-live"]';
    expect(await styleOf(page, caret, "content", "::after")).toBe('""');
    expect(
      await styleOf(page, caret, "border-top-left-radius", "::after"),
    ).toBe("0px");
    await settled(page);
    expect(await styleOf(page, caret, "content", "::after")).toBe("none");
  });
});

test.describe("events", () => {
  /** Record every chat event, where it was sent from, and the state then. */
  const record = `
    window.__chat = [];
    for (const type of ["chat:send", "chat:reply-start", "chat:reply-end", "chat:stop", "chat:call-start", "chat:call-end"]) {
      document.addEventListener(type, (event) => {
        window.__chat.push({
          type,
          fromRoot: event.target instanceof Element && event.target.hasAttribute("data-chat"),
          root: event.target instanceof Element ? event.target.getAttribute("data-genui") : null,
          page: document.documentElement.getAttribute("data-genui"),
          call: document.documentElement.getAttribute("data-genui-call"),
          stopped: event.detail.stopped,
          form: event.detail.form instanceof HTMLFormElement ? event.detail.form.dataset.testid : undefined,
        });
      });
    }
  `;
  const events = (page: Page): Promise<Record<string, unknown>[]> =>
    page.evaluate("window.__chat");

  test.beforeEach(async ({ page }) => {
    test.skip(!withScripts(), "the events are the scripts'");
    await page.addInitScript(record);
    await freshChat(page);
  });

  test("a typed reply is sent, starts, and ends, in that order", async ({
    page,
  }) => {
    const root = page.locator("[data-chat]");
    await expect(root).toHaveAttribute("data-genui", "idle");
    await send(page, "Recommend a book");
    await expect(
      page.getByTestId("turn-live").getByTestId("book-card"),
    ).toHaveCount(3);
    expect(await events(page)).toEqual([
      {
        type: "chat:send",
        fromRoot: true,
        root: "streaming",
        page: "streaming",
        call: null,
        form: "chat-composer",
      },
      {
        type: "chat:reply-start",
        fromRoot: true,
        root: "streaming",
        page: "streaming",
        call: null,
      },
      {
        type: "chat:reply-end",
        fromRoot: true,
        root: "idle",
        page: "idle",
        call: null,
        stopped: false,
      },
    ]);
    await expect(root).toHaveAttribute("data-genui", "idle");
  });

  test("a form in the thread, which the answer replaces, still ends from the root", async ({
    page,
  }) => {
    await page.getByTestId("ask-button-submit").first().click();
    await settled(page);
    const seen = await events(page);
    expect(seen.map((event) => event.type)).toEqual([
      "chat:send",
      "chat:reply-start",
      "chat:reply-end",
    ]);
    expect(seen.every((event) => event.fromRoot)).toBe(true);
    expect(seen[0]!.form).toBe("ask-button");
  });

  test("a stopped reply says so, between its start and its end", async ({
    page,
  }) => {
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect(page.getByTestId("turn-live")).toContainText("Three picks");
    await page.getByTestId("chat-composer-stop").click();
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
    const seen = await events(page);
    expect(seen.map((event) => event.type)).toEqual([
      "chat:send",
      "chat:reply-start",
      "chat:stop",
      "chat:reply-end",
    ]);
    expect(seen.every((event) => event.fromRoot)).toBe(true);
    expect(seen.at(-1)!.stopped).toBe(true);
    // The reply that was cut has its end marker, so its caret is gone.
    await expect(
      page.getByTestId("turn-live").locator('[data-chat-part="done"]'),
    ).toHaveCount(1);
  });

  test("a send the server fails still ends, though no page loads", async ({
    page,
  }) => {
    await page.evaluate("window.kept = true");
    await page.route("**/api/send", (route) =>
      route.fulfill({ status: 500, body: "no" }),
    );
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect
      .poll(async () => (await events(page)).map((event) => event.type))
      .toEqual(["chat:send", "chat:reply-end"]);
    // The composer was emptied for the echo, so the browser sends nothing.
    await expect(page.locator("[data-chat]")).toHaveAttribute(
      "data-genui",
      "idle",
    );
    expect(await page.evaluate("window.kept === true")).toBe(true);
  });

  test("a send the server fails leaves no reply waiting: the placeholder ends, as a stopped reply does", async ({
    page,
  }) => {
    await page.route("**/api/send", (route) =>
      route.fulfill({ status: 500, body: "no" }),
    );
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect(page.locator("[data-chat]")).toHaveAttribute(
      "data-genui",
      "idle",
    );
    // The message that was shown stays, and the reply that never came is over.
    await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
    const pending = page.getByTestId("turn-pending");
    await expect(pending).toHaveCount(1);
    await expect(pending).not.toHaveAttribute("aria-busy");
    // Nothing was written in it, so it is not the reply being written.
    await expect(pending).not.toHaveAttribute("data-live");
    await expect(pending.locator('[data-chat-part="done"]')).toHaveCount(1);
    expect(
      await styleOf(page, '[data-testid="turn-pending"]', "content", "::after"),
    ).toBe("none");
    // No reply in the chat is left with a caret.
    await expect(
      page.locator(
        '[data-chat-part="turn"][data-live]:not(:has([data-chat-part="done"]))',
      ),
    ).toHaveCount(0);
  });

  test("a chat in an element that is not <main> is answered without a page load", async ({
    page,
  }) => {
    // The chat's root is chat-app's own element, and the <main> inside it
    // becomes a section, so the page has no <main> at all.
    await expect(page.locator("main[data-chat]")).toHaveCount(0);
    await page.evaluate(`{
      const main = document.querySelector("[data-chat] main");
      const section = document.createElement("section");
      for (const { name, value } of main.attributes) section.setAttribute(name, value);
      main.before(section);
      section.append(...main.childNodes);
      main.remove();
      window.kept = true;
    }`);
    await expect(page.locator("main")).toHaveCount(0);
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect(
      page.getByTestId("turn-live").getByTestId("book-card"),
    ).toHaveCount(3);
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
    expect(await page.evaluate("window.kept === true")).toBe(true);
    expect((await events(page)).map((event) => event.type)).toEqual([
      "chat:send",
      "chat:reply-start",
      "chat:reply-end",
    ]);
  });

  test("a form in <main> but outside the chat is left to the browser", async ({
    page,
  }) => {
    // The chat becomes a section inside <main>, with a form beside it.
    await page.evaluate(`{
      const root = document.querySelector("[data-chat]");
      const main = root.querySelector("main");
      const section = document.createElement("section");
      section.setAttribute("data-chat", "");
      section.append(...main.childNodes);
      root.removeAttribute("data-chat");
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/api/send";
      form.dataset.testid = "beside";
      main.append(section, form);
      window.left = [];
      // After the client runtime's own listener, which was added first: was
      // the form still the browser's to send?
      document.addEventListener("submit", (event) => {
        window.left.push([event.target.dataset.testid, event.defaultPrevented]);
        event.preventDefault();
      });
    }`);
    await page.evaluate(
      `document.querySelector('[data-testid="beside"]').requestSubmit()`,
    );
    expect(await page.evaluate("window.left")).toEqual([["beside", false]]);
    expect(await events(page)).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
  });

  /** A second chat on the page, after the first, with a composer and a Stop button of its own. */
  const secondChat = `{
    const chat = document.createElement("section");
    chat.setAttribute("data-chat", "");
    chat.dataset.testid = "second-chat";
    chat.innerHTML =
      '<form method="post" action="/api/send" data-chat-part="composer">' +
      '<textarea name="text" data-chat-part="input">Hello from the second chat</textarea>' +
      '<button type="button" data-chat-part="stop">Stop</button></form>' +
      '<div data-chat-part="thread"></div>';
    document.body.append(chat);
    window.secondChat = [];
    chat.addEventListener("chat:stop", () => window.secondChat.push("chat:stop"));
    chat.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      window.secondChat.push("submit");
    });
  }`;

  test("another chat's Stop does not stop this chat's reply", async ({
    page,
  }) => {
    const stops: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/stop") {
        stops.push(request.url());
      }
    });
    await page.evaluate(secondChat);
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect(page.getByTestId("turn-live")).toContainText("Three picks");
    await page.evaluate(
      `document.querySelector('[data-testid="second-chat"] [data-chat-part="stop"]').click()`,
    );
    await expect(
      page.getByTestId("turn-live").getByTestId("book-card"),
    ).toHaveCount(3);
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
    expect(await page.evaluate("window.secondChat")).toEqual([]);
    expect(stops).toEqual([]);
    const seen = await events(page);
    expect(seen.map((event) => event.type)).toEqual([
      "chat:send",
      "chat:reply-start",
      "chat:reply-end",
    ]);
    expect(seen.at(-1)!.stopped).toBe(false);
  });

  test("a voice call leaves another chat's composer alone", async ({
    page,
  }) => {
    await page.route("**/api/voice-session", (route) =>
      route.continue({
        url: `${route.request().url()}?provider=gemini-live`,
      }),
    );
    await page.addInitScript(TONE_MICROPHONE);
    await page.reload();
    const toggle = page.getByTestId("voice-call-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const thread = page.getByTestId("chat-thread");
    await expect(thread.getByTestId("turn-voice")).toContainText(
      "Here are two books from the shelf.",
      { timeout: 30_000 },
    );
    await page.evaluate(secondChat);
    await page.evaluate(
      `document.querySelector('[data-testid="second-chat"] form').requestSubmit()`,
    );
    // The second chat's own handler had its message.
    expect(await page.evaluate("window.secondChat")).toEqual(["submit"]);
    // This chat's composer is still the call's: its message is said, not posted.
    await page.getByTestId("chat-composer-input").fill("Thank you");
    await page.getByTestId("chat-composer-input").press("Enter");
    await expect(thread.getByTestId("turn-user").last()).toHaveText(
      "Thank you",
    );
    await expect(thread).not.toContainText("Hello from the second chat");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("a voice call says when it starts and when it ends", async ({
    page,
  }) => {
    await page.route("**/api/voice-session", (route) =>
      route.continue({
        url: `${route.request().url()}?provider=gemini-live`,
      }),
    );
    await page.addInitScript(TONE_MICROPHONE);
    await page.reload();
    const toggle = page.getByTestId("voice-call-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-chat]")).toHaveAttribute(
      "data-genui-call",
      "on",
    );
    await expect(page.locator("html")).toHaveAttribute("data-genui-call", "on");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-chat]")).not.toHaveAttribute(
      "data-genui-call",
    );
    const seen = await events(page);
    expect(
      seen.map((event) => [event.type, event.fromRoot, event.call]),
    ).toEqual([
      ["chat:call-start", true, "on"],
      ["chat:call-end", true, null],
    ]);
  });
});

/** A microphone that needs no device and no permission (as in chat.spec.ts). */
const TONE_MICROPHONE = `
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    const tone = context.createOscillator();
    const out = context.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return out.stream;
  };
`;

test.describe("a page written before the parts were marked", () => {
  /**
   * The server's pages with every `data-chat` and `data-chat-part` taken
   * out: the page a project has when its own thread, sidebar and page were
   * written against the earlier components. The scripts are the new ones.
   */
  async function unmarked(page: Page): Promise<void> {
    await page.addInitScript(`{
      // The page as it is parsed: each mark is taken off before the next
      // script runs. Marks a script adds later stay, as they would.
      const unmark = (node) => {
        if (!(node instanceof Element)) return;
        for (const element of [node, ...node.querySelectorAll("[data-chat], [data-chat-part]")]) {
          element.removeAttribute("data-chat");
          element.removeAttribute("data-chat-part");
        }
      };
      const parsing = new MutationObserver((records) => {
        for (const record of records) record.addedNodes.forEach(unmark);
      });
      parsing.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", () => {
        unmark(document.documentElement);
        parsing.disconnect();
      });
      // A page a script fetches and parses: the answer the client runtime
      // streams into a document piece by piece, and a voice call's view. A
      // piece can end in the middle of a tag, so only whole tags are written.
      const strip = (html) =>
        html.replace(/ data-chat-part="[^"]*"/g, "").replace(/ data-chat(?=[\\s>])/g, "");
      const held = new WeakMap();
      const write = Document.prototype.write;
      Document.prototype.write = function (piece) {
        const text = (held.get(this) ?? "") + piece;
        const open = text.lastIndexOf("<");
        const whole = open > text.lastIndexOf(">") ? open : text.length;
        held.set(this, text.slice(whole));
        write.call(this, strip(text.slice(0, whole)));
      };
      const parse = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function (html, type) {
        return parse.call(this, strip(html), type);
      };
    }`);
  }

  test.beforeEach(async ({ page }) => {
    test.skip(!withScripts(), "the lookups are the scripts'");
    await unmarked(page);
    await freshChat(page);
    await expect(page.locator("[data-chat], [data-chat-part]")).toHaveCount(0);
  });

  test("a message is answered without a page load, and the sidebar follows", async ({
    page,
  }) => {
    await page.evaluate("window.kept = true");
    await page.addInitScript("window.reloaded = true");
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
    await expect(page.getByTestId("turn-user")).toHaveText("Recommend a book");
    await expect(
      page.getByTestId("turn-live").getByTestId("book-card"),
    ).toHaveCount(3);
    // The composer was emptied and has the keyboard again.
    await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
    await expect(page.getByTestId("chat-composer-input")).toBeFocused();
    // The sidebar was replaced with the answer's: the conversation is listed.
    await expect(page.getByTestId("chat-sidebar-item").first()).toHaveText(
      "Recommend a book",
    );
    expect(await page.evaluate("window.kept === true")).toBe(true);
    expect(await page.evaluate("window.reloaded")).toBeUndefined();
    // Nothing the server sent is marked: every part was found the old way.
    await expect(page.getByTestId("chat-thread")).not.toHaveAttribute(
      "data-chat-part",
    );
  });

  test("a reply can be stopped", async ({ page }) => {
    await page.evaluate("window.kept = true");
    await page.getByTestId("chat-composer-input").fill("Recommend a book");
    await page.getByTestId("chat-composer-send").click();
    await expect(page.getByTestId("turn-live")).toContainText("Three picks");
    await page.getByTestId("chat-composer-stop").click();
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
    expect(await page.evaluate("window.kept === true")).toBe(true);
    await page.reload();
    await expect(page.getByTestId("turn-assistant")).toContainText(
      "Three picks",
    );
  });

  test("a voice call writes its turns in the thread, and takes a typed message", async ({
    page,
  }) => {
    await page.route("**/api/voice-session", (route) =>
      route.continue({
        url: `${route.request().url()}?provider=gemini-live`,
      }),
    );
    await page.addInitScript(TONE_MICROPHONE);
    await page.reload();
    await expect(page.locator("[data-chat], [data-chat-part]")).toHaveCount(0);
    await page.evaluate("window.kept = true");
    const toggle = page.getByTestId("voice-call-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const thread = page.getByTestId("chat-thread");
    await expect(thread.getByTestId("turn-user")).toHaveText(
      "Recommend a book",
      { timeout: 30_000 },
    );
    const reply = thread.getByTestId("turn-voice");
    await expect(reply).toContainText("Here are two books from the shelf.", {
      timeout: 30_000,
    });
    // The view came from /voice-view, whose wrapper is not marked either.
    await expect(reply.getByTestId("book-card")).toHaveCount(2, {
      timeout: 30_000,
    });
    // A typed message is said to the model, not posted: no reply is streamed.
    await page.getByTestId("chat-composer-input").fill("Thank you");
    await page.getByTestId("chat-composer-input").press("Enter");
    await expect(thread.getByTestId("turn-user").last()).toHaveText(
      "Thank you",
    );
    await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate("window.kept === true")).toBe(true);
  });
});
