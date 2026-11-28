/**
 * The composer as a part with slots, and the parts a page puts in them.
 *
 * /parts holds the parts placed by hand: a composer with nothing in its
 * slots, one with every slot filled and every prop set, the voice parts
 * beside a composer, and the form parts with routes of their own. A route
 * that starts with /parts/ is not served: the spec answers it, which shows
 * that the request went where the prop said.
 */
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

/** True in the project that runs with the client runtime. */
const withScripts = (): boolean => test.info().project.name === "js";

/** An answer to a sent message: a page with the thread a reply would have. */
const answer = (reply: string): string => `<!doctype html>
<html lang="en">
  <head><title>An answer</title></head>
  <body>
    <div data-chat-part="thread" data-testid="chat-thread">
      <span data-chat-part="ready"></span>
      <div data-chat-part="turn" data-role="assistant" data-testid="turn-assistant">
        <p data-testid="parts-answer">${reply}</p>
        <span data-chat-part="done"></span>
      </div>
    </div>
  </body>
</html>`;

/** Answer every request to `glob` with `body`, and keep the requests. */
async function answered(
  page: Page,
  glob: string,
  body: string,
): Promise<Request[]> {
  const seen: Request[] = [];
  await page.route(glob, async (route) => {
    seen.push(route.request());
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });
  return seen;
}

/** A request that waits until the test lets it go. */
const gate = (): { opened: Promise<void>; open: () => void } => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

/** The top edge and the left edge of an element, in page pixels. */
async function edges(part: Locator): Promise<{
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}> {
  const box = await part.boundingBox();
  if (!box) throw new Error("the element has no box");
  return {
    top: box.y,
    bottom: box.y + box.height,
    left: box.x,
    right: box.x + box.width,
    width: box.width,
    height: box.height,
  };
}

/** The path every request the page makes goes to, for the life of the test. */
function paths(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => seen.push(new URL(request.url()).pathname));
  return seen;
}

