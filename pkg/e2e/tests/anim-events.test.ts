/**
 * e2e tests for CSS animation event scoping on the anim-events-test fixture page.
 *
 * Two instances of <anim-events> are rendered side by side. The component
 * uses a CSS @keyframes animation triggered by adding a class. bascik scopes:
 *   - @keyframes name: `flashGreen` → `bascik__anim-events__keyframe__flashGreen`
 *   - trigger class:   `.playing`   → `.bascik__anim-events__playing`
 *   - compound selector: `.anim-box.playing` → scoped compound equivalent
 *
 * The animationend event fires with e.animationName equal to the SCOPED keyframe
 * name. The component JS listens for animationstart/animationend on the anim-box
 * element and updates a status div accordingly.
 *
 * The fixture is built with `minify.identifiers: false` so scoped names
 * are readable (e.g. `bascik__anim-events__wrapper`).
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator(".bascik__anim-events__wrapper").nth(n);
}

const status = (inst: Locator) => inst.locator('[id$="__status"]');
const box = (inst: Locator) => inst.locator('[id$="__anim-box"]');
const playBtn = (inst: Locator) => inst.locator('[id$="__play-btn"]');
const resetBtn = (inst: Locator) => inst.locator('[id$="__reset-btn"]');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("anim-events-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/anim-events-test");
  });

  // ── 1. Initial state ─────────────────────────────────────────────────────

  test('initial status is "waiting..."', async ({ page }) => {
    const a = getInstance(page, 0);
    await expect(status(a)).toHaveText("waiting...");
  });

  // ── 2. Clicking play-btn triggers the animation ──────────────────────────
  //
  // The JS sets status to "animation: triggered" then animationstart fires
  // almost immediately and sets it to "animation: started". We assert that
  // the status has entered any animation phase (not still "waiting...").

  test("clicking play-btn triggers animation (status leaves waiting state)", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await playBtn(a).click();

    await expect(status(a)).not.toHaveText("waiting...");
  });

  // ── 3. animationend event fires and status shows "ended" ─────────────────

  test('animationend event fires and status shows "ended"', async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await playBtn(a).click();

    // Animation is 0.2s; allow generous timeout for reflow + event dispatch
    await expect(status(a)).toHaveText("animation: ended", { timeout: 3000 });
  });

  // ── 4. playing class is removed after animation ends ────────────────────

  test("after animation ends, playing class is removed from anim-box", async ({
    page,
  }) => {
    const a = getInstance(page, 0);

    await playBtn(a).click();

    // Wait for the animation to finish
    await expect(status(a)).toHaveText("animation: ended", { timeout: 3000 });

    // The scoped playing class should be gone from the box
    await expect(box(a)).not.toHaveClass(/bascik__anim-events__playing/);
  });

  // ── 5. reset-btn restores status to "waiting..." ────────────────────────

  test('reset-btn resets status to "waiting..."', async ({ page }) => {
    const a = getInstance(page, 0);

    await playBtn(a).click();
    // Give the animation a moment to start before resetting
    await expect(status(a)).not.toHaveText("waiting...");

    await resetBtn(a).click();

    await expect(status(a)).toHaveText("waiting...");
  });

  // ── 6. Instance A animation does not affect instance B status ────────────

  test("instance A animation does not affect instance B status", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    await playBtn(a).click();

    // A's status changes, B's stays at "waiting..."
    await expect(status(a)).not.toHaveText("waiting...");
    await expect(status(b)).toHaveText("waiting...");
  });

  // ── 7. Instance B animates independently ─────────────────────────────────

  test("instance B animates independently", async ({ page }) => {
    const b = getInstance(page, 1);

    await playBtn(b).click();

    // Wait for the full animation cycle
    await expect(status(b)).toHaveText("animation: ended", { timeout: 3000 });
  });
});
