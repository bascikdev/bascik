import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { propertyBounds } from "./property-runs.test-helper.ts";
import {
  createAttributeValueScanner,
  getFirstComponent,
  getTag,
} from "./components.ts";
import type { ComponentList } from "./types.ts";

// What a `<` read in text starts, from the characters after it: a tag
// (`<a`, `</a`), nothing (`<!--`, which the masker resolves, or a `<` before
// anything else), or a bogus comment up to `>` (`<!x`, `<?`, `</` and a
// non-letter).
const referenceAfterLess = (html: string, at: number): string => {
  const rest = html.slice(at, at + 4);
  if (/^<[a-zA-Z]/.test(rest)) return "name";
  if (/^<\/[a-zA-Z]/.test(rest)) return "end-tag-open";
  if (rest.startsWith("<!--")) return "text";
  if (/^<[!?]/.test(rest) || /^<\/[^]/.test(rest)) return "bogus";
  return "text";
};

// The original per-call check: a fresh scan from offset zero to `index`,
// with the tag and bogus-comment starts the tokenizer reads.
const referenceState = (html: string, index: number): string => {
  let state = "text";
  let quote = "";
  for (let cursor = 0; cursor < index; cursor++) {
    const char = html[cursor];
    if (state === "quoted") {
      if (char === quote) state = "tag";
    } else if (state === "unquoted") {
      if (char === ">") state = "text";
      else if (/\s/.test(char)) state = "tag";
    } else if (state === "before-value") {
      if (char === '"' || char === "'") {
        quote = char;
        state = "quoted";
      } else if (char === ">") state = "text";
      else if (!/\s/.test(char)) state = "unquoted";
    } else if (state === "tag") {
      if (char === "=") state = "before-value";
      else if (char === ">") state = "text";
    } else if (state === "bogus") {
      if (char === ">") state = "text";
    } else if (state === "end-tag-open") {
      // The `/` of `</`: the end tag's own, not the end of its name.
      state = "name";
    } else if (state === "name") {
      // A tag name runs to tag white space, `/` or `>`; `=` and quotes are in it.
      if (char === ">") state = "text";
      else if (/[\t\n\f\r /]/.test(char)) state = "tag";
    } else if (char === "<") {
      state = referenceAfterLess(html, cursor);
    }
  }
  return state;
};

const referenceInsideValue = (html: string, index: number): boolean => {
  const state = referenceState(html, index);
  return state === "quoted" || state === "unquoted" || state === "before-value";
};

const referenceInsideTag = (html: string, index: number): boolean =>
  referenceState(html, index) !== "text";

const fragment = fc.constantFrom(
  "<",
  ">",
  "=",
  '"',
  "'",
  " ",
  "\t",
  "\n",
  "\u00a0",
  "\u2028",
  "\ufeff",
  "\u0085",
  "<a",
  "</",
  "<!",
  "<!-",
  "<!--",
  "</ ",
  "<!x",
  "<x=",
  '<x"',
  "<?",
  "<1",
  "<<",
  "<my-card>",
  "</my-card>",
  '<div title="',
  "<div title='",
  "<div title=",
  ' data-x="<my-card>"',
  "x",
  "é",
);
const htmlArb = fc
  .array(fragment, { maxLength: 40 })
  .map((parts) => parts.join(""));

