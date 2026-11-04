import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_DIR } from "./content-path.ts";
import { decodeHtmlText } from "./html-entities.ts";
import { metaDescription, pageDescription, pageTitle } from "./meta-tags.ts";

describe("meta-tags", () => {
  it("decodes entities once, so an escaped entity stays an entity", () => {
    expect(decodeHtmlText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    expect(decodeHtmlText("Bascik&#39;s &quot;book&quot; &AMP; more")).toBe(
      `Bascik's "book" & more`,
    );
    // Entities a page shell never needs stay as written.
    expect(decodeHtmlText("&nbsp;&copy;")).toBe("&nbsp;&copy;");
  });

  it("reads the description with an apostrophe or double quote inside the other quote style", () => {
    expect(
      metaDescription(`<meta name="description" content="Bascik's book." />`),
    ).toBe("Bascik's book.");
    expect(
      metaDescription(`<meta content='Say "read".' name="description">`),
    ).toBe('Say "read".');
  });

  it("reads a description whose quoted value holds a `>` (PR 115 review)", () => {
    // A `>` inside a quoted value does not end the tag; reading to the first
    // `>` cut the description, so Open Graph, Twitter and TechArticle got
    // an empty or truncated one.
    expect(
      metaDescription(`<meta name="description" content="A > B, then C." />`),
    ).toBe("A > B, then C.");
    expect(
      metaDescription(`<meta content='Draft > edit.' name='description'>`),
    ).toBe("Draft > edit.");
    expect(
      pageDescription(
        `<meta data-note="x>y" name="description" content="Draft -> book" />`,
      ),
    ).toBe("Draft -> book");
    // An earlier tag with a `>` in a value is skipped whole, not reread.
    expect(
      metaDescription(
        `<meta name="theme" content="a > name='description'"><meta name="description" content="Real.">`,
      ),
    ).toBe("Real.");
  });

  it("misuse: never reads `name` or `content` out of another attribute's value", () => {
    expect(
      metaDescription(
        `<meta data-x=" name='description' content='forged'" name="keywords" content="k"><meta name="description" content="Real.">`,
      ),
    ).toBe("Real.");
    expect(
      metaDescription(
        `<meta name="description" data-x=" content='forged'" content="Real.">`,
      ),
    ).toBe("Real.");
    // An unquoted value is read as the browser reads it.
    expect(metaDescription(`<meta name=description content=Books>`)).toBe(
      "Books",
    );
    // An unclosed quote never ends the tag early: no description is read.
    expect(
      metaDescription(`<meta name="description" content="Never closed >`),
    ).toBeUndefined();
  });

  it("reads a title holding a `<` or a `>`, which a title may hold as text", () => {
    expect(pageTitle("<title>Draft < book > shelf</title>")).toBe(
      "Draft < book > shelf",
    );
    expect(pageTitle(`<title data-x="a>b">Books</title >`)).toBe("Books");
    expect(pageTitle("<TITLE>Books</TITLE>")).toBe("Books");
    // An end tag may carry attributes; `</titles>` is not one.
    expect(pageTitle("<title>Books</title x>")).toBe("Books");
    expect(pageTitle("<title>a</titles>b</title>")).toBe("a</titles>b");
  });

  it("returns empty text for a page with no title or description, or a wrong name", () => {
    const html = `<head><meta name="meta-description" content="wrong name" /></head>`;
    expect(pageDescription(html)).toBe("");
    expect(pageTitle(html)).toBe("");
  });

  it("collapses whitespace in a description wrapped over several lines", () => {
    expect(
      pageDescription(
        `<meta\n  name="description"\n  content="Read the book,\n    then rate it."\n/>`,
      ),
    ).toBe("Read the book, then rate it.");
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
  // decodeHtmlText decodes the entities page shells use (html-entities.ts). One it does
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
