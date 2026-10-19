import { test, expect } from "@playwright/test";

// Every built page carries a Content-Security-Policy <meta> listing its own inline script hashes. These tests
// prove the hashes match what the browser runs: a mismatch is a blocked script and a securitypolicyviolation
// event. The production server does not send the Cloudflare `_headers` policy, so this covers the <meta> half.
const ROUTES = [
  "/",
  "/components",
  "/scoped-styles",
  "/cli",
  "/configuration",
  "/libraries",
  "/how-to/third-party-web-components",
  "/example-components",
];

test.describe("Content Security Policy", () => {
  for (const route of ROUTES) {
    test(`${route} runs without a CSP violation`, async ({ page }) => {
      const violations: string[] = [];
      const errors: string[] = [];
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          (
            window as unknown as { __cspViolations: string[] }
          ).__cspViolations ??= [];
          (
            window as unknown as { __cspViolations: string[] }
          ).__cspViolations.push(
            `${event.violatedDirective} ${event.blockedURI} ${event.sample}`.slice(
              0,
              200,
            ),
          );
        });
      });
      page.on("pageerror", (error) => errors.push(error.message));

      await page.goto(route, { waitUntil: "load" });
      violations.push(
        ...((await page.evaluate(
          () =>
            (window as unknown as { __cspViolations?: string[] })
              .__cspViolations,
        )) ?? []),
      );

      expect(violations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("the policy never allows inline scripts, data:, or a broad source", async ({
    page,
  }) => {
    await page.goto("/");
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(policy).toMatch(/script-src 'self' 'sha256-/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|data:|\*|https:/);
  });

  test("the theme toggle still works with the policy applied", async ({
    page,
  }) => {
    await page.goto("/?theme=light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", /light/);
  });
});
