/// <reference lib="dom" />
/**
 * The catalog components in a browser, on the demo's /gallery page.
 *
 * Every spec runs twice (see playwright.config.ts): with JavaScript off, where
 * each component must still be a plain form, list or table that posts the
 * right fields, and with JavaScript on, where the swipe deck, the choice pair,
 * the map and the 3D scene add their behavior.
 *
 * Nothing here reaches the network. The map and the 3D scene load Leaflet and
 * three.js from a CDN: those requests are answered from the repository's
 * node_modules when the pinned version is installed there, and refused when it
 * is not. The specs that need the real library skip themselves with the
 * reason; the loading behavior and the fallbacks run either way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const withScripts = (): boolean => test.info().project.name === "js";
const here = dirname(fileURLToPath(import.meta.url));

/* ---- The libraries the map and the scene load from a CDN ---- */

const LEAFLET_VERSION = "1.9.4";
const THREE_VERSION = "0.170.0";
const require = createRequire(import.meta.url);

/** The folder of an installed package at exactly the pinned version, or null. */
function installed(name: string, version: string): string | null {
  // Some packages (three) do not export their package.json, so look for the
  // folder on the resolver's search paths instead of resolving the file.
  for (const folder of require.resolve.paths(name) ?? []) {
    const manifest = join(folder, name, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        version: string;
      };
      if (pkg.version === version) return dirname(manifest);
    } catch {
      // Not in this folder: try the next.
    }
  }
  return null;
}

const LEAFLET_DIR = installed("leaflet", LEAFLET_VERSION);
const THREE_DIR = installed("three", THREE_VERSION);
const NO_LEAFLET = `leaflet@${LEAFLET_VERSION} is not installed in this repository, and tests may not use the network`;
const NO_THREE = `three@${THREE_VERSION} is not installed in this repository, and tests may not use the network`;

// A 1x1 transparent PNG, so no test depends on the tile server.
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

/**
 * Answer every request the gallery makes outside this server, and return the
 * CDN requests seen so a test can say when they happen.
 */
async function offline(page: Page): Promise<string[]> {
  const cdn: string[] = [];
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ contentType: "image/png", body: TILE }),
  );
  await page.route("https://cdn.jsdelivr.net/**", (route) => {
    const url = new URL(route.request().url());
    cdn.push(url.pathname);
    const leaflet = url.pathname.match(
      new RegExp(`^/npm/leaflet@${LEAFLET_VERSION}/dist/(.+)$`),
    );
    const three = url.pathname.match(
      new RegExp(`^/npm/three@${THREE_VERSION}/build/([^/]+)$`),
    );
    const file =
      leaflet && LEAFLET_DIR
        ? join(LEAFLET_DIR, "dist", leaflet[1]!)
        : three && THREE_DIR
          ? join(THREE_DIR, "build", three[1]!)
          : null;
    if (!file) return route.abort();
    const extension = file.slice(file.lastIndexOf("."));
    return route.fulfill({
      contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(file),
    });
  });
  return cdn;
}

/** Capture the form posts to /api/send and answer them with a plain page. */
async function capture(page: Page): Promise<{ bodies: string[] }> {
  const sent = { bodies: [] as string[] };
  await page.route("**/api/send", async (route) => {
    sent.bodies.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>sent</title><p>sent</p>",
    });
  });
  return sent;
}

const fields = (body: string | undefined): string[] =>
  [...new URLSearchParams(body ?? "").entries()].map(
    ([name, value]) => `${name}=${value}`,
  );

/** A gallery section, by component name. */
const section = (page: Page, name: string) => page.locator(`#${name}`);

let cdn: string[] = [];

test.beforeEach(async ({ page }) => {
  cdn = await offline(page);
});

/* ---- Every component is on the page ---- */

const FOLDERS = [
  join(here, "../components/catalog"),
  join(here, "../demo/src/genui"),
];

interface Source {
  name: string;
  description: string;
  hasRootTestId: boolean;
}

const sources: Source[] = FOLDERS.flatMap((folder) =>
  readdirSync(folder)
    .filter((file) => file.endsWith(".html"))
    .map((file) => {
      const text = readFileSync(join(folder, file), "utf8");
      const name = file.slice(0, -".html".length);
      const comment = text.match(/<!--\s*@bascik\b([\s\S]*?)-->/);
      return {
        name,
        description: (comment?.[1] ?? "").replace(/\s+/g, " ").trim(),
        hasRootTestId: text.includes(`data-testid="${name}"`),
      };
    }),
);

