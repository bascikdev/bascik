import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createAttributeValueScanner,
  getFirstComponent,
  getTag,
} from "./components.ts";
import type { ComponentList } from "./types.ts";

// The original per-call check: a fresh scan from offset zero to `index`.
const referenceInsideValue = (html: string, index: number): boolean => {
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
    } else if (char === "<" && /[a-zA-Z/!?]/.test(html[cursor + 1] ?? "")) {
      state = "tag";
    }
  }
  return state === "quoted" || state === "unquoted" || state === "before-value";
};

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
          // The checkpoint also depends on the byte at its cursor, so one must exist.
          if (first.length === 0) return;
          const cut = rawCut % first.length;
          const scanner = createAttributeValueScanner(first);
          scanner.isInsideValue(cut);
          const checkpoint = scanner.checkpoint();
          expect(checkpoint.cursor).toBe(cut);
          const second = first.slice(0, cut + 1) + suffix;
          const resumed = createAttributeValueScanner(second, checkpoint);
          for (const raw of rawQueries) {
            const index = raw % (second.length + 1);
            expect(resumed.isInsideValue(index)).toBe(
              referenceInsideValue(second, index),
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
    // The scanner as first written: one regex test per character.
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
            while (i < n && !/[\s"'=<>`]/.test(openTag[i])) i++;
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
