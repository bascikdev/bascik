/**
 * R2-05-c: every attribute tokenizer in pkg over one corpus, against the
 * browser's tokenizer (parse5). The tokenizers stay separate (merging them
 * is its own change); this test records where each one reads a start tag
 * differently from the browser, so a change to one shows up here.
 *
 * KNOWN_DISAGREEMENTS is the list for the owner of each tokenizer: cases a
 * tokenizer reads differently on purpose or that are left for a later
 * change. A case missing from it, or listed but now agreeing, fails.
 */
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_CORPUS,
  browserAttributes,
  firstOfEachName,
  renameA,
} from "./attribute-tokenizer-corpus.test-helper.ts";
import {
  readQuotedValueRanges,
  readStartTagAttributes,
} from "./html-scanner.ts";
import { scanWholeAttributes } from "./component-attribute-scan.ts";
import { quotedAttributeValueRanges } from "./styles.ts";
import {
  collectDeclaredIds,
  rewriteIdReferencesInHtml,
} from "./id-references.ts";

type Tokenizer = (attrs: string) => boolean;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Values of the quoted attributes, as html-scanner reads them (the reference for quoted ranges). */
const scannerQuotedValues = (tag: string): string[] => {
  const ranges = readQuotedValueRanges(tag, 0);
  const values: string[] = [];
  for (let i = 0; i < ranges.length; i += 2)
    values.push(tag.slice(ranges[i], ranges[i + 1]));
  return values;
};