test.describe("the gallery", () => {
  test("has a section for every catalog component", async ({ page }) => {
    await page.goto("/gallery");
    await expect(page.getByTestId("gallery-section")).toHaveCount(
      sources.length,
    );
    expect(sources.length).toBeGreaterThanOrEqual(34);
    for (const source of sources) {
      const one = section(page, source.name);
      await expect(
        one.getByRole("heading", { name: source.name, exact: true }),
      ).toHaveCount(1);
      await expect(one.getByText("No sample yet.")).toHaveCount(0);
    }
  });

  test("shows each component's own description", async ({ page }) => {
    await page.goto("/gallery");
    for (const source of sources) {
      expect(
        source.description,
        `${source.name} has no @bascik comment`,
      ).not.toBe("");
      const shown = await section(page, source.name)
        .getByTestId("gallery-description")
        .innerText();
      expect(shown.length).toBeGreaterThan(10);
      expect(source.description.startsWith(shown.trim())).toBe(true);
    }
  });

  test("draws at least one instance of every component", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/gallery");
    for (const source of sources.filter((one) => one.hasRootTestId)) {
      await expect(
        section(page, source.name)
          .getByTestId("gallery-samples")
          .getByTestId(source.name)
          .first(),
        `${source.name} drew no instance`,
      ).toBeAttached();
    }
    expect(errors).toEqual([]);
  });

  test("the chat sidebar links to it", async ({ page }) => {
    await page.goto("/");
    // The link is small print at the foot of the sidebar, not one of the apps.
    const foot = page.getByTestId("chat-sidebar-foot");
    await expect(foot.getByTestId("chat-sidebar-memory")).toHaveText("Memory");
    await expect(
      page.getByRole("navigation", { name: "Apps" }).getByRole("link"),
    ).toHaveCount(4);
    await foot.getByTestId("chat-sidebar-gallery").click();
    await expect(page).toHaveURL(/\/gallery\?app=books$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Component gallery",
    );
    await expect(page.getByTestId("gallery-back")).toHaveText(
      "Back to Bookshop",
    );
    await page.getByTestId("gallery-back").click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("its back link stays in view and returns to the app the reader came from", async ({
    page,
  }) => {
    await page.goto("/docs");
    await page.getByTestId("chat-sidebar-gallery").click();
    await expect(page).toHaveURL(/\/gallery\?app=docs$/);
    const back = page.getByTestId("gallery-back");
    await expect(back).toHaveText("Back to Ask the docs");
    await page.getByTestId("gallery-section").last().scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();
    await back.click();
    await expect(page).toHaveURL(/\/docs$/);
  });
});

/* ---- swipe-deck ---- */

test.describe("swipe-deck", () => {
  const firstDeck = (page: Page) =>
    section(page, "swipe-deck").getByTestId("swipe-deck").first();
  // The third sample is the one written with radios="show" and its own hint.
  const radioDeck = (page: Page) =>
    section(page, "swipe-deck").getByTestId("swipe-deck").nth(2);

  test.beforeEach(async ({ page }) => {
    await page.goto("/gallery");
  });

  test("renders its question and cards in a form that posts to /api/send", async ({
    page,
  }) => {
    const deck = firstDeck(page);
    await expect(deck).toHaveAttribute("action", "/api/send");
    await expect(deck).toHaveAttribute("method", "post");
    await expect(deck).toContainText(
      "Which of these would you keep on your shelf?",
    );
    await expect(deck.getByTestId("swipe-card")).toHaveCount(3);
    await expect(deck.getByTestId("swipe-card").first()).toContainText(
      "Frank Herbert",
    );
    const other = section(page, "swipe-deck").getByTestId("swipe-deck").nth(1);
    await expect(other.getByTestId("swipe-card")).toHaveCount(2);
  });

  test("no JavaScript: a plain form of labelled radios", async ({ page }) => {
    test.skip(withScripts(), "no-JavaScript case");
    const deck = firstDeck(page);
    await expect(deck.getByTestId("swipe-deck-yes")).toBeHidden();
    await expect(deck.getByTestId("swipe-deck-progress")).toBeHidden();
    await expect(deck.getByTestId("swipe-deck-done")).toBeVisible();
    for (const card of await deck.getByTestId("swipe-card").all()) {
      await expect(card).toBeVisible();
    }
    // Nothing can be swiped, so nothing says so, and the radios are the
    // answer whether or not the deck asked for them.
    for (const each of [deck, radioDeck(page)]) {
      await expect(each.getByTestId("swipe-deck-hint")).toBeHidden();
      await expect(each.getByTestId("swipe-deck-verdict")).toBeHidden();
      for (const card of await each.getByTestId("swipe-card").all()) {
        await expect(card.getByLabel("Yes")).toBeVisible();
        await expect(card.getByLabel("No")).toBeVisible();
      }
    }
  });

  test("no JavaScript: Done is blocked until every card is answered, then posts the answers", async ({
    page,
  }) => {
    test.skip(withScripts(), "no-JavaScript case");
    const sent = await capture(page);
    const deck = firstDeck(page);
    await deck.getByTestId("swipe-deck-done").click();
    expect(sent.bodies).toEqual([]);
    await deck.getByRole("group", { name: "Dune" }).getByLabel("Yes").check();
    await deck.getByRole("group", { name: "Emma" }).getByLabel("No").check();
    await deck
      .getByRole("group", { name: "Beloved" })
      .getByLabel("Yes")
      .check();
    await deck.getByTestId("swipe-deck-done").click();
    await expect.poll(() => sent.bodies.length).toBe(1);
    expect(fields(sent.bodies[0])).toEqual([
      "Dune=yes",
      "Emma=no",
      "Beloved=yes",
    ]);
  });

  test("JavaScript: the top card is active, the others wait behind it, with a counter and buttons", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const deck = firstDeck(page);
    const cards = deck.getByTestId("swipe-card");
    await expect(cards.nth(0)).toBeVisible();
    await expect(cards.nth(0)).not.toHaveAttribute("inert", "");
    await expect(cards.nth(2)).toHaveAttribute("inert", "");
    await expect(deck.getByTestId("swipe-deck-progress")).toContainText(
      "0 of 3 answered",
    );
    await expect(deck.getByTestId("swipe-deck-yes")).toHaveText("Keep");
    await expect(deck.getByTestId("swipe-deck-no")).toHaveText("Skip");
    await expect(deck.getByTestId("swipe-deck-done")).toBeHidden();
    const other = section(page, "swipe-deck").getByTestId("swipe-deck").nth(1);
    await expect(other.getByTestId("swipe-deck-yes")).toHaveText("Yes");
    await expect(other.getByTestId("swipe-deck-no")).toHaveText("No");
  });

  test("JavaScript: a line under the question says how to answer, in the deck's own labels", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const hint = firstDeck(page).getByTestId("swipe-deck-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("right for Keep, left for Skip");
    await expect(hint).toContainText("arrow keys");
    const other = section(page, "swipe-deck").getByTestId("swipe-deck").nth(1);
    await expect(other.getByTestId("swipe-deck-hint")).toContainText(
      "right for Yes, left for No",
    );
    // A deck's own hint replaces the line.
    await expect(radioDeck(page).getByTestId("swipe-deck-hint")).toHaveText(
      "Pick an answer on the card, or swipe it.",
    );
  });

  test("JavaScript: the radios are hidden unless the deck asks for them, and the buttons are the tab stops", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const deck = firstDeck(page);
    for (const card of await deck.getByTestId("swipe-card").all()) {
      await expect(card.getByTestId("swipe-card-yes-input")).toBeHidden();
      await expect(card.getByTestId("swipe-card-no-input")).toBeHidden();
    }
    const focusedTestId = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    await deck.getByTestId("swipe-deck-no").focus();
    await page.keyboard.press("Tab");
    expect(await focusedTestId()).toBe("swipe-deck-undo");
    await page.keyboard.press("Tab");
    expect(await focusedTestId()).toBe("swipe-deck-yes");
    // Backwards from the first button, focus leaves the deck without
    // stopping on a hidden radio.
    await deck.getByTestId("swipe-deck-no").focus();
    await page.keyboard.press("Shift+Tab");
    expect(
      await deck.evaluate((form) => form.contains(document.activeElement)),
    ).toBe(false);
  });

  test("JavaScript: with the radios hidden, the keyboard alone answers every card", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const sent = await capture(page);
    const deck = firstDeck(page);
    const progress = deck.getByTestId("swipe-deck-progress");
    await deck.getByTestId("swipe-deck-no").focus();
    await page.keyboard.press("Enter");
    await expect(progress).toContainText("1 of 3 answered. Next: Emma");
    await page.keyboard.press("ArrowRight");
    await expect(progress).toContainText("2 of 3 answered. Next: Beloved");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(progress).toContainText("1 of 3 answered. Next: Emma");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => sent.bodies.length).toBe(1);
    // A line for each card, for the model, and one line for the thread.
    expect(fields(sent.bodies[0])).toEqual([
      "Dune=no",
      "Emma=no",
      "Beloved=yes",
      "show=Keep: Beloved. Skip: Dune, Emma.",
    ]);
  });

  test('JavaScript: radios="show" keeps the radios on the cards, with the buttons\' labels', async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const deck = radioDeck(page);
    const top = deck.getByRole("group", { name: "Kindred" });
    await expect(top.getByLabel("Lend")).toBeVisible();
    await expect(top.getByLabel("Hold")).toBeVisible();
    await expect(deck.getByTestId("swipe-deck-yes")).toHaveText("Lend");
    await expect(deck.getByTestId("swipe-deck-no")).toHaveText("Hold");
  });

  test("JavaScript: a dragged card is labelled with the answer its direction gives", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const deck = firstDeck(page);
    await deck.scrollIntoViewIfNeeded();
    const verdict = deck.getByTestId("swipe-deck-verdict");
    await expect(verdict).toHaveCSS("opacity", "0");
    const dune = deck.getByTestId("swipe-card").first();
    const box = (await dune.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 40;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 5 });
    await expect(verdict).toHaveText("Keep");
    await expect(verdict).not.toHaveCSS("opacity", "0");
    await page.mouse.move(x - 60, y, { steps: 5 });
    await expect(verdict).toHaveText("Skip");
    await page.mouse.up();
    // Let go short of the reach: the label goes and the card stays.
    await expect(verdict).toHaveCSS("opacity", "0");
    await expect(dune).toBeVisible();
    await expect(deck.getByTestId("swipe-deck-progress")).toContainText(
      "0 of 3 answered",
    );
  });

  // Count the nudges: every animation started on a card of either deck kind.
  const countNudges = async (page: Page): Promise<() => Promise<number>> => {
    await page.addInitScript(() => {
      const counter = window as unknown as { nudges: number };
      counter.nudges = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.matches("fieldset")) counter.nudges++;
        return animate.apply(this, args);
      };
    });
    await page.goto("/gallery");
    for (const testId of ["swipe-deck-stack", "fact-swipe-stack"]) {
      for (const stack of await page.getByTestId(testId).all()) {
        await stack.scrollIntoViewIfNeeded();
        // Two frames, so the observer has reported this position.
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
      }
    }
    return () =>
      page.evaluate(() => (window as unknown as { nudges: number }).nudges);
  };

  test("JavaScript: one deck on the page nudges its top card, once", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const nudges = await countNudges(page);
    await expect.poll(nudges).toBe(1);
  });

  test("JavaScript: with reduced motion no card is nudged", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const nudges = await countNudges(page);
    expect(await nudges()).toBe(0);
    await expect(firstDeck(page).getByTestId("swipe-deck-hint")).toBeVisible();
  });

  test("JavaScript: buttons, keys, drag and undo; the last answer submits the form", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const sent = await capture(page);
    const deck = firstDeck(page);
    await deck.scrollIntoViewIfNeeded();
    const cards = deck.getByTestId("swipe-card");
    const progress = deck.getByTestId("swipe-deck-progress");

    // Button: Dune is yes.
    await deck.getByTestId("swipe-deck-yes").click();
    await expect(cards.nth(0)).toBeHidden();
    await expect(cards.nth(1)).toBeVisible();
    await expect(progress).toContainText("1 of 3 answered");

    // Undo brings Dune back and clears its radio.
    await deck.getByTestId("swipe-deck-undo").click();
    await expect(cards.nth(0)).toBeVisible();
    await expect(
      cards.nth(0).getByTestId("swipe-card-yes-input"),
    ).not.toBeChecked();
    await expect(progress).toContainText("0 of 3 answered");

    // Keyboard: ArrowRight answers yes.
    await deck.getByTestId("swipe-deck-yes").focus();
    await page.keyboard.press("ArrowRight");
    await expect(cards.nth(0)).toBeHidden();
    await expect(
      cards.nth(0).getByTestId("swipe-card-yes-input"),
    ).toBeChecked();

    // A short drag springs back.
    const emma = cards.nth(1);
    await emma.scrollIntoViewIfNeeded();
    let box = (await emma.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + 40, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(emma).toBeVisible();
    await expect(emma.getByTestId("swipe-card-yes-input")).not.toBeChecked();
    await expect(emma.getByTestId("swipe-card-no-input")).not.toBeChecked();
    await expect(progress).toContainText("1 of 3 answered");

    // A long drag to the left answers no (Emma).
    box = (await emma.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 200, box.y + 40, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(emma).toBeHidden();
    await expect(emma.getByTestId("swipe-card-no-input")).toBeChecked();
    await expect(progress).toContainText("2 of 3 answered");
    expect(sent.bodies).toEqual([]);

    // The last card: ArrowRight, and the form submits itself.
    await deck.getByTestId("swipe-deck-no").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => sent.bodies.length).toBe(1);
    expect(fields(sent.bodies[0])).toEqual([
      "Dune=yes",
      "Emma=no",
      "Beloved=yes",
      "show=Keep: Dune, Beloved. Skip: Emma.",
    ]);
  });

  test("JavaScript: picking a radio by its label answers the card", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const deck = radioDeck(page);
    await deck
      .getByRole("group", { name: "Kindred" })
      .getByLabel("Hold")
      .check();
    await expect(deck.getByTestId("swipe-card").first()).toBeHidden();
    await expect(deck.getByTestId("swipe-deck-progress")).toContainText(
      "1 of 2 answered",
    );
  });

  test("JavaScript: with reduced motion the card leaves at once", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const deck = firstDeck(page);
    await deck.getByTestId("swipe-deck-no").click();
    await expect(deck.getByTestId("swipe-card").first()).toBeHidden({
      timeout: 100,
    });
  });

  test("JavaScript: focus moves to the next card after a radio answer", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const deck = radioDeck(page);
    await deck
      .getByRole("group", { name: "Kindred" })
      .getByLabel("Lend")
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(deck.getByTestId("swipe-deck-progress")).toContainText(
      "1 of 2 answered. Next: Hamlet",
    );
    const focused = await page.evaluate(
      () =>
        document.activeElement?.closest("fieldset")?.querySelector("legend")
          ?.textContent,
    );
    expect(focused).toBe("Hamlet");
  });

  test("JavaScript: reserved and repeated titles get names of their own", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    // The gallery's sample has neither, so serve it with a card titled like a
    // reserved field and one repeating another card's title.
    await page.route("**/gallery", async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replaceAll('name="Emma"', 'name="text"')
        .replaceAll('name="Beloved"', 'name="Dune"');
      await route.fulfill({ response, body });
    });
    await page.goto("/gallery");
    const deck = firstDeck(page);
    const names = await deck
      .locator("input[type=radio]")
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).name),
      );
    expect(names).toEqual([
      "Dune",
      "Dune",
      "text (item)",
      "text (item)",
      "Dune (2)",
      "Dune (2)",
    ]);
    // Answering every card posts one field per card, and no bare "text".
    let posted = "";
    await page.route("**/api/send", async (route) => {
      posted = route.request().postData() ?? "";
      await route.fulfill({ status: 204 });
    });
    for (let card = 0; card < 3; card++) {
      await deck.getByTestId("swipe-deck-yes").click();
    }
    await expect.poll(() => posted).toContain("Dune+%282%29=yes");
    expect(posted).not.toMatch(/(^|&)text=/);
    expect(posted).toContain("text+%28item%29=yes");
  });
});

