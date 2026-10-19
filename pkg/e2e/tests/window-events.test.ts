/**
 * e2e tests for window.addEventListener and CustomEvent scoping on the
 * window-events-test fixture page.
 *
 * Two instances of <window-events> are rendered side by side. Key behaviors:
 *
 * 1. window.addEventListener('resize', ...) — the callback's getElementById
 *    calls use scoped per-instance IDs (embedded at build time), so each
 *    instance updates its own `result` element even though all instances share
 *    the same global window listener. When window resize fires ALL instances'
 *    callbacks run — this is expected and tested.
 *
 * 2. CustomEvent('comp-update') — event names are NOT scoped by bascik.
 *    Dispatching from one instance's wrapper propagates to document, and ALL
 *    instances' document.addEventListener('comp-update') handlers fire. This
 *    cross-instance behaviour is intentional and documented here.
 *
 * 3. The `instanceId` embedded in the CustomEvent detail is the scoped wrapper
 *    ID (e.g. "bascik__window-events__d6f6274a__wrapper") — distinct per
 *    instance since getElementById("wrapper") is rewritten at build time.
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__window-events__wrapper").nth(n);
}

const result = (inst: Locator) => inst.locator('[id$="__result"]');
const customResult = (inst: Locator) => inst.locator('[id$="__custom-result"]');
const dispatchBtn = (inst: Locator) => inst.locator('[id$="__dispatch-btn"]');
const triggerResizeBtn = (inst: Locator) =>
  inst.locator('[id$="__trigger-resize-btn"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("window-events-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/window-events-test");
  });

  // ── 1. Initial state ─────────────────────────────────────────────────────

  test('initial result text is "No event yet"', async ({ page }) => {
    const a = getInstance(page, 0);
    await expect(result(a)).toHaveText("No event yet");
  });

  test('initial custom-result text is "No custom event yet"', async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    await expect(customResult(a)).toHaveText("No custom event yet");
  });

  // ── 2. trigger-resize-btn fires window resize, instance A updates ─────────

  test("trigger-resize-btn fires resize event and instance A result updates", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await triggerResizeBtn(a).click();

    await expect(result(a)).toHaveText("resize fired");
  });

  // ── 3. Resize fires for ALL instances (global window listener) ────────────
  //
  // Both instances register on window.addEventListener('resize'). When either
  // trigger-resize-btn is clicked it calls window.dispatchEvent(new Event('resize')),
  // which causes BOTH instances' callbacks to fire — each updating its own
  // scoped result element.

  test("trigger-resize-btn on instance A also updates instance B result", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await triggerResizeBtn(a).click();

    // Both instances registered on window, so both callbacks fire
    await expect(result(a)).toHaveText("resize fired");
    await expect(result(b)).toHaveText("resize fired");
  });

  test("trigger-resize-btn on instance B also updates instance A result", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await triggerResizeBtn(b).click();

    await expect(result(a)).toHaveText("resize fired");
    await expect(result(b)).toHaveText("resize fired");
  });

  // ── 4. dispatch-btn sends CustomEvent, received by THIS instance ──────────

  test("dispatch-btn on instance A updates instance A custom-result", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await dispatchBtn(a).click();

    // The custom-result should show the scoped wrapper ID of instance A
    await expect(customResult(a)).toHaveText(
      /^custom: bascik__window-events__/,
    );
  });

  // ── 5. CustomEvent is cross-instance (all document listeners fire) ─────────
  //
  // Both instances call document.addEventListener('comp-update', ...). When
  // instance A dispatches the event with bubbles:true, it reaches document and
  // both listeners run — each updating its own scoped custom-result element.

  test("dispatch-btn on instance A also updates instance B custom-result", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await dispatchBtn(a).click();

    // Both document listeners fire — B also updates
    await expect(customResult(a)).toHaveText(
      /^custom: bascik__window-events__/,
    );
    await expect(customResult(b)).toHaveText(
      /^custom: bascik__window-events__/,
    );
  });

  // ── 6. CustomEvent detail.instanceId is the scoped wrapper ID ────────────

  test("custom-result shows the scoped wrapper id of the dispatching instance", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await dispatchBtn(a).click();

    // The instanceId in the detail is document.getElementById("wrapper").id
    // which bascik rewrites to the per-instance scoped ID at build time.
    // It must contain the component name and end with "__wrapper".
    await expect(customResult(a)).toHaveText(
      /bascik__window-events__[a-f0-9]+__wrapper/,
    );
  });

  // ── 7. Instance A and B have different scoped wrapper IDs ────────────────

  test("instance A scoped wrapper ID differs from instance B scoped wrapper ID", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    const idA = await a.getAttribute("id");
    const idB = await b.getAttribute("id");

    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toEqual(idB);
  });

  // ── 8. result content is exactly "resize fired" after resize ─────────────

  test('result text is exactly "resize fired" after resize event', async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await triggerResizeBtn(a).click();

    await expect(result(a)).toHaveText("resize fired");
  });
});
