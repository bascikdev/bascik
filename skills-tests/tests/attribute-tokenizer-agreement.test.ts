/**
 * R2-05-c, outside pkg: the language server's attribute readers and the
 * bascik skill's markup.mjs over the same corpus as
 * pkg/src/lib/attribute-tokenizer-agreement.test.ts, against the browser's
 * tokenizer (parse5, through pkg's corpus helper). KNOWN_DISAGREEMENTS is
 * the list for each owner; a new disagreement, or a listed one that now
 * agrees, fails.
 */
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_CORPUS,
  browserAttributes,
  firstOfEachName,
} from "../../pkg/src/lib/attribute-tokenizer-corpus.test-helper.ts";
import {
  parseScriptOpenTagAttributes,
  readOpenTagAttributes,
} from "../../lsp/src/analyzer.ts";
import {
  parseAttributes,
  parseMarkup,
} from "../../skills/bascik/scripts/lib/markup.mjs";

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

interface MarkupNode {
  tag: string;
  attrs: Record<string, string>;
  children: MarkupNode[];
}

const TOKENIZERS: Record<string, (attrs: string) => boolean> = {
  "lsp readOpenTagAttributes": (attrs) =>
    same([...readOpenTagAttributes(`<x-t${attrs}>`)], browserAttributes(attrs)),
  "lsp parseScriptOpenTagAttributes": (attrs) =>
    same(
      [...parseScriptOpenTagAttributes(`<script${attrs}>`)].map(
        ([name, value]) => [name, value === true ? "" : value],
      ),
      browserAttributes(attrs),
    ),
  "markup.mjs parseAttributes": (attrs) =>
    same(
      firstOfEachName(
        Object.entries(parseAttributes(attrs) as Record<string, string>),
      ),
      browserAttributes(attrs),
    ),
  // The whole tree: the tag must be found, with its attributes, and the
  // next element must still be read.
  "markup.mjs parseMarkup": (attrs) => {
    const root = parseMarkup(
      `<p${attrs}>t</p><p class='z'>u</p>`,
    ) as MarkupNode;
    return same(
      root.children.map((node) => [node.tag, Object.entries(node.attrs)]),
      [
        ["p", browserAttributes(attrs)],
        ["p", [["class", "z"]]],
      ],
    );
  },
};

/**
 * Where a reader differs from the browser, and why it is left so:
 *
 * - All four treat every JavaScript `\s` character as whitespace; the
 *   tokenizer's is only tab, LF, FF, CR and space (a no-break space inside a
 *   tag is part of a name or value).
 * - readOpenTagAttributes and parseAttributes read an unquoted value
 *   without a final `/` (`src=x.png/>`): a trailing `/>` is the self-closing
 *   slash to them, as to pkg's prop reader.
 * - Names stop at a quote, `<` or backtick in all four; the tokenizer keeps
 *   those in the name (a parse error no formatter writes).
 * - parseMarkup ends an open tag at a `<` outside a quoted value and reads
 *   the tag as unclosed (R3-18), where the tokenizer reads the `<` into an
 *   unquoted value or a name: that keeps the elements after a forgotten `>`
 *   in the audit, and keeps the scan linear when many tags never close.
 *   parseAttributes, given the attribute text alone, still reads `a=<b`.
 */
const KNOWN_DISAGREEMENTS: Record<string, string[]> = {
  "lsp readOpenTagAttributes": [
    "unquoted value then /> keeps the slash",
    "unquoted value ending in a slash",
    "no-break space in an unquoted value",
    "no-break space inside a name",
  ],
  "lsp parseScriptOpenTagAttributes": [
    "no-break space in an unquoted value",
    "no-break space inside a name",
  ],
  "markup.mjs parseAttributes": [
    "unquoted value then /> keeps the slash",
    "unquoted value ending in a slash",
    "no-break space in an unquoted value",
    "no-break space inside a name",
  ],
  "markup.mjs parseMarkup": [
    "unquoted value then /> keeps the slash",
    "unquoted value ending in a slash",
    "< in an unquoted value",
    "no-break space in an unquoted value",
    "no-break space inside a name",
  ],
};

describe("LSP and skill attribute readers agree with the browser (R2-05-c)", () => {
  it.each(Object.keys(TOKENIZERS))("%s", (tokenizer) => {
    const disagreements = ATTRIBUTE_CORPUS.filter(
      ({ attrs }) => !TOKENIZERS[tokenizer](attrs),
    ).map(({ name }) => name);
    expect(disagreements).toEqual(KNOWN_DISAGREEMENTS[tokenizer]);
  });
});