test.describe("a composer with nothing in its slots", () => {
  test("is a message box and a Send button, with no trace of attachments", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/parts");
    const form = page.getByTestId("parts-plain").getByTestId("chat-composer");
    await expect(form).toHaveAttribute("action", "/api/send");
    await expect(form).not.toHaveAttribute("enctype");
    for (const hook of [
      "chat-attach",
      "chat-composer-attach",
      "chat-composer-files-input",
      "chat-composer-files",
      "chat-composer-notice",
      "chat-voice",
      "voice-call",
    ]) {
      await expect(form.getByTestId(hook)).toHaveCount(0);
    }
    const input = form.getByTestId("chat-composer-input");
    await expect(input).toHaveAttribute("placeholder", "Ask a question…");
    await expect(form.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(form.getByTestId("chat-composer-send")).toHaveText("Send");
    await expect(form.getByTestId("chat-composer-stop")).toHaveText("Stop");
    await expect(form.getByTestId("chat-composer-stop")).toBeHidden();
    await expect(form.getByTestId("chat-composer-stop")).toHaveAttribute(
      "formaction",
      "/api/stop",
    );
    // A route on a button is valid HTML only on one that submits.
    await expect(form.getByTestId("chat-composer-stop")).toHaveAttribute(
      "type",
      "submit",
    );
    // No composer of this page asked for the keyboard, so none takes it.
    await expect(page.locator("[autofocus]")).toHaveCount(0);
    await expect(input).not.toBeFocused();

    // An unfilled region has no box: the form is as tall as its message
    // box, its padding and its border, and nothing else is laid out in it.
    const boxes = await form.evaluate((element) =>
      [...element.children]
        .filter((child) => child.getClientRects().length > 0)
        .map((child) => child.getAttribute("data-testid")),
    );
    expect(boxes).toEqual(["chat-composer-input", "chat-composer-send"]);
    const whole = await edges(form);
    const box = await edges(input);
    const send = await edges(form.getByTestId("chat-composer-send"));
    expect(whole.height).toBeCloseTo(
      Math.max(box.height, send.height) + 2 * (8 + 1),
      0,
    );

    expect(errors).toEqual([]);
  });

  test("takes the keyboard as its page opens only where the page asks", async ({
    page,
  }) => {
    await page.goto("/");
    const input = page.getByTestId("chat-composer-input");
    await expect(input).toHaveAttribute("autofocus", /.*/);
    await expect(page.locator("[autofocus]")).toHaveCount(1);
    await expect(input).toBeFocused();
  });

  test("sends its text to /api/send, and the answer goes in its own chat", async ({
    page,
  }) => {
    await page.goto("/parts");
    const sent = await answered(
      page,
      "**/api/send",
      answer("The Sea Around Us."),
    );
    const plain = page.getByTestId("parts-plain");
    await plain.getByTestId("chat-composer-input").fill("A book about tides");
    await plain.getByTestId("chat-composer-send").click();
    await expect(page.getByTestId("parts-answer")).toHaveText(
      "The Sea Around Us.",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method()).toBe("POST");
    expect(sent[0]!.postData()).toMatch(/A[+ ]book[+ ]about[+ ]tides/);
    if (withScripts()) {
      // The client runtime put the answer in the chat that asked.
      await expect(plain.getByTestId("parts-answer")).toBeVisible();
      await expect(
        page.getByTestId("parts-full").getByTestId("turn-assistant"),
      ).toHaveText("Attach a cover, or ask about an author.");
    } else {
      // A form with no file input is sent the plain way.
      expect(sent[0]!.headers()["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
    }
  });
});

test.describe("a composer with every slot filled", () => {
  test("lays each slot out in its own region, with the text its props set", async ({
    page,
  }) => {
    await page.goto("/parts");
    const form = page.getByTestId("parts-full").getByTestId("chat-composer");
    const input = form.getByTestId("chat-composer-input");
    await expect(input).toHaveAttribute("placeholder", "Ask about a book…");
    await expect(form.getByRole("textbox", { name: "Question" })).toBeVisible();
    const send = form.getByTestId("chat-composer-send");
    await expect(send).toHaveText("Ask");
    await expect(form.getByTestId("chat-composer-stop")).toHaveText("Cancel");
    await expect(form).toHaveAttribute("enctype", "multipart/form-data");

    const whole = await edges(form);
    const box = await edges(input);
    const above = await edges(form.getByTestId("parts-above"));
    const below = await edges(form.getByTestId("parts-below"));
    const attach = await edges(form.getByTestId("chat-composer-attach"));
    const button = await edges(send);
    // Above and below are lines of their own; start and Send share the
    // message box's row, on either side of it.
    expect(above.bottom).toBeLessThanOrEqual(box.top);
    expect(below.top).toBeGreaterThanOrEqual(box.bottom);
    expect(below.top).toBeGreaterThanOrEqual(button.bottom);
    expect(attach.right).toBeLessThanOrEqual(box.left);
    expect(attach.top).toBeGreaterThanOrEqual(above.bottom);
    expect(attach.bottom).toBeLessThanOrEqual(below.top);
    expect(button.left).toBeGreaterThanOrEqual(box.right);
    expect(below.bottom).toBeLessThanOrEqual(whole.bottom);
    await expect(form.getByLabel("Add a cover")).toBeAttached();
    // The picker offers the types the prop names, with scripts off too.
    await expect(form.getByTestId("chat-composer-files-input")).toHaveAttribute(
      "accept",
      "text/plain,image/png",
    );

    if (withScripts()) {
      // What is in the default slot sits between the message box and Send.
      for (const hook of ["chat-voice-summary", "voice-call-toggle"]) {
        const action = await edges(form.getByTestId(hook));
        expect(action.left).toBeGreaterThanOrEqual(box.right);
        expect(action.right).toBeLessThanOrEqual(button.left);
        expect(action.top).toBeGreaterThanOrEqual(above.bottom);
        expect(action.bottom).toBeLessThanOrEqual(below.top);
      }
    }
  });

  test("a region whose every element is hidden takes no room", async ({
    page,
  }) => {
    await page.goto("/parts");
    const form = page.getByTestId("parts-full").getByTestId("chat-composer");
    const note = form.getByTestId("parts-above");
    const region = form.locator('[data-chat-line="above"]', {
      has: page.getByTestId("parts-above"),
    });
    const shown = await edges(form);
    const line = await edges(region);
    expect(line.height).toBeGreaterThan(0);

    // A status that has nothing to say, as a page's own script would leave it.
    await note.evaluate((element) => element.setAttribute("hidden", ""));
    await expect(region).toBeHidden();
    expect(await region.evaluate((el) => el.getClientRects().length)).toBe(0);
    const without = await edges(form);
    // The line and the gap under it are both gone.
    expect(shown.height - without.height).toBeCloseTo(line.height + 8, 0);

    await note.evaluate((element) => element.removeAttribute("hidden"));
    await expect(region).toBeVisible();
    expect((await edges(form)).height).toBeCloseTo(shown.height, 0);
  });

  test("posts to the route its prop names", async ({ page }) => {
    await page.goto("/parts");
    const everywhere = paths(page);
    const sent = await answered(
      page,
      "**/parts/send",
      answer("Try The Left Hand of Darkness."),
    );
    const full = page.getByTestId("parts-full");
    await full
      .getByTestId("chat-composer-input")
      .fill("Something by Ursula K. Le Guin");
    await full.getByTestId("chat-composer-send").click();
    await expect(page.getByTestId("parts-answer")).toHaveText(
      "Try The Left Hand of Darkness.",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method()).toBe("POST");
    expect(new URL(sent[0]!.url()).pathname).toBe("/parts/send");
    expect(everywhere).not.toContain("/api/send");
    if (!withScripts()) {
      // The form sends files, so the browser sends it in parts.
      expect(sent[0]!.headers()["content-type"]).toContain(
        "multipart/form-data",
      );
    }
  });

  test("chat-attach in the start slot checks files against its own props", async ({
    page,
  }) => {
    test.skip(!withScripts(), "the checks before sending are a script");
    await page.goto("/parts");
    const form = page.getByTestId("parts-full").getByTestId("chat-composer");
    const picker = form.getByTestId("chat-composer-files-input");
    await expect(picker).toHaveAttribute("accept", "text/plain,image/png");
    const notice = form.getByTestId("chat-composer-notice");
    const chips = form.getByTestId("chat-composer-file");
    const note = (name: string, size = 12) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.alloc(size, "a"),
    });

    await picker.setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes"),
    });
    await expect(notice).toHaveText(
      '"notes.md" cannot be attached: that type of file is not allowed. Allowed types: plain text, PNG.',
    );
    await expect(chips).toHaveCount(0);

    await picker.setInputFiles(note("long.txt", 4096));
    await expect(notice).toHaveText(
      '"long.txt" is too large (4 KB). Each file can be up to 2 KB.',
    );

    await picker.setInputFiles(note("cover.txt"));
    await expect(chips).toHaveCount(1);
    await expect(notice).toBeHidden();
    await picker.setInputFiles(note("second.txt"));
    await expect(notice).toHaveText(
      "You can attach up to 1 file to one message.",
    );
    await expect(chips).toHaveCount(1);

    // The chips and the refusal are lines above the message box, under the
    // line the page put in the above slot.
    const box = await edges(form.getByTestId("chat-composer-input"));
    const above = await edges(form.getByTestId("parts-above"));
    for (const line of [notice, form.getByTestId("chat-composer-files")]) {
      const at = await edges(line);
      expect(at.bottom).toBeLessThanOrEqual(box.top);
      expect(at.top).toBeGreaterThanOrEqual(above.bottom);
    }

    // A chip taken off gives the keyboard back to the message box.
    await form.getByTestId("chat-composer-file-remove").click();
    await expect(chips).toHaveCount(0);
    await expect(form.getByTestId("chat-composer-input")).toBeFocused();
  });
});