/** Each pkg tokenizer, reduced to "does it read this case as the browser does". */
const TOKENIZERS: Record<string, Tokenizer> = {
  "html-scanner readStartTagAttributes": (attrs) =>
    same(
      firstOfEachName(
        readStartTagAttributes(`<x-t${attrs}>`, 0).map(
          (a): [string, string] => [a.name, a.value],
        ),
      ),
      browserAttributes(attrs),
    ),
  "component-attribute-scan scanWholeAttributes": (attrs) => {
    const tag = `<x-t${attrs}>`;
    const read = scanWholeAttributes(tag).map((a): [string, string] => [
      a.name.toLowerCase(),
      a.valueStart < 0
        ? ""
        : tag
            .slice(a.valueStart, a.valueEnd)
            .replace(/^(["'])([\s\S]*)\1$/, (_, _q, inner: string) => inner),
    ]);
    return same(firstOfEachName(read), browserAttributes(attrs));
  },
  "styles quotedAttributeValueRanges": (attrs) => {
    const tag = `<x-t${attrs}>`;
    return same(
      quotedAttributeValueRanges(tag).map((r) => tag.slice(r.start + 1, r.end)),
      scannerQuotedValues(tag),
    );
  },
  "id-references (for= read by rewriteIdReferencesInHtml)": (attrs) => {
    const renamed = renameA(attrs, "for");
    const want = browserAttributes(renamed).find(([n]) => n === "for")?.[1];
    const seen: string[] = [];
    rewriteIdReferencesInHtml(`<label${renamed}>`, (id) => {
      seen.push(id);
      return null;
    });
    return want === undefined ? seen.length === 0 : same(seen, [want]);
  },
  "id-references collectDeclaredIds": (attrs) => {
    const renamed = renameA(attrs, "id");
    const want = browserAttributes(renamed).find(([n]) => n === "id")?.[1];
    const ids = [...collectDeclaredIds(`<div${renamed}>`)];
    return same(ids, want ? [want] : []);
  },
};

/**
 * Where a tokenizer reads a case differently from the browser, and why it is
 * left so (for the owner):
 *
 * - component-attribute-scan treats every JavaScript `\s` character as
 *   whitespace (pkg's regexes do the same); the tokenizer's whitespace is
 *   only tab, LF, FF, CR and space, so a no-break space inside a tag is part
 *   of a name or value. Changing one tokenizer alone would split pkg.
 * - id-references reads an unquoted value without a final `/`
 *   (`for=x/>`, `id=x/>`): authors mean a self-closing tag, and the declared
 *   id and its references are read the same way.
 * - id-references finds tags with element-content-scan.ts scanOpeningTags,
 *   which reproduces the regex `(?:[^>"']|"[^"]*"|'[^']*')*`: any quote
 *   opens a string, so an unquoted value holding a quote (`for=x"y`,
 *   `title=it's`) hides the whole tag. Owner: element-content-scan.ts (it
 *   is shared with shielding.ts, so the fix is its own change).
 */
const KNOWN_DISAGREEMENTS: Record<string, string[]> = {
  "html-scanner readStartTagAttributes": [],
  "component-attribute-scan scanWholeAttributes": [
    "no-break space in an unquoted value",
    "no-break space inside a name",
  ],
  "styles quotedAttributeValueRanges": [],
  "id-references (for= read by rewriteIdReferencesInHtml)": [
    "unquoted value ending in a slash",
    "double quote in an unquoted value",
    "no-break space in an unquoted value",
  ],
  "id-references collectDeclaredIds": [
    "unquoted value ending in a slash",
    "double quote in an unquoted value",
    "no-break space in an unquoted value",
  ],
};

describe("attribute tokenizers agree with the browser on one corpus (R2-05-c)", () => {
  it("parse5 reads the corpus as written (no character references)", () => {
    expect(browserAttributes(` a="1" b='2'`)).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(ATTRIBUTE_CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it.each(Object.keys(TOKENIZERS))("%s", (tokenizer) => {
    const disagreements = ATTRIBUTE_CORPUS.filter(
      ({ attrs }) => !TOKENIZERS[tokenizer](attrs),
    ).map(({ name }) => name);
    expect(disagreements).toEqual(KNOWN_DISAGREEMENTS[tokenizer]);
  });
});

/**
 * Fixed inputs for the id-references defects the corpus found (R2-05-c):
 * its attribute regex let a quoted value run past its closing quote when no
 * whitespace followed, and read `id=` text inside another attribute's
 * quoted value as a declared id.
 */
describe("id-references reads attributes as the tokenizer does", () => {
  const scoped = (id: string) => (id === "x" || id === "r" ? `s-${id}` : null);

  it("ends a quoted value at its closing quote, whatever follows", () => {
    expect(rewriteIdReferencesInHtml(`<label for="x"class="y">`, scoped)).toBe(
      `<label for="s-x"class="y">`,
    );
    expect(
      rewriteIdReferencesInHtml(`<label for="x"/ class="y">`, scoped),
    ).toBe(`<label for="s-x"/ class="y">`);
    expect([...collectDeclaredIds(`<div id="x"class="y">`)]).toEqual(["x"]);
  });

  it("reads an attribute after a slash separator", () => {
    expect(rewriteIdReferencesInHtml(`<label /for="x">`, scoped)).toBe(
      `<label /for="s-x">`,
    );
  });

  it("never reads id= text inside another attribute's quoted value", () => {
    expect([...collectDeclaredIds(`<div title=' id="q" ' id=r>`)]).toEqual([
      "r",
    ]);
    expect(
      rewriteIdReferencesInHtml(`<label title=' for="x" ' for=r>`, scoped),
    ).toBe(`<label title=' for="x" ' for="s-r">`);
  });

  it("still reads the Prettier layout and the self-closing slash", () => {
    expect(
      rewriteIdReferencesInHtml(`<label\n  class="a"\n  for="x"\n>`, scoped),
    ).toBe(`<label\n  class="a"\n  for="s-x"\n>`);
    expect(rewriteIdReferencesInHtml(`<input list=x/>`, scoped)).toBe(
      `<input list="s-x"/>`,
    );
    expect([...collectDeclaredIds(`<input id=x/>`)]).toEqual(["x"]);
  });

  it("leaves a tag alone when the attribute is missing, empty or misspelled", () => {
    for (const tag of [`<label>`, `<label for="">`, `<label htmlFor="x">`])
      expect(rewriteIdReferencesInHtml(tag, scoped)).toBe(tag);
    expect([...collectDeclaredIds(`<div id="">`)]).toEqual([]);
  });
});
