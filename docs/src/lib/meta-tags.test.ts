import { describe, expect, it } from "vitest";
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
