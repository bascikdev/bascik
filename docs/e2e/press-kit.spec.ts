import { test, expect } from "@playwright/test";

test.describe("Press kit", () => {
  test("press resources page renders with a working download and previews", async ({
    page,
    request,
  }) => {
    await page.goto("/press");
    await expect(
      page.getByRole("heading", { level: 1, name: "Press Resources" }),
    ).toBeVisible();

    const download = page.getByTestId("press-download-kit");
    await expect(download).toBeVisible();
    const href = await download.getAttribute("href");
    expect(href).toBe("/assets/press/bascik-press-kit.zip");

    const zip = await request.get(href!);
    expect(zip.status()).toBe(200);
    expect(zip.headers()["content-type"]).toContain("zip");
    const body = await zip.body();
    expect(
      body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    ).toBe(true);

    // Every preview image on the page must load successfully
    const previews = page.getByTestId("press-previews").locator("img");
    const count = await previews.count();
    expect(count).toBe(6);
    for (let i = 0; i < count; i++) {
      await expect(previews.nth(i)).toBeVisible();
      const naturalWidth = await previews
        .nth(i)
        .evaluate((img) =>
          Number((img as unknown as { naturalWidth: number }).naturalWidth),
        );
      expect(naturalWidth).toBeGreaterThan(0);
    }
  });

  test("every kit file linked from the page is served", async ({
    page,
    request,
  }) => {
    await page.goto("/press");
    const hrefs = await page
      .getByTestId("press-previews")
      .getByRole("link")
      .evaluateAll((links) => links.map((a) => String(a.getAttribute("href"))));
    hrefs.push(
      String(await page.getByTestId("press-download-kit").getAttribute("href")),
    );
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of new Set(hrefs)) {
      expect(href.startsWith("/assets/press/"), href).toBe(true);
      const response = await request.get(href);
      expect(response.status(), href).toBe(200);
    }
  });

  test("page lists the same social and avatar files the kit contains", async ({
    page,
    request,
  }) => {
    await page.goto("/press");
    const files = await page
      .getByTestId("press-guidelines")
      .getByRole("table")
      .getByRole("code")
      .allTextContents();
    const kitFiles = files.filter((text) =>
      /^(social|avatar)\/.+\.png$/.test(text),
    );
    expect(kitFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of kitFiles) {
      const response = await request.get(`/assets/press/${file}`);
      expect(response.status(), file).toBe(200);
    }
  });
});

/** One preview tile per logo and background, named `<logo>-<background>` in the tiles' test ids. */
const PREVIEWS = [
  "wordmark-dark",
  "wordmark-white",
  "wordmark-gray",
  "mark-dark",
  "mark-white",
  "mark-gray",
] as const;

test.describe("Press logo previews", () => {
  // Desktop, and a phone where the tiles stack and get narrower.
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 360, height: 800 },
  ]) {
    test(`are not clipped and keep the clear-space rule at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/press");
      for (const name of PREVIEWS) {
        const logo = page.getByTestId(`press-logo-${name}`);
        const swatch = page.getByTestId(`press-swatch-${name}`);
        await expect(page.getByTestId(`press-tile-${name}`)).toBeVisible();

        // The kit artwork is cropped to the tile's corners, so any frame or rounding on the image clips them.
        for (const corner of [
          "top-left",
          "top-right",
          "bottom-right",
          "bottom-left",
        ]) {
          await expect(logo, `${name} ${corner}`).toHaveCSS(
            `border-${corner}-radius`,
            "0px",
          );
        }
        for (const side of ["top", "right", "bottom", "left"]) {
          await expect(logo, `${name} border ${side}`).toHaveCSS(
            `border-${side}-style`,
            "none",
          );
        }
        await expect(logo, name).toHaveCSS("box-shadow", "none");

        const natural = await logo.evaluate((img) => {
          const image = img as HTMLImageElement;
          return { width: image.naturalWidth, height: image.naturalHeight };
        });
        const box = (await logo.boundingBox())!;
        const frame = (await swatch.boundingBox())!;
        expect(box, name).not.toBeNull();
        expect(frame, name).not.toBeNull();

        // Same aspect ratio as the SVG, so nothing is squeezed or cut off.
        expect(box.width / box.height, name).toBeCloseTo(
          natural.width / natural.height,
          1,
        );

        // Clear space: at least a quarter of the logo height between the logo and every edge of its swatch.
        const clearSpace = box.height / 4;
        const gaps = {
          top: box.y - frame.y,
          right: frame.x + frame.width - (box.x + box.width),
          bottom: frame.y + frame.height - (box.y + box.height),
          left: box.x - frame.x,
        };
        for (const [side, gap] of Object.entries(gaps)) {
          expect(gap, `${name} ${side} gap`).toBeGreaterThanOrEqual(
            clearSpace - 0.5,
          );
        }
      }
    });
  }
});

test.describe("Press clear-space diagram", () => {
  test("draws the dashed boundary a quarter of the logo's height outside the artwork", async ({
    page,
  }) => {
    await page.goto("/press");
    await expect(page.getByTestId("press-clear-space")).toBeVisible();
    for (const logo of ["wordmark", "mark"]) {
      const diagram = page.getByTestId(`press-clear-space-${logo}`);
      await expect(diagram.getByRole("img")).toHaveAccessibleName(
        /clear space/i,
      );
      const tile = (await diagram.locator("svg polygon").boundingBox())!;
      const boundary = (await diagram
        .locator("svg rect[stroke-dasharray]")
        .boundingBox())!;
      expect(tile, logo).not.toBeNull();
      expect(boundary, logo).not.toBeNull();
      expect(tile.height, logo).toBeGreaterThan(20);

      const quarter = tile.height / 4;
      const gaps = {
        top: tile.y - boundary.y,
        right: boundary.x + boundary.width - (tile.x + tile.width),
        bottom: boundary.y + boundary.height - (tile.y + tile.height),
        left: tile.x - boundary.x,
      };
      // The boundary's box includes half of its 1.5 px stroke, so allow 1 px either way.
      for (const [side, gap] of Object.entries(gaps)) {
        expect(Math.abs(gap - quarter), `${logo} ${side}`).toBeLessThanOrEqual(
          1,
        );
      }
    }
  });
});
