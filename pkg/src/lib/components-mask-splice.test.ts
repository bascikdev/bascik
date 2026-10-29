import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
  spliceRawTextMask,
} from "./components.ts";
import type { MaskCheckpoint, MaskFacts } from "./component-masking.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";

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
  "</style/>",
  "</script x>",
  "</style\u000b>",
  "</textarea\u00a0>",
  '<p title="<script>">',
  "<p<style>",
  "<p ",
  "<!x",
  "<?",
  "</ ",
  "</",
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
  const COUNT = 50_000;
  const openers = (count: number) => "<!--".repeat(count);
  const html = openers(COUNT);

  it(
    "masks in linear time in maskRawTextContent",
    () => {
      expect(maskRawTextContent(html)).toBe(html);
      expectLinearTime(openers, COUNT, maskRawTextContent);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "masks and reports open in linear time in maskRawTextContentWithClosure",
    () => {
      expect(maskRawTextContentWithClosure(html)).toEqual({
        masked: html,
        closed: false,
      });
      expectLinearTime(openers, COUNT, maskRawTextContentWithClosure);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

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

  it("falls back when the template closes a raw-text element the prefix leaves open, keeping only a checkpoint before it", () => {
    const prefix = "<script>unclosed ";
    const usage = "<my-card></my-card>";
    const template = "<div></script></div>";
    const body = prefix + usage;
    const spliced = spliceRawTextMask(
      body,
      maskRawTextContent(body),
      prefix.length,
      body.length,
      template,
      0,
    );
    expect(spliced.masked).toBeNull();
    // The opener now has an element. The state at the splice still records
    // it as open: a later splice resumes there, finds a closer after it, and
    // falls back again, without reading the page from the start.
    expect(spliced.closedThrough).toBe(prefix.length);
    expect(spliced.checkpoint?.pending).toEqual({ script: 0 });
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
    ).toMatchObject({ masked: null, closedThrough: 0 });
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

  it("reports the state after the inserted text, so a later sibling splice resumes there", () => {
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
            first.endCheckpoint!,
          );
          const fromStart = spliceRawTextMask(
            afterA,
            first.masked,
            startB,
            startB + usageB.length,
            templateB,
            first.checkpoint,
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

// Fragments that leave the masker in every state at a splice: inside a tag
// (name, before a value, unquoted, single or double quoted), after a partial
// opener, after a raw-text opener with no element, after a comment that never
// ends, and the closers that end each.
const stateFragment = fc.constantFrom(
  "<a ",
  "<a b",
  "<a b=",
  "<a b=1 ",
  '<a b="',
  "<a b='",
  '"',
  "'",
  "=",
  ">",
  " ",
  "<",
  "<s",
  "<scr",
  "<!-",
  "<!--",
  "-->",
  "--!>",
  "--",
  "<script>",
  "</script>",
  "</scr",
  "ipt>",
  "<style>",
  "</style>",
  "<textarea>",
  "</textarea>",
  "<!--<script>",
  "<b title='<!--'>",
  '<i title="<script>">',
  "<x-p>",
  "<p>",
  "</p>",
  "x",
  // Look-alikes of raw-text openers and closers, closers with white space
  // (`\u00a0` is not tag white space, so `</STYLE\u00a0>` ends nothing),
  // closers with attributes, and runs of white space.
  "<style-box>",
  "</style-box>",
  "<script-x>",
  "</scriptx>",
  "</textareax",
  "</style ",
  "</STYLE\u00a0>",
  "</textarea\n",
  "</script",
  " ".repeat(40),
  "\t\n ".repeat(20),
  '<textarea a"b>',
  "</style x=",
  "</script/",
  "<p<style>",
  "<!x ",
  "</ ",
);
const stateHtml = fc
  .array(stateFragment, { maxLength: 16 })
  .map((parts) => parts.join(""));

describe("spliceRawTextMask resumes the masker's state at the splice", () => {
  const splice = (
    prefix: string,
    usage: string,
    template: string,
    suffix: string,
    from: Parameters<typeof spliceRawTextMask>[5] = 0,
    facts: MaskFacts = {},
  ) => {
    const body = prefix + usage + suffix;
    return spliceRawTextMask(
      body,
      maskRawTextContent(body),
      prefix.length,
      prefix.length + usage.length,
      template,
      from,
      facts,
    );
  };
  const template =
    '<!--bascik-source-file:x-p.html--><p class="p">v</p><!--bascik-source-file-end:x-p.html-->';

  // A usage cut mid-tag by a visitor's text (`<a ` before it): the prefix
  // ends inside a tag, where a `<!--` is not a comment. Re-masking the whole
  // page after each such splice was quadratic in the instance count.
  it.each([
    ["inside a tag name", "<s", "name"],
    ["after a partial raw-text opener", "<scr", "name"],
    // `<!-` before `<` is a bogus comment, up to the next `>`.
    ["after a partial comment opener", "<!-", "bogus"],
    ["between attributes", "<a ", "tag"],
    ["after an attribute name", "<a b", "tag"],
    ["after an unquoted value", "<a b=1 ", "tag"],
    ["after a `<` inside a tag", "<a <", "tag"],
  ])(
    "accepts a prefix that ends %s, and masks exactly as the whole page",
    (_where, cut, state) => {
      const prefix = `<p>a</p><!-- c -->${cut}`;
      const suffix = `xx<x-p>${cut}<b title='<!--'>t</b><!-- d --><script>s()</script>`;
      const spliced = splice(prefix, "<x-p>", template, suffix);
      expect(spliced.masked).toBe(
        maskRawTextContent(prefix + template + suffix),
      );
      expect(spliced.checkpoint).toMatchObject({
        at: prefix.length,
        tag: state,
      });
      expect(spliced.endCheckpoint).toMatchObject({
        at: prefix.length + template.length,
        tag: "text",
      });
    },
  );

  it("follows the text after the splice until the old and new tag states agree", () => {
    // The usage left the page in text, the template leaves a quoted value
    // open: the old mask after it holds from the closing quote on.
    const prefix = "<p>a</p>";
    const suffix = 'more"><!-- c --><p>b</p>';
    const spliced = splice(prefix, "<x-p>", '<b title="x', suffix);
    expect(spliced.masked).toBe(
      maskRawTextContent(prefix + '<b title="x' + suffix),
    );
    expect(spliced.endCheckpoint).toMatchObject({ tag: "quoted", quote: '"' });
  });

  it("falls back when a comment opener comes before the tag states agree", () => {
    // In the old page `<!-- c -->` is a comment; in the new one it is inside
    // a quoted value.
    const prefix = "<p>a</p>";
    const suffix = '<!-- c -->"><p>b</p>';
    const spliced = splice(prefix, "<x-p>", '<b title="x', suffix);
    expect(spliced.masked).toBeNull();
    expect(spliced.closedThrough).toBe(prefix.length);
  });

  it("falls back when a raw-text element starts before the tag states agree", () => {
    // Both readings agree right after `<script>`, but the old page reads
    // the element inside a tag and goes on reading the tag through it (into
    // the quoted value, where `<!-- c -->` is text), while the new one starts
    // over in text after the element (where it is a comment).
    const suffix = '<script><a b="</script><!-- c -->';
    const spliced = splice("", "<b ", "", suffix);
    expect(maskRawTextContent("<b " + suffix)).toContain("<!-- c -->");
    expect(maskRawTextContent(suffix)).not.toContain("<!-- c -->");
    expect(spliced.masked).toBeNull();
  });

  it.each([
    ["a script", "<script>"],
    ["a style", "<style type=x>"],
    ["a textarea", "<TEXTAREA>"],
    ["a comment", "<!--"],
  ])(
    "accepts splices after %s that never ends, and falls back once a template ends it",
    (_kind, opener) => {
      const prefix = `<p>a</p>${opener} text `;
      const suffix = "<x-p> more <x-p>";
      // The source-file comments around a template would end the comment.
      const plain = '<p class="p">v</p>';
      const spliced = splice(prefix, "<x-p>", plain, suffix);
      expect(spliced.masked).toBe(maskRawTextContent(prefix + plain + suffix));
      expect(Object.keys(spliced.checkpoint!.pending)).not.toHaveLength(0);
      const closer =
        opener === "<!--" ? "-->" : `</${/<(\w+)/.exec(opener)![1]}>`;
      const closing = splice(
        prefix,
        "<x-p>",
        `<p>${closer}x</p>`,
        suffix,
        0,
        {},
      );
      expect(closing.masked).toBeNull();
    },
  );

  // The closer rule the masker uses (`</style\s*>`, as element-content-scan
  // reads it) decides whether an opener with no element stays open. A
  // longer name only looks like a closer: `<style-box>` is a style opener to
  // the masker, and `</style-box>` ends nothing. Taking every `</style` for
  // a closer made every later splice fall back to a whole re-mask.
  it.each([
    ["<style-box>hi", " </style-box>"],
    ["<script-x>hi", " </script-x>"],
    ["<textarea-field>hi", " </textarea-field>"],
    ["<textarea>hi", " </textareax>"],
    ["<script>hi", " </scriptx> </script-x>"],
    ["<!--hi", " -- > -!>"],
  ])(
    "accepts a splice after %s when the closer that follows is only a look-alike (%s)",
    (opener, lookalike) => {
      const prefix = `<p>a</p>${opener} `;
      const suffix = `<x-p>${lookalike}<p>b</p>`;
      const plain = '<p class="p">v</p>';
      const spliced = splice(prefix, "<x-p>", plain, suffix);
      expect(spliced.masked).toBe(maskRawTextContent(prefix + plain + suffix));
    },
  );

  it.each([
    ["</style >"],
    ["</STYLE\n>"],
    ["</style/>"],
    ['</style x="1">'],
    ["</style\t\f\r >"],
  ])(
    "falls back when a real closer (%j) follows an opener with no element before it",
    (closer) => {
      // `<style a"b>` is no element in the old page: no `"` ends its value.
      const prefix = '<p>a</p><style a"b> ';
      const suffix = `<x-p> ${closer}<p>b</p>`;
      expect(
        splice(prefix, "<x-p>", '<p class="p">v</p>', suffix).masked,
      ).toBeNull();
    },
  );

  it.each([["</style\u00a0>"], ["</style\u000b>"], ["</stylex>"]])(
    "accepts the splice when only an end tag of another name (%j) follows an opener with no element",
    (closer) => {
      const prefix = '<p>a</p><style a"b> ';
      const suffix = `<x-p> ${closer}<p>b</p>`;
      const plain = '<p class="p">v</p>';
      expect(splice(prefix, "<x-p>", plain, suffix).masked).toBe(
        maskRawTextContent(prefix + plain + suffix),
      );
    },
  );

  // A closer is `</style`, tag white space or `/`, anything but `>`, and
  // `>` (or `</style>`): a splice can
  // complete one whose name is far before it, or whose `>` is far after it.
  it.each([10, 3000, 5000])(
    "sees a closer the splice completes across %i characters of white space",
    (spaces) => {
      const run = " ".repeat(spaces);
      const cases: Array<[string, string, string, string]> = [
        // The `>` comes in at the splice, after `</style` and the run.
        ["<p><style>a </style" + run, "<x-p>", ">b", "<p>c</p>"],
        // The template ends in `</style`, the run and `>` follow it.
        ["<p><style>a ", "<x-p>", "</style", run + ">b<p>c</p>"],
        // The template is part of the run.
        ["<p><style>a </style ", "<x-p>", run, " >b"],
        // Attributes after the name: the `>` comes in at the splice.
        ["<p><style>a </style x=" + run, "<x-p>", ">b", "<p>c</p>"],
        ["<p><style>a </style/" + run, "<x-p>", "y>b", "<p>c</p>"],
      ];
      for (const [prefix, usage, inserted, suffix] of cases) {
        const spliced = splice(prefix, usage, inserted, suffix);
        if (spliced.masked !== null)
          expect(spliced.masked).toBe(
            maskRawTextContent(prefix + inserted + suffix),
          );
        expect(maskRawTextContent(prefix + inserted + suffix)).not.toBe(
          prefix + inserted + suffix,
        );
      }
    },
  );

  it("after falling back on an opener a later closer ends, keeps the state at the splice, so the next splice reads only the text since", () => {
    const prefix = `<p>a</p><textarea a"b>${"t".repeat(10_000)}`;
    const suffix = "<x-q> more <x-q></textarea>";
    const body = prefix + "<x-q>" + suffix;
    const facts: MaskFacts = {};
    const first = spliceRawTextMask(
      body,
      maskRawTextContent(body),
      prefix.length,
      prefix.length + 5,
      "<i>v</i>",
      0,
      facts,
    );
    expect(first.masked).toBeNull();
    expect(first.checkpoint).toMatchObject({
      at: prefix.length,
      pending: { textarea: 8 },
    });
    const next = prefix + "<i>v</i>" + suffix;
    const start = next.indexOf("<x-q>", prefix.length);
    __componentScanStatsForTests.reset();
    const second = spliceRawTextMask(
      next,
      maskRawTextContent(next),
      start,
      start + 5,
      "<i>v</i>",
      first.checkpoint,
      facts,
    );
    expect(second.masked).toBeNull();
    expect(second.checkpoint?.at).toBe(start);
    expect(__componentScanStatsForTests.closureBytesChecked).toBeLessThan(100);
  });

  it("misuse: a checkpoint past the splice, or none, falls back without reading the page", () => {
    expect(splice("<p>a</p>", "<x-p>", template, "", 9).masked).toBeNull();
    expect(splice("<p>a</p>", "<x-p>", template, "", null).masked).toBeNull();
  });

  it("produces the full-page mask whenever it accepts a splice, from any state", () => {
    fc.assert(
      fc.property(
        stateHtml,
        stateHtml,
        stateHtml,
        stateHtml,
        (prefix, usage, inserted, suffix) => {
          const spliced = splice(prefix, usage, inserted, suffix);
          if (spliced.masked === null) return;
          expect(spliced.masked).toBe(
            maskRawTextContent(prefix + inserted + suffix),
          );
        },
      ),
      { numRuns: 5000 },
    );
  });

  it("keeps every checkpoint it returns valid through a chain of splices, like the expansion loop", () => {
    fc.assert(
      fc.property(
        stateHtml,
        fc.array(fc.tuple(fc.nat(), fc.nat({ max: 12 }), stateHtml), {
          minLength: 1,
          maxLength: 6,
        }),
        (initial, steps) => {
          let body = initial;
          let masked = maskRawTextContent(body);
          let from: MaskCheckpoint | null = null;
          let fromEnd: MaskCheckpoint | null = null;
          const facts: MaskFacts = {};
          let last = 0;
          for (const [offset, length, inserted] of steps) {
            const start = last + (offset % (body.length - last + 1));
            const end = Math.min(body.length, start + length);
            const spliced = spliceRawTextMask(
              body,
              masked,
              start,
              end,
              inserted,
              fromEnd && start >= fromEnd.at ? fromEnd : (from ?? 0),
              facts,
            );
            body = body.slice(0, start) + inserted + body.slice(end);
            masked = maskRawTextContent(body);
            if (spliced.masked !== null) expect(spliced.masked).toBe(masked);
            from = spliced.checkpoint;
            fromEnd = spliced.endCheckpoint ?? null;
            last = start;
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
