/**
 * Tag names end where a browser ends them (2026-10-29). The HTML tokenizer
 * reads a tag name until tag whitespace (`\t\n\f\r `), `/` or `>`, so
 * `<style-guide>` is an ordinary custom element, not a stylesheet, and
 * `<my-card.foo>` and `<my-card</p>` are the tags `my-card.foo` and
 * `my-card<`, not `my-card`.
 *
 * The compiler used to match a raw-text opener by word boundary (so
 * `<style-guide>` hid every component tag after it up to a later `</style>`)
 * and a component name as the longest name ending at any character outside
 * `[\w:-]`, or at a `:` (so `<my-card.foo>`, `<my-card</p>` and `<my-card:x>`
 * were expanded as `my-card`). Neither spelling is documented as a feature.
 *
 * Each case is checked against parse5, a spec-compliant parser: the compiler
 * expands a component exactly where the browser builds that element.
 */
import { describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./component-masking.ts";
import {
  createMatchingCloseFinder,
  getFirstComponent,
  getTag,
  mayContainComponent,
  replaceTag,
} from "./component-tags.ts";
import { maskElementContents, shieldElementContents } from "./shielding.ts";
import {
  computePageCspHashes,
  __cspRegexFallbackForTests,
} from "./csp-hashes.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
  repeatTo,
} from "./linear-time.test-helper.ts";
import { transformTypeScriptScriptTags } from "./typescript.ts";
import type { ComponentList } from "./types.ts";

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

const list = {
  "my-card": { fileContent: "<div>CARD</div>" },
  a: { fileContent: "A" },
  "a:b": { fileContent: "AB" },
} as unknown as ComponentList;

/** Every component usage the compiler finds, `[start, name]`, as the expansion loop searches. */
const compilerUsages = (html: string): Array<[number, string]> => {
  const masked = maskRawTextContent(html);
  const found: Array<[number, string]> = [];
  for (let from = 0; ;) {
    const usage = getFirstComponent(html, list, masked, from);
    if (usage.name === undefined || usage.index === undefined) return found;
    found.push([usage.index, usage.name]);
    from = usage.index + 1;
  }
};

const SIZE = 200_000;

describe("a raw-text element opens only for its exact tag name", () => {
  // Component tags after each of these are live markup: the opener is a
  // custom element (or an unknown tag) whose name only starts with a raw-text
  // name, and a later real closer does not make it one.
  const visible = [
    `<style-guide></style-guide><my-card></my-card><style>.a{}</style>`,
    `<style-guide><my-card></my-card></style-guide><p></style></p>`,
    `<script-loader></script-loader><my-card></my-card><script>x</script>`,
    `<textarea-field></textarea-field><my-card></my-card><textarea>t</textarea>`,
    `<STYLE-Guide></STYLE-Guide><my-card></my-card></style>`,
    `<style.x><my-card></my-card></style>`,
    `<style:x><my-card></my-card></style>`,
    `<script x><my-card></my-card></script>`,
    `<textarea_x><my-card></my-card></textarea>`,
    `<style"x"><my-card></my-card></style>`,
  ];

  it.each(visible)("finds the component in %j, as parse5 does", (html) => {
    expect(parsedElementNames(html)).toContain("my-card");
    expect(maskRawTextContent(html)).toContain("<my-card></my-card>");
    expect(compilerUsages(html).map(([, name]) => name)).toEqual(["my-card"]);
    expect(replaceTag(html, "my-card", "X")).toBe(
      html.replace("<my-card></my-card>", "X"),
    );
  });

  // The exact name followed by tag whitespace, `/` or `>` opens one, in any case.
  const hidden = [
    `<style><my-card></my-card></style>`,
    `<style\t><my-card></my-card></style>`,
    `<style\nmedia="x"><my-card></my-card></style>`,
    `<style\f><my-card></my-card></style>`,
    `<style\r><my-card></my-card></style>`,
    `<STYLE/><my-card></my-card></STYLE>`,
    `<script type="module"><my-card></my-card></script>`,
    `<Script><my-card></my-card></script>`,
    `<textarea name=a><my-card></my-card></textarea>`,
  ];

  it.each(hidden)("hides the component in %j, as parse5 does", (html) => {
    expect(parsedElementNames(html)).not.toContain("my-card");
    expect(maskRawTextContent(html)).not.toContain("my-card");
    expect(compilerUsages(html)).toEqual([]);
    expect(replaceTag(html, "my-card", "X")).toBe(html);
  });

  it("reports text ending in a custom element named like a raw-text tag as closed", () => {
    // Nothing is left open: no later `</style>` can turn `<style-guide>` into
    // a stylesheet, so its mask can be reused as a prefix.
    for (const html of [
      "<style-guide></style-guide>",
      "<script-loader>",
      "<textarea-field>",
      "<style.x>",
    ])
      expect(maskRawTextContentWithClosure(html), html).toEqual({
        masked: html,
        closed: true,
      });
    // The exact name still is open until its closer, and a name cut off at
    // the end could still become one.
    for (const html of ["<style>", "<script x>", "<textarea/>", "<style"])
      expect(maskRawTextContentWithClosure(html).closed, html).toBe(false);
  });

  it("masks and shields only real raw-text elements in maskElementContents and shieldElementContents", () => {
    const html = `<style-guide>a</style><style>b</style>`;
    expect(maskElementContents(html, ["style"])).toBe(
      `<style-guide>a</style><style> </style>`,
    );
    const shielded = shieldElementContents(html, ["style"]);
    expect(shielded.html).toContain("<style-guide>a</style>");
    expect(shielded.html).not.toContain("<style>b</style>");
    expect(shielded.restore(shielded.html)).toBe(html);
  });

  it("hashes the real script after a custom element named like one in the CSP fallback scan", () => {
    // The fallback read `<script-loader>` as a script whose body ran to the
    // real script's `</script>`, and never hashed the real script's body.
    const html = `<script-loader>x</script-loader><script>run()</script>`;
    const fallback = __cspRegexFallbackForTests(html);
    expect(fallback.scripts).toEqual(
      new Set(computePageCspHashes(`<script>run()</script>`).scripts),
    );
  });
});

