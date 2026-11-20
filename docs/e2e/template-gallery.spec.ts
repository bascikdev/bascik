import { expect, test } from "@playwright/test";

test("the CLI links to nine template previews that open their own demos", async ({
  page,
}) => {
  await page.goto("/cli");
  await page
    .getByRole("link", { name: "Create Bascik template gallery" })
    .click();
  await expect(page).toHaveURL("/templates");

  const cards = page.getByTestId("showcase-card");
  await expect(cards).toHaveCount(9);
  const links = page.getByTestId("showcase-card-link");
  const origins = await links.evaluateAll((elements) =>
    elements.map(
      (element) => new URL((element as HTMLAnchorElement).href).origin,
    ),
  );
  expect(new Set(origins).size).toBe(9);
  expect(
    origins.every((origin) =>
      /^https:\/\/bascik-template-[a-z]+-preview\.collin-inbox\.workers\.dev$/.test(
        origin,
      ),
    ),
  ).toBe(true);

  for (const card of await cards.all()) {
    const link = card.getByTestId("showcase-card-link");
    const image = link.locator("img");
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate(
          (img) => img instanceof HTMLImageElement && img.naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    await expect(image).toHaveAttribute("srcset", /320w, .*1280w$/);
    await expect(link).toHaveAttribute("target", "_blank");
  }
  const docs = cards.filter({
    has: page.getByRole("heading", { name: "Docs", exact: true }),
  });
  await expect(docs.getByTestId("showcase-card-link")).toHaveAttribute(
    "href",
    "https://bascik-template-docs-preview.collin-inbox.workers.dev/",
  );
  await expect(docs).toContainText(
    "npm create bascik my-site -- --template docs",
  );
});