/* ---- choice-pair ---- */

test.describe("choice-pair", () => {
  const pairs = (page: Page) =>
    section(page, "choice-pair").getByTestId("choice-pair");

  test.beforeEach(async ({ page }) => {
    await page.goto("/gallery");
  });

  test("renders a question and two cards side by side, with Choose only without JavaScript", async ({
    page,
  }) => {
    const pair = pairs(page).first();
    await expect(pair).toHaveAttribute("action", "/api/send");
    await expect(pair.locator("legend")).toHaveText(
      "Which edition of Dune do you want?",
    );
    await expect(pair.getByTestId("pair-option")).toHaveCount(2);
    await expect(pair.getByTestId("pair-option-title")).toHaveText([
      "Hardcover",
      "Paperback",
    ]);
    const boxes = await pair
      .getByTestId("pair-option")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    expect(Math.abs(boxes[0]!.top - boxes[1]!.top)).toBeLessThan(2);
    const submit = pair.getByTestId("choice-pair-submit");
    if (withScripts()) await expect(submit).toBeHidden();
    else await expect(submit).toBeVisible();
  });

  test("stacks on a narrow screen", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const cards = pairs(page).first().getByTestId("pair-option");
    const [a, b] = await cards.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()),
    );
    expect(b!.top).toBeGreaterThan(a!.bottom - 1);
  });

  test("clicking a card posts its title as text", async ({ page }) => {
    const sent = await capture(page);
    const pair = pairs(page).first();
    await pair.getByTestId("pair-option").nth(1).click();
    if (!withScripts()) {
      await expect(pair.locator("input:checked")).toHaveCount(1);
      await pair.getByTestId("choice-pair-submit").click();
    }
    await expect.poll(() => sent.bodies.length).toBe(1);
    expect(fields(sent.bodies[0])).toEqual(["text=Paperback"]);
  });

  test("no JavaScript: submitting with nothing chosen is blocked", async ({
    page,
  }) => {
    test.skip(withScripts(), "no-JavaScript case");
    const sent = await capture(page);
    await pairs(page).first().getByTestId("choice-pair-submit").click();
    await page.waitForTimeout(300);
    expect(sent.bodies).toEqual([]);
  });

  test("no JavaScript: arrows select and Enter sends", async ({ page }) => {
    test.skip(withScripts(), "no-JavaScript case");
    const sent = await capture(page);
    const pair = pairs(page).first();
    await pair.getByTestId("pair-option").first().locator("input").focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      pair.getByTestId("pair-option").nth(1).locator("input"),
    ).toBeChecked();
    await page.keyboard.press("Enter");
    await expect.poll(() => sent.bodies.length).toBe(1);
    expect(fields(sent.bodies[0])).toEqual(["text=Paperback"]);
  });

  test("JavaScript: arrows move the selection without sending; Enter sends", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const sent = await capture(page);
    const pair = pairs(page).nth(1);
    await pair.getByTestId("pair-option").first().locator("input").focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      pair.getByTestId("pair-option").nth(1).locator("input"),
    ).toBeChecked();
    await page.waitForTimeout(300);
    expect(sent.bodies).toEqual([]);
    await page.keyboard.press("Enter");
    await expect.poll(() => sent.bodies.length).toBe(1);
    expect(fields(sent.bodies[0])).toEqual(["text=The Dispossessed"]);
  });

  test("JavaScript: a click after an arrow press still sends", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    const sent = await capture(page);
    const pair = pairs(page).nth(1);
    await pair.getByTestId("pair-option").first().locator("input").focus();
    await page.keyboard.press("ArrowRight");
    await pair.getByTestId("pair-option").first().click();
    await expect.poll(() => sent.bodies.length).toBe(1);
    expect(fields(sent.bodies[0])).toEqual(["text=The Left Hand of Darkness"]);
  });

  test("a long unbroken title wraps inside its card", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const card = pairs(page).first().getByTestId("pair-option").first();
    await card.evaluate((el) => {
      el.querySelector("[data-testid=pair-option-title]")!.textContent =
        "9780441013593".repeat(8);
    });
    expect(
      await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  });

  test("the chosen card is highlighted and shows a check mark, not only a color", async ({
    page,
  }) => {
    await page.evaluate(() =>
      document.addEventListener(
        "submit",
        (event) => event.preventDefault(),
        true,
      ),
    );
    const card = pairs(page).first().getByTestId("pair-option").first();
    const before = await card.evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    await card.click();
    await expect(card.locator("input")).toBeChecked();
    expect(
      await card.evaluate((el) => getComputedStyle(el).borderColor),
    ).not.toBe(before);
    const mark = await card
      .getByTestId("pair-option-title")
      .evaluate((el) => getComputedStyle(el, "::after").content);
    expect(mark).toContain("✓");
  });
});

