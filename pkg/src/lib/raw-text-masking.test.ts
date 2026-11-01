import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { propertyBounds } from "./property-runs.test-helper.ts";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./component-masking.ts";
import { replaceTag } from "./component-tags.ts";
import { findCommentEnd } from "./html-scanner.ts";

type Node = DefaultTreeAdapterTypes.ChildNode;

/** Tag names of the elements parse5 builds from `html`, in document order. */
const parsedElementNames = (html: string): string[] => {
  const names: string[] = [];
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      names.push(node.tagName);
      visit(node.childNodes);
    }
  };
  visit(parseFragment(html).childNodes);
  return names;
};

describe("comment ends in maskRawTextContent follow the HTML tokenizer", () => {
  // The tokenizer ends a comment at `-->` or `--!>`, and `<!-->` and `<!--->`
  // are complete (empty) comments. A component tag after one is live markup,
  // so masking must not stretch the comment to a later `-->`.
  const cases: Array<{ html: string; masked: string }> = [
    {
      html: "<!-- a --!><my-card></my-card>-->",
      masked: "<!--   --!><my-card></my-card>-->",
    },
    {
      html: "<!--><my-card></my-card>-->",
      masked: "<!--><my-card></my-card>-->",
    },
    {
      html: "<!---><my-card></my-card>-->",
      masked: "<!---><my-card></my-card>-->",
    },
    {
      html: "<!-- a ---!><my-card></my-card>-->",
      masked: "<!--    --!><my-card></my-card>-->",
    },
    {
      html: "<!----!><my-card></my-card>-->",
      masked: "<!----!><my-card></my-card>-->",
    },
  ];

  it.each(cases)("leaves the component after $html visible", ({ html }) => {
    expect(parsedElementNames(html)).toEqual(["my-card"]);
  });

  it.each(cases)("masks $html to $masked", ({ html, masked }) => {
    expect(maskRawTextContent(html)).toBe(masked);
    expect(maskRawTextContentWithClosure(html)).toEqual({
      masked,
      closed: true,
    });
  });

  it.each(cases)("replaces the component after $html", ({ html }) => {
    expect(replaceTag(html, "my-card", "X")).toBe(
      html.replace("<my-card></my-card>", "X"),
    );
  });

  it("still hides a component inside a comment that only looks closed", () => {
    // None of these end a comment: `--! >`, `--!->`, `-- >`, `<!--!>`, `<!---!>`.
    for (const html of [
      "<!-- --! ><my-card></my-card>-->",
      "<!-- --!-><my-card></my-card>-->",
      "<!-- -- ><my-card></my-card>-->",
      "<!--!><my-card></my-card>-->",
      "<!---!><my-card></my-card>-->",
    ]) {
      expect(parsedElementNames(html), html).toEqual([]);
      expect(replaceTag(html, "my-card", "X"), html).toBe(html);
      expect(maskRawTextContent(html), html).not.toContain("my-card");
    }
  });

  it("treats a stray --!> with no comment open as text", () => {
    const html = "a --!> <my-card></my-card>";
    expect(maskRawTextContent(html)).toBe(html);
    expect(replaceTag(html, "my-card", "X")).toBe("a --!> X");
  });

  it("leaves an unclosed comment and everything after it unmasked, as before", () => {
    const html = "<!-- a --! <my-card></my-card>";
    expect(maskRawTextContent(html)).toBe(html);
    expect(maskRawTextContentWithClosure(html).closed).toBe(false);
  });

  it("masks a script that follows a --!> comment", () => {
    const html = "<!-- x --!><script><my-card></script>-->";
    expect(maskRawTextContent(html)).toBe(
      `<!--   --!><script>${" ".repeat(9)}</script>-->`,
    );
  });
});

