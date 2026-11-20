import { expect, test } from "@playwright/test";

test("fine-pointer hover crosses the gap and Escape dismisses without reopening", async ({
  page,
}) => {
  await page.goto("/");
  const toggle = page.getByTestId("site-header-submenu-toggle");
  const submenu = page.getByTestId("site-header-submenu");
  await toggle.hover();
  await expect(submenu).toBeVisible();
  const button = (await toggle.boundingBox())!;
  const panel = (await submenu.boundingBox())!;
  await page.mouse.move(
    button.x + button.width / 2,
    (button.y + button.height + panel.y) / 2,
  );
  await page.waitForTimeout(250);
  await expect(submenu).toBeVisible();
  await submenu.getByTestId("site-header-link").first().hover();
  await expect(submenu).toBeVisible();
  await submenu.getByTestId("site-header-link").first().focus();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(submenu).toBeHidden();
  await page.waitForTimeout(250);
  await expect(submenu).toBeHidden();
  await page.getByTestId("site-header-logo").focus();
  await page.mouse.move(5, 500);
  await expect(submenu).toBeHidden();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(submenu.getByTestId("site-header-link").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(submenu).toBeHidden();
  await page.waitForTimeout(250);
  await expect(submenu).toBeHidden();
  await page.keyboard.press("Space");
  await expect(submenu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(submenu.getByTestId("site-header-link").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(submenu.getByTestId("site-header-link").last()).toBeFocused();
  await page.getByTestId("site-header-logo").focus();
  await expect(submenu).toBeHidden();
  expect(
    await toggle.evaluate((el) => getComputedStyle(el).borderTopWidth),
  ).toBe("0px");
});

test("theme icon persists both choices before paint and has no transition flash", async ({
  page,
}) => {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      (window as unknown as { firstTheme: string | undefined }).firstTheme =
        document.documentElement.dataset.theme;
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const toggle = page.getByTestId("theme-toggle-button");
  await expect(toggle).toHaveAccessibleName("Toggle dark mode");
  expect((await toggle.textContent())!.trim()).toBe("");
  expect(await toggle.locator("svg").count()).toBeGreaterThan(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  expect(
    await page.evaluate(
      () => (window as unknown as { firstTheme: string }).firstTheme,
    ),
  ).toBe("dark");
  const dark = await page
    .getByTestId("site-header")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  await toggle.click();
  await page.reload();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("light");
  expect(
    await page.evaluate(
      () => (window as unknown as { firstTheme: string }).firstTheme,
    ),
  ).toBe("light");
  expect(
    await page
      .getByTestId("site-header")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe(dark);
  await page
    .getByTestId("site-header-link")
    .filter({ hasText: "About" })
    .click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`initial content is static and overflow-free (${reducedMotion}) on every route`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.addInitScript(() => {
      const frames: { opacity: string; animation: string }[] = [];
      (window as unknown as { initialFrames: typeof frames }).initialFrames =
        frames;
      let samples = 0;
      const sample = () => {
        const hero = document.querySelector('[data-testid="home-hero"]');
        if (hero) {
          const css = getComputedStyle(hero);
          frames.push({ opacity: css.opacity, animation: css.animationName });
        }
        if (++samples < 12) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of [
          "/",
          "/services/",
          "/services/manuscript-editing",
          "/services/book-design",
          "/services/distribution",
          "/services/royalty-accounting",
          "/about",
          "/careers",
          "/news",
          "/contact",
          "/privacy",
          "/terms",
          "/missing",
        ]) {
          await page.goto(path);
          await page.waitForTimeout(60);
          const state = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            animations: document
              .getAnimations()
              .filter(
                (a) =>
                  a.effect instanceof KeyframeEffect &&
                  (a.effect.target as Element)?.getBoundingClientRect().top <
                    innerHeight,
              ).length,
            frames: (
              window as unknown as {
                initialFrames: { opacity: string; animation: string }[];
              }
            ).initialFrames,
            computed: Array.from(document.querySelectorAll("*"))
              .filter((element) => {
                const box = element.getBoundingClientRect();
                return (
                  box.height > 0 && box.bottom > 0 && box.top < innerHeight
                );
              })
              .flatMap((element) =>
                ["", "::before", "::after"].map(
                  (pseudo) =>
                    getComputedStyle(element, pseudo || null).animationName,
                ),
              ),
          }));
          expect(state.overflow, `${width} ${path}`).toBe(false);
          expect(state.animations, `${width} ${path}`).toBe(0);
          expect(
            state.computed.every((name) => name === "none"),
            `${width} ${path}`,
          ).toBe(true);
          for (const frame of state.frames)
            expect(frame).toEqual({ opacity: "1", animation: "none" });
        }
      }
    }
  });
}

test("touch disclosure and mobile navigation close with Escape and restore focus", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    baseURL: "http://127.0.0.1:9413",
  });
  const page = await context.newPage();
  await page.goto("/");
  const nav = page.getByTestId("site-header-nav-toggle");
  const menu = page.getByTestId("site-header-nav-menu");
  const toggle = page.getByTestId("site-header-submenu-toggle");
  const submenu = page.getByTestId("site-header-submenu");
  await expect(menu).toBeHidden();
  await nav.tap();
  await expect(menu).toBeVisible();
  expect(
    (await page.getByTestId("theme-toggle-button").boundingBox())!.y,
  ).toBeLessThan((await menu.boundingBox())!.y);
  await expect(submenu).toBeHidden();
  await toggle.tap();
  await expect(submenu).toBeVisible();
  await toggle.tap();
  await expect(submenu).toBeHidden();
  await toggle.tap();
  await submenu.getByTestId("site-header-link").first().focus();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(submenu).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(nav).toBeFocused();
  await nav.tap();
  await page.getByTestId("site-header-link").filter({ hasText: "About" }).tap();
  await expect(page).toHaveURL(/\/about$/);
  await expect(menu).toBeHidden();
  await context.close();
});

