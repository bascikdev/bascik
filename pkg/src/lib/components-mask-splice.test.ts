import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
  spliceRawTextMask,
} from "./components.ts";

// Fragments chosen to stress every boundary the masker cares about: comment
// and raw-text openers and closers in mixed case, quotes inside opener
// attributes, partial tokens, and tag-like text that is not a raw-text tag.
const fragment = fc.constantFrom(
  "<!--",
  "-->",
  "<!-->",
  "<!---->",
  "<script>",
  "<SCRIPT type=module>",
  "<script data-a=\"x>y\">",
  "<script a=\"",
  "<script a='",
  "<script-x>",
  "<scripts>",
  "</script>",
  "</script >",
  "</SCRIPT>",
  "<style>",
  "</style>",
  "<textarea>",
  "</textarea >",
  "<scr",
  "<sty",
  "<!-",
  "<",
  ">",
  "\"",
  "'",
  "<my-card>",
  "</my-card>",
  "<div class=\"a\">",
  "</div>",
  "text",
  " ",
  "\n",
  "é",
  "\u0130",
);

const htmlArb = fc.array(fragment, { maxLength: 24 }).map((parts) => parts.join(""));

describe("maskRawTextContentWithClosure", () => {
  it("masks exactly like maskRawTextContent", () => {
    fc.assert(
      fc.property(htmlArb, (html) => {
        expect(maskRawTextContentWithClosure(html).masked).toBe(maskRawTextContent(html));
      }),
      { numRuns: 3000 },
    );
  });

  it("reports closed only when the mask of any continuation splits at the boundary", () => {
    fc.assert(
      fc.property(htmlArb, htmlArb, (head, tail) => {
        const { masked, closed } = maskRawTextContentWithClosure(head);
        if (!closed) return;
        expect(maskRawTextContent(head + tail)).toBe(masked + maskRawTextContent(tail));
      }),
      { numRuns: 5000 },
    );
  });

  it("treats well-formed markup as closed", () => {
    for (const html of [
      "",
      "<p>plain</p>",
      "<!-- note --><div>x</div>",
      "<script>const a = '<p>';</script><p>after</p>",
      "<style>.a{}</style><textarea>t</textarea>",
      "<!--bascik-source-file:a.html--><script>run()</script><!--bascik-source-file-end:a.html-->",
    ]) {
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(true);
    }
  });

  it("treats a dangling opener or a partial token at the end as open", () => {
    for (const html of [
      "<script>never closed",
      "<!-- never closed",
      "<p>a</p><script a=\"unterminated",
      "<style>",
      "<p>x</p><scr",
      "<p>x</p><!-",
      "<p>x</p><",
      "<p>x</p><textarea",
      // Comments are masked before scripts, so a later `-->` would end this one.
      "<script>const a = '<!--';</script><p>after</p>",
    ]) {
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(false);
    }
  });
});

describe("spliceRawTextMask", () => {
  it("produces the full-page mask whenever it accepts a splice", () => {
    fc.assert(
      fc.property(htmlArb, htmlArb, htmlArb, htmlArb, (prefix, usage, template, suffix) => {
        const body = prefix + usage + suffix;
        const masked = maskRawTextContent(body);
        const start = prefix.length;
        const end = start + usage.length;
        const spliced = spliceRawTextMask(body, masked, start, end, template, 0);
        if (spliced.masked === null) return;
        expect(spliced.masked).toBe(maskRawTextContent(prefix + template + suffix));
        expect(spliced.closedThrough).toBe(start);
      }),
      { numRuns: 5000 },
    );
  });

  it("accepts the common case of a script-bearing template between well-formed markup", () => {
    const prefix = "<!--bascik-source-file:p.html--><main><script>boot()</script><p>intro</p>";
    const usage = "<code-block data-bascik-prop-lang=\"js\"><pre>x</pre></code-block>";
    const template = "<!--bascik-source-file:c.html--><div><pre>x</pre><script>highlight()</script></div><!--bascik-source-file-end:c.html-->";
    const suffix = "<p>outro</p></main><!--bascik-source-file-end:p.html-->";
    const body = prefix + usage + suffix;
    const spliced = spliceRawTextMask(body, maskRawTextContent(body), prefix.length, prefix.length + usage.length, template, 0);
    expect(spliced.masked).toBe(maskRawTextContent(prefix + template + suffix));
    expect(spliced.closedThrough).toBe(prefix.length);
  });

  it("resumes the prefix check from a previously verified position", () => {
    const first = "<p>a</p><script>one()</script>";
    const second = "<p>b</p>";
    const usage = "<my-card></my-card>";
    const template = "<div><script>two()</script></div>";
    const body = first + second + usage;
    const start = first.length + second.length;
    const spliced = spliceRawTextMask(body, maskRawTextContent(body), start, body.length, template, first.length);
    expect(spliced.masked).toBe(maskRawTextContent(first + second + template));
  });

  it("falls back and stops trying when the prefix leaves a raw-text element open", () => {
    const prefix = "<script>unclosed ";
    const usage = "<my-card></my-card>";
    const template = "<div></script></div>";
    const body = prefix + usage;
    expect(spliceRawTextMask(body, maskRawTextContent(body), prefix.length, body.length, template, 0)).toEqual({ masked: null, closedThrough: -1 });
    expect(spliceRawTextMask(body, maskRawTextContent(body), prefix.length, body.length, "<p></p>", -1).masked).toBeNull();
  });

  it("falls back but keeps the verified prefix when the template leaves a raw-text element open", () => {
    const usage = "<my-card></my-card>";
    const template = "<div><style>.a{}";
    const suffix = "<p>after</p></style>";
    const body = usage + suffix;
    expect(spliceRawTextMask(body, maskRawTextContent(body), 0, usage.length, template, 0)).toEqual({ masked: null, closedThrough: 0 });
  });

  it("falls back when the verified position is past the splice start", () => {
    const body = "<p>a</p><my-card></my-card>";
    expect(spliceRawTextMask(body, maskRawTextContent(body), 8, body.length, "<div></div>", 9).masked).toBeNull();
  });
});