describe("other scans read a script tag by its whole name", () => {
  it("does not strip TypeScript from a custom element whose name starts with script", async () => {
    // `<script.x>` is its own element; the walk read it as a script, and its
    // body as TypeScript to strip.
    const html = `<script.x type="text/typescript">let a: number = 1;</script><p>a</p>`;
    expect(await transformTypeScriptScriptTags(html, "page.html")).toBe(html);
    const real = `<script type="text/typescript">let a: number = 1;</script>`;
    expect(
      await transformTypeScriptScriptTags(real, "page.html"),
    ).not.toContain(": number");
  });
});

describe("a component tag matches only when its name is the whole tag name", () => {
  const notComponents: Array<[string, string]> = [
    ["a name followed by a dot", "<my-card.foo></my-card.foo>"],
    ["a name followed by another tag's <", "<p><my-card</p>"],
    ["a name followed by a colon", "<my-card:x></my-card:x>"],
    ["a name followed by a no-break space", "<my-card x></my-card>"],
    ["a name followed by a quote", `<my-card"x"></my-card>`],
    ["a name followed by =", "<my-card=1></my-card>"],
    ["a longer name", "<my-card-list></my-card-list>"],
  ];

  it.each(notComponents)(
    "does not expand %s, as parse5 builds no my-card",
    (_label, html) => {
      expect(parsedElementNames(html)).not.toContain("my-card");
      expect(compilerUsages(html)).toEqual([]);
      expect(mayContainComponent(html, list)).toBe(false);
      expect(getTag(html, "my-card")).toEqual({});
      expect(replaceTag(html, "my-card", "X")).toBe(html);
    },
  );

  const components: Array<[string, string]> = [
    ["a bare tag", "<my-card></my-card>"],
    ["a self-closing tag", "<my-card/>"],
    ["a space before >", "<my-card ></my-card>"],
    ["a tab before an attribute", `<my-card\tclass="a"></my-card>`],
    ["a newline before an attribute", "<my-card\nclass></my-card>"],
    ["a form feed", "<my-card\f></my-card>"],
    ["a carriage return", "<my-card\r></my-card>"],
    ["upper case", "<MY-CARD></MY-CARD>"],
  ];

  it.each(components)(
    "expands %s, as parse5 builds my-card",
    (_label, html) => {
      expect(parsedElementNames(html)).toContain("my-card");
      expect(compilerUsages(html)).toEqual([[0, "my-card"]]);
      expect(mayContainComponent(html, list)).toBe(true);
      expect(getTag(html, "my-card").startIndex).toBe(0);
      expect(replaceTag(html, "my-card", "X")).toBe("X");
    },
  );

  it("reads a name with a colon as one whole name, never as a shorter one before the colon", () => {
    expect(getFirstComponent("<a:b></a:b>", list).name).toBe("a:b");
    expect(compilerUsages("<a:c></a>")).toEqual([]);
    expect(compilerUsages("<a:b:c></a:b:c>")).toEqual([]);
  });

  it("does not count a longer tag name toward the nesting depth of a component", () => {
    // parse5: `<my-card:x>` is a child element of `my-card`, and the first
    // `</my-card>` closes the outer card.
    const html = "<my-card>a<my-card:x>b</my-card>c";
    const tag = getTag(html, "my-card");
    expect(tag.innerContent).toBe("a<my-card:x>b");
    const masked = maskRawTextContent(html);
    expect(createMatchingCloseFinder(html, masked)("my-card", 9)).toBe(
      html.indexOf("</my-card>"),
    );
    expect(
      getTag("<my-card>a<my-card.x>b</my-card>c", "my-card").innerContent,
    ).toBe("a<my-card.x>b");
  });

  it("finds the real usage after a look-alike in the same text", () => {
    const html =
      "<my-card.foo>x</my-card.foo><p><my-card</p><my-card>y</my-card>";
    const start = html.lastIndexOf("<my-card>");
    expect(compilerUsages(html)).toEqual([[start, "my-card"]]);
    expect(replaceTag(html, "my-card", "X")).toBe(html.slice(0, start) + "X");
  });
});

