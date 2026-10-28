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
  "<!--->",
  "<!---->",
  "--!>",
  "--",
  "<script>",
  "<SCRIPT type=module>",
  '<script data-a="x>y">',
  '<script a="',
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
  '"',
  "'",
  "<my-card>",
  "</my-card>",
  '<div class="a">',
  "</div>",
  "text",
  " ",
  "\n",
  "é",
  "\u0130",
);

const htmlArb = fc
  .array(fragment, { maxLength: 24 })
  .map((parts) => parts.join(""));

describe("maskRawTextContentWithClosure", () => {
  it("masks exactly like maskRawTextContent", () => {
    fc.assert(
      fc.property(htmlArb, (html) => {
        expect(maskRawTextContentWithClosure(html).masked).toBe(
          maskRawTextContent(html),
        );
      }),
      { numRuns: 3000 },
    );
  });

  it("reports closed only when the mask of any continuation splits at the boundary", () => {
    fc.assert(
      fc.property(htmlArb, htmlArb, (head, tail) => {
        const { masked, closed } = maskRawTextContentWithClosure(head);
        if (!closed) return;
        expect(maskRawTextContent(head + tail)).toBe(
          masked + maskRawTextContent(tail),
        );
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
      // A `<!--` inside a script is script text, as the tokenizer reads it,
      // so no later `-->` can reach back into it.
      "<script>const a = '<!--';</script><p>after</p>",
      "<!-- a --!><p>b</p><!--><!--->",
    ]) {
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(true);
    }
  });

  it("treats a dangling opener or a partial token at the end as open", () => {
    for (const html of [
      "<script>never closed",
      "<!-- never closed",
      '<p>a</p><script a="unterminated',
      "<style>",
      "<p>x</p><scr",
      "<p>x</p><!-",
      "<p>x</p><",
      "<p>x</p><textarea",
      // `<!--` then `<script` in a script is double-escaped script data,
      // where `</script>` does not end it.
      "<script>a('<!--<script></script>');",
    ]) {
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(false);
    }
  });
});

describe("comment masking on a run of unclosed comment openers", () => {
  // `<!--[\s\S]*?-->` retried from every `<!--` scans to the end each time:
  // quadratic, about 3 s for this input. Both maskers must stay linear.
  const html = "<!--".repeat(50_000);

  it("masks in linear time in maskRawTextContent", () => {
    const start = performance.now();
    expect(maskRawTextContent(html)).toBe(html);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it("masks and reports open in linear time in maskRawTextContentWithClosure", () => {
    const start = performance.now();
    expect(maskRawTextContentWithClosure(html)).toEqual({
      masked: html,
      closed: false,
    });
    expect(performance.now() - start).toBeLessThan(250);
  });

  it("still blanks the first complete comment after the run", () => {
    const run = "<!--".repeat(1000);
    expect(maskRawTextContent(`${run}x--><my-card>`)).toBe(
      `<!--${" ".repeat(run.length - 4 + 1)}--><my-card>`,
    );
  });
});

describe("spliceRawTextMask", () => {
  it("produces the full-page mask whenever it accepts a splice", () => {
    fc.assert(
      fc.property(
        htmlArb,
        htmlArb,
        htmlArb,
        htmlArb,
        (prefix, usage, template, suffix) => {
          const body = prefix + usage + suffix;
          const masked = maskRawTextContent(body);
          const start = prefix.length;
          const end = start + usage.length;
          const spliced = spliceRawTextMask(
            body,
            masked,
            start,
            end,
            template,
            0,
          );
          if (spliced.masked === null) return;
          expect(spliced.masked).toBe(
            maskRawTextContent(prefix + template + suffix),
          );
          expect(spliced.closedThrough).toBe(start);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it("accepts the common case of a script-bearing template between well-formed markup", () => {
    const prefix =
      "<!--bascik-source-file:p.html--><main><script>boot()</script><p>intro</p>";
    const usage =
      '<code-block data-bascik-prop-lang="js"><pre>x</pre></code-block>';
    const template =
      "<!--bascik-source-file:c.html--><div><pre>x</pre><script>highlight()</script></div><!--bascik-source-file-end:c.html-->";
    const suffix = "<p>outro</p></main><!--bascik-source-file-end:p.html-->";
    const body = prefix + usage + suffix;
    const spliced = spliceRawTextMask(
      body,
      maskRawTextContent(body),
      prefix.length,
      prefix.length + usage.length,
      template,
      0,
    );
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
    const spliced = spliceRawTextMask(
      body,
      maskRawTextContent(body),
      start,
      body.length,
      template,
      first.length,
    );
    expect(spliced.masked).toBe(maskRawTextContent(first + second + template));
  });

  it("falls back and stops trying when the prefix leaves a raw-text element open", () => {
    const prefix = "<script>unclosed ";
    const usage = "<my-card></my-card>";
    const template = "<div></script></div>";
    const body = prefix + usage;
    expect(
      spliceRawTextMask(
        body,
        maskRawTextContent(body),
        prefix.length,
        body.length,
        template,
        0,
      ),
    ).toEqual({ masked: null, closedThrough: -1 });
    expect(
      spliceRawTextMask(
        body,
        maskRawTextContent(body),
        prefix.length,
        body.length,
        "<p></p>",
        -1,
      ).masked,
    ).toBeNull();
  });

  it("falls back but keeps the verified prefix when the template leaves a raw-text element open", () => {
    const usage = "<my-card></my-card>";
    const template = "<div><style>.a{}";
    const suffix = "<p>after</p></style>";
    const body = usage + suffix;
    expect(
      spliceRawTextMask(
        body,
        maskRawTextContent(body),
        0,
        usage.length,
        template,
        0,
      ),
    ).toEqual({ masked: null, closedThrough: 0 });
  });

  // A prefix that ends in a lone `<` is closed for a continuation that does
  // not complete a tag or an opener with it. Rejecting every such prefix
  // re-masked the whole page after each instance: a slot holding
  // `<bare-card><` repeated cost a full mask per nested instance. (`<scr` or
  // `<!-` at the end is a tag already, inside which a `<!--` is no comment.)
  it("accepts a prefix ending in a lone < that the text after it does not complete", () => {
    for (const tail of ["<", "x <", "<p>x</p><", "<<"]) {
      const prefix = `<p>a</p>${tail}`;
      const usage = "<my-card></my-card>";
      const template =
        "<!--bascik-source-file:c.html--><div><script>x()</script></div><!--bascik-source-file-end:c.html-->";
      const suffix = "<p>after</p>";
      const body = prefix + usage + suffix;
      const spliced = spliceRawTextMask(
        body,
        maskRawTextContent(body),
        prefix.length,
        prefix.length + usage.length,
        template,
        0,
      );
      expect(spliced.masked, tail).toBe(
        maskRawTextContent(prefix + template + suffix),
      );
      expect(spliced.closedThrough, tail).toBe(prefix.length);
    }
  });

  it("falls back when the text after a partial opener completes it", () => {
    for (const [tail, usage, template] of [
      ["<", "<my-card></my-card>", "!-- c --><p>x</p>"],
      ["<scr", "<my-card></my-card>", "ipt>a</script>"],
      ["<!-", "<my-card></my-card>", "- c -->"],
      ["<", "<my-card></my-card>", "/p>"],
      ["<", "<my-card></my-card>", "?x>"],
      // `<` before a letter opens a tag, where a `<!--` is not a comment.
      ["<", "<my-card></my-card>", "b><!-- c -->"],
      // The usage completed it before: the old mask was not the prefix's.
      ["<scr", "ipt>a</script>", "<p>x</p>"],
      ["<", "a title='<!--'>", "<p>x</p>"],
    ]) {
      const prefix = `<p>a</p>${tail}`;
      const body = prefix + usage;
      const spliced = spliceRawTextMask(
        body,
        maskRawTextContent(body),
        prefix.length,
        body.length,
        template,
        0,
      );
      expect(spliced.masked, tail + template).toBeNull();
    }
  });

  it("falls back when the verified position is past the splice start", () => {
    const body = "<p>a</p><my-card></my-card>";
    expect(
      spliceRawTextMask(
        body,
        maskRawTextContent(body),
        8,
        body.length,
        "<div></div>",
        9,
      ).masked,
    ).toBeNull();
  });

  it("reports the end of the inserted text as closed, so a later sibling splice resumes there", () => {
    fc.assert(
      fc.property(
        fc.tuple(htmlArb, htmlArb, htmlArb, htmlArb, htmlArb, htmlArb),
        ([prefix, usageA, templateA, gap, usageB, templateB]) => {
          const body = prefix + usageA + gap + usageB;
          const startA = prefix.length;
          const first = spliceRawTextMask(
            body,
            maskRawTextContent(body),
            startA,
            startA + usageA.length,
            templateA,
            0,
          );
          if (first.masked === null) return;
          expect(first.closedEnd).toBe(startA + templateA.length);
          const afterA = prefix + templateA + gap + usageB;
          const startB = first.closedEnd! + gap.length;
          const second = spliceRawTextMask(
            afterA,
            first.masked,
            startB,
            startB + usageB.length,
            templateB,
            first.closedEnd!,
          );
          const fromStart = spliceRawTextMask(
            afterA,
            first.masked,
            startB,
            startB + usageB.length,
            templateB,
            first.closedThrough,
          );
          expect(second.masked).toBe(fromStart.masked);
          if (second.masked !== null)
            expect(second.masked).toBe(
              maskRawTextContent(prefix + templateA + gap + templateB),
            );
        },
      ),
      { numRuns: 5000 },
    );
  });
});
