import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CANVASES,
  MARK_PNG_SIZES,
  PRESS_EMAIL,
  WORDMARK_PNG_WIDTHS,
} from "../../scripts/generate-press-kit.ts";
import { renderMd } from "./md-renderer.ts";
import { CLEAR_SPACE_RATIO, readLogo } from "./press-logo.ts";

const docsDir = join(import.meta.dirname, "../..");

/** The Markdown from a heading line up to the next heading of the same or a higher level. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.indexOf(" ");
  const rest = md.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return heading + (next === -1 ? rest : rest.slice(0, next));
}

describe("press page: spacing and minimum size", () => {
  let md: string;
  let spacing: string;
  beforeAll(async () => {
    md = await readFile(join(docsDir, "content/press.md"), "utf8");
    spacing = section(md, "### Spacing and Minimum Size");
  });

  it("states the clear-space unit precisely: a quarter of the whole tile's height, not the letters'", () => {
    expect(CLEAR_SPACE_RATIO).toBe(0.25);
    expect(spacing).toMatch(/one quarter of the logo's height/);
    expect(spacing).toMatch(/whole lime tile, not of the letters/);
    // The worked example agrees with the rule.
    const example = /(\d+) px tall needs (\d+) px of clear space/.exec(spacing);
    expect(example, spacing).not.toBeNull();
    expect(Number(example![2])).toBe(Number(example![1]) * CLEAR_SPACE_RATIO);
  });

  it("says the kit files are cropped to the artwork and warns about rounded or bordered containers", () => {
    expect(spacing).toMatch(/cropped to the artwork/);
    expect(spacing).toMatch(/rounded corners/);
    expect(spacing).toMatch(/border/);
    expect(spacing).toMatch(/corners/);
  });

  it("gives minimum sizes that match the logo artwork and the smallest PNGs the kit ships", async () => {
    const wordmark = await readLogo("wordmark");
    const minimumHeight = 24;
    const minimumWidth = Math.round(
      (minimumHeight * wordmark.viewBox.width) / wordmark.viewBox.height,
    );
    expect(spacing).toContain(
      `${minimumHeight} px tall (${minimumWidth} px wide)`,
    );
    expect(spacing).toContain(`${minimumHeight} x ${minimumHeight} px`);
    expect(spacing).toContain("1/8 inch (3 mm)");

    const smallestWordmark = Math.min(...WORDMARK_PNG_WIDTHS);
    const smallestWordmarkHeight = Math.round(
      (smallestWordmark * wordmark.viewBox.height) / wordmark.viewBox.width,
    );
    expect(spacing).toContain(
      `\`logo/png/bascik-wordmark-${smallestWordmark}.png\`, ${smallestWordmark} x ${smallestWordmarkHeight} px`,
    );
    const smallestMark = Math.min(...MARK_PNG_SIZES);
    expect(spacing).toContain(
      `\`logo/png/bascik-mark-${smallestMark}.png\`, ${smallestMark} x ${smallestMark} px`,
    );
  });

  it("only claims the avatar files keep a quarter of the mark's height clear when they do", () => {
    expect(spacing).toMatch(/avatar file/);
    for (const spec of CANVASES.filter((canvas) => canvas.logo === "mark")) {
      const margin = (Math.min(spec.width, spec.height) - spec.logoWidth) / 2;
      expect(margin, spec.file).toBeGreaterThanOrEqual(
        spec.logoWidth * CLEAR_SPACE_RATIO,
      );
    }
  });

  it("is followed by the clear-space diagram in the page shell, split at the next heading", async () => {
    const shell = await readFile(join(docsDir, "src/pages/press.html"), "utf8");
    const next = /\n## (.+)/.exec(md.slice(md.indexOf(spacing) + 1))![1];
    const toNext = shell.indexOf(`to: "${next}"`);
    const fromNext = shell.indexOf(`from: "${next}"`);
    expect(toNext, `range ending at "${next}"`).toBeGreaterThan(-1);
    expect(fromNext, `range starting at "${next}"`).toBeGreaterThan(toNext);
    const between = shell.slice(toNext, fromNext);
    expect(between).toContain("<diagram-figure");
    expect(between).toContain('clearSpaceSvg("wordmark")');
    expect(between).toContain('clearSpaceSvg("mark")');
  });
});

describe("press page: contact", () => {
  let md: string;
  beforeAll(async () => {
    md = await readFile(join(docsDir, "content/press.md"), "utf8");
  });

  it("has one Contact section that leads with the press email", () => {
    expect(md.match(/^## Contact$/gm)).toHaveLength(1);
    const contact = section(md, "## Contact");
    const firstLine = contact
      .split("\n")
      .slice(1)
      .find((line) => line.trim() !== "");
    expect(firstLine).toContain(`<${PRESS_EMAIL}>`);
    expect(contact).toMatch(/interviews/);
    expect(contact).toMatch(/quotes/);
    expect(contact).toMatch(/logo/);
    expect(contact).toContain("https://github.com/bascikdev/bascik/issues");
  });

  it("renders the press email as a mailto link exactly once", async () => {
    expect(md.split(PRESS_EMAIL)).toHaveLength(2);
    const html = await renderMd(join(docsDir, "content/press.md"));
    expect(html.split(`href="mailto:${PRESS_EMAIL}"`)).toHaveLength(2);
  });

  it("no longer hides the address under the official links", () => {
    const naming = section(md, "## Naming and Description");
    const links = naming.slice(naming.indexOf("Official links:"));
    expect(links).toMatch(/^- Website: /m);
    expect(links).toMatch(/^- Source and issues: /m);
    expect(links).not.toMatch(/Press and media/);
    expect(links).not.toContain(PRESS_EMAIL);
  });

  it("points permission questions at the Contact section", () => {
    const usage = section(md, "## Using the Logo");
    expect(usage).toContain("(#contact)");
  });
});
