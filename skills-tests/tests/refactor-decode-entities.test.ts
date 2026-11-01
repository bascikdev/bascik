/**
 * The refactor scripts stay self-contained (they ship to users without pkg),
 * so they carry their own copy of pkg's character reference table:
 * lib/character-references.mjs (repeated-sections.mjs) and an inline copy in
 * llms-txt.mjs, which is copied into projects on its own. This test holds
 * both copies to pkg's decoder, which pkg's own tests hold to the HTML
 * tokenizer (parse5): every name, every numeric reference from 0 to 0xA0, the
 * invalid code points, case variants and generated mixes (R2-05).
 */
import { describe, expect, it } from "vitest";
import { decodeEntities as repeatedSectionsDecode } from "../../skills/bascik-refactor/scripts/repeated-sections.mjs";
import { decodeCharacterReferences as llmsTxtDecode } from "../../skills/bascik-refactor/scripts/llms-txt.mjs";
import {
  decodeCharacterReferences,
  namedCharacterReferences,
} from "../../pkg/src/lib/character-references.ts";

describe.each([
  ["repeated-sections.mjs", repeatedSectionsDecode],
  ["llms-txt.mjs", llmsTxtDecode],
])("%s agrees with pkg's decoder", (_script, decodeEntities) => {
  it("decodes every name pkg decodes, to the same character", () => {
    const names = [...namedCharacterReferences().keys()];
    expect(names.length).toBeGreaterThanOrEqual(290);
    const differ = names.filter(
      (name) =>
        decodeEntities(`&${name};`) !== decodeCharacterReferences(`&${name};`),
    );
    expect(differ).toEqual([]);
  });

  it("remaps numeric references as the tokenizer does (C1 table, U+FFFD)", () => {
    const written: string[] = [];
    for (let code = 0; code <= 0xa0; code++)
      written.push(`&#${code};`, `&#x${code.toString(16)};`, `&#${code}`);
    written.push(
      "&#xD800;",
      "&#xDFFF;",
      "&#x110000;",
      "&#99999999999999999999;",
      "&#x10FFFF;",
      "&#128512;",
    );
    const differ = written.filter(
      (value) => decodeEntities(value) !== decodeCharacterReferences(value),
    );
    expect(differ).toEqual([]);
  });

  it("does not throw on a code point past U+10FFFF", () => {
    expect(() => decodeEntities("&#x110000; &#99999999;")).not.toThrow();
    expect(decodeEntities("&#x110000;")).toBe("�");
  });

  it("reads names case-sensitively, so &Eacute; is É and &Lt; is not <", () => {
    for (const value of [
      "&Eacute;&eacute;",
      "&AMP;&Amp;&amp;",
      "&Lt;&LT;&lt;",
      "&NBSP;&nbsp;",
      "&Copy;&copy;",
    ])
      expect(decodeEntities(value), value).toBe(
        decodeCharacterReferences(value),
      );
  });

  it("agrees on mixed text, decoding once", () => {
    const pieces = [
      "Froth",
      " ",
      "&amp;",
      "&amp;amp;",
      "&rsquo;",
      "&#8212;",
      "&#x2014;",
      "&#150;",
      "&",
      "&;",
      "&#;",
      "&unknown;",
      "&amp",
      "&#65",
      "<b>",
    ];
    // Deterministic pseudo-random mixes, so a failure reproduces.
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    for (let run = 0; run < 500; run++) {
      let value = "";
      for (let i = next() % 12; i >= 0; i--)
        value += pieces[next() % pieces.length];
      expect(decodeEntities(value), value).toBe(
        decodeCharacterReferences(value),
      );
    }
  });
});