test.describe("Stop", () => {
  test.beforeEach(() => {
    test.skip(!withScripts(), "a reply is stopped by the client runtime");
  });

  test("is shown only in the chat whose reply streams, and posts to that chat's route", async ({
    page,
  }) => {
    await page.goto("/parts");
    const everywhere = paths(page);
    const reply = gate();
    await page.route("**/parts/send", async (route) => {
      await reply.opened;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: answer("Stopped short."),
      });
    });
    const stopped = await answered(page, "**/parts/stop", "ok");
    const full = page.getByTestId("parts-full");
    const others = [
      page.getByTestId("parts-plain"),
      page.getByTestId("parts-beside"),
    ];
    await expect(full).toHaveAttribute("data-genui", "idle");
    await expect(full.getByTestId("chat-composer-stop")).toBeHidden();

    await full.getByTestId("chat-composer-input").fill("A long answer, please");
    await full.getByTestId("chat-composer-send").click();
    await expect(full).toHaveAttribute("data-genui", "streaming");
    await expect(full.getByTestId("chat-composer-stop")).toBeVisible();
    await expect(full.getByTestId("chat-composer-send")).toBeHidden();
    // The page as a whole says a reply streams, and the other chats do not.
    await expect(page.locator("html")).toHaveAttribute(
      "data-genui",
      "streaming",
    );
    for (const other of others) {
      await expect(other).toHaveAttribute("data-genui", "idle");
      await expect(other.getByTestId("chat-composer-stop")).toBeHidden();
      await expect(other.getByTestId("chat-composer-send")).toBeVisible();
    }

    await page.evaluate("window.kept = true");
    await full.getByTestId("chat-composer-stop").click();
    await expect.poll(() => stopped.length).toBe(1);
    expect(stopped[0]!.method()).toBe("POST");
    expect(new URL(stopped[0]!.url()).pathname).toBe("/parts/stop");
    expect(stopped[0]!.postData()).toContain("books");
    expect(everywhere).not.toContain("/api/stop");

    reply.open();
    await expect(full).toHaveAttribute("data-genui", "idle");
    await expect(full.getByTestId("chat-composer-stop")).toBeHidden();
    await expect(full.getByTestId("chat-composer-send")).toBeVisible();
    // Stop was posted once, by the runtime: the form was never sent there.
    expect(stopped.length).toBe(1);
    expect(await page.evaluate("window.kept === true")).toBe(true);
    await expect(full.getByTestId("parts-answer")).toHaveText("Stopped short.");
  });

  test("pressed before the answer starts, leaves no reply being written", async ({
    page,
  }) => {
    await page.goto("/parts");
    const reply = gate();
    await page.route("**/parts/send", async (route) => {
      await reply.opened;
      await route.abort();
    });
    // A server that cannot be asked: the connection is closed instead.
    await page.route("**/parts/stop", (route) =>
      route.fulfill({ status: 500, body: "no" }),
    );
    const full = page.getByTestId("parts-full");
    await full.getByTestId("chat-composer-input").fill("A long answer, please");
    await full.getByTestId("chat-composer-send").click();
    const pending = full.getByTestId("turn-pending");
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await full.getByTestId("chat-composer-stop").click();
    await expect(full).toHaveAttribute("data-genui", "idle");
    reply.open();
    // The placeholder is over, and it is not a reply: the reading aids and
    // anything else that follows the reply being written find none.
    await expect(pending).toHaveCount(1);
    await expect(pending).not.toHaveAttribute("aria-busy");
    await expect(pending).not.toHaveAttribute("data-live");
    await expect(pending).not.toHaveClass(/\blive\b/);
    await expect(pending.locator('[data-chat-part="done"]')).toHaveCount(1);
    await expect(
      full.locator('[data-chat-part="turn"][data-live]'),
    ).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/parts");
  });

  test("on a page that marks no chat, is shown from the page's own state", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-genui", "idle");
    const stop = page.getByTestId("chat-composer-stop");
    const send = page.getByTestId("chat-composer-send");
    // With a chat marked, the page's state alone shows nothing.
    await page.evaluate("document.documentElement.dataset.genui = 'streaming'");
    await expect(stop).toBeHidden();
    await expect(send).toBeVisible();
    // Unmarked, the page's state is the chat's.
    await page.evaluate(
      "document.querySelector('[data-chat]').removeAttribute('data-chat')",
    );
    await expect(stop).toBeVisible();
    await expect(send).toBeHidden();
    await page.evaluate("document.documentElement.dataset.genui = 'idle'");
    await expect(stop).toBeHidden();
    await expect(send).toBeVisible();
  });
});

