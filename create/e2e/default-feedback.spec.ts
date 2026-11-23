import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("theme follows Contact visually and in keyboard order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const contact = page.getByTestId("site-header-contact");
  const theme = page.getByTestId("site-header-theme-toggle");
  const contactBox = await contact.boundingBox();
  const themeBox = await theme.boundingBox();
  expect(themeBox!.x).toBeGreaterThan(contactBox!.x + contactBox!.width);
  await contact.focus();
  await page.keyboard.press("Tab");
  await expect(theme).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("site-header-nav-toggle").click();
  await expect(contact).toBeVisible();
  // At phone width the theme switch is the last row of the open menu.
  await expect(theme).toBeHidden();
  const themeRow = page.getByTestId("site-header-mobile-theme");
  await expect(themeRow).toBeVisible();
  expect((await themeRow.boundingBox())!.y).toBeGreaterThan(
    (await contact.boundingBox())!.y,
  );
});

test("canonical favicon bytes reach production unchanged", async ({
  request,
}) => {
  for (const path of [
    "favicon.ico",
    "assets/favicon-32x32.png",
    "assets/apple-touch-icon.png",
  ]) {
    const response = await request.get(`/${path}`);
    expect(response.ok()).toBe(true);
    expect(
      (await response.body()).equals(
        readFileSync(new URL(`../../docs/src/pages/${path}`, import.meta.url)),
      ),
    ).toBe(true);
  }
});

test("compiled pages show icon-only themes, inline CSS, and static initial paint", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    const samples: string[][] = [];
    (window as unknown as { initialAnimations: string[][] }).initialAnimations =
      samples;
    let frames = 0;
    const sample = () => {
      samples.push(
        Array.from(document.querySelectorAll("*"))
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.height > 0 && box.bottom > 0 && box.top < innerHeight;
          })
          .flatMap((element) =>
            ["", "::before", "::after"].map(
              (pseudo) =>
                getComputedStyle(element, pseudo || null).animationName,
            ),
          ),
      );
      if (++frames < 10) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ reducedMotion, colorScheme });
      for (const width of [1440, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ["/", "/about", "/contact", "/missing"]) {
          await page.goto(route);
          await page.waitForTimeout(180);
          expect(
            await page
              .locator('link[rel="stylesheet"]')
              .evaluateAll((links) =>
                links.some((link) =>
                  (link as HTMLLinkElement).href.includes("styles.css"),
                ),
              ),
          ).toBe(false);
          expect(
            requests.some((url) => /\/styles\.css(?:[?#]|$)/.test(url)),
          ).toBe(false);
          const button = page.getByTestId("site-header-theme-toggle");
          // At phone width the icon gives way to the labeled row in the menu.
          if (width > 640) {
            await expect(button).toBeVisible();
            await expect(button).toHaveAccessibleName("Toggle dark mode");
          } else {
            await expect(button).toBeHidden();
            await expect(
              page.getByTestId("site-header-nav-toggle"),
            ).toBeVisible();
          }
          expect((await button.textContent())?.trim()).toBe("");
          expect(await button.locator("svg").count()).toBe(2);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const samples = await page.evaluate(
            () =>
              (window as unknown as { initialAnimations: string[][] })
                .initialAnimations,
          );
          expect(samples.flat().every((name) => name === "none")).toBe(true);
          expect(
            await page.evaluate(
              () =>
                getComputedStyle(
                  document.documentElement,
                  "::view-transition-old(root)",
                ).animationName,
            ),
          ).toBe("none");
          expect(
            await page.evaluate(
              () =>
                getComputedStyle(
                  document.documentElement,
                  "::view-transition-new(root)",
                ).animationName,
            ),
          ).toBe("none");
          await expect(page.getByTestId("site-header-home")).toHaveCSS(
            "text-decoration-line",
            "none",
          );
        }
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
  }
  for (const scheme of ["dark", "light"] as const) {
    await page.getByTestId("site-header-theme-toggle").click();
    await page.reload();
    expect(
      await page.evaluate(() => document.documentElement.dataset.theme),
    ).toBe(scheme);
    await expect(page.getByTestId("site-header-theme-toggle")).toHaveAttribute(
      "aria-pressed",
      String(scheme === "dark"),
    );
  }
});

test("default design remains readable in both themes at phone and desktop widths", async ({
  page,
}, testInfo) => {
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/");
      await page.screenshot({
        path: testInfo.outputPath(`${width}-${colorScheme}.png`),
        fullPage: true,
      });
    }
  }
});

test("two compiled counters reflect raw numbers and scoped CSS monitors negative, zero, and positive values", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Welcome to default",
  );
  const counters = page.getByTestId("my-counter");
  await expect(counters).toHaveCount(2);
  const first = counters.nth(0);
  const second = counters.nth(1);
  const value = first.getByTestId("my-counter-value");
  const otherValue = second.getByTestId("my-counter-value");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(value).toHaveAttribute("data-value", "0");
    await expect(otherValue).toHaveAttribute("data-value", "0");
    const neutral = await value.evaluate(
      (element) => getComputedStyle(element).color,
    );
    await first.getByTestId("my-counter-dec").click();
    await expect(value).toHaveText("-1");
    await expect(value).toHaveAttribute("data-value", "-1");
    await expect(otherValue).toHaveText("0");
    await expect(otherValue).toHaveAttribute("data-value", "0");
    const negative = await value.evaluate(
      (element) => getComputedStyle(element).color,
    );
    expect(negative).not.toBe(neutral);
    expect(
      await value.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--error)";
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(element).color === color;
      }),
    ).toBe(true);
    await first.getByTestId("my-counter-inc").click();
    await expect(value).toHaveText("0");
    await expect(value).toHaveAttribute("data-value", "0");
    await expect(value).toHaveCSS("color", neutral);
    await first.getByTestId("my-counter-inc").click();
    await expect(value).toHaveText("1");
    await expect(value).toHaveAttribute("data-value", "1");
    await expect(value).toHaveCSS("color", neutral);
    await expect(otherValue).toHaveText("0");
    await first.getByTestId("my-counter-dec").click();
    await second.getByTestId("my-counter-inc").click();
    await expect(otherValue).toHaveText("1");
    await expect(otherValue).toHaveAttribute("data-value", "1");
    await expect(otherValue).toHaveCSS("color", neutral);
    await expect(value).toHaveText("0");
    await second.getByTestId("my-counter-dec").click();
    // Attribute-only mutations prove CSS monitors the number, not script classification.
    await value.evaluate((element) => element.setAttribute("data-value", "-9"));
    await expect(value).toHaveCSS("color", negative);
    await expect(otherValue).toHaveCSS("color", neutral);
    await value.evaluate((element) => element.setAttribute("data-value", "0"));
    await expect(value).toHaveCSS("color", neutral);
    expect(
      await first.getByTestId("my-counter-inc").getAttribute("id"),
    ).not.toBe(await second.getByTestId("my-counter-inc").getAttribute("id"));
  }
});
