import { test, expect } from "@playwright/test";

const sites = [
  { slug: "rinsesoft", name: "Rinsesoft", url: "https://rinsesoft.com" },
  {
    slug: "sunridge-counseling",
    name: "Sunridge Counseling",
    url: "https://sunridgecounseling.com",
  },
  { slug: "dgco", name: "DGCO", url: "https://dgcocpa.com" },
  {
    slug: "lateral-emdr",
    name: "Lateral EMDR",
    url: "https://lateralemdr.com",
  },
  { slug: "bascik", name: "Bascik", url: "https://bascik.dev" },
];

test("showcase has five real screenshots, working site links, and a submission link", async ({
  page,
  request,
}) => {
  await page.goto("/showcase");
  await expect(
    page.getByRole("heading", { name: "Showcase", level: 1 }),
  ).toBeVisible();
  const cards = page.getByTestId("showcase-card");
  await expect(page.getByTestId("showcase-grid")).toBeVisible();
  await expect(cards).toHaveCount(5);
  for (const site of sites) {
    const card = cards.filter({
      has: page.getByRole("heading", { name: site.name, exact: true }),
    });
    await expect(
      card.getByRole("heading", { name: site.name, exact: true }),
    ).toHaveAttribute("id", site.slug);
    const link = card.getByTestId("showcase-card-link");
    await expect(link).toHaveAttribute("href", site.url);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const image = card.getByRole("img", {
      name: `${site.name} website homepage`,
    });
    await image.scrollIntoViewIfNeeded();
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty("complete", true);
    await expect(image).toHaveJSProperty("naturalWidth", 1280);
    await expect(image).toHaveAttribute("width", "640");
    await expect(image).toHaveAttribute("height", "400");
    const imageSize = await image.boundingBox();
    const cardSize = await card.boundingBox();
    expect(imageSize).not.toBeNull();
    expect(cardSize).not.toBeNull();
    expect(imageSize!.width).toBeCloseTo(cardSize!.width - 2, 0);
    expect(
      Math.abs(imageSize!.height - imageSize!.width / 1.6),
    ).toBeLessThanOrEqual(1.1);
    const src = await image.getAttribute("src");
    expect(src).toMatch(/\?v=[0-9a-f]{10}$/);
    const response = await request.get(src!);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/webp");
  }
  const lateral = cards.filter({
    has: page.getByRole("heading", { name: "Lateral EMDR", exact: true }),
  });
  await expect(lateral).toContainText("stream scripts and server scripts");
  await expect(
    page.getByRole("link", { name: "Submit your site on GitHub" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/bascikdev/bascik/issues/new?template=showcase.yml",
  );
});

for (const width of [1440, 390]) {
  test(`homepage preview and showcase layout work at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const preview = page.getByTestId("home-showcase");
    await preview.scrollIntoViewIfNeeded();
    await expect(
      preview.getByRole("heading", { name: "Made with Bascik." }),
    ).toBeVisible();
    await expect(preview.getByTestId("showcase-card")).toHaveCount(2);
    for (const site of sites.filter(
      (site) => site.name === "Rinsesoft" || site.name === "Lateral EMDR",
    )) {
      await expect(
        preview.getByRole("heading", { name: site.name, exact: true }),
      ).toBeVisible();
    }
    const sizes = await preview
      .getByTestId("showcase-card")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const { x, y, width } = card.getBoundingClientRect();
          return { x, y, width };
        }),
      );
    if (width === 390) {
      expect(new Set(sizes.map((size) => size.x)).size).toBe(1);
      expect(new Set(sizes.map((size) => size.y)).size).toBe(2);
    } else {
      expect(new Set(sizes.map((size) => size.y)).size).toBe(1);
    }
    await page.getByTestId("home-showcase-link").click();
    await expect(page).toHaveURL(/\/showcase$/);
    const cards = page.getByTestId("showcase-card");
    await expect(cards).toHaveCount(5);
    const bounds = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, width } = element.getBoundingClientRect();
        return { x, width };
      }),
    );
    for (const card of bounds) {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(width);
    }
    const link = cards
      .filter({ has: page.getByRole("heading", { name: "Rinsesoft" }) })
      .getByTestId("showcase-card-link");
    await link.focus();
    await expect(link).toBeFocused();
  });
}
