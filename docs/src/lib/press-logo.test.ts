import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COLORS, MARK_CROP, clearSpaceSvg, parseLogo } from "./press-logo.ts";

const docsDir = join(import.meta.dirname, "../..");
const assets = join(docsDir, "src/pages/assets");

/** The x, y, width, and height of the dashed clear-space boundary in a rendered diagram SVG. */
function boundary(svg: string): number[] {
  const rect = /<rect\b[^>]*\bstroke-dasharray="[^"]+"[^>]*>/.exec(svg);
  expect(rect, svg).not.toBeNull();
  return ["x", "y", "width", "height"].map((name) =>
    Number(new RegExp(`\\b${name}="([^"]+)"`).exec(rect![0])![1]),
  );
}

describe("clearSpaceSvg", () => {
  it("draws the dashed boundary one quarter of the wordmark's height outside the artwork", async () => {
    const svg = await clearSpaceSvg("wordmark", assets);
    const source = await readFile(join(assets, "bascik-logo.svg"), "utf8");
    const art = parseLogo(source);
    const quarter = art.viewBox.height / 4;
    expect(boundary(svg)).toEqual([
      art.viewBox.x - quarter,
      art.viewBox.y - quarter,
      art.viewBox.width + 2 * quarter,
      art.viewBox.height + 2 * quarter,
    ]);
    // The artwork is the kit's own, inlined from the same source: tile and ink, no animation.
    expect(svg).toContain(`points="${art.points}"`);
    expect(svg).toContain(`fill="${COLORS.lime}"`);
    expect(svg).toContain(`fill="${COLORS.ink}"`);
    expect(svg).not.toMatch(/<animate|<script|<!--/);
  });

  it("uses the mark's cropped artwork, as the kit does", async () => {
    const svg = await clearSpaceSvg("mark", assets);
    const quarter = MARK_CROP.height / 4;
    expect(boundary(svg)).toEqual([
      MARK_CROP.x - quarter,
      MARK_CROP.y - quarter,
      MARK_CROP.width + 2 * quarter,
      MARK_CROP.height + 2 * quarter,
    ]);
  });

  it("fits the boundary inside the view box, so the dashed line is never cut off", async () => {
    for (const logo of ["wordmark", "mark"] as const) {
      const svg = await clearSpaceSvg(logo, assets);
      const [vx, vy, vw, vh] = /viewBox="([^"]+)"/
        .exec(svg)![1]
        .split(" ")
        .map(Number);
      const [x, y, width, height] = boundary(svg);
      expect(x, logo).toBeGreaterThan(vx);
      expect(y, logo).toBeGreaterThan(vy);
      expect(x + width, logo).toBeLessThan(vx + vw);
      expect(y + height, logo).toBeLessThan(vy + vh);
    }
  });

  it("is an image with a text alternative and no ids, so two diagrams on one page never clash", async () => {
    for (const logo of ["wordmark", "mark"] as const) {
      const svg = await clearSpaceSvg(logo, assets);
      expect(svg, logo).toMatch(/^<svg\b[^>]*\brole="img"/);
      expect(svg, logo).toMatch(/<title>[^<]*clear space[^<]*<\/title>/i);
      expect(svg, logo).not.toMatch(/\bid="/);
    }
  });

  it("names the accepted logos when given a typo, instead of rendering nothing", async () => {
    await expect(
      clearSpaceSvg("wordmrak" as "wordmark", assets),
    ).rejects.toThrow(/unknown logo "wordmrak".*"wordmark" or "mark"/);
  });

  it("names the missing source file when the assets folder is wrong", async () => {
    await expect(
      clearSpaceSvg("mark", join(docsDir, "no-such-folder")),
    ).rejects.toThrow(/favicon\.svg/);
  });
});