test("production CSS is inline, canonical favicon is intact, and nav links are deliberate", async ({
  page,
  request,
}) => {
  const styles: string[] = [];
  page.on("request", (request) => {
    if (/\/styles\.css(?:[?#]|$)/.test(request.url()))
      styles.push(request.url());
  });
  const response = await page.goto("/");
  expect(styles).toEqual([]);
  expect(
    await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) =>
        links.some((link) =>
          (link as HTMLLinkElement).href.includes("styles.css"),
        ),
      ),
  ).toBe(false);
  const html = await response!.text();
  expect(html).not.toMatch(/<link[^>]+styles\.css/);
  expect(html).not.toMatch(/@view-transition|view-transition-name/);
  const favicon = await request.get("/assets/favicon.svg");
  expect(await favicon.text()).toContain("#d3ff8d");
  await expect(page.getByTestId("site-header-logo")).toHaveText("corporate");
  const about = page
    .getByTestId("site-header-link")
    .filter({ hasText: "About" });
  expect(
    await about.evaluate((el) => getComputedStyle(el).textDecorationLine),
  ).toBe("none");
});

test("native navigation survives without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
    baseURL: "http://127.0.0.1:9413",
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("site-header-nav-menu")).toBeVisible();
  await expect(page.getByTestId("site-header-submenu")).toBeVisible();
  await expect(page.getByTestId("theme-toggle-button")).toBeHidden();
  await page
    .getByTestId("site-header-submenu")
    .getByTestId("site-header-link")
    .first()
    .click();
  await expect(page).toHaveURL(/\/services\/manuscript-editing$/);
  await context.close();
});

test("theme preference follows the system when storage is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage disabled");
      },
    });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const button = page.getByTestId("theme-toggle-button");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(button).toHaveAttribute("aria-pressed", "true");
});

test("interaction feedback respects reduced motion and retains the corporate design", async ({
  page,
}, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
      await page.goto("/");
      const action = page.getByTestId("home-hero-contact");
      const bounds = (await action.boundingBox())!;
      await page.mouse.move(bounds.x + 10, bounds.y + 10);
      await page.mouse.down();
      await expect
        .poll(() => action.evaluate((el) => getComputedStyle(el).scale))
        .toBe("0.97");
      await page.mouse.move(5, 5);
      await page.mouse.up();
      await expect
        .poll(() => action.evaluate((el) => getComputedStyle(el).scale))
        .toBe("none");
      await page.screenshot({
        path: testInfo.outputPath(`${width}-${colorScheme}.png`),
        fullPage: true,
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.mouse.move(bounds.x + 10, bounds.y + 10);
      await page.mouse.down();
      expect(await action.evaluate((el) => getComputedStyle(el).scale)).toBe(
        "none",
      );
      await page.mouse.move(5, 5);
      await page.mouse.up();
    }
  }
});