describe("comments and raw text are resolved in document order, as the tokenizer does", () => {
  // Comments used to be masked before raw-text elements, so a `<!--` inside a
  // script string or a stylesheet was taken for a comment opener. Once a
  // comment could also end at `--!>`, such a `<!--` ran to a later `--!>`
  // anywhere in the page (at request time, possibly in echoed visitor text)
  // and hid the closing tag and the component after it. The browser reads a
  // raw-text element first: a `<!--` inside it is text.
  const visible: string[] = [
    `<script>x="<!--"</script><my-card></my-card><script>y="--!>"</script>`,
    `<script>x="<!--"</script><my-card></my-card><p>--!></p>`,
    `<style>/* <!-- */</style><my-card></my-card><!-- c --!>`,
    `<textarea><!--</textarea><my-card></my-card><textarea><!--></textarea>`,
    `<script>"<!--"</script><my-card></my-card><script>"<!-->"</script>`,
    `<script>"<!--"</script><my-card></my-card><!-- c -->`,
    // A closer inside what looks like a comment still ends the element.
    `<script><!-- </script><my-card></my-card> --></script>`,
    `<style><!-- </style><my-card></my-card> --></style>`,
    `<textarea><!-- </textarea><my-card></my-card> --></textarea>`,
    // A `<!--` inside a tag (an attribute value) is not a comment either.
    `<div title="<!--"><my-card></my-card><p>--!></p>`,
    `<input value='<!--'><my-card></my-card><!-- c --!>`,
    `<a title="<!--"><my-card></my-card></a><b title="-->">`,
    // The element that opens first wins; the other's tags are its text.
    `<style>a<script>b</style><my-card></my-card></script>`,
    `<textarea><style></textarea><my-card></my-card></style>`,
  ];

  it.each(visible)("finds the component in %j, as parse5 does", (html) => {
    expect(parsedElementNames(html)).toContain("my-card");
    expect(maskRawTextContent(html)).toContain("<my-card></my-card>");
    expect(replaceTag(html, "my-card", "X")).toBe(
      html.replace("<my-card></my-card>", "X"),
    );
  });

  it("keeps a script's legacy comment wrapper with a nested script string whole (double-escaped script data)", () => {
    // `<!--` then `<script>` inside a script puts the tokenizer in the
    // double-escaped state, where `</script>` does not end the element; the
    // `-->` leaves it again.
    const html = `<script><!--\ndocument.write("<script></script>");\n<my-card></my-card>--></script><my-card></my-card>`;
    expect(parsedElementNames(html)).toEqual(["script", "my-card"]);
    const inner = html.slice(
      "<script>".length,
      html.indexOf("--></script>") + 3,
    );
    expect(maskRawTextContent(html)).toBe(
      `<script>${" ".repeat(inner.length)}</script><my-card></my-card>`,
    );
    expect(maskRawTextContentWithClosure(html)).toEqual({
      masked: maskRawTextContent(html),
      closed: true,
    });
  });

  it("keeps reading a tag across a raw-text element inside its attribute value", () => {
    // The `<script>` is attribute text to the browser. It is masked as
    // before, but the tag goes on around it, so the `<!--` after it is still
    // inside the attribute value and is not a comment.
    const html = `<p title='<script></script><!-- a --!><my-card></my-card>'><my-card></my-card>`;
    expect(parsedElementNames(html)).toEqual(["p", "my-card"]);
    expect(maskRawTextContent(html)).toBe(html);
  });

  it("reports a string that ends inside a tag as open, since the tag decides whether a later <!-- is a comment", () => {
    for (const html of [`<div title="x`, `<p>a</p><div `, `<div title='<!--`])
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(false);
    for (const html of [`<div title="<!--">`, `<p title='-->'>x</p>`])
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(true);
  });

  it("misuse: a double-escaped script with no way out stays unmasked and open", () => {
    const html = `<script><!--<script></script><my-card></my-card>`;
    // The browser runs the script to the end of input; the masker, as for any
    // opener without a closer, leaves it and reports the string open.
    expect(parsedElementNames(html)).toEqual(["script"]);
    expect(maskRawTextContentWithClosure(html).closed).toBe(false);
  });
});

/**
 * The parse5 oracle (R2-07-b): on pages where the masker's model is the
 * browser's (HTML content only, every comment and raw-text element closed,
 * no other raw-text or RCDATA element), the mask blanks exactly what parse5
 * parses as comment text and as the text of `<script>`, `<style>` and
 * `<textarea>`.
 */