/* ---- map-view ---- */

test.describe("map-view", () => {
  const maps = (page: Page) =>
    section(page, "map-view").getByTestId("map-view");

  test("renders a titled list of pins, and the map canvas stays hidden until it loads", async ({
    page,
  }) => {
    await page.goto("/gallery");
    await expect(maps(page)).toHaveCount(3);
    const first = maps(page).first();
    await expect(first.getByRole("heading")).toHaveText(
      "Bookshops of Charing Cross Road",
    );
    await expect(first.getByTestId("map-pin")).toHaveCount(3);
    await expect(first.getByTestId("map-pin").first()).toContainText("Foyles");
    await expect(first.getByTestId("map-view-list")).toBeVisible();
    await expect(first.getByTestId("map-view-canvas")).toBeHidden();
  });

  test("no JavaScript: a pin's link is a plain GET to OpenStreetMap", async ({
    page,
  }) => {
    test.skip(withScripts(), "no-JavaScript case");
    await page.goto("/gallery");
    const pin = maps(page).first().getByTestId("map-pin").first();
    const form = pin.getByTestId("map-pin-open");
    await expect(form).toHaveAttribute("method", "get");
    await expect(form).toHaveAttribute(
      "action",
      "https://www.openstreetmap.org/",
    );
    let seen: URL | undefined;
    await page.context().route("https://www.openstreetmap.org/**", (route) => {
      seen = new URL(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "<p>osm</p>" });
    });
    const popup = page.waitForEvent("popup");
    await pin.getByTestId("map-pin-link").click();
    await (await popup).waitForLoadState();
    await expect.poll(() => seen?.hostname).toBe("www.openstreetmap.org");
    expect(seen!.searchParams.get("mlat")).toBe("51.5159");
    expect(seen!.searchParams.get("mlon")).toBe("-0.1294");
  });

  test("JavaScript: a pin's link is a noopener anchor built from its numbers", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    await page.goto("/gallery");
    const pin = maps(page).first().getByTestId("map-pin").first();
    const link = pin.getByTestId("map-pin-link");
    await expect(link).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/?mlat=51.5159&mlon=-0.1294#map=12/51.5159/-0.1294",
    );
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(pin.getByTestId("map-pin-open")).toHaveCount(0);
    await expect(maps(page).nth(1).getByTestId("map-pin-link")).toHaveAttribute(
      "href",
      /#map=14\/48\.853\/2\.3499$/,
    );
  });

  test("JavaScript: nothing is requested until a map scrolls into view", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    await page.setViewportSize({ width: 800, height: 400 });
    await page.goto("/gallery");
    await page.waitForTimeout(300);
    expect(cdn.filter((path) => path.includes("leaflet"))).toHaveLength(0);
    await maps(page).first().scrollIntoViewIfNeeded();
    await expect
      .poll(() => cdn.some((path) => path.endsWith("/dist/leaflet.js")))
      .toBe(true);
  });

  test("JavaScript: when the library cannot load, the list stays and the canvas stays hidden", async ({
    page,
  }) => {
    test.skip(
      LEAFLET_DIR !== null,
      "the library loads here; this case needs it to fail",
    );
    test.skip(!withScripts(), "JavaScript case");
    await page.goto("/gallery");
    const first = maps(page).first();
    await first.scrollIntoViewIfNeeded();
    await expect.poll(() => cdn.length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(first.getByTestId("map-view-canvas")).toBeHidden();
    await expect(first.getByTestId("map-pin")).toHaveCount(3);
    await expect(first.getByTestId("map-pin-link").first()).toBeVisible();
  });

  test("JavaScript: a failed stylesheet keeps the map hidden and the list", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!LEAFLET_DIR, NO_LEAFLET);
    await page.route("**/leaflet.css", (route) => route.abort());
    await page.goto("/gallery");
    // Every map shares the one failed load, the second as much as the first:
    // none of them may show a map without its stylesheet.
    for (const at of [0, 1]) {
      const map = maps(page).nth(at);
      await map.scrollIntoViewIfNeeded();
      await expect(map.getByTestId("map-view-canvas")).toHaveAttribute(
        "data-ready",
        "failed",
      );
      await expect(map.getByTestId("map-view-canvas")).toBeHidden();
      await expect(map.getByTestId("map-view-list")).toBeVisible();
    }
  });

  test("JavaScript: markers, attribution, popups and panning", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!LEAFLET_DIR, NO_LEAFLET);
    await page.goto("/gallery");
    const map = maps(page).first();
    await map.scrollIntoViewIfNeeded();
    const canvas = map.getByTestId("map-view-canvas");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    await expect(canvas).toHaveAttribute("data-markers", "3");
    await expect(canvas).toHaveAttribute(
      "aria-label",
      "Map: Bookshops of Charing Cross Road",
    );
    await expect(canvas.locator(".leaflet-marker-icon")).toHaveCount(3);
    await expect(canvas.locator(".leaflet-control-attribution")).toContainText(
      "OpenStreetMap",
    );
    const alts = await canvas
      .locator(".leaflet-marker-icon")
      .evaluateAll((els) => els.map((el) => el.getAttribute("alt")));
    expect(alts).toContain("Foyles");
    expect(alts).not.toContain("Marker");
    await expect(map.getByTestId("map-view-list")).toHaveAttribute(
      "role",
      "list",
    );
    // Keyboard: a marker takes focus and Enter opens its popup.
    await canvas.locator(".leaflet-marker-icon").first().focus();
    await page.keyboard.press("Enter");
    await expect(canvas.locator(".leaflet-popup-content")).toContainText(
      /Foyles|Waterstones|Hatchards/,
    );
    await page.keyboard.press("Escape");
    // Pointer drag pans the map.
    const pane = canvas.locator(".leaflet-map-pane");
    const before = await pane.evaluate(
      (el) => (el as HTMLElement).style.transform,
    );
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 90, { steps: 8 });
    await page.mouse.up();
    expect(
      await pane.evaluate((el) => (el as HTMLElement).style.transform),
    ).not.toBe(before);
  });

  test("JavaScript: a lone pin uses the zoom, a map with only a center shows no markers", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!LEAFLET_DIR, NO_LEAFLET);
    await page.goto("/gallery");
    const lone = maps(page).nth(1);
    await lone.scrollIntoViewIfNeeded();
    const canvas = lone.getByTestId("map-view-canvas");
    await expect(canvas).toHaveAttribute("data-markers", "1");
    await canvas.locator(".leaflet-marker-icon").click();
    await expect(canvas.locator(".leaflet-popup-content")).toContainText(
      "Shakespeare and Company",
    );
    const center = maps(page).nth(2);
    await center.scrollIntoViewIfNeeded();
    await expect(center.getByTestId("map-view-canvas")).toHaveAttribute(
      "data-markers",
      "0",
    );
  });

  test("JavaScript: all maps share one library load", async ({ page }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!LEAFLET_DIR, NO_LEAFLET);
    await page.goto("/gallery");
    for (let i = 0; i < 3; i++)
      await maps(page).nth(i).scrollIntoViewIfNeeded();
    await expect(
      section(page, "map-view").locator(
        '[data-testid="map-view-canvas"][data-ready="true"]',
      ),
    ).toHaveCount(3);
    expect(await page.locator('script[src*="leaflet"]').count()).toBe(1);
    expect(await page.locator('link[href*="leaflet"]').count()).toBe(1);
  });

  test("JavaScript: reduced motion turns Leaflet's animation off", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!LEAFLET_DIR, NO_LEAFLET);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/gallery");
    const map = maps(page).first();
    await map.scrollIntoViewIfNeeded();
    const canvas = map.getByTestId("map-view-canvas");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    await expect(canvas.locator(".leaflet-fade-anim")).toHaveCount(0);
    await expect(canvas.locator(".leaflet-zoom-anim")).toHaveCount(0);
  });
});