test.describe("a form part posts to the route its prop names", () => {
  for (const [name, hook, path, field] of [
    ["tool-approval", "tool-approval-allow", "/parts/approve", "call-1"],
    ["memory-note", "memory-note-undo", "/parts/forget-note", "memory-1"],
    ["memory-item", "memory-item-forget", "/parts/forget-item", "memory-2"],
    ["search-result", "search-result-open", "/parts/open", "conversation-1"],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto("/parts");
      const sent = await answered(
        page,
        "**/parts/**",
        `<!doctype html><title>Taken</title><p data-testid="parts-taken">Taken</p>`,
      );
      await page.getByTestId("parts-forms").getByTestId(hook).click();
      await expect(page.getByTestId("parts-taken")).toBeVisible();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method()).toBe("POST");
      expect(new URL(sent[0]!.url()).pathname).toBe(path);
      const fields = new URLSearchParams(sent[0]!.postData() ?? "");
      expect(fields.get("app")).toBe("books");
      expect([fields.get("id"), fields.get("call")]).toContain(field);
    });
  }
});

test.describe("the voice parts", () => {
  test.beforeEach(() => {
    test.skip(!withScripts(), "the voice parts are scripts");
  });

  const noMicrophone =
    "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no', 'NotAllowedError'); };";

  test("in a composer, put their lines above the message box and their buttons in its row", async ({
    page,
  }) => {
    await page.goto("/parts");
    await page.route("**/api/voice-session", (route) =>
      route.fulfill({ status: 503, body: "no" }),
    );
    const form = page.getByTestId("parts-full").getByTestId("chat-composer");
    const whole = await edges(form);
    const inner = whole.width - 2 * (8 + 1);

    await form.getByTestId("chat-voice-summary").click();
    const aids = form.getByTestId("chat-voice-aids");
    await expect(aids).toBeVisible();
    await form.getByTestId("chat-voice-captions").click();
    const caption = form.getByTestId("chat-voice-caption");
    await caption.evaluate((element) => {
      element.textContent = "A few words of a reply";
    });
    await form.getByTestId("voice-call-toggle").click();
    const status = form.getByTestId("voice-call-status");
    await expect(status).not.toBeEmpty();
    await expect(status).not.toHaveText("Connecting…");

    const box = await edges(form.getByTestId("chat-composer-input"));
    const top = await edges(caption);
    const above = await edges(form.getByTestId("parts-above"));
    const controls = await edges(aids);
    // The caption is the first line of all; the rest stack under it, each
    // the whole width of the form, and all of them above the message box.
    // The controls the button opens are the line next to the message box,
    // under the call's line.
    const line = await edges(status);
    expect(top.bottom).toBeLessThanOrEqual(above.top);
    expect(above.bottom).toBeLessThanOrEqual(line.top);
    expect(line.bottom).toBeLessThanOrEqual(controls.top);
    expect(controls.bottom).toBeLessThanOrEqual(box.top);
    expect(top.width).toBeCloseTo(inner, 0);
    expect(controls.width).toBeCloseTo(inner, 0);
  });

  test("beside a composer, are laid out by what holds them, and caption their own chat", async ({
    page,
  }) => {
    await page.goto("/parts");
    const beside = page.getByTestId("parts-beside");
    const row = beside.getByTestId("parts-voice-row");
    await expect(row.getByTestId("chat-voice-summary")).toBeVisible();
    await expect(row.getByTestId("voice-call-toggle")).toBeVisible();
    // Not in a composer: nothing of theirs is in the form.
    const form = beside.getByTestId("chat-composer");
    await expect(form.getByTestId("chat-voice")).toHaveCount(0);

    await row.getByTestId("chat-voice-summary").click();
    await expect(row.getByTestId("chat-voice-aids")).toBeVisible();
    await row.getByTestId("chat-voice-captions").click();
    await expect(row.getByTestId("chat-voice-captions")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // A reply written in this chat is captioned here, and nowhere else.
    await beside.getByTestId("chat-thread").evaluate((thread) => {
      const turn = document.createElement("div");
      turn.dataset.chatPart = "turn";
      turn.dataset.role = "assistant";
      turn.dataset.live = "";
      const done = document.createElement("span");
      done.dataset.chatPart = "done";
      // A reply's prose is the turn's own text, as the server streams it.
      turn.append("Dune is a long book about a desert planet.", done);
      thread.append(turn);
    });
    await expect(row.getByTestId("chat-voice-caption")).toContainText("Dune");
    await expect(
      page.getByTestId("parts-full").getByTestId("chat-voice-caption"),
    ).toBeEmpty();
  });

  test("a call beside a composer uses the four routes its props name", async ({
    page,
  }) => {
    // A visitor with a conversation, as every other spec starts.
    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await page.addInitScript(noMicrophone);
    await page.goto("/parts");
    const everywhere = paths(page);
    // Each route of the page's own is sent on to the demo's, so the call is
    // a real one; what is asked for is still the path the prop named.
    const views: string[] = [];
    await page.route("**/parts/voice-*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/parts/voice-view") views.push(url.search);
      const real =
        url.pathname === "/parts/voice-view"
          ? `/voice-view${url.search}`
          : url.pathname === "/parts/voice-session"
            ? "/api/voice-session?provider=gemini-live"
            : url.pathname.replace("/parts/", "/api/");
      await route.continue({ url: new URL(real, url).href });
    });

    const beside = page.getByTestId("parts-beside");
    const toggle = beside.getByTestId("voice-call-toggle");
    await toggle.click();
    await expect(beside.getByTestId("voice-call-status")).toHaveText(
      "No microphone: type to talk.",
      { timeout: 15_000 },
    );
    await expect(beside).toHaveAttribute("data-genui-call", "on");

    // Typed during the call, in this chat's own composer.
    await beside.getByTestId("chat-composer-input").fill("Recommend a book");
    await beside.getByTestId("chat-composer-send").click();
    const reply = beside.getByTestId("turn-voice");
    await expect(reply.getByTestId("book-card")).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(beside.getByTestId("turn-user")).toHaveText(
      "Recommend a book",
    );
    // The other chats' threads were left alone.
    await expect(
      page.getByTestId("parts-full").getByTestId("turn-voice"),
    ).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() => everywhere)
      .toEqual(
        expect.arrayContaining([
          "/parts/voice-session",
          "/parts/voice-tool",
          "/parts/voice-view",
          "/parts/voice-turn",
        ]),
      );
    expect(views[0]).toMatch(/^\?app=books&call=/);
    expect(
      everywhere.filter(
        (path) => path.startsWith("/api/voice-") || path === "/voice-view",
      ),
    ).toEqual([]);
  });
});
