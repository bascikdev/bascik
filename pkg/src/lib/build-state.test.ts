/**
 * The page comparison between dist/ and the build record in .bascik/dist/.
 * `bascik --server` warns about a page that differs (a deploy step may edit
 * dist/ after the build); a targeted build refuses one.
 */
import { describe, expect, it } from "vitest";
import {
  assertSameRelease,
  changedPages,
  pageDifferenceWarning,
} from "./build-state.ts";

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
    // One page unchanged, so the changed ones are listed.
    recorded["same.html"] = found["same.html"] = "s";
    const warning = pageDifferenceWarning(recorded, found)!;
    expect(warning).toContain("25 pages in dist/ differ");
    expect(warning).toContain("dist/p09.html");
    expect(warning).not.toContain("dist/p10.html");
    expect(warning).toContain("and 15 more");
  });
});

describe("pageDifferenceWarning: how to make it go away, and every page at once", () => {
  it("ends with the exec-script route that starts without the warning", () => {
    const warning = pageDifferenceWarning(
      { "index.html": "a", "live.html": "b" },
      { "index.html": "edited", "live.html": "b" },
    )!;
    expect(warning).toMatch(
      /To start without this warning, make the change in a `post` exec script, which runs before the build records its pages and hashes their inline code\.$/,
    );
    expect(warning).not.toContain("Content-Security-Policy");
  });

  it("says the pages are served with only what the private folder holds", () => {
    const pages = [{ "index.html": "a" }, { "index.html": "b" }] as const;
    // CSP off and no sidecar: the folder holds neither, so the clause goes.
    const bare = pageDifferenceWarning(pages[0], pages[1])!;
    expect(bare).toContain("The server serves these pages as they are.");
    expect(bare).not.toContain("server scripts");
    expect(bare).not.toContain("CSP hashes");
    expect(
      pageDifferenceWarning(pages[0], pages[1], [], { serverScripts: true }),
    ).toContain(
      "The server serves these pages as they are, with the server scripts .bascik/dist/ holds.",
    );
    expect(
      pageDifferenceWarning(pages[0], pages[1], [], { cspHashes: true }),
    ).toContain(
      "The server serves these pages as they are, with the CSP hashes .bascik/dist/ holds.",
    );
    expect(
      pageDifferenceWarning(pages[0], pages[1], [], {
        serverScripts: true,
        cspHashes: true,
      }),
    ).toContain(
      "with the server scripts and the CSP hashes .bascik/dist/ holds.",
    );
  });

  it("with a report-only CSP, says browsers will report the unhashed inline code, not block it", () => {
    const warning = pageDifferenceWarning(
      { "index.html": "a" },
      { "index.html": "x" },
      [{ page: "index.html", scripts: 1, styles: 0 }],
      { cspHashes: true, reportOnly: true },
    )!;
    expect(warning).toContain(
      "The site sends a Content-Security-Policy-Report-Only, and browsers will report the inline code",
    );
    expect(warning).not.toContain("will block");
  });

  it("says every page changed in one short clause instead of listing ten", () => {
    const recorded: Record<string, string> = {};
    const found: Record<string, string> = {};
    for (let i = 0; i < 14; i++) {
      recorded[`p${i}.html`] = "a";
      found[`p${i}.html`] = "b";
    }
    const warning = pageDifferenceWarning(recorded, found)!;
    expect(warning).toContain("14 pages in dist/ differ");
    expect(warning).toContain("all 14 pages that build wrote are changed");
    expect(warning).not.toContain("p0.html");
    expect(warning).not.toContain("more");
    expect(warning.length).toBeLessThan(700);
  });

  it("still names pages added beside a site where every page changed", () => {
    const warning = pageDifferenceWarning(
      { "a.html": "1", "b.html": "2" },
      { "a.html": "x", "b.html": "y", "new.html": "z" },
    )!;
    expect(warning).toContain("3 pages in dist/ differ");
    expect(warning).toContain("all 2 pages that build wrote are changed");
    expect(warning).toContain("dist/new.html is not a page that build wrote");
  });

  it("misuse: a single-page site with its one page changed names the page", () => {
    const warning = pageDifferenceWarning(
      { "index.html": "a" },
      { "index.html": "b" },
    )!;
    expect(warning).toContain(
      "dist/index.html is not the page that build wrote",
    );
    expect(warning).not.toContain("all 1");
  });

  it("with a CSP, names the changed pages whose inline code is not hashed, and says a post script is the fix", () => {
    const warning = pageDifferenceWarning(
      { "index.html": "a", "about.html": "b" },
      { "index.html": "x", "about.html": "b" },
      [
        { page: "index.html", scripts: 1, styles: 0 },
        { page: "other.html", scripts: 2, styles: 1 },
      ],
    )!;
    expect(warning).not.toContain("\n");
    expect(warning).toContain(
      "browsers will block the inline code in these changed pages that is not in .bascik/dist/csp-hashes.json: " +
        "dist/index.html (1 inline script); dist/other.html (2 inline scripts, 1 inline style).",
    );
    expect(warning).toMatch(
      /make the change in a `post` exec script, which runs before the build records its pages and hashes their inline code\.$/,
    );
    expect(warning).not.toContain("source instead");
  });
});

describe("changedPages", () => {
  it("lists changed and added pages, not missing ones", () => {
    expect(
      changedPages(
        { "a.html": "1", "b.html": "2", "gone.html": "3" },
        { "a.html": "1", "b.html": "x", "new.html": "4" },
      ),
    ).toEqual(["b.html", "new.html"]);
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
      /--only: dist\/index\.html is not the page that build wrote, as recorded in \.bascik\/dist\//,
    );
  });

  it("names both causes: an edit after the build, or a private folder from another build", () => {
    let message = "";
    try {
      assertSameRelease({ "live.html": "a" }, { "live.html": "b" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("If you edited dist/ after the build");
    expect(message).toContain("`post` exec script");
    expect(message).toContain("run a full `bascik --build`, which reconciles");
    expect(message).toContain("if you copied .bascik/dist/ from another build");
    // The old text called a local edit "a different build" and offered any
    // exec script, though a `pre` script's edits are overwritten.
    expect(message).not.toContain("come from different builds");
    expect(message).not.toContain("in an exec script");
  });

  it("names a page that the build wrote and is now missing", () => {
    expect(() => assertSameRelease({ "a.html": "a" }, {})).toThrow(
      /--only: dist\/a\.html, which that build wrote, is missing/,
    );
  });
});