/* ---- scene-3d ---- */

// A canvas that answers for WebGL, so the component goes on to ask for the
// library even where the browser has no graphics stack. Only for the specs
// that refuse the library.
const pretendWebGL = (): void => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    if (type === "webgl" || type === "webgl2") {
      return { getExtension: () => null };
    }
    return (original as (...args: unknown[]) => unknown).call(
      this,
      type,
      ...rest,
    );
  } as typeof original;
};

const noWebGL = (): void => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    if (type === "webgl" || type === "webgl2") return null;
    return (original as (...args: unknown[]) => unknown).call(
      this,
      type,
      ...rest,
    );
  } as typeof original;
};

test.describe("scene-3d", () => {
  const scene = (page: Page, title: string) =>
    section(page, "scene-3d")
      .getByTestId("scene-3d")
      .filter({ hasText: title });

  test("renders its title, caption and a table of the objects", async ({
    page,
  }) => {
    await page.goto("/gallery");
    const molecule = scene(page, "Water molecule");
    await expect(molecule).toContainText(
      "One oxygen atom bonded to two hydrogen atoms.",
    );
    const rows = molecule.getByTestId("scene-object");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Oxygen" })).toContainText("red");
    await expect(rows.filter({ hasText: "Oxygen" })).toContainText("sphere");
    await expect(molecule.getByTestId("scene-3d-table")).toBeVisible();
    await expect(
      scene(page, "Bookshelf").getByTestId("scene-object"),
    ).toHaveCount(4);
  });

  test("no JavaScript: no canvas, no form, no request", async ({ page }) => {
    test.skip(withScripts(), "no-JavaScript case");
    const sends: string[] = [];
    await page.route("**/api/send", (route) => {
      sends.push(route.request().url());
      return route.abort();
    });
    await page.goto("/gallery");
    const molecule = scene(page, "Water molecule");
    await expect(molecule.getByTestId("scene-3d-canvas")).toBeHidden();
    expect(await section(page, "scene-3d").locator("form").count()).toBe(0);
    expect(sends).toEqual([]);
    expect(cdn).toEqual([]);
  });

  test("JavaScript: makes no CDN request until a scene is in view", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    await page.addInitScript(pretendWebGL);
    await page.setViewportSize({ width: 800, height: 60 });
    await page.goto("/gallery");
    await page.waitForTimeout(800);
    expect(cdn.filter((path) => path.includes("three"))).toHaveLength(0);
    await scene(page, "Water molecule").scrollIntoViewIfNeeded();
    await expect
      .poll(() => cdn.some((path) => path.includes("three@")), {
        timeout: 10_000,
      })
      .toBe(true);
  });

  test("JavaScript: a library that cannot load keeps the table and says so", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(
      THREE_DIR !== null,
      "the library loads here; this case needs it to fail",
    );
    await page.addInitScript(pretendWebGL);
    await page.goto("/gallery");
    const molecule = scene(page, "Water molecule");
    await molecule.scrollIntoViewIfNeeded();
    await expect(molecule.getByTestId("scene-3d-status")).toContainText(
      "could not load",
    );
    await expect(molecule.getByTestId("scene-3d-canvas")).toBeHidden();
    await expect(molecule.getByTestId("scene-3d-table")).toBeVisible();
  });

  test("JavaScript: with no WebGL the table stays and the status says so", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    await page.addInitScript(noWebGL);
    await page.goto("/gallery");
    const molecule = scene(page, "Water molecule");
    await molecule.scrollIntoViewIfNeeded();
    await expect(molecule.getByTestId("scene-3d-status")).toContainText(
      "unavailable",
    );
    await expect(molecule.getByTestId("scene-3d-canvas")).toBeHidden();
    await expect(molecule.getByTestId("scene-3d-table")).toBeVisible();
    expect(cdn.filter((path) => path.includes("three"))).toHaveLength(0);
  });

  test("JavaScript: a canvas with a described label, and a vertical touch still scrolls the page", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!THREE_DIR, NO_THREE);
    await page.goto("/gallery");
    const molecule = scene(page, "Water molecule");
    await molecule.scrollIntoViewIfNeeded();
    const canvas = molecule.getByTestId("scene-3d-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await expect(canvas).toHaveAttribute("role", "application");
    await expect(canvas).toHaveAttribute("aria-roledescription", "3D scene");
    const label = (await canvas.getAttribute("aria-label")) ?? "";
    expect(label).toContain("Water molecule");
    expect(label).toContain("3 objects");
    expect(label).toContain("red sphere Oxygen");
    await expect(molecule.getByTestId("scene-3d-status")).toHaveText("");
    await expect(molecule.getByTestId("scene-3d-table")).toBeVisible();
    expect(
      await canvas.evaluate((el) => getComputedStyle(el).touchAction),
    ).toBe("pan-y");
  });

  test("JavaScript: a drag stops the auto-rotation and rotates; the keyboard rotates", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!THREE_DIR, NO_THREE);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/gallery");
    const shelf = scene(page, "Bookshelf");
    await shelf.scrollIntoViewIfNeeded();
    const canvas = shelf.getByTestId("scene-3d-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    const a = await canvas.screenshot();
    await page.waitForTimeout(600);
    const b = await canvas.screenshot();
    expect(Buffer.compare(a, b)).not.toBe(0);
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 20, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const c = await canvas.screenshot();
    await page.waitForTimeout(600);
    const d = await canvas.screenshot();
    expect(Buffer.compare(c, d)).toBe(0);
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    expect(Buffer.compare(d, await canvas.screenshot())).not.toBe(0);
  });

  test("JavaScript: with reduced motion nothing rotates by itself, but the keyboard still does", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!THREE_DIR, NO_THREE);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/gallery");
    const shelf = scene(page, "Bookshelf");
    await shelf.scrollIntoViewIfNeeded();
    const canvas = shelf.getByTestId("scene-3d-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const a = await canvas.screenshot();
    await page.waitForTimeout(700);
    const b = await canvas.screenshot();
    expect(Buffer.compare(a, b)).toBe(0);
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    expect(Buffer.compare(b, await canvas.screenshot())).not.toBe(0);
  });

  test("JavaScript: a lost WebGL context hides the canvas and says so", async ({
    page,
  }) => {
    test.skip(!withScripts(), "JavaScript case");
    test.skip(!THREE_DIR, NO_THREE);
    await page.goto("/gallery");
    const molecule = scene(page, "Water molecule");
    await molecule.scrollIntoViewIfNeeded();
    const canvas = molecule.getByTestId("scene-3d-canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await canvas.evaluate((el) => {
      const gl = ((el as HTMLCanvasElement).getContext("webgl2") ??
        (el as HTMLCanvasElement).getContext("webgl")) as WebGLRenderingContext;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    });
    await expect(molecule.getByTestId("scene-3d-status")).toContainText(
      "was lost",
    );
    await expect(canvas).toBeHidden();
    await expect(molecule.getByTestId("scene-3d-table")).toBeVisible();
  });
});
