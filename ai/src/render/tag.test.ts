import { describe, expect, it } from "vitest";
import type { Catalog } from "../catalog.ts";
import { parseOpenTag, WAIT } from "./tag.ts";

const catalog: Catalog = new Map([
  [
    "book-card",
    {
      name: "book-card",
      description: "",
      props: ["title", "author"],
      slot: true,
    },
  ],
]);

describe("parseOpenTag", () => {
  it("keeps only declared props, escaped, in the catalog's order", () => {
    const tag = parseOpenTag(
      catalog,
      `<book-card author='Grace "G" Lin' onclick="steal()" title="A <b> & C">rest`,
    );
    expect(tag).toEqual({
      entry: catalog.get("book-card"),
      html: `<book-card data-bascik-prop-title="A &lt;b&gt; &amp; C" data-bascik-prop-author="Grace &quot;G&quot; Lin">`,
      selfClosed: false,
      end: expect.any(Number),
    });
    expect(
      `<book-card author='Grace "G" Lin' onclick="steal()" title="A <b> & C">rest`.slice(
        (tag as { end: number }).end,
      ),
    ).toBe("rest");
  });

  it("reads a self-closed tag, bare values and uppercase attribute names", () => {
    const source = `<book-card TITLE=Dune/>after`;
    // A bare value runs to whitespace or `>`, so `/` belongs to it here.
    expect(parseOpenTag(catalog, source)).toMatchObject({
      html: `<book-card data-bascik-prop-title="Dune/">`,
      selfClosed: false,
    });
    expect(parseOpenTag(catalog, `<book-card title=Dune />x`)).toMatchObject({
      html: `<book-card data-bascik-prop-title="Dune">`,
      selfClosed: true,
      end: `<book-card title=Dune />`.length,
    });
  });

  it("waits for a tag that is not all here yet", () => {
    expect(parseOpenTag(catalog, "<book-card")).toBe(WAIT);
    expect(parseOpenTag(catalog, `<book-card title="Du`)).toBe(WAIT);
    expect(parseOpenTag(catalog, "<book-card title=Dune")).toBe(WAIT);
    expect(parseOpenTag(catalog, "<book-card /")).toBe(WAIT);
  });

  it("treats anything that is not a catalog tag as text", () => {
    expect(parseOpenTag(catalog, "<script>alert(1)</script>")).toBeNull();
    expect(parseOpenTag(catalog, "<book-cards>")).toBeNull();
    expect(parseOpenTag(catalog, "< book-card>")).toBeNull();
    expect(parseOpenTag(catalog, "<book-card /x>")).toBeNull();
    expect(parseOpenTag(catalog, "<book-card =x>")).toBeNull();
  });
});
