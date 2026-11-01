import { test, expect } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`search results retain their production styling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/how-to/sharing-components");
    await page.getByRole("button", { name: "Search docs" }).click();
    await page
      .getByRole("combobox", { name: "Search docs" })
      .fill("agent skills");

    const results = page.getByRole("listbox", { name: "Search results" });
    const links = results.getByTestId("search-result-link");
    await expect(links.first()).toBeVisible();
    expect(await links.count()).toBeGreaterThan(1);
    expect(
      await results.getByTestId("search-result-text").count(),
    ).toBeGreaterThan(1);

    for (const link of await links.all()) {
      await expect(link).toHaveCSS("display", "block");
      await expect(link).toHaveCSS("padding", "10px 12px");
      await expect(link).toHaveCSS("text-decoration-line", "none");
      const section = link.getByTestId("search-result-section");
      const label = link.getByTestId("search-result-label");
      const text = link.getByTestId("search-result-text");
      await expect(section).toHaveCSS("display", "inline-block");
      await expect(section).toHaveCSS("text-transform", "uppercase");
      await expect(label).toHaveCSS("display", "block");
      if (!(await text.count())) continue;
      await expect(text).toHaveCSS("display", "block");
      await expect(text).toHaveCSS("white-space", "nowrap");
      await expect(text).toHaveCSS("overflow", "hidden");
      await expect(text).toHaveCSS("text-overflow", "ellipsis");
      const badgeBox = await section.boundingBox();
      const titleBox = await label.boundingBox();
      const snippetBox = await text.boundingBox();
      expect(badgeBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      expect(snippetBox).not.toBeNull();
      expect(titleBox!.y).toBeGreaterThanOrEqual(
        badgeBox!.y + badgeBox!.height,
      );
      expect(snippetBox!.y).toBeGreaterThanOrEqual(
        titleBox!.y + titleBox!.height,
      );
    }

    const first = links.first();
    const background = await first.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await first.focus();
    await expect(first).not.toHaveCSS("background-color", background);
    expect(
      await results.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);

    await page.getByRole("combobox", { name: "Search docs" }).fill("bascik");
    const home = page.getByTestId("search-home-result");
    const sitelinks = home.getByTestId("search-sitelink");
    await expect(sitelinks).toHaveCount(6);
    await expect(sitelinks.first()).toHaveCSS("display", "block");
    await expect(sitelinks.first()).toHaveCSS("text-decoration-line", "none");
    await expect(home.getByRole("presentation")).toHaveCSS("display", "grid");
    const boxes = await sitelinks.evaluateAll((els) =>
      els.map((el) => {
        const { x, y } = el.getBoundingClientRect();
        return { x, y };
      }),
    );
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
    expect(boxes[1].y).toBe(boxes[0].y);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  });
}
