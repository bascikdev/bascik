/**
 * Property tests: whatever a model (or a visitor steering one) writes, and
 * however the stream is sliced, the renderer's output is the same, is made of
 * whole elements, and holds nothing outside the allow-list.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "./catalog.ts";
import { createRenderer, renderText } from "./render.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<article><h3 data-bascik-prop-title></h3><a data-bascik-attr-href="link"></a><span data-bascik-slot></span></article>`,
    )!,
    describeComponent(
      "card-grid.html",
      `<div><span data-bascik-slot></span></div>`,
    )!,
    describeComponent("bar-row.html", `<li data-bascik-prop-value></li>`)!,
  ].map((entry) => [entry.name, entry]),
);

/** Fragments chosen to hit every branch: tags, quotes, markers, fences, hostile markup. */
const fragment = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      "<",
      ">",
      "/>",
      "</",
      "=",
      '"',
      "'",
      " ",
      "\n",
      "\n\n",
      "**",
      "*",
      "`",
      "```",
      "# ",
      "## ",
      "- ",
      "<book-card",
      "</book-card>",
      "<card-grid>",
      "</card-grid>",
      "<bar-row",
      "<book-",
      "<card",
      ' title="',
      " title='",
      " link=",
      " value=12",
      ' onclick="alert(1)"',
      " data-bascik-prop-title=x",
      "<script>",
      "</script>",
      "<script data-bascik-server>",
      "<img src=x onerror=alert(1)>",
      "<!--",
      "-->",
      "<style>",
      "<admin-panel>",
      "javascript:alert(1)",
      "&",
      "&lt;",
      "&#60;",
      "$&",
      "$1",
      "\u0000",
      " ",
    ),
  },
  { weight: 3, arbitrary: fc.string({ maxLength: 8 }) },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 4 }) },
);
const modelText = fc
  .array(fragment, { maxLength: 60 })
  .map((parts) => parts.join(""));

/** Cut `text` at the given points and feed the pieces one by one. */
function sliced(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map((cut) => cut % (text.length + 1)))].sort(
    (a, b) => a - b,
  );
  const renderer = createRenderer(catalog);
  const chunks: string[] = [];
  let from = 0;
  for (const point of [...points, text.length]) {
    chunks.push(renderer.push(text.slice(from, point)));
    from = point;
  }
  chunks.push(renderer.end());
  return chunks;
}

const ALLOWED_TAGS = new Set([
  "book-card",
  "card-grid",
  "bar-row",
  "strong",
  "code",
  "h3",
  "h4",
  "div",
  "br",
]);
const ALLOWED_ATTRIBUTE = /^(data-bascik-prop-(title|link|value)|data-line)$/;

/** Every tag in `html`, as the browser's tokenizer would find them. */
function tags(
  html: string,
): { name: string; closing: boolean; attributes: string[] }[] {
  const found = [];
  for (const match of html.matchAll(
    /<(\/?)([A-Za-z!?][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>?/g,
  )) {
    const attributes = [
      ...match[3]!.matchAll(
        /([^\s=/"']+)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g,
      ),
    ].map((attribute) => attribute[1]!);
    found.push({
      name: match[2]!.toLowerCase(),
      closing: match[1] === "/",
      attributes,
    });
  }
  return found;
}

describe("renderer properties", () => {
  it("renders the same HTML however the stream is sliced", () => {
    fc.assert(
      fc.property(
        modelText,
        fc.array(fc.nat(), { maxLength: 40 }),
        (text, cuts) => {
          expect(sliced(text, cuts).join("")).toBe(renderText(text, catalog));
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("emits only allow-listed tags, with only declared props", () => {
    fc.assert(
      fc.property(modelText, (text) => {
        for (const tag of tags(renderText(text, catalog))) {
          expect(
            ALLOWED_TAGS.has(tag.name),
            `<${tag.name}> from ${JSON.stringify(text)}`,
          ).toBe(true);
          for (const attribute of tag.attributes) {
            expect(attribute, JSON.stringify(text)).toMatch(ALLOWED_ATTRIBUTE);
          }
        }
      }),
      { numRuns: 3000 },
    );
  });

  it("returns whole elements from every push", () => {
    fc.assert(
      fc.property(
        modelText,
        fc.array(fc.nat(), { maxLength: 40 }),
        (text, cuts) => {
          for (const chunk of sliced(text, cuts)) {
            const stack: string[] = [];
            for (const tag of tags(chunk)) {
              if (tag.name === "br") continue;
              if (tag.closing) expect(stack.pop()).toBe(tag.name);
              else stack.push(tag.name);
            }
            expect(stack, chunk).toEqual([]);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("never loses a character of plain prose", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("a", "b", " ", "é", "7", ".", ",") }),
        (text) => {
          expect(renderText(text, catalog)).toBe(text);
        },
      ),
    );
  });
});
