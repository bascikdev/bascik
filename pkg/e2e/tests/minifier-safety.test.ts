import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// The data script must reach the page byte for byte, whatever layout a formatter gave it in the source.
const jsonLdSource =
  /<script type="application\/ld\+json" data-testid="json-ld">([\s\S]*?)<\/script>/.exec(
    readFileSync(
      new URL(
        "../src/components/minifier-safety/minifier-safety.html",
        import.meta.url,
      ),
      "utf8",
    ),
  )![1];

test("preserves raw script content, nesting, and empty external script bodies", async ({
  page,
}) => {
  await page.goto("/minifier-safety");

  await expect(page.getByTestId("document-tail")).toHaveText(
    "Content after data script",
  );
  await expect(page.getByTestId("json-ld")).toHaveJSProperty(
    "textContent",
    jsonLdSource,
  );
  expect(jsonLdSource).toContain('"<!-- remains data"');
  const nestedScript = page
    .getByTestId("script-sample")
    .getByTestId("nested-script");
  await expect(nestedScript).toHaveCount(1);
  await expect(page.getByTestId("external-script")).toHaveJSProperty(
    "textContent",
    "",
  );
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "minifierExternalLoaded")),
    )
    .toBe(true);
});
