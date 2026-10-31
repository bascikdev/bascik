import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_DIR } from "./content-path.ts";
import {
  decodeHtmlText,
  metaDescription,
  pageDescription,
  pageTitle,
} from "./meta-tags.ts";

describe("meta-tags", () => {
  it("decodes entities once, so an escaped entity stays an entity", () => {
    expect(decodeHtmlText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    expect(decodeHtmlText("Bascik&#39;s &quot;frother&quot; &AMP; more")).toBe(
      `Bascik's "frother" & more`,
    );
    // Entities a page shell never needs stay as written.
    expect(decodeHtmlText("&nbsp;&copy;")).toBe("&nbsp;&copy;");
  });

  it("reads the description with an apostrophe or double quote inside the other quote style", () => {
    expect(
      metaDescription(
        `<meta name="description" content="Bascik's frother." />`,
      ),
    ).toBe("Bascik's frother.");
    expect(
      metaDescription(`<meta content='Say "froth".' name="description">`),
    ).toBe('Say "froth".');
  });

  it("returns empty text for a page with no title or description, or a wrong name", () => {
    const html = `<head><meta name="meta-description" content="wrong name" /></head>`;
    expect(pageDescription(html)).toBe("");
    expect(pageTitle(html)).toBe("");
  });

  it("collapses whitespace in a description wrapped over several lines", () => {
    expect(
      pageDescription(
        `<meta\n  name="description"\n  content="Froth the milk,\n    then serve."\n/>`,
      ),
    ).toBe("Froth the milk, then serve.");
  });

  it("reads a title with attributes and entities", () => {
    expect(
      pageTitle(`<title data-x="1"> Benchmarking &amp; Profiling </title>`),
    ).toBe("Benchmarking & Profiling");
  });
});

/** Every page shell under src/pages, as a path relative to the docs folder. */
const pageShells = (dir = join(DOCS_DIR, "src", "pages")): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "assets"
        ? []
        : pageShells(join(dir, entry.name))
      : entry.name.endsWith(".html")
        ? [join(dir, entry.name)]
        : [],
  );

describe("meta-tags on the docs page shells (R2-03)", () => {
  // decodeHtmlText decodes the seven entities page shells use. One it does
  // not know, such as `&mdash;` in a title, would reach the Open Graph tags,
  // the search index and the TechArticle schema as the text `&mdash;`, so a
  // page that adds one fails here and either writes the character itself or
  // extends the table.
  it("finds only entities decodeHtmlText decodes in every title and description", () => {
    const shells = pageShells();
    expect(shells.length).toBeGreaterThan(10);
    const undecoded: string[] = [];
    for (const file of shells) {
      const html = readFileSync(file, "utf8");
      for (const text of [pageTitle(html), pageDescription(html)]) {
        for (const [entity] of text.matchAll(/&#?[a-zA-Z0-9]+;/g))
          undecoded.push(`${file.slice(DOCS_DIR.length + 1)}: ${entity}`);
      }
    }
    expect(undecoded).toEqual([]);
  });

  it("leaves an entity it does not know as written, so the guard above can see it", () => {
    expect(pageTitle("<title>Build &mdash; Ship</title>")).toBe(
      "Build &mdash; Ship",
    );
  });
});
