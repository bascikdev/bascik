import { describe, expect, it } from "vitest";
import { mermaidFence, safeSvg, spaceArrows } from "./mermaid.ts";
import { createRenderer, renderText } from "./render.ts";

const FLOW = "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]";
const fences = { mermaid: mermaidFence() };
const draw = (text: string): string => renderText(text, new Map(), { fences });

/** The labels of the nodes a drawn diagram holds, in order. */
const nodes = (html: string): string[] =>
  [...html.matchAll(/class="node"[^>]*data-label="([^"]*)"/g)].map(
    (match) => match[1]!,
  );

describe("mermaidFence", () => {
  it("draws a mermaid fence as one inline SVG", () => {
    const html = draw(`Before\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\nAfter`);
    expect(html).toMatch(
      /^Before<div><\/div><figure class="diagram" data-testid="diagram"><svg [\s\S]*<\/svg><\/figure>After$/,
    );
    expect(nodes(html)).toEqual(["Start", "Ready?", "Ship"]);
    expect(html).not.toContain("flowchart TD");
  });

  it.each([
    ["sequenceDiagram", "sequenceDiagram\n  Reader->>Shop: Any picks?"],
    ["stateDiagram-v2", "stateDiagram-v2\n  [*] --> Reading"],
    ["classDiagram", "classDiagram\n  Book <|-- Novel"],
    ["erDiagram", "erDiagram\n  AUTHOR ||--o{ BOOK : writes"],
    ["xychart-beta", "xychart-beta\n  x-axis [a, b]\n  bar [1, 5]"],
  ])("draws a %s", (_, source) => {
    expect(fences.mermaid(source)).toMatch(/^<figure class="diagram"/);
  });

  // Labels land in text and in data attributes, never in CSS, so characters
  // that safeSvg refuses in CSS do not cost a diagram its drawing.
  it.each([
    ["flowchart", `flowchart TD\n  A["a@b /* c \\ url(d)"] -->|"e@f \\"| B`],
    ["sequenceDiagram", "sequenceDiagram\n  Reader->>Shop: a@b /* c \\ url(d)"],
    ["stateDiagram-v2", "stateDiagram-v2\n  [*] --> Reading : a@b \\ url(d)"],
    ["classDiagram", "classDiagram\n  Book <|-- Novel : a@b \\ url(d)"],
    ["erDiagram", `erDiagram\n  AUTHOR ||--o{ BOOK : "a@b \\ url(d)"`],
    [
      "xychart-beta",
      `xychart-beta\n  x-axis ["a@b", "c \\ url(d)"]\n  bar [1, 5]`,
    ],
    [
      "flowchart with spaces and brackets",
      `flowchart TD\n  A["a b\vc > d < e"] -->|"f g > h"| B`,
    ],
  ])("draws a %s whose labels hold CSS characters", (_, source) => {
    expect(fences.mermaid(source)).toMatch(/^<figure class="diagram"/);
  });

  it("draws a diagram with every kind of style a model can give it", () => {
    expect(
      fences.mermaid(
        `${FLOW}\n  style A fill:#f00,stroke:#00f,stroke-width:2px,color:#fff\n  classDef k fill:#0f0\n  class B k\n  linkStyle 0 stroke:#f0f`,
      ),
    ).toMatch(/^<figure class="diagram"/);
  });

  it("leaves the font and the colors to the page", () => {
    const html = fences.mermaid(FLOW)!;
    expect(html).not.toMatch(
      /@import|fonts\.googleapis|https?:\/\/(?!www\.w3)/,
    );
    expect(html).not.toMatch(/<svg[^>]*\sstyle=/);
    expect(html).toContain("var(--fg)");
  });

  it("holds the fence back until it closes, whatever the slices", () => {
    const text = `\`\`\`mermaid\n${FLOW}\n\`\`\`\ndone`;
    const whole = draw(text);
    for (const size of [1, 2, 3, 7, 50]) {
      const renderer = createRenderer(new Map(), { fences });
      const chunks: string[] = [];
      for (let at = 0; at < text.length; at += size) {
        chunks.push(renderer.push(text.slice(at, at + size)));
      }
      chunks.push(renderer.end());
      // Nothing is sent before the diagram, and it is sent in one piece.
      const sent = chunks.filter(Boolean);
      expect(sent[0]).toMatch(/^<figure[\s\S]*<\/figure>/);
      expect(sent.join("")).toBe(whole);
    }
  });

  it("shows what it cannot draw as code", () => {
    expect(draw("```mermaid\ngantt\n  title Plan\n```")).toBe(
      "<code data-line>gantt</code><code data-line>  title Plan</code>",
    );
    expect(draw("```mermaid\n<script>alert(1)</script>\n```")).toBe(
      "<code data-line>&lt;script&gt;alert(1)&lt;/script&gt;</code>",
    );
    expect(fences.mermaid("")).toBeNull();
    expect(mermaidFence({ maxLength: 10 })(FLOW)).toBeNull();
  });

  it("draws a fence the reply ended inside, and leaves other fences alone", () => {
    expect(draw(`\`\`\`mermaid\n${FLOW}`)).toMatch(/^<figure class="diagram"/);
    expect(draw("```js\ngraph TD\n```")).toBe(
      "<code data-line>graph TD</code>",
    );
    // A language is an own key of `fences`, never an inherited one.
    expect(draw("```constructor\nx\n```")).toBe("<code data-line>x</code>");
  });

  it("escapes markup in labels", () => {
    const html = fences.mermaid(
      `flowchart TD\n  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]\n  click A href "javascript:alert(1)"`,
    )!;
    expect(html).not.toMatch(/<script|<img|<a[\s>]|<foreignObject/i);
    expect(html).toContain("&lt;script&gt;");
    expect(
      safeSvg(html.replace(/^<figure[^>]*>|<\/figure>$/g, "")),
    ).not.toBeNull();
  });

  it.each(["fill", "stroke"])(
    "shows a style whose %s hides an external url() behind a CSS escape as code",
    (property) => {
      const source = `flowchart LR\n  A --> B\n  style A ${property}:\\75 rl(https://evil.example/g)`;
      expect(fences.mermaid(source)).toBeNull();
      expect(
        fences.mermaid(`flowchart LR\n  A --> B\n  style A ${property}:#f00`),
      ).toMatch(/^<figure class="diagram"/);
    },
  );

  it("remembers a diagram it has drawn", () => {
    const render = mermaidFence({ cache: 1 });
    const first = render(FLOW);
    expect(render(FLOW)).toBe(first);
    render("graph LR\n  A --> B");
    expect(render(FLOW)).toEqual(first);
  });
});

