import { describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./component-masking.ts";
import { maskElementContents, shieldElementContents } from "./shielding.ts";
import { replaceTag } from "./component-tags.ts";

// Since request-time component rendering, server and stream output (which can
// echo user input such as `?q=`) is masked on every request, so masking time
// must stay linear in the input: a super-linear masker is a per-request
// denial of service. The old `(<tag(?:\b(?:[^>"']|"[^"]*"|'[^']*')*)?>)
// ([\s\S]*?)(<\/tag\s*>)` regex scanned to the end of the input from every
// opener with no closer, and from every opener with an unclosed quote.
// Measured on it at 100k characters: `<script '` and `<script x` repeated
// took about 2.5 s to mask or shield, and `<script>` repeated about 0.3 s
// (four times that at the 200k used here). The bound is generous for a
// linear scan and far below those.

const SIZE = 200_000;
const BOUND_MS = 250;

const repeatTo = (unit: string, size = SIZE): string =>
  unit.repeat(Math.ceil(size / unit.length));

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};

// Openers that never find a closer, for every raw-text tag in mixed case: a
// complete opener, one cut off before `>`, one with an unclosed quote of each
// kind, and one whose quoted value hides the `>`.
const worstCases = ["script", "style", "textarea"].flatMap((tag) =>
  [tag, tag.toUpperCase(), tag[0].toUpperCase() + tag.slice(1)].flatMap(
    (name) => [
      `<${name}>`,
      `<${name} x`,
      `<${name} '`,
      `<${name} "`,
      `<${name} a="1>`,
      `<${name} a='>' `,
      `<${name}></${name}`,
      `<${name}></${name} x>`,
    ],
  ),
);

describe("raw-text masking time on hostile input", () => {
  it.each(worstCases)(
    "maskRawTextContent masks %j repeated to 200k characters in linear time",
    (unit) => {
      const html = repeatTo(unit);
      const { value, ms } = timed(() => maskRawTextContent(html));
      expect(value).toHaveLength(html.length);
      expect(ms).toBeLessThan(BOUND_MS);
    },
  );

  it.each(worstCases)(
    "maskRawTextContentWithClosure masks %j repeated in linear time and reports it open",
    (unit) => {
      const html = repeatTo(unit);
      const { value, ms } = timed(() => maskRawTextContentWithClosure(html));
      expect(value.closed).toBe(false);
      expect(ms).toBeLessThan(BOUND_MS);
    },
  );

  it.each(worstCases)(
    "maskElementContents and shieldElementContents scan %j repeated in linear time",
    (unit) => {
      const html = repeatTo(unit);
      const tags = ["script", "style", "textarea"];
      const masked = timed(() => maskElementContents(html, tags));
      expect(masked.value).toHaveLength(html.length);
      expect(masked.ms).toBeLessThan(BOUND_MS);
      const shielded = timed(() => shieldElementContents(html, tags));
      expect(shielded.value.restore(shielded.value.html)).toBe(html);
      expect(shielded.ms).toBeLessThan(BOUND_MS);
    },
  );

  it("still masks a complete element after a long run of openers with no closer", () => {
    const run = repeatTo("<script '", 50_000);
    const html = `${run}'><my-card></my-card></script><my-card>`;
    // Quotes pair up in order, so the first or second opener's attributes
    // run to the `>` after the last quote and its content to the `</script>`.
    const { value, ms } = timed(() => maskRawTextContent(html));
    expect(value).toBe(
      `${run}'>${" ".repeat("<my-card></my-card>".length)}</script><my-card>`,
    );
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

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

  it("masks hostile runs of script escapes in linear time", () => {
    for (const html of [
      `${repeatTo("<script><!--<script>", SIZE / 2)}${repeatTo("</script><script>", SIZE / 2)}`,
      repeatTo("<script x<!--"),
      repeatTo("<script><!--"),
      `${repeatTo("<script><!--<script>", SIZE / 2)}${repeatTo("-->", SIZE / 2)}`,
      `<!--${repeatTo("<script>")}`,
      repeatTo("<style><!--</style "),
    ]) {
      const { value, ms } = timed(() => maskRawTextContentWithClosure(html));
      expect(value.masked).toHaveLength(html.length);
      expect(ms, html.slice(0, 40)).toBeLessThan(BOUND_MS);
    }
  });
});
