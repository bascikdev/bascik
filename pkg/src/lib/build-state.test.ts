/**
 * The page comparison between dist/ and the build record in .bascik/dist/.
 * `bascik --server` warns about a page that differs (a deploy step may edit
 * dist/ after the build); a targeted build refuses one.
 */
import { describe, expect, it } from "vitest";
import { assertSameRelease, pageDifferenceWarning } from "./build-state.ts";

describe("pageDifferenceWarning", () => {
  it("returns nothing when every page matches the record", () => {
    expect(
      pageDifferenceWarning({ "index.html": "a" }, { "index.html": "a" }),
    ).toBeUndefined();
  });

  it("names a changed page once, in one line, with what to do", () => {
    const warning = pageDifferenceWarning(
      { "index.html": "a", "live.html": "b" },
      { "index.html": "edited", "live.html": "b" },
    )!;
    expect(warning).not.toContain("\n");
    expect(warning).toContain("1 page in dist/ differs");
    expect(warning).toContain(
      "dist/index.html is not the page that build wrote",
    );
    expect(warning).not.toContain("live.html");
    expect(warning).toContain(".bascik/dist/build-state.json");
    expect(warning).toContain(
      "if you edited dist/ after the build this is expected",
    );
    expect(warning).toContain(
      "if you copied .bascik/dist/ from another build, rebuild",
    );
  });

  it("names added and missing pages", () => {
    const warning = pageDifferenceWarning(
      { "index.html": "a", "gone.html": "g" },
      { "index.html": "a", "extra.html": "x" },
    )!;
    expect(warning).toContain("2 pages in dist/ differ");
    expect(warning).toContain("dist/extra.html is not a page that build wrote");
    expect(warning).toContain(
      "dist/gone.html, which that build wrote, is missing",
    );
  });

  it("names the first ten pages of many and counts the rest", () => {
    const recorded: Record<string, string> = {};
    const found: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      const rel = `p${String(i).padStart(2, "0")}.html`;
      recorded[rel] = "a";
      found[rel] = "b";
    }
    const warning = pageDifferenceWarning(recorded, found)!;
    expect(warning).toContain("25 pages in dist/ differ");
    expect(warning).toContain("dist/p09.html");
    expect(warning).not.toContain("dist/p10.html");
    expect(warning).toContain("and 15 more");
  });
});

describe("assertSameRelease (targeted builds)", () => {
  it("passes matching pages and refuses the first that differs", () => {
    expect(() =>
      assertSameRelease({ "index.html": "a" }, { "index.html": "a" }),
    ).not.toThrow();
    expect(() =>
      assertSameRelease({ "index.html": "a" }, { "index.html": "b" }),
    ).toThrow(
      /--only: dist\/ and \.bascik\/dist\/ come from different builds: dist\/index\.html is not the page that build wrote/,
    );
  });
});