/** Fixed inputs for the defects the corpus found (R2-05-c). */
describe("fixed inputs", () => {
  it("markup.mjs keeps an element whose unquoted value holds an apostrophe, and the elements after it", () => {
    const root = parseMarkup(
      `<p title=it's>Milk frother</p>\n<p class='z'>Steam</p>`,
    ) as MarkupNode;
    expect(
      root.children.map((node) => [node.tag, node.attrs["title"] ?? null]),
    ).toEqual([
      ["p", "it's"],
      ["p", null],
    ]);
  });

  it("markup.mjs still blanks a raw-text body whose open tag has an unquoted quote", () => {
    const root = parseMarkup(
      `<script data-x=it's>const p = "<p>";</script><p>after</p>`,
    ) as MarkupNode & { children: Array<MarkupNode & { body?: string }> };
    expect(root.children.map((node) => node.tag)).toEqual(["script", "p"]);
    expect(root.children[0].body).toBe(`const p = "<p>";`);
  });

  it("markup.mjs keeps an element whose unquoted value holds a quote and then = (PR 115 review)", () => {
    // `a"b="` is one unquoted value: the quote after its `=` opens nothing.
    const root = parseMarkup(
      `<p data-x=a"b="><h1>Title</h1></p>\n<p class='z'>Steam</p>`,
    ) as MarkupNode;
    expect(
      root.children.map((node) => [node.tag, node.attrs["data-x"] ?? null]),
    ).toEqual([
      ["p", 'a"b="'],
      ["p", null],
    ]);
    expect(root.children[0].children.map((node) => node.tag)).toEqual(["h1"]);
  });

  it("markup.mjs ends a raw-text open tag at its > when an unquoted value holds a quote and then =", () => {
    const root = parseMarkup(
      `<script data-x=a"b=">const p = "<p>";</script><p>after</p>`,
    ) as MarkupNode & { children: Array<MarkupNode & { body?: string }> };
    expect(root.children.map((node) => node.tag)).toEqual(["script", "p"]);
    expect(root.children[0].attrs["data-x"]).toBe('a"b="');
    expect(root.children[0].body).toBe(`const p = "<p>";`);
  });

  it("markup.mjs reads an unquoted value with = in it whole, and an = with no value", () => {
    const root = parseMarkup(
      `<a href=a=b x=a'b=c>Milk frother</a><a y= >Steam</a>`,
    ) as MarkupNode;
    expect(root.children.map((node) => node.attrs)).toEqual([
      { href: "a=b", x: "a'b=c" },
      { y: "" },
    ]);
  });

  // Its growth is checked in attribute-tokenizer-agreement.linear-time.test.ts.
  it("markup.mjs reads a tag of unquoted values full of = and quotes that never closes, without throwing", () => {
    const html = `<p${" a=b\"c='d=e".repeat(20_000)}`;
    expect(() => parseMarkup(html)).not.toThrow();
  });

  it("markup.mjs reads a tag that never closes in linear time, without throwing", () => {
    const html = `<p${' a="x" b=y c'.repeat(20_000)}`;
    const started = performance.now();
    expect(() => parseMarkup(html)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("markup.mjs reads a tag that stops at a < before its > as unclosed, and keeps the elements after it (R3-18)", () => {
    // A forgotten `>`: the browser reads `<h1` as an attribute of the
    // paragraph; the skill ends the paragraph's tag at the `<` instead, so
    // the heading after it is still audited, on its own line.
    const root = parseMarkup(
      `<p class="lead"\n<h1 class="title">Milk frother</h1>\n<p title="a<b">Steam</p>`,
    ) as MarkupNode;
    const children = root.children as Array<MarkupNode & { line: number }>;
    expect(children.map((node) => [node.tag, node.line, node.attrs])).toEqual([
      ["h1", 2, { class: "title" }],
      ["p", 3, { title: "a<b" }],
    ]);
  });

  it("markup.mjs keeps offsets after text whose lower case is longer, and matches raw-text tags in any case (R3-18)", () => {
    // `İ` lower-cases to two code units: a scan of a lower-cased copy
    // would blank the wrong span.
    const root = parseMarkup(
      `<p title="İİİ">İİ</p><SCRIPT>const s = "<h2>";</Script ><h1>Milk frother</h1>`,
    ) as MarkupNode & { children: Array<MarkupNode & { body?: string }> };
    expect(root.children.map((node) => node.tag)).toEqual([
      "p",
      "script",
      "h1",
    ]);
    expect(root.children[1].body).toBe(`const s = "<h2>";`);
  });

  it("the language server reads the first of two src attributes, as the browser runs it", () => {
    expect(
      parseScriptOpenTagAttributes(`<script src="./a.ts" src="./b.ts">`).get(
        "src",
      ),
    ).toBe("./a.ts");
  });

  it("the language server reads an unquoted value with a quote or = in it whole", () => {
    expect(
      readOpenTagAttributes(`<form action=/send?a=b title=it's>`).get("action"),
    ).toBe("/send?a=b");
    expect(
      readOpenTagAttributes(`<form action=/send?a=b title=it's>`).get("title"),
    ).toBe("it's");
  });
});

// The R3-18 growth checks (many unclosed tags) are in
// attribute-tokenizer-agreement.linear-time.test.ts.