describe("createAttributeValueScanner", () => {
  it("answers every query, in any order, like a fresh scan from offset zero", () => {
    fc.assert(
      fc.property(
        htmlArb,
        fc.array(fc.nat(), { maxLength: 20 }),
        (html, rawQueries) => {
          const scanner = createAttributeValueScanner(html);
          for (const raw of rawQueries) {
            const index = raw % (html.length + 1);
            expect(scanner.isInsideValue(index)).toBe(
              referenceInsideValue(html, index),
            );
            expect(scanner.isInsideTag(index)).toBe(
              referenceInsideTag(html, index),
            );
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("resumes from a checkpoint on any string sharing the bytes through the checkpoint cursor", () => {
    fc.assert(
      fc.property(
        htmlArb,
        htmlArb,
        fc.nat(),
        fc.array(fc.nat(), { maxLength: 10 }),
        (first, suffix, rawCut, rawQueries) => {
          // The checkpoint also depends on the three bytes from its cursor
          // (the peek after a `<`, up to `<!--`), so they must exist.
          if (first.length < 3) return;
          const cut = rawCut % (first.length - 2);
          const scanner = createAttributeValueScanner(first);
          scanner.isInsideValue(cut);
          const checkpoint = scanner.checkpoint();
          expect(checkpoint.cursor).toBe(cut);
          const second = first.slice(0, cut + 3) + suffix;
          const resumed = createAttributeValueScanner(second, checkpoint);
          for (const raw of rawQueries) {
            const index = raw % (second.length + 1);
            expect(resumed.isInsideValue(index)).toBe(
              referenceInsideValue(second, index),
            );
            expect(resumed.isInsideTag(index)).toBe(
              referenceInsideTag(second, index),
            );
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("component search with a shared attribute scan", () => {
  const componentList: ComponentList = {
    "my-card": { fileContent: "<div>card</div>" },
  };

  it("skips a component tag written inside a quoted attribute value", () => {
    const html = `<p title="<my-card></my-card>">x</p><my-card a="1">in</my-card>`;
    const found = getFirstComponent(html, componentList) as ReturnType<
      typeof getFirstComponent
    > & { startIndex?: number };
    expect(found.name).toBe("my-card");
    expect(found.startIndex).toBe(html.indexOf('<my-card a="1">'));
  });

  it("finds a component after an end tag whose name holds quotes and =, as the browser does", () => {
    // `</p"='x>` is one end tag (its name runs to the `>`); the `'` after
    // `=` opens no value there, so it cannot hide the tag after it.
    for (const before of [`</p"='x>`, `</p='x>`, `</div="x>`]) {
      const html = `<p>a${before}<my-card>in</my-card>'"`;
      const found = getFirstComponent(html, componentList) as {
        name?: string;
        startIndex?: number;
      };
      expect(found.name, before).toBe("my-card");
      expect(found.startIndex, before).toBe(html.indexOf("<my-card>"));
      const scanner = createAttributeValueScanner(html);
      expect(scanner.isInsideTag(html.indexOf("<my-card>")), before).toBe(
        false,
      );
    }
  });

  it("pairs the close tag after a quoted close tag inside the content", () => {
    const html = `<my-card><b title="</my-card>">x</b></my-card>`;
    const tag = getTag(html, "my-card");
    expect(tag.content).toBe(html);
  });

  it("resumes a search from a checkpoint after the text past it changes", () => {
    const state: { attributeCheckpoint?: { cursor: number } } = {};
    const first = `<p>a</p><<my-card></my-card>`;
    const found = getFirstComponent(
      first,
      componentList,
      undefined,
      0,
      state as never,
    ) as { startIndex?: number };
    expect(found.startIndex).toBe(first.indexOf("<my-card>"));
    // The prefix before the replaced tag is unchanged; the byte the old scan
    // peeked at is not, so the resumed scan must re-read it.
    const second = `<p>a</p><x<my-card title="<my-card>"></my-card>`;
    const resumed = getFirstComponent(
      second,
      componentList,
      undefined,
      first.indexOf("<my-card>"),
      state as never,
    ) as { startIndex?: number; name?: string };
    const fresh = getFirstComponent(
      second,
      componentList,
      undefined,
      first.indexOf("<my-card>"),
    ) as { startIndex?: number; name?: string };
    expect(resumed.name).toBe(fresh.name);
    expect(resumed.startIndex).toBe(fresh.startIndex);
  });
});

describe("scanWholeAttributes reads values the way the browser does", () => {
  const scan = async (tag: string) => {
    const { scanWholeAttributes } =
      await import("./component-attribute-scan.ts");
    return scanWholeAttributes(tag).map((a) => ({
      name: a.name,
      value: a.valueStart === -1 ? null : tag.slice(a.valueStart, a.valueEnd),
    }));
  };

  it.each([
    [
      "an unquoted URL with a query string",
      "<my-card data-bascik-prop-href=/docs/page?q=1&x=2>",
      [{ name: "data-bascik-prop-href", value: "/docs/page?q=1&x=2" }],
    ],
    [
      "an unquoted value with an apostrophe",
      "<my-card title=it's>",
      [{ name: "title", value: "it's" }],
    ],
    [
      "an unquoted value with a backtick, then another attribute",
      "<my-card title=a`b data-x=1>",
      [
        { name: "title", value: "a`b" },
        { name: "data-x", value: "1" },
      ],
    ],
    [
      'an unquoted value with " and <',
      '<my-card title=a"b<c>',
      [{ name: "title", value: 'a"b<c' }],
    ],
    [
      "a name that starts with =",
      "<my-card =x data-y=1>",
      [
        { name: "=x", value: null },
        { name: "data-y", value: "1" },
      ],
    ],
    ["a value cut by >", "<my-card a=b>c=d>", [{ name: "a", value: "b" }]],
  ])("%s", async (_case, tag, expected) => {
    expect(await scan(tag)).toEqual(expected);
  });

  const PARSE5_BOUNDS = propertyBounds(2000);
  it(
    "agrees with parse5 on the attributes of arbitrary tags",
    async () => {
      const { parseFragment } = await import("parse5");
      const { scanWholeAttributes } =
        await import("./component-attribute-scan.ts");
      // ASCII whitespace only: the scanner splits on everything JavaScript's
      // \s matches (see above), wider than HTML. No `&`, so values need no
      // character reference decoding.
      const alphabet = [..."ab=/>\"'`< \t\n"];
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...alphabet), { maxLength: 30 }),
          (chars) => {
            const tag = `<x ${chars.join("")}>`;
            const element = parseFragment(tag).childNodes[0];
            // An unclosed quote runs to the end, where the tag is dropped.
            if (!element || !("attrs" in element)) return;
            const seen = new Set<string>();
            const scanned: { name: string; value: string }[] = [];
            for (const a of scanWholeAttributes(tag)) {
              const name = a.name.toLowerCase();
              if (seen.has(name)) continue;
              seen.add(name);
              scanned.push({
                name,
                value:
                  a.valueStart === -1
                    ? ""
                    : tag.slice(a.valueStart, a.valueEnd),
              });
            }
            expect(scanned).toEqual(
              element.attrs.map((a) => ({ name: a.name, value: a.value })),
            );
          },
        ),
        PARSE5_BOUNDS.options,
      );
    },
    PARSE5_BOUNDS.timeoutMs,
  );
});

describe("scanWholeAttributes separators", () => {
  it("splits on every character a JavaScript \\s matches, not only ASCII whitespace", async () => {
    const { scanWholeAttributes } =
      await import("./component-attribute-scan.ts");
    const cases = [
      `<a b=1　c="x y"\vd>`,
      `<div/disabled data-x = 'q' e= f>`,
      `<x a=b/c﻿g=h>`,
      `<p\tclass=one\nid="two"\r\fz>`,
    ];
    expect(
      cases.map((tag) =>
        scanWholeAttributes(tag).map((a) => [
          a.name,
          a.start,
          a.end,
          a.valueStart,
          a.valueEnd,
        ]),
      ),
    ).toEqual([
      [
        ["b", 3, 6, 5, 6],
        ["c", 7, 14, 10, 13],
        ["d", 15, 16, -1, -1],
      ],
      [
        ["disabled", 5, 13, -1, -1],
        ["data-x", 14, 26, 24, 25],
        ["e", 27, 31, 30, 31],
      ],
      [
        ["a", 3, 8, 5, 8],
        ["g", 9, 12, 11, 12],
      ],
      [
        ["class", 3, 12, 9, 12],
        ["id", 13, 21, 17, 20],
        ["z", 23, 24, -1, -1],
      ],
    ]);
  });

  it("agrees with a regex-per-character reference on arbitrary tags", async () => {
    const { scanWholeAttributes } =
      await import("./component-attribute-scan.ts");
    // The scanner as a regex test per character, with the WHATWG rules: a
    // name may start with `=`, and an unquoted value ends only at whitespace
    // or `>` (quotes, `=`, `<` and backtick in it are value characters).
    const reference = (openTag: string) => {
      const out: number[][] = [];
      let i = 0;
      const n = openTag.length;
      if (n > 0 && openTag.charCodeAt(0) === 60) i = 1;
      while (i < n && !/[\s/>]/.test(openTag[i])) i++;
      while (i < n) {
        while (i < n && /[\s/]/.test(openTag[i])) i++;
        if (i >= n || openTag[i] === ">") break;
        const nameStart = i;
        if (openTag[i] === "=") i++;
        while (i < n && !/[\s=/>]/.test(openTag[i])) i++;
        const nameEnd = i;
        let valueStart = -1;
        let valueEnd = -1;
        let attrEnd = nameEnd;
        while (i < n && /[\s]/.test(openTag[i])) i++;
        if (i < n && openTag[i] === "=") {
          i++;
          while (i < n && /[\s]/.test(openTag[i])) i++;
          if (i < n && (openTag[i] === '"' || openTag[i] === "'")) {
            const quote = openTag[i];
            i++;
            valueStart = i;
            while (i < n && openTag[i] !== quote) i++;
            valueEnd = i;
            if (i < n) i++;
          } else {
            valueStart = i;
            while (i < n && !/[\s>]/.test(openTag[i])) i++;
            valueEnd = i;
          }
          attrEnd = i;
        }
        out.push([nameStart, nameEnd, valueStart, valueEnd, attrEnd]);
      }
      return out;
    };
    const alphabet = [
      ..."ab=/>\"'`< \t\n\v\f\r",
      " ",
      " ",
      " ",
      " ",
      "​",
      " ",
      " ",
      " ",
      "　",
      "﻿",
      "\u0085",
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...alphabet), { maxLength: 40 }),
        (chars) => {
          const tag = `<x${chars.join("")}`;
          expect(
            scanWholeAttributes(tag).map((a) => [
              a.nameStart,
              a.nameEnd,
              a.valueStart,
              a.valueEnd,
              a.end,
            ]),
          ).toEqual(reference(tag));
        },
      ),
      { numRuns: 2000 },
    );
  });
});

// extractProps and extractInheritableAttributes read the start tag once
// (prompt 158 R2-09): the attributes readStartTag returns for a whole
// template are the ones a second scan of the start tag alone would find.
describe("readStartTag", () => {
  it.each([
    ["a plain start tag before content", '<my-card title="a">body</my-card>'],
    ["a `>` inside a quoted value", '<my-card title="a > b" x=1>body'],
    ["a quote inside an unquoted value", "<my-card title=it's x='y'>body"],
    ["a self-closing unquoted value", "<my-card title=x/>rest"],
    ["no attributes", "<my-card>rest"],
    ["a name that starts with `=`", '<my-card =x="1" y>rest'],
  ])("%s", async (_label, html) => {
    const { readStartTag, scanWholeAttributes } =
      await import("./component-attribute-scan.ts");
    const { attributes, end } = readStartTag(html);
    expect(end).toBeGreaterThan(0);
    expect(html[end - 1]).toBe(">");
    expect(attributes).toEqual(scanWholeAttributes(html.slice(0, end)));
  });

  it.each([
    ["an unterminated quoted value", '<my-card title="a>b'],
    ["no `>` at all", "<my-card title=a"],
    ["an empty template", ""],
  ])("reports no start tag for %s", async (_label, html) => {
    const { readStartTag } = await import("./component-attribute-scan.ts");
    expect(readStartTag(html).end).toBe(-1);
  });

  const START_TAG_BOUNDS = propertyBounds(2000);
  it(
    "agrees with a second scan of the start tag on any input",
    async () => {
      const { readStartTag, scanWholeAttributes } =
        await import("./component-attribute-scan.ts");
      fc.assert(
        fc.property(
          fc.stringMatching(/^<[a-z][a-z-]{0,6}[ a-z=/"'<>`-]{0,40}$/),
          fc.string({ maxLength: 10 }),
          (tag, rest) => {
            const html = tag + rest;
            const { attributes, end } = readStartTag(html);
            if (end === -1) return;
            expect(attributes).toEqual(scanWholeAttributes(html.slice(0, end)));
          },
        ),
        START_TAG_BOUNDS.options,
      );
    },
    START_TAG_BOUNDS.timeoutMs,
  );
});
