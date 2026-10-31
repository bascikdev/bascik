/**
 * The prop decoder against the HTML tokenizer: parse5 reads each reference
 * in an attribute value the way a browser does, so every name in the table,
 * every C1 remapping and generated mixes of references must decode to what
 * parse5 gives (F028).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  decodeCharacterReferences,
  namedCharacterReferences,
} from "./character-references.ts";

/** What the browser's tokenizer makes of `value` written in a quoted attribute. */
const browserDecode = (value: string): string => {
  const element = parseFragment(`<p title="${value}">`)
    .childNodes[0] as DefaultTreeAdapterTypes.Element;
  return element.attrs[0].value;
};

describe("decodeCharacterReferences", () => {
  it("decodes every name in its table as the tokenizer does", () => {
    const table = namedCharacterReferences();
    // The ASCII names plus HTML 4's 252.
    expect(table.size).toBeGreaterThanOrEqual(290);
    for (const [name, character] of table) {
      expect(browserDecode(`&${name};`), name).toBe(character);
      expect(decodeCharacterReferences(`&${name};`), name).toBe(character);
    }
  });

  it("decodes the common typographic names", () => {
    expect(
      decodeCharacterReferences(
        "&nbsp;&eacute;&copy;&reg;&mdash;&ndash;&hellip;&lsquo;&rsquo;&ldquo;&rdquo;&euro;&trade;&apos;&times;&larr;",
      ),
    ).toBe(" é©®—–…‘’“”€™'×←");
  });

  it("remaps numeric references in 0x80-0x9F and replaces invalid ones, as the tokenizer does", () => {
    for (let code = 0; code <= 0xa0; code++) {
      if (code === 0x0d) continue; // a CR is normalized by the input stream, not the reference
      for (const written of [`&#${code};`, `&#x${code.toString(16)};`]) {
        expect(decodeCharacterReferences(written), written).toBe(
          browserDecode(written),
        );
      }
    }
    for (const written of [
      "&#xD800;",
      "&#xDFFF;",
      "&#x110000;",
      "&#99999999999999999999;",
      "&#x10FFFF;",
      "&#128512;",
      "&#8212",
    ]) {
      expect(decodeCharacterReferences(written), written).toBe(
        browserDecode(written),
      );
    }
  });

  it("decodes in one pass and leaves unknown names as written", () => {
    expect(decodeCharacterReferences("&amp;mdash; &amp;amp;")).toBe(
      "&mdash; &amp;",
    );
    expect(decodeCharacterReferences("&notaname; & &; &#; &#x;")).toBe(
      "&notaname; & &; &#; &#x;",
    );
    expect(browserDecode("&notaname; & &; &#; &#x;")).toBe(
      "&notaname; & &; &#; &#x;",
    );
    const clean = "no references here";
    expect(decodeCharacterReferences(clean)).toBe(clean);
  });

  it("agrees with the tokenizer on generated mixes of known references and text", () => {
    const names = [...namedCharacterReferences().keys()];
    const piece = fc.oneof(
      fc.constantFrom(...names).map((name) => `&${name};`),
      fc.integer({ min: 1, max: 0x10ffff }).map((code) => `&#${code};`),
      fc
        .integer({ min: 1, max: 0x10ffff })
        .map((code) => `&#x${code.toString(16)};`),
      fc.constantFrom("a", " ", "1", ";", "#", "x", "é", "<", ">", "'"),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }), (pieces) => {
        const written = pieces.join("");
        expect(decodeCharacterReferences(written)).toBe(browserDecode(written));
      }),
    );
  });
});
