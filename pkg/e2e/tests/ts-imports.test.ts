/**
 * A TypeScript browser script's relative and @/ imports are bundled into it.
 *
 * Runs in every e2e lane (static build, dev server, HTTP/1.1 and HTTP/2
 * production servers). <ts-imports> has an inline text/typescript block and
 * a classic .ts companion that import helper modules beside the component
 * (one through another) and under scripts.importRoot through @/; the page has
 * its own inline block importing the same helper, and a type="module" .ts
 * script importing through @/. The e2e config compiles
 * TypeScript with esbuild (scripts.typescript), so the helpers also go
 * through a custom compiler.
 */
import { expect, test } from "@playwright/test";

test.describe("TypeScript scripts with local imports", () => {
  test("component and page scripts run their bundled helpers, once per instance", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));
    const typeScriptRequests: string[] = [];
    page.on("request", (request) => {
      if (/\.m?ts(?:[?#]|$)/.test(new URL(request.url()).pathname))
        typeScriptRequests.push(request.url());
    });

    await page.goto("/ts-imports-test");

    // Each instance's scripts fill that instance's own outputs, so the
    // bundled code still went through per-instance id scoping.
    const inline = page.getByTestId("ts-imports-inline");
    await expect(inline).toHaveCount(2);
    await expect(inline.first()).toHaveText("Kindred: 4/5");
    await expect(inline.last()).toHaveText("Kindred: 4/5");

    const module = page.getByTestId("ts-imports-module");
    await expect(module).toHaveCount(2);
    await expect(module.first()).toHaveText(
      "Parable of the Sower: 5/5 by Octavia E. Butler",
    );
    await expect(module.last()).toHaveText(
      "Parable of the Sower: 5/5 by Octavia E. Butler",
    );

    await expect(page.getByTestId("ts-imports-page")).toHaveText(
      "Beloved: 5/5",
    );
    await expect(page.getByTestId("ts-imports-page-module")).toHaveText(
      "module: Octavia E. Butler",
    );

    expect(typeScriptRequests).toEqual([]);
    expect(
      pageErrors,
      pageErrors.map((e) => e.message).join("\n"),
    ).toHaveLength(0);
  });

  test("emitted HTML holds no local import, no TypeScript and no page-global helper", async ({
    request,
  }) => {
    const response = await request.get("/ts-imports-test");
    expect(response.ok()).toBe(true);
    const html = await response.text();

    expect(html).not.toContain("text/typescript");
    expect(html).not.toContain("ts-imports-format.ts");
    expect(html).not.toContain("ts-imports-rating.ts");
    expect(html).not.toContain("@/lib/");
    expect(html).not.toContain(": number");
    expect(html).not.toContain("interface Book");
    expect(html).not.toContain('ts-imports-test.ts"');

    // The page's module script stays a module, unwrapped.
    const moduleScript = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
    ].find((m) => m[2].includes("page-module-out"));
    expect(moduleScript?.[1]).toContain('type="module"');

    // The page's own classic script is wrapped, so the helper it bundles
    // is not a global the page's other scripts could collide with.
    const pageScript = [
      ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
    ]
      .map((m) => m[1])
      .find((body) => body.includes("page-out"));
    expect(pageScript).toBeDefined();
    expect(pageScript!.trimStart().startsWith("(")).toBe(true);
  });

  test("the helper modules are not published", async ({ request }) => {
    for (const path of [
      "/components/ts-imports/ts-imports-format.ts",
      "/components/ts-imports/ts-imports-format.js",
      "/lib/ts-imports-books.ts",
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
    }
  });
});