describe("maskRawTextContent agrees with parse5", () => {
  const maskFragment = fc.constantFrom(
    "<script>a()</script>",
    "<SCRIPT type=module>m()</SCRIPT>",
    '<script data-a="x>y">b()</script>',
    "<script/>c()</script>",
    "<script>",
    "</script>",
    "</script foo>",
    '</script x=">">',
    "</script\u000b>",
    "</script >",
    "</style/>",
    "</textarea >",
    '"</script"',
    "'</script>'",
    "<!--<script>",
    "<!--",
    "-->",
    "--!>",
    "<!-->",
    "<!--->",
    "<!-- c -->",
    "<style>",
    "</style>",
    "<textarea>",
    "</textarea>",
    "<style-guide>",
    "<script-x>",
    "<scr",
    "ipt>",
    "<my-card>",
    "</my-card>",
    "<p>",
    "</p>",
    '<p title="<script>">',
    "<p title='<!--'>",
    "<p<style>",
    "<!x",
    "<?p",
    "</ x",
    "</",
    "<",
    ">",
    '"',
    "'",
    "=",
    " ",
    "\n",
    "x",
    '<div\n  class="a > b"\n>',
    "</div>",
    // Quotes where the tokenizer does not read a value, in an end tag's
    // name and in an ordinary start tag. (In a raw-text opener the masker
    // reads `(?:[^>"']|"[^"]*"|'[^']*')*>`, as documented: `<script a=b"c>`
    // and `<script "a>b">` end where that regex ends them, not where the
    // tokenizer does. Not in this model; R2-07 progress log.)
    '<p a=b"c>',
    "<p 'a>",
    '</p"=',
    "</p='",
  );
  const maskSoup = fc
    .array(maskFragment, { maxLength: 18 })
    .map((parts) => parts.join(""));

  const RAW = new Set(["script", "style", "textarea"]);

  /** The mask parse5 implies, or null when the page is outside the model. */
  const parsedMask = (html: string): string | null => {
    const blanks: Array<[number, number]> = [];
    let outside = false;
    const visit = (nodes: Node[]): void => {
      for (const node of nodes) {
        const location = (
          node as {
            sourceCodeLocation?: DefaultTreeAdapterTypes.Element["sourceCodeLocation"];
          }
        ).sourceCodeLocation;
        if (node.nodeName === "#comment") {
          if (!location || !html.startsWith("<!--", location.startOffset))
            continue;
          const { startOffset: start, endOffset: end } = location;
          if (findCommentEnd(html, start) !== end) outside = true;
          const closeLength = html.endsWith("--!>", end) ? 4 : 3;
          if (end - closeLength > start + 4)
            blanks.push([start + 4, end - closeLength]);
          continue;
        }
        if (!("tagName" in node)) continue;
        if (RAW.has(node.tagName)) {
          if (!location?.startTag || !location.endTag) outside = true;
          else
            blanks.push([
              location.startTag.endOffset,
              location.endTag.startOffset,
            ]);
          continue;
        }
        visit(node.childNodes);
      }
    };
    visit(parse(html, { sourceCodeLocationInfo: true }).childNodes as Node[]);
    if (outside) return null;
    let masked = html;
    for (const [start, end] of blanks)
      masked =
        masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
    return masked;
  };

  const MODEL_BOUNDS = propertyBounds(2000, "MASK_ORACLE_RUNS");
  it(
    "on random markup in its model",
    () => {
      let compared = 0;
      fc.assert(
        fc.property(maskSoup, (html) => {
          const expected = parsedMask(html);
          if (expected === null) return;
          compared++;
          expect(maskRawTextContent(html)).toBe(expected);
        }),
        MODEL_BOUNDS.options,
      );
      expect(compared).toBeGreaterThan(400);
    },
    MODEL_BOUNDS.timeoutMs,
  );
});

describe("an end tag's name runs to tag white space, / or > (parse5 oracle counterexample)", () => {
  // `</` and a letter starts an end tag's name, in which `=` and quotes are
  // name characters. The `/` of `</` was read as the end of the name, so
  // `="...` or `='...` right after it opened an attribute value that hid
  // the markup after the tag's real `>`.
  it.each([
    // Shrunk by fast-check from the property above.
    `"</script"='</script>'<script>a()</script>`,
    `</p"='</p>'<script>a()</script>`,
    `</div="x><style>.a{}</style>"`,
    `</p='x>'<!-- c -->'`,
  ])("masks what follows it as parse5 parses it: %s", (html) => {
    expect(maskRawTextContent(html)).toBe(
      // The expected mask, built from parse5's tree.
      html
        .replace("<script>a()</script>", "<script>   </script>")
        .replace("<style>.a{}</style>", "<style>    </style>")
        .replace("<!-- c -->", "<!--   -->"),
    );
  });

  it("misuse: a typo'd end tag does not hide the component after it", () => {
    const html = `<p>a</p"='x><my-card>y</my-card>'`;
    const found = replaceTag(html, "my-card", "<b>card</b>");
    expect(found).toBe(`<p>a</p"='x><b>card</b>'`);
  });
});
