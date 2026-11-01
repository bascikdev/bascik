/**
 * The docs' one entity decoder (meta-tags.ts and heading-slug.ts both use it)
 * against the browser's tokenizer (parse5) and pkg's decoder: every spelling
 * it decodes must decode to what both give, and every spelling it does not
 * know must stay as written, never turn into a different character (R2-05).
 */
import { describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { fileURLToPath } from "node:url";
import { DECODED_ENTITIES, decodeHtmlText } from "./html-entities.ts";

// pkg's full decoder, read from source (outside the docs tsconfig's rootDir).
const { decodeCharacterReferences } = (await import(
  fileURLToPath(
    new URL("../../../pkg/src/lib/character-references.ts", import.meta.url),
  )
)) as { decodeCharacterReferences: (value: string) => string };

/** What the browser makes of `text` as element text. */
const browserText = (text: string): string => {
  const element = parseFragment(`<p>${text}</p>`)
    .childNodes[0] as DefaultTreeAdapterTypes.Element;
  return (element.childNodes[0] as DefaultTreeAdapterTypes.TextNode).value;
};

describe("decodeHtmlText", () => {
  it("decodes every spelling in its table as the browser and pkg do", () => {
    expect(DECODED_ENTITIES.length).toBeGreaterThanOrEqual(11);
    for (const entity of DECODED_ENTITIES) {
      expect(decodeHtmlText(entity), entity).toBe(browserText(entity));
      expect(decodeHtmlText(entity), entity).toBe(
        decodeCharacterReferences(entity),
      );
    }
  });

  it("reads names case-sensitively: another case is another name or none", () => {
    // `&Lt;` and `&Gt;` are HTML's ≪ and ≫, not < and >; `&Amp;`,
    // `&Quot;` and `&APOS;` are not references. None may become < > & " '.
    for (const written of [
      "&Lt;",
      "&Gt;",
      "&Amp;",
      "&Quot;",
      "&APOS;",
      "&Apos;",
    ])
      expect(decodeHtmlText(written), written).toBe(written);
  });

  it("decodes once, so an escaped entity stays an entity", () => {
    expect(decodeHtmlText("&amp;lt;b&amp;gt; &amp;amp;")).toBe(
      "&lt;b&gt; &amp;",
    );
  });

  it("leaves the entities it does not know as written, for the page-shell guard to see", () => {
    expect(decodeHtmlText("&nbsp;&copy;&mdash;&#8212;&notaname; & &;")).toBe(
      "&nbsp;&copy;&mdash;&#8212;&notaname; & &;",
    );
  });
});
