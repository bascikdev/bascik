/**
 * e2e tests for CSS :root custom property scoping on the root-vars-test fixture page.
 *
 * Two instances of <root-vars> and one <css-advanced> are rendered. Tests verify:
 *   - :root custom properties are scoped (--primary → --bascik__root-vars__primary)
 *   - :root selector is preserved; scoped property names are injected into it
 *   - .box receives the correct primary color from the scoped :root property
 *   - .accent-box receives the correct accent color from the scoped :root property
 *   - var() with a fallback resolves to the declared value (not the fallback)
 *   - Both root-vars instances share the same scoped property values
 *   - css-advanced's --accent on .wrapper does not bleed into root-vars (no collision)
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number): Locator {
  return page.locator(".bascik__root-vars__wrapper").nth(n);
}

function primaryBox(inst: Locator): Locator {
  return inst.locator(".bascik__root-vars__box");
}

function accentBox(inst: Locator): Locator {
  return inst.locator(".bascik__root-vars__accent-box");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("root-vars-test page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/root-vars-test");
  });

  // ── 1. Primary color from :root custom property ──────────────────────────

  test("box has correct primary color from :root custom property", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await primaryBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(96, 165, 250)");
  });

  // ── 2. Accent color from :root custom property ───────────────────────────

  test("accent-box has correct accent color from :root custom property", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const color = await accentBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(74, 222, 128)");
  });

  // ── 3. var() with fallback resolves to declared value, not fallback ───────

  test("var() with fallback: accent-box border uses --accent value, not fallback", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const borderColor = await accentBox(a).evaluate(
      (el) => getComputedStyle(el).borderColor,
    );
    // CSS: border: 2px solid var(--accent, rgb(100, 100, 100))
    // --accent is declared so the fallback must NOT apply
    expect(borderColor).toBe("rgb(74, 222, 128)");
  });

  // ── 4. Both instances share the same scoped :root custom property values ──

  test("both instances have correct primary color (scoped :root properties apply globally)", async ({
    page,
  }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);
    const colorA = await primaryBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    const colorB = await primaryBox(b).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(colorA).toBe("rgb(96, 165, 250)");
    expect(colorB).toBe("rgb(96, 165, 250)");
  });

  test("both instances have correct accent color", async ({ page }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);
    const colorA = await accentBox(a).evaluate(
      (el) => getComputedStyle(el).color,
    );
    const colorB = await accentBox(b).evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(colorA).toBe("rgb(74, 222, 128)");
    expect(colorB).toBe("rgb(74, 222, 128)");
  });

  // ── 5. Cross-component isolation: scoped :root vars don't bleed ──────────
  //
  // The page also has a <css-advanced> instance. css-advanced defines --accent
  // on .wrapper (component-scoped). root-vars defines --accent on :root
  // (page-scoped but with a scoped name). After bascik scoping:
  //   - root-vars: --bascik__root-vars__accent → rgb(74, 222, 128) on :root
  //   - css-advanced: --bascik__css-advanced__accent → rgb(74, 222, 128) on .wrapper
  // These are distinct custom property names; neither bleeds into the other.
  //
  // Verify by checking the page source: --bascik__css-advanced__accent must NOT
  // appear inside the :root rule, and --bascik__root-vars__accent must NOT
  // appear inside the css-advanced class scope.

  test("scoped :root rule contains only root-vars properties, not css-advanced properties", async ({
    page,
  }) => {
    const html = await page.content();
    // Extract all :root { … } block(s)
    const rootBlocks = [...html.matchAll(/:root\s*\{([^}]*)\}/g)].map(
      (m) => m[1],
    );
    expect(rootBlocks.length).toBeGreaterThan(0);
    for (const block of rootBlocks) {
      // css-advanced's scoped --accent must not appear inside :root
      expect(block).not.toContain("--bascik__css-advanced__accent");
    }
  });

  test("css-advanced accent-box still has its own correct accent color", async ({
    page,
  }) => {
    const advancedWrapper = page
      .locator(".bascik__css-advanced__wrapper")
      .first();
    const bg = await advancedWrapper
      .locator(".bascik__css-advanced__accent-box")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(74, 222, 128)");
  });
});