describe("the browser tag-name rule keeps every scan linear", () => {
  const hostile: Array<[string, (size: number) => string]> = [
    ["<style-a repeated", (size) => repeatTo("<style-a", size)],
    [
      "<style-guide> repeated before a </style>",
      (size) => `${repeatTo("<style-guide>", size)}</style>`,
    ],
    ["<script-x '> repeated", (size) => repeatTo("<script-x '>", size)],
    ["<textarea. repeated", (size) => repeatTo("<textarea.", size)],
    ["<my-card. repeated", (size) => repeatTo("<my-card.", size)],
    [
      "<my-card: repeated before a >",
      (size) => `${repeatTo("<my-card:", size)}>`,
    ],
    ["<a:b:a:b repeated", (size) => `<${repeatTo("a:b:", size)}>`],
    ["<my-card</p> repeated", (size) => repeatTo("<my-card</p>", size)],
  ];

  it.each(hostile)(
    "masks and searches %s in linear time",
    (_label, input) => {
      expect(maskRawTextContent(input(SIZE))).toHaveLength(input(SIZE).length);
      expectLinearTime(input, SIZE, maskRawTextContentWithClosure, {
        label: "mask",
      });
      expectLinearTime(input, SIZE, compilerUsages, { label: "usages" });
      expectLinearTime(
        input,
        SIZE,
        (html) => replaceTag(html, "my-card", "X"),
        { label: "replaceTag" },
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

/**
 * Tags as the tokenizer reads them around a name (2026-10-29, second pass).
 *
 * - A `<script>`, `<style>` or `<textarea>` written inside another tag (an
 *   attribute value, an attribute name, or the tag's own name, as in
 *   `<p<style>`) opens nothing: the browser reads it as part of that tag.
 *   The masker used to open an element there anyway, and blanked the tag's
 *   closing quote with it, so a page with a later real `</script>` lost its
 *   whole body.
 * - A raw-text element or a component ends at `</name` followed by tag
 *   whitespace, `/` or `>`, and then anything up to `>` (`</style/>`,
 *   `</style foo>`). `</style\v>`, `</style >` and `</style﻿>` are
 *   end tags of other names. The closer used to be `</name\s*>`.
 * - A component name inside another tag (`<p<my-card>`, `</p <my-card>`) or
 *   inside a bogus comment (`<!x`, `<?`, `</` and a non-letter, up to `>`)
 *   is part of that tag or comment, not a usage.
 */
describe("a raw-text opener inside another tag opens nothing", () => {
  const visible: Array<[string, string]> = [
    [
      "a double-quoted attribute value",
      `<p title="Add a <script> tag">tip</p><my-card></my-card><script>console.log(1)</script>`,
    ],
    [
      "a style opener in an attribute value",
      `<p title="<style>">tip</p><my-card></my-card><style>.a{}</style>`,
    ],
    [
      "a single-quoted attribute value",
      `<p title='<script>'>tip</p><my-card></my-card><script>x()</script>`,
    ],
    [
      "an unquoted attribute value",
      `<p title=<style>>tip</p><my-card></my-card><style>.a{}</style>`,
    ],
    [
      "a textarea opener in a data attribute",
      `<p data-x="<textarea>">tip</p><my-card></my-card><textarea>t</textarea>`,
    ],
    [
      "an attribute name",
      `<div <style>></div><my-card></my-card><style>.a{}</style>`,
    ],
    [
      "an attribute name after a slash",
      `<div/<style>></div><my-card></my-card><style>.a{}</style>`,
    ],
    [
      "the attribute of the element around the card",
      `<div title="<style>"><my-card></my-card></div><style></style>`,
    ],
    ["another tag's name", `<p<style>x<my-card></my-card><style>.a{}</style>`],
    [
      "another tag's name with the card inside",
      `<p<style><my-card></my-card></style>`,
    ],
    [
      "an end tag's attribute",
      `</p <style>><my-card></my-card><style>.a{}</style>`,
    ],
    ["a bogus comment", `<!x <style>><my-card></my-card><style>.a{}</style>`],
  ];

  it.each(visible)(
    "finds the component after %s, as parse5 does",
    (_label, html) => {
      expect(parsedElementNames(html)).toContain("my-card");
      expect(maskRawTextContent(html)).toContain("<my-card></my-card>");
      expect(compilerUsages(html).map(([, name]) => name)).toEqual(["my-card"]);
      expect(replaceTag(html, "my-card", "X")).toBe(
        html.replace("<my-card></my-card>", "X"),
      );
    },
  );

  it("still masks the real raw-text element that follows", () => {
    const html = `<p title="<script>">tip</p><script><my-card></my-card></script>`;
    expect(parsedElementNames(html)).not.toContain("my-card");
    expect(maskRawTextContent(html)).toBe(
      `<p title="<script>">tip</p><script>${" ".repeat(19)}</script>`,
    );
    expect(compilerUsages(html)).toEqual([]);
  });

  it("keeps a page's body when an attribute names a raw-text tag and a real one follows", () => {
    for (const body of [
      `<p title="Add a <script> tag">tip</p><my-card></my-card><script>console.log(1)</script>`,
      `<p title="<style>">tip</p><p>x</p><style>.a{}</style>`,
    ]) {
      const html = `<html><body>${body}</body></html>`;
      expect(maskRawTextContent(html), html).toContain('">tip</p>');
      expect(getTag(html, "body").innerContent, html).toBe(body);
    }
  });

  it("does not hide components inside the tag's own quote after a later comment", () => {
    // The `<!--` is inside the attribute value too, and so is not a comment.
    const html = `<p title="<style><!--">x</p><my-card></my-card><style>--></style>`;
    expect(parsedElementNames(html)).toContain("my-card");
    expect(compilerUsages(html).map(([, name]) => name)).toEqual(["my-card"]);
  });
});

describe("a raw-text element ends where the browser ends it", () => {
  const tags = ["script", "style", "textarea"];
  const ends = (tag: string): string[] => [
    `</${tag}/>`,
    `</${tag} foo>`,
    `</${tag} x=1>`,
    `</${tag}\t>`,
    `</${tag} >`,
    `</${tag.toUpperCase()}/ >`,
  ];
  const notEnds = (tag: string): string[] => [
    `</${tag}\u000b>`,
    `</${tag} >`,
    `</${tag} >`,
    `</${tag}﻿>`,
    `</${tag}x>`,
    `</${tag}->`,
  ];

  for (const tag of tags) {
    it.each(ends(tag))(`ends a ${tag} at %j, as parse5 does`, (closer) => {
      const html = `<${tag}>${closer}<my-card></my-card></${tag}>`;
      expect(parsedElementNames(html)).toContain("my-card");
      expect(maskRawTextContent(html)).toContain("<my-card></my-card>");
      expect(compilerUsages(html)).toEqual([
        [tag.length + 2 + closer.length, "my-card"],
      ]);
    });

    it.each(notEnds(tag))(
      `does not end a ${tag} at %j, as parse5 does`,
      (closer) => {
        const html = `<${tag}>${closer}<my-card></my-card></${tag}>`;
        expect(parsedElementNames(html)).not.toContain("my-card");
        expect(maskRawTextContent(html)).not.toContain("my-card");
        expect(compilerUsages(html)).toEqual([]);
      },
    );
  }

  it("reports the end of a closer with attributes as its first >", () => {
    const html = `<style>a</style foo>b`;
    expect(maskRawTextContent(html)).toBe(`<style> </style foo>b`);
    expect(maskRawTextContentWithClosure(html).closed).toBe(true);
  });
});

describe("a component ends where the browser ends it", () => {
  const closes = [
    "</my-card foo>",
    "</my-card/>",
    "</my-card\t>",
    "</MY-CARD x=1>",
  ];
  it.each(closes)("pairs the usage with %j, as parse5 does", (close) => {
    const html = `<my-card>a</my-card>`.replace("</my-card>", close) + "b";
    // parse5 closes my-card at the close: `b` is its sibling.
    const fragment = parseFragment(html);
    const card = fragment.childNodes[0] as DefaultTreeAdapterTypes.Element;
    expect(card.tagName).toBe("my-card");
    expect(card.childNodes).toHaveLength(1);
    expect(replaceTag(html, "my-card", "X")).toBe("Xb");
    const tag = getTag(html, "my-card");
    expect(tag.innerContent).toBe("a");
    expect(tag.endIndex).toBe(html.length - 1);
    const masked = maskRawTextContent(html);
    expect(createMatchingCloseFinder(html, masked)("my-card", 9)).toBe(10);
  });

  const notCloses = ["</my-card\u000b>", "</my-card >", "</my-card﻿>"];
  it.each(notCloses)(
    "does not pair the usage with %j, as parse5 does not",
    (close) => {
      const html = `<my-card>a${close}b`;
      const card = parseFragment(html)
        .childNodes[0] as DefaultTreeAdapterTypes.Element;
      expect(card.childNodes).toHaveLength(1); // `ab`: the end tag is ignored
      expect(getTag(html, "my-card").closeIndex).toBe(-1);
      expect(
        createMatchingCloseFinder(html, maskRawTextContent(html))("my-card", 9),
      ).toBe(-1);
    },
  );

  it("counts a close with attributes toward the nesting depth", () => {
    const html = "<my-card>a<my-card>b</my-card x>c</my-card/>d";
    const tag = getTag(html, "my-card");
    expect(tag.innerContent).toBe("a<my-card>b</my-card x>c");
    expect(replaceTag(html, "my-card", "X")).toBe("Xd");
  });

  it("expands nested components closed with attributes in a whole page", () => {
    const html = "<my-card>a</my-card foo><p>b</p><my-card></my-card/>";
    const masked = maskRawTextContent(html);
    expect(compilerUsages(html)).toEqual([
      [0, "my-card"],
      [html.lastIndexOf("<my-card>"), "my-card"],
    ]);
    expect(masked).toBe(html);
  });
});

describe("a component name inside another tag or a bogus comment is no usage", () => {
  const notUsages: Array<[string, string]> = [
    ["another tag's name", "<p<my-card></my-card>"],
    ["an unknown tag's name", "<e<my-card>"],
    ["a bogus comment opened by <!", "<!<my-card>"],
    ["a bogus comment opened by <?", "<?<my-card>"],
    ["a bogus comment opened by </ and a non-letter", "</<my-card>"],
    ["an end tag's attribute", "</p <my-card>"],
    ["an attribute name", "<p <my-card>>"],
    ["an attribute name after another", "<p a <my-card>>"],
  ];

  it.each(notUsages)(
    "does not expand a name in %s, as parse5 builds none",
    (_label, html) => {
      expect(parsedElementNames(html)).not.toContain("my-card");
      expect(compilerUsages(html)).toEqual([]);
      expect(replaceTag(html, "my-card", "X")).toBe(html);
    },
  );

  it("finds the real usage after the tag or bogus comment ends", () => {
    for (const html of [
      "<p<my-card><my-card></my-card>",
      "<!x<my-card><my-card></my-card>",
      `<!x="><my-card></my-card>`,
      "</ <my-card>><my-card></my-card>",
      // `=` and quotes in a tag name start no attribute value: the tag is
      // `x="`, and its `>` ends it.
      `<x="><my-card></my-card>`,
      `<x='a><p title="b"><my-card></my-card>`,
    ]) {
      const start = html.lastIndexOf("<my-card>");
      expect(parsedElementNames(html), html).toContain("my-card");
      expect(compilerUsages(html), html).toEqual([[start, "my-card"]]);
    }
  });

  it("keeps an unclosed comment from hiding later components, as before", () => {
    // An HTML comment with no end hides the rest of the document in a
    // browser; the compiler leaves it as text (masking.ts), so the tag after
    // it is still expanded, as it always was.
    expect(compilerUsages("<!--<my-card></my-card>")).toEqual([[4, "my-card"]]);
  });
});

describe("elements other than script, style and textarea", () => {
  // Documented in docs/content/internals/transpilation-pipeline.md: the
  // compiler masks only script, style and textarea content.
  it.each(["title", "noscript", "xmp", "iframe", "noembed", "noframes"])(
    "expands a component inside <%s>, which the compiler reads as markup",
    (tag) => {
      const html = `<${tag}><my-card></my-card></${tag}>`;
      expect(compilerUsages(html)).toEqual([[tag.length + 2, "my-card"]]);
    },
  );

  it("expands a component after <plaintext>, which has no end", () => {
    expect(compilerUsages("<plaintext><my-card></my-card>")).toEqual([
      [11, "my-card"],
    ]);
  });

  it("masks a style inside SVG, as it masks every style", () => {
    const html = "<svg><style><my-card></my-card></style></svg>";
    expect(compilerUsages(html)).toEqual([]);
  });
});

describe("the tag-boundary rules keep every scan linear", () => {
  const hostile: Array<[string, (size: number) => string]> = [
    [
      `<p title="<script>"> repeated before a </script>`,
      (size) => `${repeatTo(`<p title="<script>">`, size)}</script>`,
    ],
    [
      "<p<style> repeated before a </style>",
      (size) => `${repeatTo("<p<style>", size)}</style>`,
    ],
    [
      "<style></style  repeated with no >",
      (size) => `<style>${repeatTo("</style ", size)}`,
    ],
    [
      "<script></script/ repeated with no >",
      (size) => `<script>${repeatTo("</script/", size)}`,
    ],
    [
      "<my-card></my-card  repeated with no >",
      (size) => `<my-card>${repeatTo("</my-card ", size)}`,
    ],
    ["<!x repeated", (size) => repeatTo("<!x", size)],
    ["</ <my-card repeated", (size) => `${repeatTo("</ <my-card", size)}>`],
    ["<?<my-card> repeated", (size) => repeatTo("<?<my-card>", size)],
  ];

  it.each(hostile)(
    "masks and searches %s in linear time",
    (_label, input) => {
      expect(maskRawTextContent(input(SIZE))).toHaveLength(input(SIZE).length);
      expectLinearTime(input, SIZE, maskRawTextContentWithClosure, {
        label: "mask",
      });
      expectLinearTime(input, SIZE, compilerUsages, { label: "usages" });
      expectLinearTime(
        input,
        SIZE,
        (html) => replaceTag(html, "my-card", "X"),
        { label: "replaceTag" },
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "pairs every usage with a close that has attributes in linear time",
    () => {
      const input = (size: number) => repeatTo("<my-card>a</my-card x>", size);
      expectLinearTime(input, SIZE, (html) => {
        const find = createMatchingCloseFinder(html, html);
        let closes = 0;
        for (
          let at = html.indexOf("<my-card>");
          at !== -1;
          at = html.indexOf("<my-card>", at + 1)
        )
          if (find("my-card", at + 9) !== -1) closes++;
        return closes;
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
