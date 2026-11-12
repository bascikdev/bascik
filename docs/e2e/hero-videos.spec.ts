/**
 * The two launch videos in the home page hero: small thumbnails under the
 * hero's stats, each a plain link to the video on YouTube. A plain link
 * opens the YouTube app on a phone and a new tab on a desktop, loads nothing
 * from YouTube on this page, and needs no script.
 */
import { expect, test } from "@playwright/test";

const videos = [
  {
    title: "Bascik in 3 Minutes",
    href: "https://www.youtube.com/watch?v=pyPPiKpoWVY",
  },
  {
    title: "Bascik: A New Kind of Web Development Tool",
    href: "https://www.youtube.com/watch?v=GCqJvXgm7Dc",
  },
] as const;

for (const width of [1280, 390]) {
  test(`the hero links both videos under its stats at ${width}px`, async ({
    page,
  }) => {
    const thirdParty: string[] = [];
    page.on("request", (request) => {
      const host = new URL(request.url()).hostname;
      if (/youtube|ytimg|google|doubleclick/.test(host)) thirdParty.push(host);
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    const list = page.getByTestId("hero-videos");
    await expect(list).toBeVisible();
    const links = list.getByTestId("video-link");
    await expect(links).toHaveCount(2);

    // The 3-minute cut comes first; each link names its video and says where it goes.
    for (const [index, video] of videos.entries()) {
      const link = links.nth(index);
      await expect(link).toHaveAttribute("href", video.href);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
      await expect(link).toHaveAccessibleName(
        new RegExp(`${video.title}.*YouTube.*new tab`, "i"),
      );
      await expect(link.getByTestId("video-link-title")).toHaveText(
        video.title,
      );
      const image = link.locator("img");
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute("alt", "");
      expect(
        await image.evaluate(
          (img) => (img as { naturalWidth?: number }).naturalWidth ?? 0,
        ),
      ).toBeGreaterThan(0);
    }

    // Under the stats, inside the hero, and small.
    const stats = (await page.getByTestId("hero-stats").boundingBox())!;
    const boxes = await links.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    for (const box of boxes) {
      expect(box.y).toBeGreaterThanOrEqual(stats.y + stats.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.width).toBeLessThanOrEqual(340);
    }
    // Each thumbnail fills its link and no more, and is served from a width list.
    for (const link of await links.all()) {
      const linkBox = (await link.boundingBox())!;
      const imageBox = (await link.locator("img").boundingBox())!;
      expect(imageBox.width).toBeLessThanOrEqual(linkBox.width + 1);
      expect(imageBox.width).toBeGreaterThanOrEqual(linkBox.width - 3);
      expect(Math.abs(imageBox.width / imageBox.height - 16 / 9)).toBeLessThan(
        0.02,
      );
      const srcset = (await link.locator("img").getAttribute("srcset")) ?? "";
      expect(srcset).toMatch(/ 320w, .* 480w, .* 640w, .* 960w$/);
      await expect(link.locator("img")).toHaveAttribute("sizes", /300px/);
    }
    // The two thumbnails are the same size.
    expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThanOrEqual(1);
    if (width === 1280) {
      // Side by side, the 3-minute cut on the left.
      expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1);
      expect(boxes[0].x).toBeLessThan(boxes[1].x);
    }

    // Keyboard reachable, and nothing was fetched from YouTube.
    await links.first().focus();
    await expect(links.first()).toBeFocused();
    expect(thirdParty).toEqual([]);
  });
}

test("the hero's video thumbnails reserve their space, so nothing shifts when they load", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  for (const image of await page
    .getByTestId("hero-videos")
    .locator("img")
    .all()) {
    // The committed file is 960 by 540 at 2x; the attributes give the 16:9 shape.
    await expect(image).toHaveAttribute("width", "480");
    await expect(image).toHaveAttribute("height", "270");
  }
});