describe("safeSvg", () => {
  const ok = `<svg viewBox="0 0 1 1"><style>svg { --a: var(--fg); }</style><defs><marker id="m"></marker></defs><path d="M0 0" marker-end="url(#m)" /><text x="1">a &lt; b</text></svg>`;

  it("accepts drawing elements that refer only to themselves", () => {
    expect(safeSvg(ok)).toBe(ok);
    // Every space HTML ends a name at, and text holding any other.
    const spaced = `<svg\tviewBox="0 0 1 1"\n\f\r><rect\r\nfill="red"\t/><text>a b\vc</text></svg>`;
    expect(safeSvg(spaced)).toBe(spaced);
    const local = `<svg><style>rect { fill: url(#g); }</style><rect fill="URL(#a-1)" data-label="a@b /* \\ url(x)" /></svg>`;
    expect(safeSvg(local)).toBe(local);
  });

  it.each([
    ["a script", `<svg><script>alert(1)</script></svg>`],
    [
      "foreign content",
      `<svg><foreignObject><div></div></foreignObject></svg>`,
    ],
    ["a link", `<svg><a href="https://example.com"><text>x</text></a></svg>`],
    ["an event handler", `<svg><rect onclick="alert(1)" /></svg>`],
    [
      "an image reference",
      `<svg><rect fill="url(https://example.com/x.svg#a)" /></svg>`,
    ],
    ["a use of another file", `<svg><g xlink:href="x.svg#a"></g></svg>`],
    [
      "a stylesheet import",
      `<svg><style>@import url('https://example.com/x.css');</style></svg>`,
    ],
    ["markup in a stylesheet", `<svg><style><g></g></style></svg>`],
    ["an unclosed stylesheet", `<svg><style>svg { }</svg>`],
    [
      "an image reference written with a CSS escape",
      `<svg><rect fill="\\75 rl(https://example.com/x.svg#a)" /></svg>`,
    ],
    [
      "an image reference with an escaped character",
      `<svg><rect stroke="u\\rl(https://example.com/x)" /></svg>`,
    ],
    [
      "an image reference written with a character reference",
      `<svg><rect fill="&#117;rl(https://example.com/x)" /></svg>`,
    ],
    [
      "an image reference written with a named character reference",
      `<svg><rect fill="url&lpar;https://example.com/x)" /></svg>`,
    ],
    [
      "an escaped url() in a stylesheet",
      `<svg><style>rect { fill: \\55RL(https://example.com/x); }</style></svg>`,
    ],
    [
      "an escaped stylesheet import",
      `<svg><style>@\\69mport "https://example.com/x.css";</style></svg>`,
    ],
    // A comment opener in a string hides nothing from the browser.
    [
      "a url() after a comment opener in a stylesheet string",
      `<svg><style>a{content:"/*"}svg{background:url(https://evil.example/x)}b{content:"*/"}</style></svg>`,
    ],
    [
      "a url() after a comment opener in a style attribute string",
      `<svg><rect style="--a:'/*';fill:url(https://evil.example/fill.svg#a);--b:'*/'"/></svg>`,
    ],
    [
      "a mask url() after a comment opener in a string",
      `<svg><rect style="--a:'/*';mask:url(https://evil.example/mask.svg#a);--b:'*/'"/></svg>`,
    ],
    [
      "a url() after an escaped newline and a comment opener in a string",
      `<svg><style>a{content:"\\\n/*"}html{background:url(https://evil.example/z)}b{content:"*/"}</style></svg>`,
    ],
    [
      "an import after a comment opener in a string",
      `<svg><style>a{content:"/*"}@import "https://evil.example/i.css";b{content:"*/"}</style></svg>`,
    ],
    [
      "an image-set() in a stylesheet",
      `<svg><style>body{background-image:image-set("https://evil.example/imageset" 1x)}</style></svg>`,
    ],
    [
      "a -webkit-image-set() in a stylesheet",
      `<svg><style>body{background-image:-webkit-image-set("https://evil.example/w" 1x)}</style></svg>`,
    ],
    [
      "a src() in a stylesheet",
      `<svg><style>body{background-image:src("https://evil.example/s")}</style></svg>`,
    ],
    [
      "a cross-fade() in a style attribute",
      `<svg><rect style="background:cross-fade(&quot;https://evil.example/c&quot;, red 50%)" /></svg>`,
    ],
    [
      "an image() in a presentation attribute",
      `<svg><rect fill="image(&quot;https://evil.example/i&quot;)" /></svg>`,
    ],
    [
      "an element() in a stylesheet",
      `<svg><style>svg{background:element(#a)}</style></svg>`,
    ],
    [
      "an attr() in a stylesheet",
      `<svg><style>svg{--a:attr(data-x)}</style></svg>`,
    ],
    [
      "an image-set() written with a character reference",
      `<svg><rect fill="&#105;mage-set(&quot;https://evil.example/r&quot; 1x)" /></svg>`,
    ],
    [
      "a url() with anything but a local id",
      `<svg><rect fill="url(#a) url(https://evil.example/x)" /></svg>`,
    ],
    ["a quoted local url()", `<svg><rect fill="url('#a')" /></svg>`],
    ["any backslash", `<svg><rect fill="re\\64" /></svg>`],
    [
      "a backslash written as a character reference",
      `<svg><rect fill="&#92;75rl(#a)" /></svg>`,
    ],
    ["any comment", `<svg><style>svg { /* note */ }</style></svg>`],
    ["a comment in an attribute", `<svg><rect fill="red/**/" /></svg>`],
    ["any at-rule", `<svg><style>@media print { svg { } }</style></svg>`],
    [
      "an at-rule written with a character reference",
      `<svg><style>&#64;import "x.css";</style></svg>`,
    ],
    // HTML ends a tag name or an attribute only at a tab, a line feed, a form
    // feed, a carriage return, a space, `/` or `>`; JavaScript's \s also
    // matches the characters below, which HTML reads as part of a name.
    ...[" ", "\v", " ", "﻿", "　"].flatMap((space): [string, string][] => [
      [
        `a tag name ended by U+${space.codePointAt(0)!.toString(16).padStart(4, "0")} hiding an external fill`,
        `<svg><g${space}data-x="/><rect width=100 height=100 style=fill:url(https://evil.example/f.svg#a) />"></g></svg>`,
      ],
      [
        `a tag name ended by U+${space.codePointAt(0)!.toString(16).padStart(4, "0")} hiding a stylesheet`,
        `<svg><g${space}data-x="/><style>svg{background:url(https://evil.example/bg)}</style>"></g></svg>`,
      ],
      [
        `a tag name ended by U+${space.codePointAt(0)!.toString(16).padStart(4, "0")} hiding an event handler`,
        `<svg><g${space}x="/><image href=x onerror=fetch('https://evil.example/xss') />"></g></svg>`,
      ],
      [
        `attributes separated by U+${space.codePointAt(0)!.toString(16).padStart(4, "0")}`,
        `<svg><rect fill="red"${space}x="1" /></svg>`,
      ],
      [
        `a tag closed after U+${space.codePointAt(0)!.toString(16).padStart(4, "0")}`,
        `<svg><rect fill="red"${space}/></svg>`,
      ],
    ]),
    // A label is written escaped, so markup in any attribute value is refused.
    [
      "markup in a data attribute",
      `<svg><g data-x="<rect fill='url(https://evil.example/x)'/>"></g></svg>`,
    ],
    ["a closing bracket in an attribute", `<svg><g data-x="a > b"></g></svg>`],
    ["a tag it cannot read", `<svg><rect x=1 /></svg>`],
    ["a stray angle bracket", `<svg><text>a < b</text></svg>`],
  ])("rejects %s", (_, svg) => {
    expect(safeSvg(svg)).toBeNull();
  });
});

describe("spaceArrows", () => {
  it.each([
    ["A-->B", ["A", "B"]],
    ["A-->|yes|B", ["A", "B"]],
    ["A[Start]-->B{Ok?}", ["Start", "Ok?"]],
    ["A---B", ["A", "B"]],
    ["A-.->B", ["A", "B"]],
    ["A-->B-->C", ["A", "B", "C"]],
    ["A --> B", ["A", "B"]],
  ])("reads %s as an edge between nodes", (edge, labels) => {
    expect(nodes(fences.mermaid(`graph LR\n  ${edge}`)!)).toEqual(labels);
  });

  it("leaves labels and other diagram types alone", () => {
    expect(spaceArrows(`graph LR\nA["x-->y"]-->B[a-->b]`)).toBe(
      `graph LR\nA["x-->y"] --> B[a-->b]`,
    );
    const sequence = "sequenceDiagram\n  A-->>B: hi";
    expect(spaceArrows(sequence)).toBe(sequence);
  });
});
